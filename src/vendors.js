/**
 * Vendors, mounted under /api/admin/vendors/* (admins only, like src/admin_api.js).
 *
 *   GET    vendors          every vendor with its contacts, flags and what's spent with it
 *   POST   vendors          { name, category, day_of, key_vendor, primary_*, secondary_*, ... }
 *   GET    vendors/:id      one vendor and its expenses (items and line items)
 *   PUT    vendors/:id      update; a new name is carried onto its expenses
 *   DELETE vendors/:id      only when no expense names it
 *
 * Expenses name their vendor as text (expenses.vendor), matched here ignoring case, so
 * the expense form and Claude keep working with plain names. Contacts are optional: a
 * store like Costco has none. A day-of vendor is a key vendor unless you say otherwise.
 */

import { json } from "./auth.js";
import { all, first, run, markDirty } from "./db.js";
import { listExpenses, loadContext } from "./store.js";
import { STATUS_LABELS } from "./calc.js";

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const bool = (v) => (v === true || v === 1 || v === "1" || v === "true" || v === "on" ? 1 : 0);

export const CONTACT_FIELDS = [
  "primary_first", "primary_last", "primary_email", "primary_phone",
  "secondary_first", "secondary_last", "secondary_email", "secondary_phone",
];
const TEXT_FIELDS = ["category", "website", "notes", ...CONTACT_FIELDS];
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i;

function cleanVendor(input) {
  const patch = Object.create(null);
  if (has(input, "name")) {
    patch.name = String(input.name ?? "").trim().slice(0, 200);
    if (!patch.name) throw new Error("Name the vendor.");
  }
  for (const key of TEXT_FIELDS) {
    if (!has(input, key)) continue;
    const value = String(input[key] ?? "").trim().slice(0, key === "notes" ? 2000 : 200);
    if (value && key.endsWith("_email") && !EMAIL.test(value)) throw new Error(`"${value}" doesn't look like an email address.`);
    patch[key] = value || null;
  }
  for (const key of ["day_of", "key_vendor"]) if (has(input, key)) patch[key] = bool(input[key]);
  // Every day-of vendor is a key vendor, unless the same save says it isn't.
  if (patch.day_of && !has(input, "key_vendor")) patch.key_vendor = 1;
  return patch;
}

const fold = (name) => String(name || "").trim().toLowerCase();

/** Owed is what's booked and not yet paid, as on the Expenses page; an estimate owes nothing. */
const owedNow = (e) => Math.max(Math.round(((e.incurred || 0) - (e.paid || 0)) * 100) / 100, 0);

function totalsOf(expenses) {
  const t = { expenses: expenses.length, projected: 0, paid: 0, owed: 0 };
  for (const e of expenses) {
    t.projected += e.projected || 0;
    t.paid += e.paid || 0;
    t.owed += owedNow(e);
  }
  for (const k of ["projected", "paid", "owed"]) t[k] = Math.round(t[k] * 100) / 100;
  return t;
}

/** Each vendor's expenses by name: line items, and items with no line items (an item with line items counts through them). */
function byVendor(expenses) {
  const out = new Map();
  for (const e of expenses) {
    if (!e.vendor || e.purchases) continue;
    const key = fold(e.vendor);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(e);
  }
  return out;
}

/** Vendors with what's spent with each; reports.js and sync.js read this too. */
export async function vendorsWithSpending(env, ctx = null) {
  const vendors = await all(env, "SELECT * FROM vendors ORDER BY name COLLATE NOCASE");
  const expenses = await listExpenses(env, ctx || (await loadContext(env)));
  const grouped = byVendor(expenses);
  return vendors.map((v) => ({ ...v, ...totalsOf(grouped.get(fold(v.name)) || []) }));
}

async function vendorDetail(env, id) {
  const vendor = await first(env, "SELECT * FROM vendors WHERE id = ?", id);
  if (!vendor) return null;
  const expenses = await listExpenses(env, await loadContext(env));
  const byId = new Map(expenses.map((e) => [e.id, e]));
  const own = byVendor(expenses).get(fold(vendor.name)) || [];
  const mine = own.map((e) => ({
    id: e.id,
    parent_id: e.parent_id,
    part_of: e.parent_id ? byId.get(e.parent_id)?.item || "" : "",
    category: e.category,
    subcategory: e.subcategory,
    item: e.item,
    status: e.status,
    due_date: e.due_date,
    projected: e.projected,
    paid: e.paid,
    owed: owedNow(e),
  }));
  return { vendor: { ...vendor, ...totalsOf(own) }, expenses: mine, status_labels: STATUS_LABELS };
}

async function nameTaken(env, name, exceptId = 0) {
  return first(env, "SELECT id FROM vendors WHERE name = ? COLLATE NOCASE AND id <> ?", name, exceptId);
}

export async function handleVendors(parts, method, request, env, body) {
  const id = parts[1] && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null;
  if (parts.length === 1 && method === "GET") return json({ vendors: await vendorsWithSpending(env) });

  if (parts.length === 1 && method === "POST") {
    const patch = cleanVendor(await body(request));
    if (!patch.name) throw new Error("Name the vendor.");
    if (await nameTaken(env, patch.name)) throw new Error(`There's already a vendor called ${patch.name}.`);
    patch.updated_at = new Date().toISOString();
    const columns = Object.keys(patch);
    const result = await run(
      env,
      `INSERT INTO vendors (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      ...columns.map((c) => patch[c])
    );
    await markDirty(env);
    return json(await vendorDetail(env, result.meta.last_row_id), 201);
  }

  if (id && method === "GET") {
    const detail = await vendorDetail(env, id);
    return detail ? json(detail) : json({ error: "No such vendor." }, 404);
  }

  if (id && method === "PUT") {
    const vendor = await first(env, "SELECT * FROM vendors WHERE id = ?", id);
    if (!vendor) return json({ error: "No such vendor." }, 404);
    const patch = cleanVendor(await body(request));
    if (patch.name && (await nameTaken(env, patch.name, id))) throw new Error(`There's already a vendor called ${patch.name}.`);
    const columns = Object.keys(patch);
    if (columns.length) {
      await run(
        env,
        `UPDATE vendors SET ${columns.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
        ...columns.map((c) => patch[c]),
        new Date().toISOString(),
        id
      );
    }
    // A rename carries over to every expense that named the vendor.
    if (patch.name && patch.name !== vendor.name) {
      await run(env, "UPDATE expenses SET vendor = ?, updated_at = datetime('now') WHERE lower(trim(vendor)) = lower(?)", patch.name, vendor.name.trim());
    }
    await markDirty(env);
    return json(await vendorDetail(env, id));
  }

  if (id && method === "DELETE") {
    const vendor = await first(env, "SELECT * FROM vendors WHERE id = ?", id);
    if (!vendor) return json({ error: "No such vendor." }, 404);
    const used = await first(env, "SELECT COUNT(*) AS n FROM expenses WHERE lower(trim(vendor)) = lower(?)", vendor.name.trim());
    if (used.n) throw new Error(`${used.n} expense${used.n === 1 ? "" : "s"} name ${vendor.name}. Change or remove ${used.n === 1 ? "it" : "them"} first.`);
    await run(env, "DELETE FROM ros_links WHERE kind = 'vendor' AND ref_id = ?", id);
    await run(env, "DELETE FROM vendors WHERE id = ?", id);
    await markDirty(env);
    return json({ ok: true });
  }

  return json({ error: "Not found." }, 404);
}
