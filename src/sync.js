/**
 * Google Drive sync: writes the whole database out as CSV files in the chosen folder.
 *
 *   guests.csv           one row per guest, with household address, contact details,
 *                        save-the-date/invite/gift/thank-you tracking and RSVP answers
 *   expenses.csv         one row per expense with its computed totals
 *   payments.csv         every payment
 *   price_history.csv    every status/price change
 *   planning_numbers.csv guest counts, the drinks calculator, and settings
 *
 * Runs from the cron (every five minutes, only when something changed since the last
 * successful sync) and from the control panel's "Sync now" button. A sync always
 * rewrites every file, so the Drive copies never drift from each other.
 */

import { getSetting, setSetting, all } from "./db.js";
import { driveStatus, requireFolder, upsertFile } from "./google.js";
import { listExpenses, loadContext } from "./store.js";
import { STATUS_LABELS } from "./calc.js";

export function toCsv(header, rows) {
  const cell = (value) => {
    if (value === null || value === undefined) return "";
    let text = String(value);
    // Keep spreadsheet apps from executing a cell as a formula (CSV injection).
    if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [header.map(cell).join(",")];
  for (const row of rows) lines.push(header.map((h) => cell(row[h])).join(","));
  // BOM so Excel opens accented names as UTF-8.
  return `﻿${lines.join("\r\n")}\r\n`;
}

const yesNo = (v) => (v ? "yes" : "");

export async function buildExports(env) {
  const ctx = await loadContext(env);
  const guests = await all(
    env,
    `SELECT g.*, h.code AS household_code, h.display_name, h.greeting, h.address1, h.address2, h.city, h.state,
            h.zip, h.country, h.email, h.phone, h.save_the_date_sent, h.invite_sent, h.gift, h.gift_received,
            h.thank_you_sent, h.rsvp_message, h.rsvp_at, h.notes AS household_notes
       FROM guests g JOIN households h ON h.id = g.household_id
      ORDER BY h.id, g.sort_order, g.id`
  );
  const guestRows = guests.map((g) => ({
    household: g.household_code || g.household_id,
    first_name: g.first_name,
    last_name: g.last_name,
    side: g.side,
    priority: g.priority,
    wedding_party: yesNo(g.wedding_party),
    immediate_family: yesNo(g.immediate_family),
    extended_family: yesNo(g.extended_family),
    invite_type: g.invite_type,
    rsvp: g.rsvp,
    dietary: g.dietary,
    plus_one_allowed: yesNo(g.plus_one_allowed),
    plus_one_name: g.plus_one_name,
    plus_one_rsvp: g.plus_one_allowed ? g.plus_one_rsvp : "",
    plus_one_dietary: g.plus_one_dietary,
    table: g.table_name,
    guest_notes: g.notes,
    mailing_name: g.display_name,
    greeting: g.greeting,
    address1: g.address1,
    address2: g.address2,
    city: g.city,
    state: g.state,
    zip: g.zip,
    country: g.country,
    email: g.email,
    phone: g.phone,
    save_the_date_sent: yesNo(g.save_the_date_sent),
    invite_sent: yesNo(g.invite_sent),
    gift: g.gift,
    gift_received: yesNo(g.gift_received),
    thank_you_sent: yesNo(g.thank_you_sent),
    rsvp_message: g.rsvp_message,
    rsvp_at: g.rsvp_at,
    household_notes: g.household_notes,
  }));

  const expenses = await listExpenses(env, ctx);
  const expenseRows = expenses.map((e) => ({
    id: e.id,
    category: e.category,
    subcategory: e.subcategory,
    item: e.item,
    vendor: e.vendor,
    status: STATUS_LABELS[e.status] || e.status,
    pricing: e.pricing,
    unit_cost: e.unit_cost,
    quantity: e.quantity,
    quantity_source: e.pricing === "variable" ? e.quantity_source : "",
    subtotal: e.subtotal,
    tax: e.tax,
    gratuity: e.gratuity,
    current_total: e.current,
    original_estimate: e.estimate,
    projected: e.projected,
    paid: e.paid,
    owed: e.owed,
    due_date: e.due_date,
    due_amount: e.due_amount,
    payer: e.payer,
    notes: e.notes,
  }));

  const payments = await all(
    env,
    `SELECT p.*, e.item, e.category FROM payments p JOIN expenses e ON e.id = p.expense_id ORDER BY p.paid_on, p.id`
  );
  const attachments = await all(env, "SELECT payment_id, web_link FROM attachments WHERE payment_id IS NOT NULL");
  const receiptFor = new Map(attachments.map((a) => [a.payment_id, a.web_link]));
  const paymentRows = payments.map((p) => ({ ...p, receipt: receiptFor.get(p.id) || "" }));

  const history = await all(
    env,
    `SELECT h.*, e.item, e.category FROM expense_history h JOIN expenses e ON e.id = h.expense_id ORDER BY h.at, h.id`
  );

  const s = ctx.settings;
  const numbers = [
    ["Guest basis for costs", ctx.basis],
    ["Guests used for costs", ctx.basisCount],
    ["Total invited", ctx.counts.invited],
    ["Weighted invites", ctx.counts.weighted],
    ["Confirmed (RSVP yes)", ctx.counts.confirmed],
    ["Declined", ctx.counts.declined],
    ["Awaiting RSVP", ctx.counts.pending],
    ["Households", ctx.counts.households],
    ["Tax rate", s.tax_rate],
    ...Object.entries(s.priority_weights).map(([k, v]) => [`${k} priority weight`, v]),
    ...Object.entries(s.drinks).map(([k, v]) => [`Drinks setting: ${k}`, v]),
    ...Object.entries(ctx.drinks).map(([k, v]) => [`Drinks result: ${k}`, v]),
  ].map(([name, value]) => ({ name, value }));

  return {
    "guests.csv": toCsv(Object.keys(guestRows[0] || { household: "" }), guestRows),
    "expenses.csv": toCsv(Object.keys(expenseRows[0] || { id: "" }), expenseRows),
    "payments.csv": toCsv(
      ["id", "paid_on", "category", "item", "amount", "payer", "method", "note", "receipt", "created_by", "created_at"],
      paymentRows
    ),
    "price_history.csv": toCsv(
      ["at", "category", "item", "status", "total", "unit_cost", "quantity", "note", "changed_by"],
      history
    ),
    "planning_numbers.csv": toCsv(["name", "value"], numbers),
  };
}

/** Upload every export. Records the outcome in _sync_last either way. */
export async function syncToDrive(env) {
  const startedAt = new Date().toISOString();
  const previous = (await getSetting(env, "_sync_last")) || {};
  try {
    const folder = await requireFolder(env);
    const files = await buildExports(env);
    for (const [name, content] of Object.entries(files)) {
      await upsertFile(env, folder.id, name, content, "text/csv");
    }
    const result = { ...previous, ok_at: startedAt, error: null, error_at: null, files: Object.keys(files) };
    await setSetting(env, "_sync_last", result);
    return result;
  } catch (error) {
    const result = { ...previous, error: error.message, error_at: startedAt };
    await setSetting(env, "_sync_last", result);
    throw error;
  }
}

/** Cron entry: sync only if connected, a folder is chosen, and something changed. */
export async function scheduledSync(env) {
  const status = await driveStatus(env);
  if (!status.connected || !status.folder?.id || !status.pending_changes) return { skipped: true };
  return syncToDrive(env);
}
