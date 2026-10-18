/**
 * The run of show: the day's schedule, step by step, with who each step involves.
 *
 * Control panel, under /api/admin/runofshow/* (admins only):
 *   GET    runofshow                  steps (with their links resolved to names), guest
 *                                     groups, and the pick lists for linking
 *   POST   runofshow/items            { day, start_time, duration_min, title, location,
 *                                       details, links: [{ kind, ref_id?, ref_key?, plus_one?, role? }] }
 *   PUT    runofshow/items/:id        the same fields; links, when sent, replace the old ones
 *   DELETE runofshow/items/:id
 *   POST   runofshow/items/:id/status { status: "todo" | "in_progress" | "done" }
 *   POST   runofshow/groups           { name, notes, members: ["<guest id>:<0|1>", ...] }
 *   PUT    runofshow/groups/:id / DELETE runofshow/groups/:id
 *   GET    runofshow/link             the coordinator's day-of link, if one is made
 *   POST   runofshow/link             make a new one (the old one stops working)
 *   DELETE runofshow/link             turn the link off
 *
 * Day-of view, under /api/dayof/* for /dayof/ (the coordinator's iPad): the key from the
 * link in the X-Dayof-Key header, or an admin's sign-in. The coordinator sees the steps,
 * names and tables of the people in them, and vendor contacts -- never budgets,
 * addresses or RSVP details.
 *   GET    dayof                      the run of show
 *   POST   dayof/status               { item_id, status }
 *
 * A link is to a vendor, a guest (or their plus-one), a named group of guests, a table
 * (whoever sits at it), or a preset set like the wedding party.
 */

import { currentUser, json, randomToken, sameSecret } from "./auth.js";
import { all, first, run, getSetting, setSetting, deleteSetting } from "./db.js";
import { loadPeople } from "./people.js";
import { loadSettings } from "./store.js";
import { sqlValue } from "./importer.js";

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
export const STATUSES = ["todo", "in_progress", "done"];
const LINK_KINDS = ["vendor", "guest", "group", "table", "preset"];
const MAX_LINKS = 60;

/** Built-in sets of guests. Nobody who has declined is in one. */
export const PRESETS = {
  wedding_party: { label: "Wedding party", test: (p) => p.wedding_party },
  immediate_family: { label: "Immediate family", test: (p) => p.immediate_family },
  extended_family: { label: "Extended family", test: (p) => p.extended_family },
  bride_side: { label: "Bride's side", test: (p) => p.side === "Bride" },
  groom_side: { label: "Groom's side", test: (p) => p.side === "Groom" },
  ceremony_guests: { label: "Ceremony guests", test: (p) => p.ceremony },
  reception_guests: { label: "Reception guests", test: (p) => p.reception },
};

function cleanItem(input) {
  const patch = Object.create(null);
  if (has(input, "title")) {
    patch.title = String(input.title ?? "").trim().slice(0, 200);
    if (!patch.title) throw new Error("Give the step a name.");
  }
  if (has(input, "day")) {
    const day = String(input.day ?? "").trim();
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("The day must be YYYY-MM-DD.");
    patch.day = day;
  }
  if (has(input, "start_time")) {
    const time = String(input.start_time ?? "").trim();
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("The time must look like 16:30.");
    patch.start_time = time;
  }
  if (has(input, "duration_min")) {
    const v = input.duration_min;
    if (v === "" || v === null || v === undefined) patch.duration_min = null;
    else {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 1440) throw new Error("The length is a whole number of minutes.");
      patch.duration_min = n;
    }
  }
  for (const key of ["location", "details"]) {
    if (has(input, key)) patch[key] = String(input[key] ?? "").trim().slice(0, key === "details" ? 4000 : 200) || null;
  }
  if (has(input, "sort_order")) patch.sort_order = Number(input.sort_order) || 0;
  return patch;
}

async function cleanLinks(env, input) {
  if (!Array.isArray(input)) throw new Error("Links must be a list.");
  if (input.length > MAX_LINKS) throw new Error(`A step can link at most ${MAX_LINKS} people and vendors.`);
  const vendors = new Set((await all(env, "SELECT id FROM vendors")).map((r) => r.id));
  const groups = new Set((await all(env, "SELECT id FROM guest_groups")).map((r) => r.id));
  const tables = new Set((await all(env, "SELECT id FROM seating_items WHERE kind IN ('table', 'seat')")).map((r) => r.id));
  const guests = new Map((await all(env, "SELECT id, plus_one_allowed FROM guests")).map((r) => [r.id, r]));
  const seen = new Set();
  const out = [];
  for (const link of input) {
    if (!link || typeof link !== "object") continue;
    const kind = LINK_KINDS.includes(link.kind) ? link.kind : null;
    if (!kind) throw new Error("Unknown kind of link.");
    const refId = Number(link.ref_id);
    const plusOne = link.plus_one ? 1 : 0;
    const refKey = kind === "preset" ? String(link.ref_key || "") : null;
    if (kind === "vendor" && !vendors.has(refId)) throw new Error("That vendor no longer exists.");
    if (kind === "group" && !groups.has(refId)) throw new Error("That group no longer exists.");
    if (kind === "table" && !tables.has(refId)) throw new Error("That table no longer exists.");
    if (kind === "guest" && (!guests.has(refId) || (plusOne && !guests.get(refId).plus_one_allowed))) throw new Error("That guest no longer exists.");
    if (kind === "preset" && !has(PRESETS, refKey)) throw new Error("Unknown preset group.");
    const id = kind === "preset" ? refKey : `${refId}:${plusOne}`;
    if (seen.has(`${kind}:${id}`)) continue;
    seen.add(`${kind}:${id}`);
    out.push({ kind, ref_id: kind === "preset" ? null : refId, ref_key: refKey, plus_one: kind === "guest" ? plusOne : 0, role: String(link.role || "").trim().slice(0, 200) || null });
  }
  return out;
}

async function saveLinks(env, itemId, links) {
  await run(env, "DELETE FROM ros_links WHERE item_id = ?", itemId);
  if (!links.length) return;
  // One insert with escaped literals (D1 caps bound parameters per query; 6 per link x 60
  // is too many).
  const q = sqlValue;
  await run(
    env,
    `INSERT INTO ros_links (item_id, kind, ref_id, ref_key, plus_one, role) VALUES ${links
      .map((l) => `(${q(itemId)}, ${q(l.kind)}, ${q(l.ref_id)}, ${q(l.ref_key)}, ${q(l.plus_one)}, ${q(l.role)})`)
      .join(", ")}`
  );
}

function cleanMembers(input, people) {
  if (!Array.isArray(input)) throw new Error("Members must be a list.");
  const known = new Set(people.map((p) => p.key));
  const keys = [...new Set(input.map(String))].filter((k) => known.has(k));
  return keys.map((k) => {
    const [guestId, plusOne] = k.split(":").map(Number);
    return { guest_id: guestId, plus_one: plusOne ? 1 : 0 };
  });
}

async function saveMembers(env, groupId, members) {
  await run(env, "DELETE FROM guest_group_members WHERE group_id = ?", groupId);
  if (!members.length) return;
  await run(
    env,
    `INSERT INTO guest_group_members (group_id, guest_id, plus_one) VALUES ${members
      .map((m) => `(${Number(groupId)}, ${Number(m.guest_id)}, ${m.plus_one ? 1 : 0})`)
      .join(", ")}`
  );
}

const sortItems = (a, b) =>
  (a.day || "9999").localeCompare(b.day || "9999") ||
  (a.start_time || "99:99").localeCompare(b.start_time || "99:99") ||
  a.sort_order - b.sort_order ||
  a.id - b.id;

/**
 * The run of show with every link resolved: who is in each step, and the vendors with
 * their contacts. `forDayOf` trims it to what the coordinator needs.
 */
export async function loadRunOfShow(env, { forDayOf = false } = {}) {
  const items = (await all(env, "SELECT * FROM ros_items")).sort(sortItems);
  const links = await all(env, "SELECT * FROM ros_links ORDER BY id");
  const groups = await all(env, "SELECT * FROM guest_groups ORDER BY name COLLATE NOCASE, id");
  const members = await all(env, "SELECT * FROM guest_group_members");
  const vendors = await all(env, "SELECT * FROM vendors ORDER BY name COLLATE NOCASE");
  const tables = await all(
    env,
    `SELECT i.id, i.label, i.kind, r.name AS room FROM seating_items i JOIN seating_rooms r ON r.id = i.room_id
      WHERE i.kind IN ('table', 'seat') AND r.kind = 'reception' ORDER BY r.sort_order, i.id`
  );
  const seated = await all(env, "SELECT item_id, guest_id, plus_one FROM seat_assignments");
  const people = await loadPeople(env);
  const byKey = new Map(people.map((p) => [p.key, p]));
  const vendorById = new Map(vendors.map((v) => [v.id, v]));
  const groupById = new Map(groups.map((g) => [g.id, { ...g, members: [] }]));
  for (const m of members) groupById.get(m.group_id)?.members.push(`${m.guest_id}:${m.plus_one}`);

  // Only what a step needs to show about a person; no addresses or RSVP details.
  const who = (p) => ({ key: p.key, name: p.name, table_seat: p.table_seat, declined: p.rsvp_code === "no" });
  const coming = (list) => list.filter(Boolean).filter((p) => p.rsvp_code !== "no");
  const vendorCard = (v) => ({
    id: v.id,
    name: v.name,
    category: v.category || "",
    day_of: Boolean(v.day_of),
    primary: [v.primary_first, v.primary_last].filter(Boolean).join(" "),
    primary_phone: v.primary_phone || "",
    primary_email: v.primary_email || "",
    secondary: [v.secondary_first, v.secondary_last].filter(Boolean).join(" "),
    secondary_phone: v.secondary_phone || "",
    secondary_email: v.secondary_email || "",
  });

  const resolve = (link) => {
    const base = { kind: link.kind, ref_id: link.ref_id, ref_key: link.ref_key, plus_one: link.plus_one, role: link.role || "" };
    if (link.kind === "vendor") {
      const v = vendorById.get(link.ref_id);
      return v ? { ...base, label: v.name, vendor: vendorCard(v), people: [] } : null;
    }
    if (link.kind === "guest") {
      const p = byKey.get(`${link.ref_id}:${link.plus_one}`);
      return p ? { ...base, label: p.name, people: [who(p)] } : null;
    }
    if (link.kind === "group") {
      const g = groupById.get(link.ref_id);
      return g ? { ...base, label: g.name, people: coming(g.members.map((k) => byKey.get(k))).map(who) } : null;
    }
    if (link.kind === "table") {
      const t = tables.find((x) => x.id === link.ref_id);
      if (!t) return null;
      const atTable = seated.filter((x) => x.item_id === t.id).map((x) => byKey.get(`${x.guest_id}:${x.plus_one}`));
      return { ...base, label: `Table ${t.label}`, people: coming(atTable).map(who) };
    }
    if (link.kind === "preset") {
      const preset = PRESETS[link.ref_key];
      return preset ? { ...base, label: preset.label, people: coming(people.filter(preset.test)).map(who) } : null;
    }
    return null;
  };
  const linksByItem = new Map();
  for (const link of links) {
    const resolved = resolve(link);
    if (!resolved) continue;
    if (!linksByItem.has(link.item_id)) linksByItem.set(link.item_id, []);
    linksByItem.get(link.item_id).push(resolved);
  }
  const steps = items.map((i) => ({
    id: i.id,
    day: i.day,
    start_time: i.start_time,
    duration_min: i.duration_min,
    title: i.title,
    location: i.location || "",
    details: i.details || "",
    status: i.status,
    status_at: i.status_at,
    status_by: forDayOf ? null : i.status_by,
    sort_order: i.sort_order,
    links: linksByItem.get(i.id) || [],
  }));
  const settings = await loadSettings(env);
  const out = {
    steps,
    wedding_date: settings.wedding_date || "",
    couple_names: settings.couple_names || "",
    day_of_vendors: vendors.filter((v) => v.day_of).map(vendorCard),
  };
  if (forDayOf) return out;
  return {
    ...out,
    groups: [...groupById.values()],
    presets: Object.entries(PRESETS).map(([key, p]) => ({ key, label: p.label })),
    vendors: vendors.map((v) => ({ id: v.id, name: v.name, category: v.category || "", day_of: Boolean(v.day_of) })),
    tables: tables.map((t) => ({ id: t.id, label: t.label, room: t.room })),
    people: people.map((p) => ({ key: p.key, name: p.name, household: p.household, rsvp: p.rsvp_code, table_seat: p.table_seat })),
  };
}

/** Rows for the Run of show report (src/reports.js). */
export async function runOfShowRows(env) {
  const { steps } = await loadRunOfShow(env, { forDayOf: true });
  const end = (s) => {
    if (!s.start_time || s.duration_min == null) return "";
    const [h, m] = s.start_time.split(":").map(Number);
    const t = (h * 60 + m + s.duration_min) % 1440;
    return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  };
  const statusText = { todo: "Not started", in_progress: "Happening now", done: "Done" };
  return steps.map((s) => ({
    day: s.day,
    start_time: s.start_time,
    end_time: end(s),
    duration_min: s.duration_min ?? "",
    title: s.title,
    location: s.location,
    details: s.details,
    status: statusText[s.status] || s.status,
    vendors: s.links.filter((l) => l.kind === "vendor").map((l) => l.label + (l.role ? ` (${l.role})` : "")).join("; "),
    people: s.links.filter((l) => l.kind !== "vendor").map((l) => l.label + (l.role ? ` (${l.role})` : "")).join("; "),
    headcount: new Set(s.links.flatMap((l) => l.people.map((p) => p.key))).size,
  }));
}

async function setStatus(env, id, status, by) {
  if (!STATUSES.includes(status)) throw new Error("Status must be todo, in_progress or done.");
  const result = await run(
    env,
    "UPDATE ros_items SET status = ?, status_at = ?, status_by = ? WHERE id = ?",
    status,
    new Date().toISOString(),
    by,
    Number(id)
  );
  return result.meta.changes > 0;
}

async function dayofLink(env, request) {
  const saved = await getSetting(env, "_dayof_key");
  if (!saved?.key) return { url: null };
  return { url: `${env.PUBLIC_URL || new URL(request.url).origin}/dayof/#k=${saved.key}`, created_at: saved.created_at };
}

export async function handleRunOfShow(parts, method, request, env, body, user) {
  const [, section, rawId, action] = parts;
  const id = rawId && /^\d+$/.test(rawId) ? Number(rawId) : null;

  if (!section && method === "GET") return json(await loadRunOfShow(env));

  if (section === "items") {
    if (!id && method === "POST") {
      const input = await body(request);
      const patch = cleanItem(input);
      if (!patch.title) throw new Error("Give the step a name.");
      const links = has(input, "links") ? await cleanLinks(env, input.links) : [];
      const columns = Object.keys(patch);
      const result = await run(env, `INSERT INTO ros_items (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, ...columns.map((c) => patch[c]));
      await saveLinks(env, result.meta.last_row_id, links);
      return json({ id: result.meta.last_row_id, ...(await loadRunOfShow(env)) }, 201);
    }
    if (id && !action && method === "PUT") {
      if (!(await first(env, "SELECT id FROM ros_items WHERE id = ?", id))) return json({ error: "No such step." }, 404);
      const input = await body(request);
      const patch = cleanItem(input);
      const columns = Object.keys(patch);
      if (columns.length) await run(env, `UPDATE ros_items SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, ...columns.map((c) => patch[c]), id);
      if (has(input, "links")) await saveLinks(env, id, await cleanLinks(env, input.links));
      return json(await loadRunOfShow(env));
    }
    if (id && !action && method === "DELETE") {
      await run(env, "DELETE FROM ros_links WHERE item_id = ?", id);
      await run(env, "DELETE FROM ros_items WHERE id = ?", id);
      return json(await loadRunOfShow(env));
    }
    if (id && action === "status" && method === "POST") {
      if (!(await setStatus(env, id, (await body(request)).status, user.email))) return json({ error: "No such step." }, 404);
      return json(await loadRunOfShow(env));
    }
  }

  if (section === "groups") {
    if (!id && method === "POST") {
      const input = await body(request);
      const name = String(input.name ?? "").trim().slice(0, 100);
      if (!name) throw new Error("Name the group.");
      const result = await run(env, "INSERT INTO guest_groups (name, notes) VALUES (?, ?)", name, String(input.notes ?? "").trim().slice(0, 1000) || null);
      if (has(input, "members")) await saveMembers(env, result.meta.last_row_id, cleanMembers(input.members, await loadPeople(env)));
      return json({ id: result.meta.last_row_id, ...(await loadRunOfShow(env)) }, 201);
    }
    if (id && method === "PUT") {
      if (!(await first(env, "SELECT id FROM guest_groups WHERE id = ?", id))) return json({ error: "No such group." }, 404);
      const input = await body(request);
      if (has(input, "name")) {
        const name = String(input.name ?? "").trim().slice(0, 100);
        if (!name) throw new Error("Name the group.");
        await run(env, "UPDATE guest_groups SET name = ? WHERE id = ?", name, id);
      }
      if (has(input, "notes")) await run(env, "UPDATE guest_groups SET notes = ? WHERE id = ?", String(input.notes ?? "").trim().slice(0, 1000) || null, id);
      if (has(input, "members")) await saveMembers(env, id, cleanMembers(input.members, await loadPeople(env)));
      return json(await loadRunOfShow(env));
    }
    if (id && method === "DELETE") {
      await run(env, "DELETE FROM ros_links WHERE kind = 'group' AND ref_id = ?", id);
      await run(env, "DELETE FROM guest_groups WHERE id = ?", id);
      return json(await loadRunOfShow(env));
    }
  }

  if (section === "link") {
    if (method === "GET") return json(await dayofLink(env, request));
    if (method === "POST") {
      await setSetting(env, "_dayof_key", { key: randomToken(24), created_at: new Date().toISOString() });
      return json(await dayofLink(env, request));
    }
    if (method === "DELETE") {
      await deleteSetting(env, "_dayof_key");
      return json({ url: null });
    }
  }

  return json({ error: "Not found." }, 404);
}

/** /api/dayof/*: the coordinator's key, or an admin who is signed in. */
export async function handleDayOf(route, request, env) {
  const method = request.method.toUpperCase();
  const saved = await getSetting(env, "_dayof_key");
  const given = request.headers.get("x-dayof-key") || "";
  let by = null;
  if (given && saved?.key && sameSecret(given, saved.key)) by = "coordinator";
  else {
    const user = await currentUser(request, env);
    // The custom header doubles as the CSRF check for a signed-in admin's POST.
    if (user && (method === "GET" || request.headers.get("x-wedding") === "1")) by = user.email;
  }
  if (!by) return json({ error: given ? "This day-of link has been turned off or replaced. Ask for the new one." : "Open the day-of link you were sent." }, 401);

  if (route === "dayof" && method === "GET") return json({ ...(await loadRunOfShow(env, { forDayOf: true })), by });
  if (route === "dayof/status" && method === "POST") {
    let input = {};
    try {
      input = await request.json();
    } catch {}
    try {
      if (!(await setStatus(env, input?.item_id, input?.status, by))) return json({ error: "No such step." }, 404);
    } catch (error) {
      return json({ error: error.message }, 400);
    }
    return json({ ...(await loadRunOfShow(env, { forDayOf: true })), by });
  }
  return json({ error: "Not found." }, 404);
}
