/**
 * One-time import of the original planning spreadsheet (Wedding_Data.xlsx), uploaded
 * through the control panel. The repo is public, so guest names and addresses never
 * live in it: they go straight from the uploaded file into D1.
 *
 * What comes across:
 *   Guest List  households (grouped by "Household ID"; the row marked as the new
 *               household carries the mailing name and address) and their guests,
 *               with side, priority, wedding party and family flags. Everyone is
 *               invited to the reception; an "x" in the Ceremony column adds the
 *               ceremony.
 *               Plus-one placeholder rows ("Guest" / "Guest Conor Smith") become a
 *               plus-one allowance on their host, with no name -- the guest types it
 *               in when they RSVP. "Round 2 Invites" and "Decor" are deliberately ignored.
 *   Data        every budget line. A quantity that pointed at the Constants tab
 *               becomes a variable quantity on the matching source (wine bottles,
 *               non-alcoholic drinks, invite count, weighted count); everything else
 *               is fixed. A typed-in Total Cost (no formula) becomes a fixed lump sum.
 *               An Actual Cost becomes a payment and marks the item Paid.
 *   Constants   priority weights and the drinks-calculator inputs.
 *
 * Rows are written with multi-row INSERTs built from escaped literals: D1 on the
 * Workers Free plan allows 50 queries per request and 100 bound parameters per query,
 * and one statement per row would blow through that on a 150-guest list.
 */

import { readWorkbook, sheetRows } from "./xlsx.js";
import { all, run, setSetting, markDirty } from "./db.js";
import { expenseTotals } from "./calc.js";
import { loadContext, loadSettings } from "./store.js";

/** A SQL literal. Strings are quoted with '' escaping; NULs stripped; non-finite numbers become NULL. */
export function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replace(/\u0000/g, "").replace(/'/g, "''")}'`;
}

function insertMany(table, columns, rows) {
  if (!rows.length) return null;
  const values = rows.map((row) => `(${columns.map((c) => sqlValue(row[c])).join(", ")})`).join(",\n");
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES\n${values}`;
}

const text = (cell) => {
  if (!cell || cell.v === null || cell.v === undefined) return "";
  return String(cell.v).replace(/\s+/g, " ").trim();
};
const number = (cell) => (cell && typeof cell.v === "number" && Number.isFinite(cell.v) ? cell.v : null);
const flag = (cell) => {
  if (!cell) return 0;
  if (typeof cell.v === "number") return cell.v ? 1 : 0;
  return /^(x|1|y|yes|true)$/i.test(text(cell)) ? 1 : 0;
};

const CATEGORY_FIXES = { "Ceremony & Recption": "Ceremony & Reception" };

/** Which Constants cell a quantity formula pointed at -> the matching quantity source. */
const CONSTANT_SOURCES = {
  F43: "drinks:wine_bottles",
  F44: "drinks:red_bottles",
  F45: "drinks:white_bottles",
  C40: "drinks:total",
  E47: "drinks:beer_drinks",
  F49: "drinks:liquor_bottles",
  C55: "drinks:nonalc_drinks",
  C5: "invited",
  C22: "guests",
  C33: "guests",
};

export function parseGuests(sheet) {
  const rows = sheetRows(sheet);
  if (!rows.length) return { households: [], guests: [] };
  const [, header] = rows[0];
  const col = Object.create(null);
  for (const [letter, cell] of Object.entries(header)) col[text(cell).toLowerCase()] = letter;
  const get = (row, name) => (col[name] ? row[col[name]] : undefined);

  const households = new Map();
  const guests = [];
  let order = 0;
  for (const [, row] of rows.slice(1)) {
    const firstName = text(get(row, "first"));
    const lastName = text(get(row, "last"));
    if (!firstName && !lastName) continue;
    const code = text(get(row, "household id")) || `H-${String(households.size + 1).padStart(3, "0")}`;
    if (!households.has(code)) households.set(code, { code });
    const household = households.get(code);
    const display = text(get(row, "full name(s)"));
    if (display && !household.display_name) {
      let zip = get(row, "zip");
      let zipText = text(zip);
      const country = text(get(row, "country"));
      if (typeof zip?.v === "number") {
        zipText = String(Math.round(zip.v));
        if (!country && zipText.length < 5) zipText = zipText.padStart(5, "0");
      }
      Object.assign(household, {
        display_name: display,
        greeting: text(get(row, "first name(s)")),
        address1: text(get(row, "address 1")),
        address2: [text(get(row, "address 2")), text(get(row, "column 2")), text(get(row, "column 3"))]
          .filter(Boolean)
          .join(", "),
        city: text(get(row, "city")),
        state: text(get(row, "state")),
        zip: zipText,
        country,
      });
    }
    const side = text(get(row, "bride/groom"));
    const priority = text(get(row, "priority"));
    guests.push({
      household_code: code,
      first_name: firstName,
      last_name: lastName,
      side: ["Bride", "Groom"].includes(side) ? side : null,
      priority: ["High", "Medium", "Low"].includes(priority) ? priority : "High",
      wedding_party: flag(get(row, "wedding party?")),
      immediate_family: flag(get(row, "immediate family")),
      extended_family: flag(get(row, "extended")),
      invite_ceremony: flag(get(row, "ceremony")),
      invite_reception: 1,
      plus_one_allowed: 0,
      sort_order: order++,
    });
  }
  // Fold plus-one placeholder rows into their host (see the module docstring).
  const isPlaceholder = (g) => /^guest$/i.test(g.first_name) && /^guest\b/i.test(g.last_name);
  const nameKey = (text) => text.toLowerCase().replace(/\s+/g, " ").trim();
  for (const placeholder of guests.filter(isPlaceholder)) {
    const family = guests.filter((g) => g.household_code === placeholder.household_code && !isPlaceholder(g));
    const named = nameKey(placeholder.last_name.replace(/^guest\s*/i, ""));
    const host = family.find((g) => nameKey(`${g.first_name} ${g.last_name}`) === named) || family[0];
    if (!host) continue;
    host.plus_one_allowed = 1;
    guests.splice(guests.indexOf(placeholder), 1);
  }

  for (const household of households.values()) {
    if (!household.display_name) {
      const members = guests.filter((g) => g.household_code === household.code);
      household.display_name = members.map((g) => `${g.first_name} ${g.last_name}`.trim()).join(" and ");
      household.greeting = members.map((g) => g.first_name).join(" and ");
    }
  }
  return { households: [...households.values()], guests };
}

/** A cell's value, following a plain "=Constants!C59" reference when nothing is cached. */
function resolved(cell, constants) {
  if (cell && cell.v === null && cell.f && constants) {
    const m = /^Constants!\$?([A-Z]+)\$?(\d+)$/.exec(String(cell.f).trim());
    if (m) return constants.get(`${m[1]}${m[2]}`) || cell;
  }
  return cell;
}

export function parseBudget(sheet, constants = null) {
  const expenses = [];
  let order = 0;
  for (const [rowNumber, row] of sheetRows(sheet)) {
    if (rowNumber < 3) continue;
    const item = text(row.C);
    if (!item) continue;
    const category = text(row.A);
    const expense = {
      category: CATEGORY_FIXES[category] || category,
      subcategory: text(row.B),
      item,
      status: "estimate",
      pricing: "fixed",
      unit_cost: number(resolved(row.D, constants)),
      units: 1,
      quantity_source: "guests",
      quantity_factor: 1,
      gratuity_rate: number(row.G) || 0,
      sort_order: order++,
      actual: number(row.J),
    };
    const unitsFormula = row.E?.f ? String(row.E.f) : "";
    const constant = /^Constants!\$?([A-Z]+)\$?(\d+)$/.exec(unitsFormula.trim());
    const source = constant ? CONSTANT_SOURCES[`${constant[1]}${constant[2]}`] : null;
    if (source) {
      expense.pricing = "variable";
      expense.quantity_source = source;
    } else if (number(row.E) != null) {
      expense.units = number(row.E);
    }
    // A typed-in total (no formula) overrides the unit math: keep it as a lump sum.
    const total = row.I;
    if (total && !total.f && number(total) != null) {
      Object.assign(expense, { pricing: "fixed", unit_cost: number(total), units: 1, gratuity_rate: 0 });
    }
    if (expense.unit_cost === 0) expense.unit_cost = null;
    if (expense.actual && expense.actual > 0) expense.status = "paid";
    expenses.push(expense);
  }
  return expenses;
}

export function parseConstants(sheet, current) {
  const at = (ref) => number(sheet.get(ref));
  const weights = { ...current.priority_weights };
  for (const [ref, key] of [["C18", "High"], ["C19", "Medium"], ["C20", "Low"]]) {
    if (at(ref) != null) weights[key] = at(ref);
  }
  const drinks = { ...current.drinks };
  const map = {
    C26: "drinks_per_wine_bottle",
    C27: "drinks_per_liquor_bottle",
    C28: "ounces_per_beer",
    C35: "hours",
    C37: "first_hour_drinks",
    C38: "later_hour_drinks",
    C43: "wine_share",
    C44: "red_share",
    C45: "white_share",
    C47: "beer_share",
    C49: "liquor_share",
    C53: "nonalc_per_guest_hour",
  };
  for (const [ref, key] of Object.entries(map)) if (at(ref) != null) drinks[key] = at(ref);
  return { priority_weights: weights, drinks };
}

/**
 * Import the workbook. `parts` picks which of guests / budget / constants to bring in;
 * each part chosen REPLACES what's there for that part.
 */
export async function importWorkbook(env, buffer, parts, by) {
  const sheets = await readWorkbook(buffer);
  const summary = {};

  if (parts.constants) {
    const sheet = sheets.get("Constants");
    if (!sheet) throw new Error('No "Constants" tab in that workbook.');
    const current = await loadSettings(env);
    const parsed = parseConstants(sheet, current);
    await setSetting(env, "priority_weights", parsed.priority_weights);
    await setSetting(env, "drinks", parsed.drinks);
    summary.constants = parsed;
  }

  if (parts.guests) {
    const sheet = sheets.get("Guest List");
    if (!sheet) throw new Error('No "Guest List" tab in that workbook.');
    const { households, guests } = parseGuests(sheet);
    await run(env, "DELETE FROM guests");
    await run(env, "DELETE FROM households");
    const householdSql = insertMany(
      "households",
      ["code", "display_name", "greeting", "address1", "address2", "city", "state", "zip", "country"],
      households
    );
    if (householdSql) await run(env, householdSql);
    const ids = new Map((await all(env, "SELECT id, code FROM households")).map((h) => [h.code, h.id]));
    const guestRows = guests.map((g) => ({ ...g, household_id: ids.get(g.household_code) }));
    const guestSql = insertMany(
      "guests",
      [
        "household_id",
        "first_name",
        "last_name",
        "side",
        "priority",
        "wedding_party",
        "immediate_family",
        "extended_family",
        "invite_ceremony",
        "invite_reception",
        "plus_one_allowed",
        "sort_order",
      ],
      guestRows
    );
    if (guestSql) await run(env, guestSql);
    summary.households = households.length;
    summary.guests = guests.length;
  }

  if (parts.budget) {
    const sheet = sheets.get("Data");
    if (!sheet) throw new Error('No "Data" tab in that workbook.');
    const expenses = parseBudget(sheet, sheets.get("Constants"));
    for (const table of ["attachments", "payments", "expense_history", "expenses"]) await run(env, `DELETE FROM ${table}`);
    const columns = [
      "category",
      "subcategory",
      "item",
      "status",
      "pricing",
      "unit_cost",
      "units",
      "quantity_source",
      "quantity_factor",
      "gratuity_rate",
      "sort_order",
      "source",
    ];
    const rows = expenses.map((e) => ({ ...e, source: "spreadsheet-import" }));
    const sql = insertMany("expenses", columns, rows);
    if (sql) await run(env, sql);
    const saved = await all(env, "SELECT id, sort_order FROM expenses");
    const idByOrder = new Map(saved.map((e) => [e.sort_order, e.id]));
    // History starts with one "Imported" row per item; actual costs become payments.
    const ctx = await loadContext(env);
    const history = rows.map((e) => ({
      expense_id: idByOrder.get(e.sort_order),
      status: e.status,
      total: expenseTotals(e, ctx).total,
      unit_cost: e.unit_cost,
      note: "Imported from spreadsheet",
      changed_by: by,
    }));
    const historySql = insertMany("expense_history", ["expense_id", "status", "total", "unit_cost", "note", "changed_by"], history);
    if (historySql) await run(env, historySql);
    const payments = rows
      .filter((e) => e.actual > 0)
      .map((e) => ({
        expense_id: idByOrder.get(e.sort_order),
        paid_on: null,
        amount: e.actual,
        note: "Actual cost from spreadsheet",
        created_by: by,
      }));
    const paymentSql = insertMany("payments", ["expense_id", "paid_on", "amount", "note", "created_by"], payments);
    if (paymentSql) await run(env, paymentSql);
    summary.expenses = expenses.length;
    summary.payments = payments.length;
  }

  await markDirty(env);
  return summary;
}
