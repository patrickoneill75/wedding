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
  mergeSettings,
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
  const guests = await all(env, "SELECT household_id, priority, side, rsvp, plus_one_allowed, plus_one_rsvp FROM guests");
  return buildContext(settings, guests);
}

async function paidByExpense(env) {
  const rows = await all(env, "SELECT expense_id, SUM(amount) AS paid FROM payments GROUP BY expense_id");
  return new Map(rows.map((r) => [r.expense_id, r.paid || 0]));
}

export async function listExpenses(env, ctx) {
  const expenses = await all(env, "SELECT * FROM expenses ORDER BY category, subcategory, sort_order, id");
  const paid = await paidByExpense(env);
  return expenses.map((e) => enrichExpense(e, paid.get(e.id) || 0, ctx));
}

export async function getExpense(env, id, ctx) {
  const expense = await first(env, "SELECT * FROM expenses WHERE id = ?", id);
  if (!expense) return null;
  const paid = await first(env, "SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE expense_id = ?", id);
  return enrichExpense(expense, paid.paid, ctx);
}

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
  const columns = Object.keys(patch);
  const result = await run(
    env,
    `INSERT INTO expenses (${[...columns, "source"].join(", ")}) VALUES (${[...columns, "source"].map(() => "?").join(", ")})`,
    ...columns.map((c) => patch[c]),
    source
  );
  const id = result.meta.last_row_id;
  const expense = await first(env, "SELECT * FROM expenses WHERE id = ?", id);
  await recordHistory(env, expense, ctx, input.history_note || "Created", by);
  await markDirty(env);
  return id;
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
  if (before.status === "estimate" && after.status !== "estimate" && before.baseline_total == null) {
    patch.baseline_total = expenseTotals(before, ctx).total;
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
  await markDirty(env);
  return updated;
}

/** Record a payment, then move the expense forward to Partially paid / Paid if it's due. */
export async function addPayment(env, expenseId, input, ctx, by) {
  const expense = await first(env, "SELECT * FROM expenses WHERE id = ?", expenseId);
  if (!expense) throw new Error("That expense no longer exists.");
  const amount = toNumberOrNull(input.amount);
  if (amount == null || amount <= 0) throw new Error("Payment amount must be more than zero.");
  const paidOn = toText(input.paid_on) || new Date().toISOString().slice(0, 10);
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
