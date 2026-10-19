/**
 * Control panel API, mounted under /api/admin/*. Every route needs someone signed in
 * with access to the page it belongs to (ROUTE_PAGES below, src/auth.js requirePage);
 * the rest are admin-only.
 *
 *   GET    summary                     dashboard numbers, charts' data, what's due
 *   GET    expenses                    every expense with computed totals
 *   POST   expenses                    create; with parent_id, a purchase under that item
 *   GET    expenses/:id                one expense + payments, history, attachments
 *   PUT    expenses/:id                update (status moves, price changes)
 *   DELETE expenses/:id
 *   POST   expenses/:id/payments       record a payment (JSON)
 *   DELETE payments/:id
 *   POST   expenses/:id/attachments    upload a receipt/contract to Drive (multipart)
 *   GET    guests                      households with their guests, and the counts
 *   POST   households / PUT households/:id / DELETE households/:id
 *   POST   guests / PUT guests/:id / DELETE guests/:id
 *   POST   households/bulk             set a tracking flag on many households at once
 *   POST   households/reset-rsvp       { ids } -- clear RSVPs back to "awaiting reply"
 *   POST   guests/bulk                 { household_ids, field: "invite_ceremony" | "invite_reception"
 *                                       | "invite_rehearsal" | "out_of_town" | "international",
 *                                       value: true | false }
 *   GET    settings / PUT settings
 *   POST   basis                       { basis: "confirmed" | "weighted" }
 *   GET    form-link                   the expense form's address (PUBLIC_URL/submit)
 *   POST   import                      the original spreadsheet (multipart)
 *   *      seating/*                   rooms, tables, templates and seats (src/seating.js)
 *   *      vendors/*                   vendors and their contacts (src/vendors.js)
 *   *      reports/*                   built-in and custom reports, CSV export (src/reports.js)
 *   *      runofshow/*                 the run of show and guest groups (src/runofshow.js)
 *   *      users/*                     who can sign in, and their pages (src/users.js), admins only
 *   *      comms/*                     guest emails, the calendar invite, the RSVP page (src/comms.js)
 *   GET    site/status                 the Zola copy: address, last check, pages, warnings
 *   POST   site/refresh                fetch the Zola site now ("Refresh from Zola")
 *   GET    drive/status, GET drive/connect, GET drive/folders?parent=,
 *   POST   drive/folder, POST drive/folder/create, POST drive/sync, POST drive/disconnect
 */

import { json, requirePage, startOAuth } from "./auth.js";
import { all, first, run, getSetting, setSetting, markDirty, updateClause } from "./db.js";
import {
  DEFAULT_SETTINGS,
  PRIORITIES,
  QUANTITY_SOURCES,
  RSVP_VALUES,
  SIDES,
  STATUSES,
  STATUS_LABELS,
  summarize,
} from "./calc.js";
import {
  addPayment,
  createExpense,
  deletePayment,
  getExpense,
  listExpenses,
  listVendors,
  loadContext,
  loadSettings,
  updateExpense,
} from "./store.js";
import {
  createFolder,
  disconnectDrive,
  driveStatus,
  folderInfo,
  listFolders,
  uploadReceipt,
} from "./google.js";
import { syncToDrive } from "./sync.js";
import { importWorkbook } from "./importer.js";
import { refreshSite, requestGithubRefresh, siteSlug } from "./site.js";
import { handleSeating, seatsByGuest } from "./seating.js";
import { handleVendors } from "./vendors.js";
import { handleReports } from "./reports.js";
import { handleRunOfShow } from "./runofshow.js";
import { handleUsers } from "./users.js";
import { handleComms } from "./comms.js";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

async function body(request) {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const idList = (v) => (Array.isArray(v) ? v : []).map(Number).filter(Number.isInteger);
// Ids go into the SQL as literals (they're integers): D1 allows only 100 bound
// parameters a statement, and a bulk action can pick more households than that.
const idSql = (ids) => ids.map((n) => String(Math.trunc(n))).join(",") || "0";
const bool = (v) => (v === true || v === 1 || v === "1" || v === "true" || v === "on" ? 1 : 0);
const textOrNull = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim().slice(0, 2000);
  return t || null;
};

/* ------------------------------------------------------------------- guests ---- */

const HOUSEHOLD_TEXT = ["code", "display_name", "greeting", "address1", "address2", "city", "state", "zip", "country", "email", "phone", "gift", "rsvp_message", "notes"];
const HOUSEHOLD_FLAGS = ["save_the_date_sent", "invite_sent", "gift_received", "thank_you_sent"];
const GUEST_TEXT = ["first_name", "last_name", "plus_one_name", "dietary", "plus_one_dietary", "table_name", "notes", "email"];
const GUEST_FLAGS = ["wedding_party", "immediate_family", "extended_family", "plus_one_allowed", "invite_ceremony", "invite_reception", "invite_rehearsal", "out_of_town", "international", "post_wedding_call"];
// The per-guest switches the Guests page can flip for whole households at once.
const INVITE_FLAGS = ["invite_ceremony", "invite_reception", "invite_rehearsal", "out_of_town", "international"];

const checkEmail = (value, who) => {
  if (value && !/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(value)) throw new Error(`${who} email "${value}" doesn't look like an email address.`);
  return value;
};

function cleanHousehold(input) {
  const patch = Object.create(null);
  for (const key of HOUSEHOLD_TEXT) if (has(input, key)) patch[key] = textOrNull(input[key]);
  if (has(patch, "email")) checkEmail(patch.email, "The household's");
  for (const key of ["display_name", "greeting"]) if (has(patch, key) && patch[key] === null) patch[key] = "";
  for (const key of HOUSEHOLD_FLAGS) if (has(input, key)) patch[key] = bool(input[key]);
  return patch;
}

/** A guest needs a first or last name: a blank one would still count in the budget. */
const named = (g) => Boolean(String(g.first_name || "").trim() || String(g.last_name || "").trim());

function cleanGuest(input) {
  const patch = Object.create(null);
  for (const key of GUEST_TEXT) if (has(input, key)) patch[key] = textOrNull(input[key]);
  if (has(patch, "email")) checkEmail(patch.email, "A guest's");
  for (const key of ["first_name", "last_name"]) if (has(patch, key) && patch[key] === null) patch[key] = "";
  for (const key of GUEST_FLAGS) if (has(input, key)) patch[key] = bool(input[key]);
  if (has(input, "side")) {
    if (input.side && !SIDES.includes(input.side)) throw new Error(`Side must be ${SIDES.join(" or ")}.`);
    patch.side = input.side || null;
  }
  if (has(input, "priority")) {
    if (!PRIORITIES.includes(input.priority)) throw new Error(`Priority must be ${PRIORITIES.join(", ")}.`);
    patch.priority = input.priority;
  }
  for (const key of ["rsvp", "plus_one_rsvp", "rehearsal_rsvp", "plus_one_rehearsal_rsvp"]) {
    if (has(input, key)) {
      if (!RSVP_VALUES.includes(input[key])) throw new Error(`RSVP must be ${RSVP_VALUES.join(", ")}.`);
      patch[key] = input[key];
    }
  }
  if (has(input, "sort_order")) patch.sort_order = Number(input.sort_order) || 0;
  return patch;
}

async function listGuests(env) {
  const households = await all(env, "SELECT * FROM households ORDER BY id");
  const guests = await all(env, "SELECT * FROM guests ORDER BY household_id, sort_order, id");
  const seats = await seatsByGuest(env);
  const byHousehold = new Map(households.map((h) => [h.id, { ...h, guests: [] }]));
  for (const g of guests) {
    const seat = seats.get(g.id) || {};
    byHousehold.get(g.household_id)?.guests.push({ ...g, seat: seat.guest || null, plus_one_seat: seat.plus_one || null });
  }
  return [...byHousehold.values()];
}

async function nextHouseholdCode(env) {
  const rows = await all(env, "SELECT code FROM households WHERE code LIKE 'H-%'");
  const max = rows.reduce((m, r) => Math.max(m, Number(String(r.code).slice(2)) || 0), 0);
  return `H-${String(max + 1).padStart(3, "0")}`;
}

/* ------------------------------------------------------------------- settings -- */

function cleanSettings(input) {
  const patch = Object.create(null);
  const asNumber = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number of zero or more.`);
    return n;
  };
  for (const key of ["couple_names", "venue", "rsvp_intro"]) if (has(input, key)) patch[key] = String(input[key] ?? "").slice(0, 2000);
  for (const key of ["wedding_date", "rsvp_deadline"]) {
    if (has(input, key)) {
      const v = String(input[key] ?? "").trim();
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${key} must be YYYY-MM-DD.`);
      patch[key] = v;
    }
  }
  if (has(input, "rsvp_open")) patch.rsvp_open = Boolean(bool(input.rsvp_open));
  if (has(input, "tax_rate")) {
    patch.tax_rate = asNumber(input.tax_rate, "Tax rate");
    if (patch.tax_rate > 1) throw new Error("Tax rate is a fraction (7% is 0.07).");
  }
  if (has(input, "budget_target")) {
    patch.budget_target = input.budget_target === "" || input.budget_target == null ? null : asNumber(input.budget_target, "Budget");
  }
  if (has(input, "guest_basis")) {
    if (!["weighted", "confirmed"].includes(input.guest_basis)) throw new Error("Guest basis must be weighted or confirmed.");
    patch.guest_basis = input.guest_basis;
  }
  if (has(input, "priority_weights")) {
    const weights = {};
    for (const key of PRIORITIES) weights[key] = asNumber(input.priority_weights?.[key] ?? DEFAULT_SETTINGS.priority_weights[key], `${key} weight`);
    patch.priority_weights = weights;
  }
  if (has(input, "drinks")) {
    const drinks = {};
    for (const key of Object.keys(DEFAULT_SETTINGS.drinks)) {
      drinks[key] = asNumber(input.drinks?.[key] ?? DEFAULT_SETTINGS.drinks[key], key.replace(/_/g, " "));
    }
    patch.drinks = drinks;
  }
  if (has(input, "zola_url")) {
    const url = String(input.zola_url || "").trim().replace(/\/+$/, "");
    if (url && !siteSlug(url)) throw new Error("The Zola address should look like https://www.zola.com/wedding/your-site.");
    patch.zola_url = url;
  }
  if (has(input, "registry_url")) {
    const url = String(input.registry_url || "").trim();
    if (url && !/^https?:\/\/[^\s"<>]+$/i.test(url)) throw new Error("The registry link should start with https://.");
    patch.registry_url = url;
  }
  if (has(input, "contact_email")) {
    const email = String(input.contact_email || "").trim();
    if (email && !/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(email)) throw new Error("The contact email doesn't look like an email address.");
    patch.contact_email = email;
  }
  if (has(input, "rsvp_button_color")) {
    const color = String(input.rsvp_button_color || "").trim();
    if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error("The RSVP button color must be a hex color like #2f5d62.");
    patch.rsvp_button_color = color;
  }
  for (const key of ["payers", "payment_methods"]) {
    if (has(input, key)) {
      const list = Array.isArray(input[key]) ? input[key] : String(input[key] || "").split(",");
      patch[key] = list.map((s) => String(s).trim()).filter(Boolean).slice(0, 30);
    }
  }
  return patch;
}

/* ------------------------------------------------------------------- router ---- */

/**
 * Which control-panel page each route belongs to, for users limited to some pages.
 * Anything not listed (settings, basis, import, site, drive, users) is admin-only.
 */
const ROUTE_PAGES = {
  summary: "dashboard",
  expenses: "expenses",
  payments: "expenses",
  "form-link": "expenses",
  vendors: "vendors",
  guests: "guests",
  households: "guests",
  seating: "seating",
  runofshow: "runofshow",
  reports: "reports",
  comms: "communications",
};

export async function handleAdminApi(route, request, env) {
  const parts = route.split("/").filter(Boolean);
  const page = Object.prototype.hasOwnProperty.call(ROUTE_PAGES, parts[0]) ? ROUTE_PAGES[parts[0]] : "admin";
  const [user, denied] = await requirePage(request, env, page);
  if (denied) return denied;
  const method = request.method.toUpperCase();
  const id = parts[1] && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null;

  try {
    // ---- dashboard ---------------------------------------------------------------
    if (route === "summary" && method === "GET") {
      const ctx = await loadContext(env);
      const expenses = await listExpenses(env, ctx);
      const payments = await all(env, "SELECT paid_on, amount FROM payments");
      return json({
        user,
        settings: ctx.settings,
        counts: ctx.counts,
        basis: ctx.basis,
        basis_count: ctx.basisCount,
        drinks: ctx.drinks,
        statuses: STATUSES,
        status_labels: STATUS_LABELS,
        ...summarize(expenses, payments, ctx),
        // Just what the dashboard's category table needs: one row per item (an item
        // with purchases already includes them).
        items: expenses.filter((e) => !e.parent_id).map((e) => ({
          id: e.id,
          category: e.category,
          subcategory: e.subcategory,
          item: e.item,
          status: e.status,
          estimate: e.estimate,
          actual: e.actual,
          projected: e.projected,
          purchases: e.purchases,
        })),
        drive: await driveStatus(env),
      });
    }

    // ---- expenses ----------------------------------------------------------------
    if (parts[0] === "expenses") {
      const ctx = await loadContext(env);
      if (parts.length === 1 && method === "GET") {
        return json({
          expenses: await listExpenses(env, ctx),
          statuses: STATUSES,
          status_labels: STATUS_LABELS,
          quantity_sources: QUANTITY_SOURCES,
          settings: ctx.settings,
          counts: ctx.counts,
          basis: ctx.basis,
          basis_count: ctx.basisCount,
          drinks: ctx.drinks,
          vendors: await listVendors(env),
        });
      }
      if (parts.length === 1 && method === "POST") {
        const newId = await createExpense(env, await body(request), ctx, user.email);
        return json({ expense: await getExpense(env, newId, ctx) }, 201);
      }
      if (id && parts.length === 2) {
        if (method === "GET") {
          const expense = await getExpense(env, id, ctx);
          if (!expense) return json({ error: "No such expense." }, 404);
          return json({
            expense,
            payments: await all(env, "SELECT * FROM payments WHERE expense_id = ? ORDER BY paid_on, id", id),
            history: await all(env, "SELECT * FROM expense_history WHERE expense_id = ? ORDER BY at, id", id),
            attachments: await all(env, "SELECT * FROM attachments WHERE expense_id = ? ORDER BY id", id),
          });
        }
        if (method === "PUT") {
          const updated = await updateExpense(env, id, await body(request), ctx, user.email);
          if (!updated) return json({ error: "No such expense." }, 404);
          return json({ expense: await getExpense(env, id, ctx) });
        }
        if (method === "DELETE") {
          // Its purchases go with it (also enforced by the foreign key).
          await run(env, "DELETE FROM expenses WHERE parent_id = ?", id);
          await run(env, "DELETE FROM expenses WHERE id = ?", id);
          await markDirty(env);
          return json({ ok: true });
        }
      }
      if (id && parts[2] === "payments" && method === "POST") {
        const paymentId = await addPayment(env, id, await body(request), ctx, user.email);
        return json({ payment_id: paymentId, expense: await getExpense(env, id, ctx) }, 201);
      }
      if (id && parts[2] === "attachments" && method === "POST") {
        const form = await request.formData();
        const file = form.get("file");
        if (!file || typeof file === "string") return json({ error: "Choose a file to upload." }, 400);
        if (file.size > MAX_UPLOAD_BYTES) return json({ error: "Files must be under 20 MB." }, 400);
        const expense = await first(env, "SELECT * FROM expenses WHERE id = ?", id);
        if (!expense) return json({ error: "No such expense." }, 404);
        const paymentId = Number(form.get("payment_id")) || null;
        const uploaded = await uploadReceipt(env, file, [expense.vendor, expense.item].filter(Boolean).join(" "));
        await run(
          env,
          "INSERT INTO attachments (expense_id, payment_id, drive_file_id, name, web_link, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)",
          id,
          paymentId,
          uploaded.id,
          uploaded.name,
          uploaded.webViewLink || null,
          user.email
        );
        await markDirty(env);
        return json({ attachment: uploaded }, 201);
      }
    }

    if (parts[0] === "payments" && id && method === "DELETE") {
      const ok = await deletePayment(env, id);
      return ok ? json({ ok: true }) : json({ error: "No such payment." }, 404);
    }

    // ---- guests ------------------------------------------------------------------
    if (route === "guests" && method === "GET") {
      const ctx = await loadContext(env);
      // No settings here: a user with only the Guests page doesn't get the budget's.
      return json({ households: await listGuests(env), counts: ctx.counts });
    }

    if (parts[0] === "households") {
      // Back to "awaiting reply", as if they never answered: every guest's and plus-one's
      // answer, what the RSVP form filled in (plus-one name, dietary needs, the message),
      // and the RSVP time, so the RSVP page stops saying "you've already replied".
      // Plus-one allowances and the household's email stay.
      if (parts[1] === "reset-rsvp" && method === "POST") {
        const ids = idList((await body(request)).ids);
        if (!ids.length) return json({ error: "Pick at least one household." }, 400);
        const marks = idSql(ids);
        await run(
          env,
          `UPDATE guests SET rsvp = 'pending', plus_one_rsvp = 'pending', rehearsal_rsvp = 'pending', plus_one_rehearsal_rsvp = 'pending', plus_one_name = NULL, dietary = NULL,
                  plus_one_dietary = NULL, updated_at = datetime('now') WHERE household_id IN (${marks})`
        );
        await run(
          env,
          `UPDATE households SET rsvp_at = NULL, rsvp_message = NULL, updated_at = datetime('now') WHERE id IN (${marks})`
        );
        await markDirty(env);
        return json({ ok: true, reset: ids.length });
      }
      if (parts[1] === "bulk" && method === "POST") {
        const input = await body(request);
        if (!HOUSEHOLD_FLAGS.includes(input.field)) return json({ error: "Unknown field." }, 400);
        const ids = idList(input.ids);
        if (!ids.length) return json({ error: "Pick at least one household." }, 400);
        await run(
          env,
          `UPDATE households SET ${input.field} = ?, updated_at = datetime('now') WHERE id IN (${idSql(ids)})`,
          bool(input.value)
        );
        await markDirty(env);
        return json({ ok: true, updated: ids.length });
      }
      if (parts.length === 1 && method === "POST") {
        const input = await body(request);
        const patch = cleanHousehold(input);
        if (!patch.code) patch.code = await nextHouseholdCode(env);
        const columns = Object.keys(patch);
        const result = await run(
          env,
          `INSERT INTO households (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          ...columns.map((c) => patch[c])
        );
        const householdId = result.meta.last_row_id;
        for (const [i, guest] of (Array.isArray(input.guests) ? input.guests : []).entries()) {
          const g = cleanGuest(guest);
          if (!named(g)) continue; // a blank card left in the editor adds nobody
          if (!has(g, "sort_order")) g.sort_order = i;
          const cols = Object.keys(g);
          await run(
            env,
            `INSERT INTO guests (household_id${cols.map((c) => `, ${c}`).join("")}) VALUES (?${cols.map(() => ", ?").join("")})`,
            householdId,
            ...cols.map((c) => g[c])
          );
        }
        await markDirty(env);
        return json({ id: householdId }, 201);
      }
      if (id && method === "PUT") {
        const { sql, values } = updateClause(cleanHousehold(await body(request)), [...HOUSEHOLD_TEXT, ...HOUSEHOLD_FLAGS]);
        if (sql) await run(env, `UPDATE households SET ${sql}, updated_at = datetime('now') WHERE id = ?`, ...values, id);
        await markDirty(env);
        return json({ household: await first(env, "SELECT * FROM households WHERE id = ?", id) });
      }
      if (id && method === "DELETE") {
        await run(env, "DELETE FROM guests WHERE household_id = ?", id);
        await run(env, "DELETE FROM households WHERE id = ?", id);
        await markDirty(env);
        return json({ ok: true });
      }
    }

    if (parts[0] === "guests") {
      // Bulk edits apply to every guest in the chosen households.
      if (parts[1] === "bulk" && method === "POST") {
        const input = await body(request);
        if (!INVITE_FLAGS.includes(input.field)) return json({ error: "Unknown field." }, 400);
        if (typeof input.value !== "boolean") return json({ error: "Value must be true or false." }, 400);
        const ids = idList(input.household_ids);
        if (!ids.length) return json({ error: "Pick at least one household." }, 400);
        const result = await run(
          env,
          `UPDATE guests SET ${input.field} = ?, updated_at = datetime('now') WHERE household_id IN (${idSql(ids)})`,
          input.value ? 1 : 0
        );
        await markDirty(env);
        return json({ ok: true, updated: result.meta.changes });
      }
      if (parts.length === 1 && method === "POST") {
        const input = await body(request);
        const householdId = Number(input.household_id);
        if (!(await first(env, "SELECT id FROM households WHERE id = ?", householdId))) {
          return json({ error: "Pick the household this guest belongs to." }, 400);
        }
        const g = cleanGuest(input);
        if (!named(g)) return json({ error: "Give the guest a first or last name." }, 400);
        // A guest added later goes after the household's others (imported guests are
        // numbered across the whole sheet).
        if (!has(g, "sort_order")) {
          g.sort_order = (await first(env, "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM guests WHERE household_id = ?", householdId)).next;
        }
        const cols = Object.keys(g);
        const result = await run(
          env,
          `INSERT INTO guests (household_id${cols.map((c) => `, ${c}`).join("")}) VALUES (?${cols.map(() => ", ?").join("")})`,
          householdId,
          ...cols.map((c) => g[c])
        );
        await markDirty(env);
        return json({ id: result.meta.last_row_id }, 201);
      }
      if (id && method === "PUT") {
        const input = await body(request);
        const patch = cleanGuest(input);
        // The RSVP page's rules hold here too: a guest who isn't coming brings no plus-one
        // and isn't at the rehearsal dinner, and nor is a plus-one whose guest skips it.
        const answers = ["rsvp", "plus_one_rsvp", "rehearsal_rsvp", "plus_one_rehearsal_rsvp"];
        if (answers.some((k) => has(patch, k))) {
          const now = { ...(await first(env, `SELECT ${answers.join(", ")} FROM guests WHERE id = ?`, id)), ...patch };
          if (now.rsvp === "no") Object.assign(patch, { plus_one_rsvp: "no", rehearsal_rsvp: "no", plus_one_rehearsal_rsvp: "no" });
          else if (now.plus_one_rsvp === "no" || now.rehearsal_rsvp === "no") patch.plus_one_rehearsal_rsvp = "no";
        }
        if (has(input, "household_id")) {
          const target = await first(env, "SELECT id FROM households WHERE id = ?", Number(input.household_id));
          if (!target) return json({ error: "No such household." }, 400);
          patch.household_id = target.id;
        }
        const { sql, values } = updateClause(patch, [...GUEST_TEXT, ...GUEST_FLAGS, "side", "priority", "rsvp", "plus_one_rsvp", "rehearsal_rsvp", "plus_one_rehearsal_rsvp", "sort_order", "household_id"]);
        if (sql) await run(env, `UPDATE guests SET ${sql}, updated_at = datetime('now') WHERE id = ?`, ...values, id);
        await markDirty(env);
        return json({ guest: await first(env, "SELECT * FROM guests WHERE id = ?", id) });
      }
      if (id && method === "DELETE") {
        await run(env, "DELETE FROM guests WHERE id = ?", id);
        await markDirty(env);
        return json({ ok: true });
      }
    }

    // ---- seating chart -----------------------------------------------------------
    if (parts[0] === "seating") return await handleSeating(parts, method, request, env, body);
    if (parts[0] === "vendors") return await handleVendors(parts, method, request, env, body);
    if (parts[0] === "reports") return await handleReports(parts, method, request, env, body);
    if (parts[0] === "runofshow") return await handleRunOfShow(parts, method, request, env, body, user);
    if (parts[0] === "users") return await handleUsers(parts, method, request, env, body, user);
    if (parts[0] === "comms") return await handleComms(parts, method, request, env, body, user);

    // ---- settings ----------------------------------------------------------------
    if (route === "settings" && method === "GET") {
      const ctx = await loadContext(env);
      return json({ settings: ctx.settings, counts: ctx.counts, drinks: ctx.drinks, basis_count: ctx.basisCount, user });
    }
    if (route === "settings" && method === "PUT") {
      const patch = cleanSettings(await body(request));
      for (const [key, value] of Object.entries(patch)) await setSetting(env, key, value);
      await markDirty(env);
      const ctx = await loadContext(env);
      return json({ settings: ctx.settings, counts: ctx.counts, drinks: ctx.drinks, basis_count: ctx.basisCount });
    }
    if (route === "basis" && method === "POST") {
      const { basis } = await body(request);
      if (!["weighted", "confirmed"].includes(basis)) return json({ error: "Basis must be weighted or confirmed." }, 400);
      await setSetting(env, "guest_basis", basis);
      await markDirty(env);
      const ctx = await loadContext(env);
      return json({ basis: ctx.basis, basis_count: ctx.basisCount });
    }

    if (route === "form-link" && method === "GET") {
      return json({ url: `${env.PUBLIC_URL || new URL(request.url).origin}/submit` });
    }

    // ---- spreadsheet import ------------------------------------------------------
    if (route === "import" && method === "POST") {
      const form = await request.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") return json({ error: "Choose the .xlsx file to import." }, 400);
      if (file.size > MAX_UPLOAD_BYTES) return json({ error: "That file is over 20 MB." }, 400);
      const partsToImport = {
        guests: bool(form.get("guests")),
        budget: bool(form.get("budget")),
        constants: bool(form.get("constants")),
      };
      if (!partsToImport.guests && !partsToImport.budget && !partsToImport.constants) {
        return json({ error: "Pick at least one thing to import." }, 400);
      }
      const summary = await importWorkbook(env, await file.arrayBuffer(), partsToImport, user.email);
      return json({ ok: true, summary });
    }

    // ---- the public website (copied from Zola) --------------------------------------
    if (route === "site/status" && method === "GET") {
      const s = await loadSettings(env);
      const pages = await all(env, "SELECT path, title, fetched_at, changed_at FROM site_pages ORDER BY path");
      return json({
        zola_url: s.zola_url || env.ZOLA_URL || "",
        status: (await getSetting(env, "_site_status")) || null,
        pages,
        via_github: Boolean(env.GH_DISPATCH_TOKEN && env.GITHUB_REPO),
      });
    }
    // With the GitHub setup, GitHub does the fetching (Zola blocks Cloudflare) and this
    // returns at once with requested: true; Settings then watches for the result.
    if (route === "site/refresh" && method === "POST") {
      if (env.GH_DISPATCH_TOKEN && env.GITHUB_REPO) return json({ ok: true, requested: true, status: await requestGithubRefresh(env) });
      const s = await loadSettings(env);
      const status = await refreshSite(env, { zolaUrl: s.zola_url || env.ZOLA_URL, rsvpColor: s.rsvp_button_color });
      return json({ ok: true, status });
    }

    // ---- Google Drive ------------------------------------------------------------
    if (parts[0] === "drive") {
      const sub = parts.slice(1).join("/");
      if (sub === "status" && method === "GET") return json(await driveStatus(env));
      if (sub === "connect" && method === "GET") return startOAuth(request, env, "drive", { loginHint: user.email });
      if (sub === "folders" && method === "GET") {
        const parent = new URL(request.url).searchParams.get("parent") || "root";
        return json({ parent, folders: await listFolders(env, parent) });
      }
      if (sub === "folder" && method === "POST") {
        const { id: folderId } = await body(request);
        if (!folderId) return json({ error: "Pick a folder." }, 400);
        const info = await folderInfo(env, String(folderId));
        await setSetting(env, "_drive_folder", { id: info.id, name: info.name });
        await markDirty(env);
        return json({ folder: { id: info.id, name: info.name } });
      }
      if (sub === "folder/create" && method === "POST") {
        const input = await body(request);
        const name = String(input.name || "").trim();
        if (!name) return json({ error: "Name the new folder." }, 400);
        const created = await createFolder(env, name, String(input.parent || "root"));
        return json({ folder: created }, 201);
      }
      if (sub === "sync" && method === "POST") return json({ ok: true, result: await syncToDrive(env) });
      if (sub === "disconnect" && method === "POST") {
        await disconnectDrive(env);
        return json({ ok: true });
      }
    }

    return json({ error: "Not found." }, 404);
  } catch (error) {
    return json({ error: error.message || String(error) }, 400);
  }
}
