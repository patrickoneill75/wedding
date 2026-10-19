/**
 * Reads and writes shared by the control panel API and the public forms: loading the
 * calculation context, enriched expense lists, and the expense/payment writes that
 * must also record price history and advance status.
 */

import {
  STATUSES,
  QUANTITY_SOURCES,
  buildContext,
  enrichExpense,
  expenseTotals,
  localToday,
  mergeSettings,
  rollupPurchases,
  statusAfterPayment,
  PUBLIC_SETTING_KEYS,
} from "./calc.js";
import { all, first, run, markDirty, updateClause } from "./db.js";

export const EXPENSE_COLUMNS = [
  "category",
  "subcategory",
  "item",
  "vendor",
  "status",
  "pricing",
  "unit_cost",
  "units",
  "quantity_source",
  "quantity_factor",
  "round_up",
  "taxable",
  "gratuity_rate",
  "due_date",
  "due_amount",
  "payer",
  "notes",
  "sort_order",
];

export async function loadSettings(env) {
  const rows = await all(env, "SELECT key, value FROM settings WHERE key NOT LIKE '\\_%' ESCAPE '\\'");
  const stored = Object.create(null);
  for (const row of rows) {
    if (!PUBLIC_SETTING_KEYS.includes(row.key)) continue;
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      /* ignore a corrupt row; the default applies */
    }
  }
  return mergeSettings(stored);
}

export async function loadContext(env) {
  const settings = await loadSettings(env);
  const guests = await all(env, "SELECT household_id, priority, side, rsvp, plus_one_allowed, plus_one_rsvp, invite_ceremony, invite_reception FROM guests");
  return buildContext(settings, guests);
}

async function paidByExpense(env) {
  const rows = await all(env, "SELECT expense_id, SUM(amount) AS paid FROM payments GROUP BY expense_id");
  return new Map(rows.map((r) => [r.expense_id, r.paid || 0]));
}

export async function listExpenses(env, ctx) {
  const expenses = await all(env, "SELECT * FROM expenses ORDER BY category, subcategory, sort_order, id");
  const paid = await paidByExpense(env);
  return rollupPurchases(expenses.map((e) => enrichExpense(e, paid.get(e.id) || 0, ctx)));
}

/** One expense with its purchases rolled up; purchases come back alongside it. */
export async function getExpense(env, id, ctx) {
  const rows = await all(env, "SELECT * FROM expenses WHERE id = ? OR parent_id = ? ORDER BY sort_order, id", id, id);
  if (!rows.some((r) => r.id === id)) return null;
  const paidRows = await all(
    env,
    `SELECT expense_id, SUM(amount) AS paid FROM payments WHERE expense_id IN (${rows.map(() => "?").join(",")}) GROUP BY expense_id`,
    ...rows.map((r) => r.id)
  );
  const paid = new Map(paidRows.map((r) => [r.expense_id, r.paid || 0]));
  const rolled = rollupPurchases(rows.map((e) => enrichExpense(e, paid.get(e.id) || 0, ctx)));
  const expense = rolled.find((e) => e.id === id);
  expense.purchase_list = rolled.filter((e) => e.parent_id === id);
  return expense;
}

export async function listVendors(env) {
  return (await all(env, "SELECT name FROM vendors ORDER BY name COLLATE NOCASE")).map((v) => v.name);
}

/** Every vendor name used anywhere is remembered for the pick lists. */
async function rememberVendor(env, name) {
  const clean = String(name || "").trim();
  if (clean) await run(env, "INSERT OR IGNORE INTO vendors (name) VALUES (?)", clean.slice(0, 200));
}

/**
 * Saving something as Paid means it's been paid for: record a payment for whatever is
 * still owed, so it lands in the Paid column. An item with purchases is the exception:
 * Paid there means "done buying", and its purchases carry their own payments.
 */
async function settleIfPaid(env, id, ctx, by, details = {}) {
  const expense = await getExpense(env, id, ctx);
  if (!expense || expense.status !== "paid" || expense.purchases) return;
  // Not expense.owed: at Paid, projected cost is taken to be what was paid, so owed
  // reads zero. The price is what was due.
  const remaining = Math.round((expense.current - expense.paid) * 100) / 100;
  if (!(remaining > 0.004)) return;
  const paidOn = toText(details.paid_on);
  await run(
    env,
    "INSERT INTO payments (expense_id, paid_on, amount, payer, method, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id,
    paidOn && /^\d{4}-\d{2}-\d{2}$/.test(paidOn) ? paidOn : localToday(ctx.settings.time_zone),
    remaining,
    toText(details.payer) || expense.payer || null,
    toText(details.method),
    "Recorded when marked Paid",
    by || null
  );
}

const isPriced = (e) => e.unit_cost != null && Number(e.unit_cost) !== 0;

const toNumberOrNull = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${v}" isn't a number.`);
  return n;
};
const toBool = (v) => (v === true || v === 1 || v === "1" || v === "true" || v === "on" ? 1 : 0);
const toText = (v) => (v === null || v === undefined ? null : String(v).trim().slice(0, 2000));

/** Validate and normalize an expense patch from a request body. Throws on bad input. */
export function cleanExpensePatch(input, { creating = false } = {}) {
  const patch = Object.create(null);
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  for (const key of ["category", "subcategory", "item", "vendor", "payer", "notes"]) {
    if (has(key)) patch[key] = toText(input[key]) ?? (["category", "subcategory", "item"].includes(key) ? "" : null);
  }
  if (has("status")) {
    if (!STATUSES.includes(input.status)) throw new Error(`Unknown status "${input.status}".`);
    patch.status = input.status;
  }
  if (has("pricing")) {
    if (!["fixed", "variable"].includes(input.pricing)) throw new Error('Pricing must be "fixed" or "variable".');
    patch.pricing = input.pricing;
  }
  if (has("quantity_source")) {
    if (!Object.prototype.hasOwnProperty.call(QUANTITY_SOURCES, input.quantity_source)) {
      throw new Error(`Unknown quantity source "${input.quantity_source}".`);
    }
    patch.quantity_source = input.quantity_source;
  }
  for (const key of ["unit_cost", "due_amount"]) if (has(key)) patch[key] = toNumberOrNull(input[key]);
  for (const key of ["units", "quantity_factor", "gratuity_rate", "sort_order"]) {
    if (has(key)) {
      const n = toNumberOrNull(input[key]);
      patch[key] = n ?? (key === "units" || key === "quantity_factor" ? 1 : 0);
    }
  }
  if (has("gratuity_rate") && (patch.gratuity_rate < 0 || patch.gratuity_rate > 1)) {
    throw new Error("Gratuity is a fraction between 0 and 1 (20% is 0.2).");
  }
  for (const key of ["round_up", "taxable"]) if (has(key)) patch[key] = toBool(input[key]);
  if (has("due_date")) {
    const d = toText(input.due_date);
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error("Due date must be YYYY-MM-DD.");
    patch.due_date = d || null;
  }
  if (creating && !patch.item) throw new Error("Give the expense a name.");
  return patch;
}

async function recordHistory(env, expense, ctx, note, by) {
  const totals = expenseTotals(expense, ctx);
  await run(
    env,
    "INSERT INTO expense_history (expense_id, status, total, unit_cost, quantity, note, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
    expense.id,
    expense.status,
    totals.total,
    expense.unit_cost,
    totals.quantity,
    note || null,
    by || null
  );
}

export async function createExpense(env, input, ctx, by, source = "control-panel") {
  const patch = cleanExpensePatch(input, { creating: true });
  const parentId = input.parent_id == null || input.parent_id === "" ? null : Number(input.parent_id);
  if (parentId !== null) {
    const parent = await first(env, "SELECT id, parent_id, category, subcategory FROM expenses WHERE id = ?", parentId);
    if (!parent) throw new Error("The item this line item belongs to no longer exists.");
    if (parent.parent_id) throw new Error("A line item can't have line items of its own.");
    await splitIntoLineItems(env, parent.id, by);
    // A line item files under its item.
    patch.parent_id = parent.id;
    patch.category = parent.category;
    patch.subcategory = parent.subcategory;
  }
  const columns = Object.keys(patch);
  const result = await run(
    env,
    `INSERT INTO expenses (${[...columns, "source"].join(", ")}) VALUES (${[...columns, "source"].map(() => "?").join(", ")})`,
    ...columns.map((c) => patch[c]),
    source
  );
  const id = result.meta.last_row_id;
  let expense = await first(env, "SELECT * FROM expenses WHERE id = ?", id);
  // Created past Estimate with a price: that price is the original estimate.
  if (expense.status !== "estimate" && expense.status !== "cancelled" && isPriced(expense)) {
    await run(env, "UPDATE expenses SET baseline_total = ? WHERE id = ?", expenseTotals(expense, ctx).total, id);
    expense = { ...expense, baseline_total: expenseTotals(expense, ctx).total };
  }
  await recordHistory(env, expense, ctx, input.history_note || "Created", by);
  await rememberVendor(env, patch.vendor);
  await settleIfPaid(env, id, ctx, by, input);
  await markDirty(env);
  return id;
}

/**
 * Before an item gets its first line item, move what it already has -- its price,
 * vendor, stage, due date, payments, receipts -- into a line item of its own (named
 * after the item), so the item is left as a container that only adds up its line
 * items. An item with no price, no vendor and nothing paid has nothing to move.
 */
async function splitIntoLineItems(env, id, by) {
  const item = await first(env, "SELECT * FROM expenses WHERE id = ?", id);
  if (await first(env, "SELECT id FROM expenses WHERE parent_id = ? LIMIT 1", id)) return;
  const paid = await first(env, "SELECT COUNT(*) AS n FROM payments WHERE expense_id = ?", id);
  const booked = !["estimate", "cancelled"].includes(item.status);
  const priced = item.unit_cost != null && Number(item.unit_cost) !== 0;
  if (!booked && !priced && !paid.n && !item.vendor && !item.due_date) return;
  const copy = [
    "category", "subcategory", "item", "vendor", "status", "pricing", "unit_cost", "units", "quantity_source",
    "quantity_factor", "round_up", "taxable", "gratuity_rate", "due_date", "due_amount", "payer", "baseline_total",
  ];
  const result = await run(
    env,
    `INSERT INTO expenses (parent_id, ${copy.join(", ")}, source) SELECT id, ${copy.join(", ")}, 'split' FROM expenses WHERE id = ?`,
    id
  );
  const lineId = result.meta.last_row_id;
  await run(env, "UPDATE payments SET expense_id = ? WHERE expense_id = ?", lineId, id);
  await run(env, "UPDATE attachments SET expense_id = ? WHERE expense_id = ?", lineId, id);
  await run(
    env,
    `UPDATE expenses SET status = 'estimate', baseline_total = NULL, unit_cost = NULL, units = 1, pricing = 'fixed', taxable = 0,
       gratuity_rate = 0, vendor = NULL, due_date = NULL, due_amount = NULL, payer = NULL, updated_at = datetime('now') WHERE id = ?`,
    id
  );
  await run(
    env,
    "INSERT INTO expense_history (expense_id, status, total, note, changed_by) VALUES (?, ?, NULL, ?, ?)",
    lineId,
    item.status,
    "Moved here from the item when it was split into line items",
    by || null
  );
}

/**
 * Apply a patch, freezing the original estimate when the item first leaves the
 * Estimate stage, and log a history row when the status or total changed.
 */
export async function updateExpense(env, id, input, ctx, by) {
  const before = await first(env, "SELECT * FROM expenses WHERE id = ?", id);
  if (!before) return null;
  const patch = cleanExpensePatch(input);
  const after = { ...before, ...patch };
  // The original estimate freezes when the item leaves Estimate, or, for an item that
  // had no price then, when it first gets one. An unpriced item never freezes $0.
  if (after.status !== "estimate" && after.status !== "cancelled" && before.baseline_total == null) {
    if (before.status === "estimate" && isPriced(before)) patch.baseline_total = expenseTotals(before, ctx).total;
    else if (isPriced(after)) patch.baseline_total = expenseTotals(after, ctx).total;
  }
  // Moving an item back to Estimate re-opens its estimate.
  if (after.status === "estimate" && before.status !== "estimate") patch.baseline_total = null;

  const { sql, values } = updateClause(patch, [...EXPENSE_COLUMNS, "baseline_total"]);
  if (sql) {
    await run(env, `UPDATE expenses SET ${sql}, updated_at = datetime('now') WHERE id = ?`, ...values, id);
  }
  const updated = await first(env, "SELECT * FROM expenses WHERE id = ?", id);
  const totalBefore = expenseTotals(before, ctx).total;
  const totalAfter = expenseTotals(updated, ctx).total;
  if (updated.status !== before.status || Math.abs(totalAfter - totalBefore) >= 0.005 || input.history_note) {
    const parts = [];
    if (updated.status !== before.status) parts.push(`Status ${before.status} → ${updated.status}`);
    if (Math.abs(totalAfter - totalBefore) >= 0.005) parts.push(`Total ${totalBefore.toFixed(2)} → ${totalAfter.toFixed(2)}`);
    if (input.history_note) parts.push(String(input.history_note).slice(0, 500));
    await recordHistory(env, updated, ctx, parts.join(". "), by);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "vendor")) await rememberVendor(env, patch.vendor);
  // Line items file under their item's category.
  if (["category", "subcategory"].some((k) => Object.prototype.hasOwnProperty.call(patch, k)) && !updated.parent_id) {
    await run(env, "UPDATE expenses SET category = ?, subcategory = ? WHERE parent_id = ?", updated.category, updated.subcategory, id);
  }
  // Only a move to Paid records the rest as paid: editing an item that's already Paid
  // (after deleting a payment, say) doesn't put a payment back.
  if (before.status !== "paid") await settleIfPaid(env, id, ctx, by, input);
  // Money already paid on it (a deposit) moves a Quote or Booked item on to Partially
  // paid, and an item paid up moves on to Paid, whichever stage it was saved at. An
  // item with line items is left alone.
  if (["estimate", "quote", "booked", "partially_paid"].includes(updated.status) && !(await first(env, "SELECT id FROM expenses WHERE parent_id = ? LIMIT 1", id))) {
    await advanceAfterPayment(env, id, ctx, by, "Has payments already");
  }
  await markDirty(env);
  return await first(env, "SELECT * FROM expenses WHERE id = ?", id);
}

/** Record a payment, then move the expense forward to Partially paid / Paid if it's due. */
export async function addPayment(env, expenseId, input, ctx, by) {
  const expense = await first(env, "SELECT * FROM expenses WHERE id = ?", expenseId);
  if (!expense) throw new Error("That expense no longer exists.");
  if (await first(env, "SELECT id FROM expenses WHERE parent_id = ? LIMIT 1", expenseId)) {
    throw new Error("This item is split into line items. Record the payment on the line item it was for.");
  }
  const amount = toNumberOrNull(input.amount);
  if (amount == null || amount <= 0) throw new Error("Payment amount must be more than zero.");
  const paidOn = toText(input.paid_on) || localToday(ctx.settings.time_zone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) throw new Error("Payment date must be YYYY-MM-DD.");
  const result = await run(
    env,
    "INSERT INTO payments (expense_id, paid_on, amount, payer, method, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
    expenseId,
    paidOn,
    amount,
    toText(input.payer),
    toText(input.method),
    toText(input.note),
    by || null
  );
  // A payment that covers what was due clears the due date, so it stops reading overdue.
  // With no amount set, the due date is for the rest, so it clears once that's paid.
  if (expense.due_date) {
    const due = toNumberOrNull(expense.due_amount);
    const paid = await first(env, "SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE expense_id = ?", expenseId);
    const covered = due != null && due > 0 ? amount + 0.005 >= due : paid.paid + 0.005 >= expenseTotals(expense, ctx).total;
    if (covered) {
      await run(env, "UPDATE expenses SET due_date = NULL, due_amount = NULL, updated_at = datetime('now') WHERE id = ?", expenseId);
    }
  }
  await advanceAfterPayment(env, expenseId, ctx, by, `Payment of ${amount.toFixed(2)}`);
  await markDirty(env);
  return result.meta.last_row_id;
}

export async function deletePayment(env, paymentId) {
  const payment = await first(env, "SELECT * FROM payments WHERE id = ?", paymentId);
  if (!payment) return false;
  await run(env, "DELETE FROM payments WHERE id = ?", paymentId);
  await markDirty(env);
  return true;
}

async function advanceAfterPayment(env, expenseId, ctx, by, note) {
  const expense = await first(env, "SELECT * FROM expenses WHERE id = ?", expenseId);
  const paid = await first(env, "SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE expense_id = ?", expenseId);
  const next = statusAfterPayment(expense, paid.paid, ctx);
  if (next !== expense.status) {
    await updateExpense(env, expenseId, { status: next, history_note: note }, ctx, by);
  }
}
