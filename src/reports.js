/**
 * Reports, mounted under /api/admin/reports/* (admins only).
 *
 *   GET    reports                 the built-in reports, saved custom reports, and the
 *                                  sources and fields a custom report can use
 *   POST   reports/run             { id } or { definition } -> { name, columns, rows }
 *   GET    reports/:id/csv         a built-in ("chase-list") or saved (12) report as CSV
 *   POST   reports/csv             { definition, name } -> an unsaved report as CSV
 *   POST   reports                 { name, definition } save a custom report
 *   PUT    reports/:id / DELETE reports/:id
 *
 * A definition is { source, columns: [field], filters: [{ field, op, value }],
 * sort: [{ field, dir }], group_by: field | null }. With group_by, the report counts
 * rows per value instead of listing them. Sources: people (one row per guest and per
 * plus-one), households, vendors, run_of_show. The head count report is built here
 * rather than from a definition. CSVs go through toCsv (src/sync.js), which defuses
 * formula injection.
 */

import { json } from "./auth.js";
import { all, first, run } from "./db.js";
import { loadPeople } from "./people.js";
import { vendorsWithSpending } from "./vendors.js";
import { runOfShowRows } from "./runofshow.js";
import { toCsv } from "./sync.js";

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const T = "text";
const B = "bool";
const N = "number";

/** What each source's rows carry: [key, label, type]. */
export const SOURCES = {
  people: {
    label: "Guests (one row per person, plus-ones included)",
    fields: [
      ["name", "Name", T], ["first_name", "First name", T], ["last_name", "Last name", T],
      ["plus_one", "Is a plus-one", B], ["guest_of", "Plus-one of", T],
      ["household", "Household", T], ["household_code", "Household code", T], ["greeting", "Greeting", T],
      ["side", "Side", T], ["priority", "Priority", T],
      ["invited_to", "Invited to", T], ["ceremony", "Ceremony", B], ["reception", "Reception", B],
      ["rehearsal", "Rehearsal dinner", B], ["rehearsal_rsvp", "Rehearsal dinner RSVP", T], ["out_of_town", "Out of town", B], ["international", "International", B],
      ["rsvp", "RSVP", T], ["dietary", "Dietary needs", T],
      ["table", "Table", T], ["seat", "Seat", T], ["table_seat", "Table and seat", T],
      ["wedding_party", "Wedding party", B], ["immediate_family", "Immediate family", B], ["extended_family", "Extended family", B],
      ["email", "Household email", T], ["guest_email", "Their own email", T], ["phone", "Phone", T],
      ["address1", "Address", T], ["address2", "Address line 2", T], ["city", "City", T], ["state", "State", T],
      ["zip", "ZIP", T], ["country", "Country", T], ["notes", "Notes", T],
    ],
  },
  households: {
    label: "Households (one row per invitation)",
    fields: [
      ["household", "Name on the envelope", T], ["code", "Household code", T], ["greeting", "Greeting", T],
      ["address1", "Address", T], ["address2", "Address line 2", T], ["city", "City", T], ["state", "State", T],
      ["zip", "ZIP", T], ["country", "Country", T], ["has_address", "Has an address", B],
      ["out_of_town", "Out of town", B], ["international", "International", B],
      ["email", "Email", T], ["phone", "Phone", T],
      ["people", "People invited", N], ["rehearsal", "Invited to the rehearsal dinner", N], ["rehearsal_coming", "Coming to the rehearsal dinner", N], ["coming", "Coming", N], ["awaiting", "Awaiting reply", N], ["declined", "Not coming", N], ["expected", "Coming or awaiting", N],
      ["awaiting_names", "Who hasn't replied", T], ["names", "Everyone in it", T],
      ["save_the_date_sent", "Save-the-date sent", B], ["invite_sent", "Invite sent", B],
      ["gift", "Gift", T], ["gift_received", "Gift received", B], ["thank_you_sent", "Thank-you sent", B],
      ["rsvp_at", "RSVP'd on", T], ["rsvp_message", "Message with RSVP", T], ["notes", "Notes", T],
    ],
  },
  vendors: {
    label: "Vendors",
    fields: [
      ["name", "Vendor", T], ["category", "Category", T], ["day_of", "Day-of", B], ["key_vendor", "Key vendor", B],
      ["primary_name", "Primary contact", T], ["primary_phone", "Primary phone", T], ["primary_email", "Primary email", T],
      ["secondary_name", "Secondary contact", T], ["secondary_phone", "Secondary phone", T], ["secondary_email", "Secondary email", T],
      ["website", "Website", T], ["notes", "Notes", T],
      ["expenses", "Expenses", N], ["projected", "Projected cost", N], ["paid", "Paid", N], ["owed", "Still owed", N],
    ],
  },
  run_of_show: {
    label: "Run of show (one row per step)",
    fields: [
      ["day", "Day", T], ["start_time", "Start", T], ["end_time", "End", T], ["duration_min", "Minutes", N],
      ["title", "Step", T], ["location", "Where", T], ["details", "Details", T], ["status", "Status", T],
      ["lead_vendor", "Lead vendor", T], ["supporting_vendors", "Supporting vendors", T], ["vendors", "All vendors", T],
      ["cohorts", "Guest cohorts", T], ["others", "Other guests, groups and tables", T], ["people", "Everyone but vendors", T],
      ["headcount", "People involved", N],
    ],
  },
};
for (const source of Object.values(SOURCES)) source.byKey = new Map(source.fields.map(([key, label, type]) => [key, { key, label, type }]));

export const OPS = ["is", "is_not", "contains", "empty", "not_empty", "gt", "lt"];

const def = (source, columns, filters = [], sort = [], group_by = null) => ({
  source,
  columns,
  filters: filters.map(([field, op, value = ""]) => ({ field, op, value })),
  sort: sort.map((s) => (s.startsWith("-") ? { field: s.slice(1), dir: "desc" } : { field: s, dir: "asc" })),
  group_by,
});
const notDeclined = ["rsvp", "is_not", "Not coming"];
const LIST = ["name", "household", "rsvp", "side", "dietary", "table_seat"];

/** The standard reports every wedding needs. */
export const BUILTINS = [
  { id: "headcount", group: "Venue and caterer", name: "Head count", description: "Invited, coming, awaiting and not coming for the ceremony, the reception and the rehearsal dinner, and how many are traveling. Plus-ones included." },
  { id: "meal-counts", group: "Venue and caterer", name: "Meal counts by dietary need", description: "Reception guests who are coming, counted by dietary need.",
    definition: def("people", [], [["reception", "is", "yes"], ["rsvp", "is", "Coming"]], [], "dietary") },
  { id: "dietary", group: "Venue and caterer", name: "Dietary needs by guest", description: "Every reception guest with a dietary need, and where they sit.",
    definition: def("people", ["name", "dietary", "table", "seat", "rsvp"], [["reception", "is", "yes"], notDeclined, ["dietary", "not_empty"]], ["table", "seat", "last_name"]) },
  { id: "table-cards", group: "Seating", name: "Table cards", description: "One row per reception guest for escort or place cards: name, table, seat and meal.",
    definition: def("people", ["first_name", "last_name", "name", "table", "seat", "dietary"], [["reception", "is", "yes"], notDeclined], ["last_name", "first_name"]) },
  { id: "seating-board", group: "Seating", name: "Seating chart board", description: "Who sits at each table, table by table, for the seating chart display.",
    definition: def("people", ["table", "seat", "name"], [["table", "not_empty"], notDeclined], ["table", "seat"]) },
  { id: "unseated", group: "Seating", name: "Reception guests without a seat", description: "Coming or awaiting reply, invited to the reception, with no seat yet.",
    definition: def("people", ["name", "household", "rsvp", "side"], [["reception", "is", "yes"], notDeclined, ["table", "empty"]], ["last_name"]) },
  { id: "ceremony-only", group: "Guest lists", name: "Ceremony-only guests", description: "Invited to the ceremony and not the reception.",
    definition: def("people", LIST, [["ceremony", "is", "yes"], ["reception", "is", "no"]], ["last_name", "first_name"]) },
  { id: "reception-only", group: "Guest lists", name: "Reception-only guests", description: "Invited to the reception and not the ceremony.",
    definition: def("people", LIST, [["ceremony", "is", "no"], ["reception", "is", "yes"]], ["last_name", "first_name"]) },
  { id: "both-events", group: "Guest lists", name: "Ceremony and reception guests", description: "Invited to both.",
    definition: def("people", LIST, [["ceremony", "is", "yes"], ["reception", "is", "yes"]], ["last_name", "first_name"]) },
  { id: "full-list", group: "Guest lists", name: "Full guest list", description: "Everyone, plus-ones included, with invitations, RSVP and seat.",
    definition: def("people", ["name", "household", "side", "priority", "invited_to", "rsvp", "dietary", "table_seat", "email", "phone"], [], ["last_name", "first_name"]) },
  { id: "wedding-party", group: "Guest lists", name: "Wedding party", description: "Everyone marked wedding party.",
    definition: def("people", ["name", "side", "rsvp", "phone", "email", "dietary"], [["wedding_party", "is", "yes"]], ["side", "last_name"]) },
  { id: "plus-ones", group: "Guest lists", name: "Plus-ones", description: "Every plus-one offered, named or not, and whose guest they are.",
    definition: def("people", ["name", "guest_of", "rsvp", "dietary", "table_seat"], [["plus_one", "is", "yes"]], ["guest_of"]) },
  { id: "declined", group: "Guest lists", name: "Not coming", description: "Everyone who declined.",
    definition: def("people", ["name", "household", "invited_to"], [["rsvp", "is", "Not coming"]], ["last_name"]) },
  { id: "chase-list", group: "RSVPs and mail", name: "Chase list", description: "Households with someone who hasn't replied, with how to reach them.",
    definition: def("households", ["household", "greeting", "awaiting_names", "email", "phone", "invite_sent"], [["awaiting", "gt", "0"]], ["household"]) },
  { id: "mailing-labels", group: "RSVPs and mail", name: "Mailing labels", description: "Name and address for every household with an address, ready for a label mail merge.",
    definition: def("households", ["household", "address1", "address2", "city", "state", "zip", "country"], [["has_address", "is", "yes"]], ["household"]) },
  { id: "missing-addresses", group: "RSVPs and mail", name: "Missing addresses", description: "Households with no street address yet.",
    definition: def("households", ["household", "names", "email", "phone"], [["has_address", "is", "no"]], ["household"]) },
  { id: "thank-yous", group: "RSVPs and mail", name: "Thank-you notes to write", description: "Gift received, no thank-you sent yet, with the address.",
    definition: def("households", ["household", "greeting", "gift", "address1", "address2", "city", "state", "zip"], [["gift_received", "is", "yes"], ["thank_you_sent", "is", "no"]], ["household"]) },
  { id: "rehearsal-dinner", group: "Rehearsal dinner and travel", name: "Rehearsal dinner guests", description: "Everyone invited to the rehearsal dinner, plus-ones included, with their rehearsal dinner RSVP, wedding RSVP and dietary needs.",
    definition: def("people", ["name", "household", "side", "rehearsal_rsvp", "rsvp", "dietary"], [["rehearsal", "is", "yes"]], ["last_name", "first_name"]) },
  { id: "rehearsal-meals", group: "Rehearsal dinner and travel", name: "Rehearsal dinner meal counts", description: "Rehearsal dinner guests who haven't declined the dinner, counted by dietary need.",
    definition: def("people", [], [["rehearsal", "is", "yes"], ["rehearsal_rsvp", "is_not", "Not coming"]], [], "dietary") },
  { id: "out-of-town", group: "Rehearsal dinner and travel", name: "Out-of-town guests", description: "Everyone tagged out of town, for the hotel block and transportation.",
    definition: def("people", ["name", "household", "rsvp", "city", "state", "country", "phone", "email"], [["out_of_town", "is", "yes"]], ["household", "last_name"]) },
  { id: "welcome-bags", group: "Rehearsal dinner and travel", name: "Welcome bags", description: "One row per household with someone out of town, and someone coming or yet to reply.",
    definition: def("households", ["household", "greeting", "coming", "awaiting", "city", "state", "country", "phone", "email"], [["out_of_town", "is", "yes"], ["expected", "gt", "0"]], ["household"]) },
  { id: "international", group: "Rehearsal dinner and travel", name: "International guests", description: "Everyone tagged international, with country and contact details.",
    definition: def("people", ["name", "household", "country", "rsvp", "phone", "email"], [["international", "is", "yes"]], ["country", "household"]) },
  { id: "international-mailing", group: "Rehearsal dinner and travel", name: "International mailing list", description: "Households with someone tagged international, with their full address, for postage and customs.",
    definition: def("households", ["household", "address1", "address2", "city", "state", "zip", "country"], [["international", "is", "yes"]], ["country", "household"]) },
  { id: "day-of-vendors", group: "Vendors and the day", name: "Day-of vendor contacts", description: "Every day-of vendor with both contacts.",
    definition: def("vendors", ["name", "category", "primary_name", "primary_phone", "primary_email", "secondary_name", "secondary_phone"], [["day_of", "is", "yes"]], ["category", "name"]) },
  { id: "key-vendors", group: "Vendors and the day", name: "Key vendors", description: "Key vendors with contacts and what's still owed.",
    definition: def("vendors", ["name", "category", "primary_name", "primary_phone", "primary_email", "projected", "paid", "owed"], [["key_vendor", "is", "yes"]], ["category", "name"]) },
  { id: "run-of-show", group: "Vendors and the day", name: "Run of show", description: "Every step with its time, place, vendors and people.",
    definition: def("run_of_show", ["day", "start_time", "end_time", "title", "location", "lead_vendor", "supporting_vendors", "cohorts", "others", "details"], [], ["day", "start_time"]) },
];

/* ------------------------------------------------------------------- rows ---- */

async function householdRows(env) {
  const households = await all(env, "SELECT * FROM households ORDER BY display_name COLLATE NOCASE, id");
  const people = await loadPeople(env);
  const byHousehold = new Map();
  for (const p of people) {
    if (!byHousehold.has(p.household_id)) byHousehold.set(p.household_id, []);
    byHousehold.get(p.household_id).push(p);
  }
  return households.map((h) => {
    const mine = byHousehold.get(h.id) || [];
    const count = (code) => mine.filter((p) => p.rsvp_code === code).length;
    return {
      household: h.display_name,
      code: h.code || "",
      greeting: h.greeting,
      address1: h.address1 || "",
      address2: h.address2 || "",
      city: h.city || "",
      state: h.state || "",
      zip: h.zip || "",
      country: h.country || "",
      has_address: Boolean(String(h.address1 || "").trim()),
      // A household is out of town or international when anyone in it is.
      out_of_town: mine.some((p) => p.out_of_town),
      international: mine.some((p) => p.international),
      rehearsal: mine.filter((p) => p.rehearsal).length,
      rehearsal_coming: mine.filter((p) => p.rehearsal_rsvp_code === "yes").length,
      email: h.email || "",
      phone: h.phone || "",
      people: mine.length,
      coming: count("yes"),
      awaiting: count("pending"),
      declined: count("no"),
      expected: count("yes") + count("pending"),
      awaiting_names: mine.filter((p) => p.rsvp_code === "pending").map((p) => p.name).join(", "),
      names: mine.map((p) => p.name).join(", "),
      save_the_date_sent: Boolean(h.save_the_date_sent),
      invite_sent: Boolean(h.invite_sent),
      gift: h.gift || "",
      gift_received: Boolean(h.gift_received),
      thank_you_sent: Boolean(h.thank_you_sent),
      rsvp_at: h.rsvp_at || "",
      rsvp_message: h.rsvp_message || "",
      notes: h.notes || "",
    };
  });
}

async function vendorRows(env) {
  return (await vendorsWithSpending(env)).map((v) => ({
    ...v,
    day_of: Boolean(v.day_of),
    key_vendor: Boolean(v.key_vendor),
    primary_name: [v.primary_first, v.primary_last].filter(Boolean).join(" "),
    secondary_name: [v.secondary_first, v.secondary_last].filter(Boolean).join(" "),
    primary_phone: v.primary_phone || "",
    primary_email: v.primary_email || "",
    secondary_phone: v.secondary_phone || "",
    secondary_email: v.secondary_email || "",
    category: v.category || "",
    website: v.website || "",
    notes: v.notes || "",
  }));
}

const LOADERS = { people: loadPeople, households: householdRows, vendors: vendorRows, run_of_show: runOfShowRows };

/* --------------------------------------------------------------- the engine ---- */

/** Check a definition from a request against the source's fields. */
export function cleanDefinition(input) {
  if (!input || typeof input !== "object") throw new Error("The report has no definition.");
  const source = has(SOURCES, input.source) ? input.source : null;
  if (!source) throw new Error("Pick what the report lists.");
  const fields = SOURCES[source].byKey;
  const known = (f) => typeof f === "string" && fields.has(f);
  const columns = (Array.isArray(input.columns) ? input.columns : []).filter(known).slice(0, 40);
  const filters = (Array.isArray(input.filters) ? input.filters : []).slice(0, 20).map((f) => {
    if (!f || !known(f.field)) throw new Error("A filter names a field this report doesn't have.");
    if (!OPS.includes(f.op)) throw new Error("Unknown filter.");
    return { field: f.field, op: f.op, value: String(f.value ?? "").slice(0, 200) };
  });
  const sort = (Array.isArray(input.sort) ? input.sort : []).filter((s) => s && known(s.field)).slice(0, 3)
    .map((s) => ({ field: s.field, dir: s.dir === "desc" ? "desc" : "asc" }));
  const group_by = input.group_by && known(input.group_by) ? input.group_by : null;
  if (!group_by && !columns.length) throw new Error("Pick at least one column.");
  return { source, columns, filters, sort, group_by };
}

const truthy = (v) => v === true || v === 1 || /^(yes|y|true|1|x)$/i.test(String(v ?? "").trim());

function passes(row, filter, type) {
  const value = row[filter.field];
  const text = String(value ?? "").trim().toLowerCase();
  const want = String(filter.value ?? "").trim().toLowerCase();
  switch (filter.op) {
    case "empty": return type === B ? !value : text === "";
    case "not_empty": return type === B ? Boolean(value) : text !== "";
    case "is": return type === B ? Boolean(value) === truthy(want) : text === want;
    case "is_not": return type === B ? Boolean(value) !== truthy(want) : text !== want;
    case "contains": return text.includes(want);
    case "gt": return Number(value) > Number(want);
    case "lt": return Number(value) < Number(want);
    default: return true;
  }
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
function compare(a, b, type) {
  if (type === N) return (Number(a) || 0) - (Number(b) || 0);
  if (type === B) return Number(Boolean(a)) - Number(Boolean(b));
  return collator.compare(String(a ?? ""), String(b ?? ""));
}
const blank = (v) => v === null || v === undefined || String(v).trim() === "";

const display = (value, type) => (type === B ? (value ? "Yes" : "") : value ?? "");

/** Run a cleaned definition: { columns: [{ key, label }], rows: [[...]] }. */
export async function runDefinition(env, definition) {
  const source = SOURCES[definition.source];
  let rows = await LOADERS[definition.source](env);
  for (const f of definition.filters) rows = rows.filter((r) => passes(r, f, source.byKey.get(f.field).type));

  if (definition.group_by) {
    const field = source.byKey.get(definition.group_by);
    const counts = new Map();
    for (const r of rows) {
      const label = String(display(r[field.key], field.type) || "").trim() || "(none)";
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    const out = [...counts.entries()].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]));
    out.push(["Total", rows.length]);
    return { columns: [{ key: field.key, label: field.label }, { key: "count", label: "Count" }], rows: out };
  }

  const sorted = [...rows];
  sorted.sort((a, b) => {
    for (const s of definition.sort) {
      const type = source.byKey.get(s.field).type;
      // Blanks go last whichever way the column sorts (unseated guests after table 12).
      if (type === T && blank(a[s.field]) !== blank(b[s.field])) return blank(a[s.field]) ? 1 : -1;
      const c = compare(a[s.field], b[s.field], type);
      if (c) return s.dir === "desc" ? -c : c;
    }
    return 0;
  });
  const columns = definition.columns.map((k) => source.byKey.get(k));
  return {
    columns: columns.map((c) => ({ key: c.key, label: c.label })),
    rows: sorted.map((r) => columns.map((c) => display(r[c.key], c.type))),
  };
}

async function headcount(env) {
  const people = await loadPeople(env);
  // The rehearsal dinner row counts the rehearsal dinner RSVP; the others count the wedding's.
  const rowFor = (label, list, answer = "rsvp_code") => {
    const n = (code) => list.filter((p) => p[answer] === code).length;
    return [label, list.length, n("yes"), n("pending"), n("no"), list.filter((p) => p.plus_one && p[answer] === "yes").length, list.filter((p) => p[answer] === "yes" && p.dietary).length];
  };
  return {
    columns: ["Event", "Invited", "Coming", "Awaiting reply", "Not coming", "Plus-ones coming", "Coming with a dietary need"].map((label, i) => ({ key: `c${i}`, label })),
    rows: [
      rowFor("Ceremony", people.filter((p) => p.ceremony)),
      rowFor("Reception", people.filter((p) => p.reception)),
      rowFor("Ceremony only", people.filter((p) => p.ceremony && !p.reception)),
      rowFor("Reception only", people.filter((p) => p.reception && !p.ceremony)),
      rowFor("Both", people.filter((p) => p.ceremony && p.reception)),
      rowFor("Rehearsal dinner", people.filter((p) => p.rehearsal), "rehearsal_rsvp_code"),
      rowFor("Out of town", people.filter((p) => p.out_of_town)),
      rowFor("International", people.filter((p) => p.international)),
    ],
  };
}

async function findReport(env, id) {
  const builtin = BUILTINS.find((b) => b.id === id);
  if (builtin) return { name: builtin.name, definition: builtin.definition || null, builtin: true };
  if (!/^\d+$/.test(String(id))) return null;
  const row = await first(env, "SELECT * FROM reports WHERE id = ?", Number(id));
  return row ? { id: row.id, name: row.name, definition: JSON.parse(row.definition) } : null;
}

async function runReport(env, report) {
  if (report.builtin && !report.definition) return headcount(env);
  return runDefinition(env, cleanDefinition(report.definition));
}

function csvResponse(name, result) {
  const header = result.columns.map((c) => c.label);
  const rows = result.rows.map((r) => Object.fromEntries(header.map((label, i) => [label, r[i]])));
  const file = `${String(name || "report").replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "report"}.csv`;
  return new Response(toCsv(header, rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${file}"`,
      "cache-control": "no-store",
    },
  });
}

export async function handleReports(parts, method, request, env, body) {
  const [, sub, action] = parts;

  if (!sub && method === "GET") {
    const saved = await all(env, "SELECT * FROM reports ORDER BY name COLLATE NOCASE, id");
    return json({
      builtins: BUILTINS,
      custom: saved.map((r) => ({ id: r.id, name: r.name, definition: JSON.parse(r.definition), updated_at: r.updated_at })),
      sources: Object.fromEntries(Object.entries(SOURCES).map(([key, s]) => [key, { label: s.label, fields: s.fields.map(([k, label, type]) => ({ key: k, label, type })) }])),
      ops: OPS,
    });
  }

  if (sub === "run" && method === "POST") {
    const input = await body(request);
    if (input.id !== undefined && input.id !== null) {
      const report = await findReport(env, String(input.id));
      if (!report) return json({ error: "No such report." }, 404);
      return json({ name: report.name, ...(await runReport(env, report)) });
    }
    return json({ name: String(input.name || "Custom report"), ...(await runDefinition(env, cleanDefinition(input.definition))) });
  }

  if (sub === "csv" && method === "POST") {
    const input = await body(request);
    return csvResponse(input.name, await runDefinition(env, cleanDefinition(input.definition)));
  }

  if (sub && action === "csv" && method === "GET") {
    const report = await findReport(env, sub);
    if (!report) return json({ error: "No such report." }, 404);
    return csvResponse(report.name, await runReport(env, report));
  }

  if (!sub && method === "POST") {
    const input = await body(request);
    const name = String(input.name ?? "").trim().slice(0, 100);
    if (!name) throw new Error("Name the report.");
    const definition = cleanDefinition(input.definition);
    const result = await run(env, "INSERT INTO reports (name, definition) VALUES (?, ?)", name, JSON.stringify(definition));
    return json({ id: result.meta.last_row_id, name, definition }, 201);
  }

  if (sub && /^\d+$/.test(sub) && !action) {
    const id = Number(sub);
    if (method === "PUT") {
      const existing = await first(env, "SELECT * FROM reports WHERE id = ?", id);
      if (!existing) return json({ error: "No such report." }, 404);
      const input = await body(request);
      const name = has(input, "name") ? String(input.name ?? "").trim().slice(0, 100) : existing.name;
      if (!name) throw new Error("Name the report.");
      const definition = has(input, "definition") ? cleanDefinition(input.definition) : JSON.parse(existing.definition);
      await run(env, "UPDATE reports SET name = ?, definition = ?, updated_at = datetime('now') WHERE id = ?", name, JSON.stringify(definition), id);
      return json({ id, name, definition });
    }
    if (method === "DELETE") {
      await run(env, "DELETE FROM reports WHERE id = ?", id);
      return json({ ok: true });
    }
  }

  return json({ error: "Not found." }, 404);
}
