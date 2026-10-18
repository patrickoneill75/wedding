/**
 * The budget math, kept pure so tests can pin it down without a database.
 *
 * Guest counts (mirrors the spreadsheet's Constants tab):
 *   invited    every guest, plus every plus-one a guest was given
 *   weighted   ROUNDUP(sum of each invitee's priority weight) -- High 0.9, Medium 0.6,
 *              Low 0.4 by default. A plus-one carries their host's weight.
 *   confirmed  guests and plus-ones who RSVP'd yes
 *   households households with at least one guest (one invitation, one stamp)
 *
 * The "guest basis" setting picks which of weighted / confirmed drives every
 * per-guest expense and the drinks calculator. It starts on weighted and flips to
 * confirmed with the control panel's "Convert all to confirmed" button.
 *
 * Expense totals:
 *   fixed     unit_cost x units
 *   variable  unit_cost x quantity, where quantity = source x factor (rounded up when
 *             round_up is set). Sources: the guest basis, total invited, households, or
 *             one of the drinks calculator's outputs.
 *   total     subtotal + tax (settings.tax_rate, when taxable) + gratuity_rate x subtotal
 *
 * Money columns per expense:
 *   current    the total from today's price fields
 *   estimate   the original estimate: live while the item is still an estimate, then
 *              frozen in baseline_total the moment it moves past that stage
 *   projected  what the item will really cost: what was paid once it's Paid, the paid
 *              amount if Cancelled (forfeited deposits), otherwise current
 *   paid       sum of payments
 *   owed       projected - paid, never negative
 *   actual     the real cost once there is one: null while the item is still an
 *              estimate, otherwise projected
 *
 * Line items: an item can have line items under it (parent_id), one level deep --
 * "Place Settings" bought a bit at a time from several vendors. (The code calls them
 * purchases.) Each line item is a full expense of its own: vendor, stage, price,
 * payments. The item above them becomes a container: its own price is the budget for
 * the group, and it holds no vendor, stage or payments of its own (adding the first
 * line item moves those down into one; see splitIntoLineItems in src/store.js).
 * rollupPurchases() then makes the item speak for the group:
 *   budget     the item's own price
 *   spent      what the line items add up to
 *   estimate   the item's own estimate, as for any item (the budget, frozen once it's
 *              marked done)
 *   paid       everything paid, on the line items (and on the item itself, for data
 *              from before items became containers)
 *   actual     the line items' actual costs added up (null until one has one)
 *   projected  the larger of the budget and what's spent, since more may be bought --
 *              until the item is marked done buying (stored as Paid), when it's exactly
 *              what was spent
 *   status     worked out from the line items. Once anything is paid: Partially paid
 *              while a booked line item still owes money (the venue's deposit is in,
 *              the rest is due), In progress while everything bought so far is paid
 *              but more is to come (place settings bought a few at a time), and Paid
 *              once it's done buying and nothing is owed. Before anything is paid, the
 *              furthest stage a line item reached (Booked at most). `done` says
 *              whether it's marked done buying. In progress only ever comes from line
 *              items, so it's a label, not one of the STATUSES an expense is saved at.
 * Totals, the category table and the pie use top-level rows only, so line items are
 * never counted twice; payments due and stages come from the line items themselves.
 */

export const STATUSES = ["estimate", "quote", "booked", "partially_paid", "paid", "cancelled"];
export const STATUS_LABELS = {
  estimate: "Estimate",
  quote: "Quote",
  booked: "Booked",
  in_progress: "In progress",
  partially_paid: "Partially paid",
  paid: "Paid",
  cancelled: "Cancelled",
};
export const PRIORITIES = ["High", "Medium", "Low"];
export const SIDES = ["Bride", "Groom"];
export const RSVP_VALUES = ["pending", "yes", "no"];

export const QUANTITY_SOURCES = {
  guests: "Guest count (weighted or confirmed)",
  invited: "Total invited (people)",
  households: "Households (invitations)",
  "drinks:total": "Drinks: total alcoholic drinks",
  "drinks:wine_bottles": "Drinks: wine bottles",
  "drinks:red_bottles": "Drinks: red wine bottles",
  "drinks:white_bottles": "Drinks: white wine bottles",
  "drinks:beer_drinks": "Drinks: beers",
  "drinks:liquor_bottles": "Drinks: liquor bottles",
  "drinks:nonalc_drinks": "Drinks: non-alcoholic drinks",
};

export const DEFAULT_SETTINGS = {
  couple_names: "",
  wedding_date: "",
  venue: "",
  rsvp_deadline: "",
  rsvp_open: true,
  rsvp_intro: "",
  tax_rate: 0.07,
  guest_basis: "weighted",
  priority_weights: { High: 0.9, Medium: 0.6, Low: 0.4 },
  drinks: {
    hours: 5,
    first_hour_drinks: 2,
    later_hour_drinks: 1,
    wine_share: 0.4,
    red_share: 0.5,
    white_share: 0.5,
    beer_share: 0.6,
    liquor_share: 0,
    drinks_per_wine_bottle: 5,
    drinks_per_liquor_bottle: 15,
    ounces_per_beer: 12,
    nonalc_per_guest_hour: 0.25,
  },
  payers: ["Patrick", "Kaitlyn", "Joint", "Family"],
  payment_methods: ["Credit card", "Check", "Cash", "Venmo", "Zelle", "Bank transfer"],
  budget_target: null,
  // The Zola wedding website copied onto the home page ("" falls back to ZOLA_URL in
  // wrangler.jsonc), and the RSVP button's color there ("" picks one from the theme).
  zola_url: "",
  rsvp_button_color: "",
};

export const PUBLIC_SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

const KEG_OUNCES = { half: 1984, quarter: 992, sixth: 672 };

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const cents = (value) => Math.round(value * 100) / 100;

export function mergeSettings(stored) {
  const merged = { ...DEFAULT_SETTINGS };
  for (const key of PUBLIC_SETTING_KEYS) {
    if (stored && Object.prototype.hasOwnProperty.call(stored, key) && stored[key] !== undefined) {
      merged[key] = stored[key];
    }
  }
  merged.priority_weights = { ...DEFAULT_SETTINGS.priority_weights, ...(merged.priority_weights || {}) };
  merged.drinks = { ...DEFAULT_SETTINGS.drinks, ...(merged.drinks || {}) };
  return merged;
}

export function guestCounts(guests, settings) {
  const weights = settings.priority_weights;
  const weightOf = (priority) => num(weights[priority], num(weights.High, 0.9));
  let invited = 0;
  let weightedSum = 0;
  let confirmed = 0;
  let declined = 0;
  let pending = 0;
  let plusOnesAllowed = 0;
  const households = new Set();
  const bySide = { Bride: 0, Groom: 0 };
  const byPriority = { High: 0, Medium: 0, Low: 0 };
  const invites = { ceremony: 0, reception: 0 };
  // Invitees (plus-ones included, at their host's priority) -- what the weights multiply.
  const inviteesByPriority = { High: 0, Medium: 0, Low: 0 };

  const tally = (rsvp) => {
    if (rsvp === "yes") confirmed++;
    else if (rsvp === "no") declined++;
    else pending++;
  };

  for (const guest of guests) {
    households.add(guest.household_id);
    invited++;
    weightedSum += weightOf(guest.priority);
    if (guest.side in bySide) bySide[guest.side]++;
    if (guest.priority in byPriority) byPriority[guest.priority]++;
    if (guest.invite_ceremony) invites.ceremony++;
    if (guest.invite_reception) invites.reception++;
    tally(guest.rsvp);
    const weightKey = guest.priority in inviteesByPriority ? guest.priority : "High";
    inviteesByPriority[weightKey] += guest.plus_one_allowed ? 2 : 1;
    if (guest.plus_one_allowed) {
      plusOnesAllowed++;
      invited++;
      weightedSum += weightOf(guest.priority);
      tally(guest.plus_one_rsvp);
    }
  }

  // ROUNDUP, as the spreadsheet does; the epsilon keeps 123.0000000001 at 123.
  const weighted = Math.ceil(weightedSum - 1e-9);
  return {
    invited,
    weighted,
    confirmed,
    declined,
    pending,
    plus_ones_allowed: plusOnesAllowed,
    households: households.size,
    by_side: bySide,
    by_priority: byPriority,
    invites,
    invitees_by_priority: inviteesByPriority,
  };
}

/** The spreadsheet's drinks calculator, for a given number of guests. */
export function drinksPlan(params, guestCount) {
  const p = { ...DEFAULT_SETTINGS.drinks, ...(params || {}) };
  const g = num(guestCount);
  const hours = num(p.hours);
  const total = Math.ceil(num(p.first_hour_drinks) * g + Math.max(hours - 1, 0) * num(p.later_hour_drinks) * g - 1e-9);
  const wineDrinks = Math.round(total * num(p.wine_share));
  const wineBottles = Math.round(wineDrinks / Math.max(num(p.drinks_per_wine_bottle, 5), 1));
  const beerDrinks = Math.round(total * num(p.beer_share));
  const beerOunces = beerDrinks * num(p.ounces_per_beer, 12);
  const liquorDrinks = Math.round(total * num(p.liquor_share));
  return {
    guests: g,
    total,
    wine_drinks: wineDrinks,
    wine_bottles: wineBottles,
    red_bottles: Math.round(wineBottles * num(p.red_share)),
    white_bottles: Math.round(wineBottles * num(p.white_share)),
    beer_drinks: beerDrinks,
    beer_ounces: beerOunces,
    half_kegs: cents(beerOunces / KEG_OUNCES.half),
    quarter_kegs: cents(beerOunces / KEG_OUNCES.quarter),
    sixth_kegs: cents(beerOunces / KEG_OUNCES.sixth),
    liquor_drinks: liquorDrinks,
    liquor_bottles: Math.round(liquorDrinks / Math.max(num(p.drinks_per_liquor_bottle, 15), 1)),
    nonalc_drinks: Math.round(hours * g * num(p.nonalc_per_guest_hour)),
  };
}

/** Everything an expense's quantity can depend on, computed once per request. */
export function buildContext(settings, guests) {
  const counts = guestCounts(guests, settings);
  const basis = settings.guest_basis === "confirmed" ? "confirmed" : "weighted";
  const basisCount = counts[basis];
  return {
    settings,
    counts,
    basis,
    basisCount,
    drinks: drinksPlan(settings.drinks, basisCount),
    taxRate: num(settings.tax_rate, 0.07),
  };
}

export function sourceValue(source, ctx) {
  if (source === "guests") return ctx.basisCount;
  if (source === "invited") return ctx.counts.invited;
  if (source === "households") return ctx.counts.households;
  if (typeof source === "string" && source.startsWith("drinks:")) {
    const key = source.slice("drinks:".length);
    if (Object.prototype.hasOwnProperty.call(ctx.drinks, key)) return ctx.drinks[key];
  }
  return 0;
}

export function expenseQuantity(expense, ctx) {
  if (expense.pricing !== "variable") return num(expense.units, 1);
  const raw = sourceValue(expense.quantity_source, ctx) * num(expense.quantity_factor, 1);
  return expense.round_up ? Math.ceil(raw - 1e-9) : cents(raw);
}

export function expenseTotals(expense, ctx) {
  const quantity = expenseQuantity(expense, ctx);
  const subtotal = cents(num(expense.unit_cost) * quantity);
  const tax = expense.taxable ? cents(subtotal * ctx.taxRate) : 0;
  const gratuity = cents(subtotal * num(expense.gratuity_rate));
  return { quantity, subtotal, tax, gratuity, total: cents(subtotal + tax + gratuity) };
}

export function enrichExpense(expense, paid, ctx) {
  const totals = expenseTotals(expense, ctx);
  const current = totals.total;
  const paidAmount = cents(num(paid));
  let estimate;
  if (expense.status === "cancelled") estimate = 0;
  else if (expense.status === "estimate") estimate = current;
  else estimate = expense.baseline_total == null ? current : num(expense.baseline_total);
  let projected;
  if (expense.status === "cancelled") projected = paidAmount;
  else if (expense.status === "paid") projected = paidAmount > 0 ? paidAmount : current;
  else projected = current;
  return {
    ...expense,
    ...totals,
    current,
    estimate: cents(estimate),
    projected: cents(projected),
    paid: paidAmount,
    owed: cents(Math.max(projected - paidAmount, 0)),
    actual: expense.status === "estimate" ? null : cents(projected),
    priced: expense.unit_cost != null && num(expense.unit_cost) !== 0,
  };
}

/** Roll each item's line items up into it (see the module docstring). */
export function rollupPurchases(expenses) {
  const kids = new Map();
  for (const e of expenses) {
    if (e.parent_id) {
      if (!kids.has(e.parent_id)) kids.set(e.parent_id, []);
      kids.get(e.parent_id).push(e);
    }
  }
  return expenses.map((e) => {
    const list = kids.get(e.id);
    if (!list || e.parent_id) return { ...e, purchases: 0 };
    const spent = cents(list.reduce((s, k) => s + k.projected, 0));
    const paid = cents(e.paid + list.reduce((s, k) => s + k.paid, 0));
    const known = list.filter((k) => k.actual != null);
    const done = e.status === "paid";
    let projected;
    if (e.status === "cancelled") projected = paid;
    else if (done) projected = spent;
    else projected = Math.max(e.current, spent);
    const owed = cents(Math.max(projected - paid, 0));
    // A line item that's committed to (past Quote) and not fully paid yet.
    const committedOwing = list.some((k) => k.owed > 0.004 && !["estimate", "quote", "cancelled"].includes(k.status));
    let status;
    if (e.status === "cancelled") status = "cancelled";
    else if (done && owed === 0) status = "paid";
    else if (paid > 0) status = done || committedOwing ? "partially_paid" : "in_progress";
    else {
      const furthest = Math.max(0, ...list.filter((k) => k.status !== "cancelled").map((k) => STATUSES.indexOf(k.status)));
      status = STATUSES[Math.min(furthest, STATUSES.indexOf("booked"))];
    }
    return {
      ...e,
      status,
      own_status: e.status,
      done,
      purchases: list.length,
      budget: e.current,
      spent,
      paid,
      projected: cents(projected),
      owed,
      actual: known.length ? cents(known.reduce((s, k) => s + k.actual, 0)) : null,
      priced: e.priced || spent > 0,
    };
  });
}

/**
 * The status an expense should move to after its payments change. Only ever moves
 * forward along the route, and never touches a cancelled item or one with no price.
 */
export function statusAfterPayment(expense, paid, ctx) {
  if (expense.status === "cancelled") return expense.status;
  const total = expenseTotals(expense, ctx).total;
  const order = STATUSES.indexOf(expense.status);
  let target = expense.status;
  if (paid > 0 && total > 0 && paid + 0.005 >= total) target = "paid";
  else if (paid > 0) target = "partially_paid";
  return STATUSES.indexOf(target) > order ? target : expense.status;
}

/** Totals for the dashboard: by category, by status, payments over time, what's due. */
export function summarize(all, payments, ctx, today = new Date().toISOString().slice(0, 10)) {
  // Top-level rows carry the totals (a parent already includes its purchases); stages
  // and due dates come from the rows that are actually bought: purchases and items
  // without purchases.
  const expenses = all.filter((e) => !e.parent_id);
  const leaves = all.filter((e) => !e.purchases);
  const byCategory = new Map();
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, { count: 0, current: 0, paid: 0 }]));
  const totals = { estimate: 0, projected: 0, actual: 0, paid: 0, owed: 0, unpriced: 0, items: expenses.length };

  for (const e of expenses) {
    const cat = e.category || "Uncategorized";
    if (!byCategory.has(cat)) {
      byCategory.set(cat, { category: cat, estimate: 0, projected: 0, actual: 0, paid: 0, owed: 0, items: 0, priced_items: 0 });
    }
    const c = byCategory.get(cat);
    c.estimate += e.estimate;
    c.projected += e.projected;
    c.actual += e.actual || 0;
    c.paid += e.paid;
    c.owed += e.owed;
    c.items++;
    if (e.priced) c.priced_items++;
    totals.estimate += e.estimate;
    totals.projected += e.projected;
    totals.actual += e.actual || 0;
    totals.paid += e.paid;
    totals.owed += e.owed;
    if (!e.priced && e.status !== "cancelled") totals.unpriced++;
  }
  for (const e of leaves) {
    const s = byStatus[e.status] || byStatus.estimate;
    s.count++;
    s.current += e.status === "cancelled" ? e.paid : e.projected;
    s.paid += e.paid;
  }
  for (const key of ["estimate", "projected", "actual", "paid", "owed"]) totals[key] = cents(totals[key]);
  const categories = [...byCategory.values()].map((c) => ({
    ...c,
    estimate: cents(c.estimate),
    projected: cents(c.projected),
    actual: cents(c.actual),
    paid: cents(c.paid),
    owed: cents(c.owed),
  }));
  for (const s of Object.values(byStatus)) {
    s.current = cents(s.current);
    s.paid = cents(s.paid);
  }

  // Cumulative paid by date. Payments with no date sort first, as "before tracking".
  const dated = [...payments].sort((a, b) => String(a.paid_on || "").localeCompare(String(b.paid_on || "")));
  let running = 0;
  const timeline = [];
  for (const p of dated) {
    running = cents(running + num(p.amount));
    const date = p.paid_on || null;
    const last = timeline[timeline.length - 1];
    if (last && last.date === date) last.cumulative = running;
    else timeline.push({ date, cumulative: running });
  }

  const names = new Map(all.map((e) => [e.id, e.item]));
  const upcoming = leaves
    .filter((e) => e.due_date && e.status !== "cancelled" && e.status !== "paid")
    .map((e) => ({
      id: e.id,
      item: e.parent_id && names.has(e.parent_id) ? `${names.get(e.parent_id)}: ${e.item}` : e.item,
      vendor: e.vendor,
      category: e.category,
      due_date: e.due_date,
      due_amount: e.due_amount == null ? e.owed : num(e.due_amount),
      owed: e.owed,
      overdue: e.due_date < today,
    }))
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  const late = upcoming.filter((u) => u.overdue);
  const overdue = { count: late.length, amount: cents(late.reduce((sum, u) => sum + u.due_amount, 0)) };

  return { totals, categories, by_status: byStatus, timeline, upcoming, overdue };
}
