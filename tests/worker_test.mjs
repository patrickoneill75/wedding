/**
 * Tests for the Worker in src/. They drive the REAL route handlers through the
 * Worker's own fetch(): an in-memory SQLite database (node:sqlite) stands in for the
 * D1 binding, and globalThis.fetch is stubbed per test so nothing reaches Google.
 *
 * Run: node tests/worker_test.mjs   (Node 22.5+, for node:sqlite)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import worker from "../src/worker.js";
import { resetSchemaMemo } from "../src/db.js";
import { sign } from "../src/auth.js";
import { buildContext, drinksPlan, enrichExpense, guestCounts, mergeSettings, statusAfterPayment } from "../src/calc.js";
import { toCsv } from "../src/sync.js";
import { sqlValue } from "../src/importer.js";
import { normalizeName, searchGuests } from "../src/public_api.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "sample_wedding.xlsx");

/* ------------------------------------------------------------------ tiny test runner */
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ------------------------------------------------------------------------- D1 stub */
class FakeStatement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new FakeStatement(this.db, this.sql, params.map((p) => (typeof p === "boolean" ? Number(p) : p)));
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }
  async first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
  }
}

class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA foreign_keys = ON");
  }
  prepare(sql) {
    return new FakeStatement(this.db, sql);
  }
  async batch(statements) {
    const out = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }
}

function makeEnv(extra = {}) {
  resetSchemaMemo();
  return {
    DB: new FakeD1(),
    ASSETS: { fetch: async () => new Response("asset") },
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    ADMIN_EMAILS: "admin@example.com, partner@example.com",
    ...extra,
  };
}

const ORIGIN = "https://wedding.example.workers.dev";

async function call(env, pathname, { method = "GET", body, cookie, form, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (cookie) init.headers.cookie = cookie;
  if (form) init.body = form;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  const response = await worker.fetch(new Request(`${ORIGIN}${pathname}`, init), env);
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data, headers: response.headers };
}

async function sessionCookie(env, email = "admin@example.com") {
  await call(env, "/api/config-check"); // no-op; keeps call order realistic
  await worker.fetch(new Request(`${ORIGIN}/api/auth/me`), env); // runs migrations
  const token = await sign(env, { kind: "session", email, name: "Admin" }, 3600);
  return `wedding_session=${token}`;
}

/** Signed-in admin helper: adds the cookie and the CSRF header. */
async function adminClient(env) {
  const cookie = await sessionCookie(env);
  return (pathname, opts = {}) => call(env, pathname, { ...opts, cookie, headers: { "x-wedding": "1", ...(opts.headers || {}) } });
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    return handler(url, init, calls);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const okJson = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function fixtureForm(parts = { guests: 1, budget: 1, constants: 1 }) {
  const form = new FormData();
  form.append("file", new File([fs.readFileSync(FIXTURE)], "sample_wedding.xlsx"));
  for (const [k, v] of Object.entries(parts)) form.append(k, String(v));
  return form;
}

/* ------------------------------------------------------------------- calc tests -- */

test("drinks calculator reproduces the spreadsheet's numbers for 123 weighted guests", () => {
  const plan = drinksPlan(undefined, 123);
  assert.equal(plan.total, 738);
  assert.equal(plan.wine_bottles, 59);
  assert.equal(plan.red_bottles, 30);
  assert.equal(plan.white_bottles, 30);
  assert.equal(plan.beer_drinks, 443);
  assert.equal(plan.beer_ounces, 5316);
  assert.equal(plan.nonalc_drinks, 154);
  assert.equal(plan.half_kegs, 2.68);
});

test("weighted count rounds up like ROUNDUP and a plus-one carries the host's weight", () => {
  const settings = mergeSettings({});
  const guests = [
    { household_id: 1, priority: "High", rsvp: "yes", plus_one_allowed: 1, plus_one_rsvp: "no" },
    { household_id: 1, priority: "Medium", rsvp: "pending", plus_one_allowed: 0 },
    { household_id: 2, priority: "Low", rsvp: "no", plus_one_allowed: 0 },
  ];
  const counts = guestCounts(guests, settings);
  assert.equal(counts.invited, 4);
  assert.equal(counts.weighted, Math.ceil(0.9 + 0.9 + 0.6 + 0.4)); // 3
  assert.equal(counts.confirmed, 1);
  assert.equal(counts.declined, 2);
  assert.equal(counts.pending, 1);
  assert.equal(counts.households, 2);
});

test("weighted count is not bumped up by floating-point noise (0.9 x 10 = 9, not 10)", () => {
  const guests = Array.from({ length: 10 }, (_, i) => ({ household_id: i, priority: "High", rsvp: "pending" }));
  assert.equal(guestCounts(guests, mergeSettings({})).weighted, 9);
});

test("variable expense follows the guest basis; tax and gratuity are added to the subtotal", () => {
  const guests = [
    { household_id: 1, priority: "High", rsvp: "yes" },
    { household_id: 2, priority: "High", rsvp: "pending" },
  ];
  const expense = { pricing: "variable", quantity_source: "guests", quantity_factor: 1, unit_cost: 100, taxable: 1, gratuity_rate: 0.2, status: "quote" };
  const weighted = enrichExpense(expense, 0, buildContext(mergeSettings({}), guests));
  assert.equal(weighted.quantity, 2); // ceil(1.8)
  assert.equal(weighted.total, 200 + 14 + 40);
  const confirmed = enrichExpense(expense, 0, buildContext(mergeSettings({ guest_basis: "confirmed" }), guests));
  assert.equal(confirmed.quantity, 1);
  assert.equal(confirmed.total, 127);
});

test("payments only move status forward, and never touch a cancelled item", () => {
  const ctx = buildContext(mergeSettings({}), []);
  const e = { pricing: "fixed", unit_cost: 100, units: 1, status: "booked" };
  assert.equal(statusAfterPayment(e, 40, ctx), "partially_paid");
  assert.equal(statusAfterPayment(e, 100, ctx), "paid");
  assert.equal(statusAfterPayment({ ...e, status: "paid" }, 40, ctx), "paid");
  assert.equal(statusAfterPayment({ ...e, status: "cancelled" }, 100, ctx), "cancelled");
});

test("CSV export quotes commas/quotes and defuses formula injection", () => {
  const csv = toCsv(["a", "b", "c"], [{ a: 'x, "y"', b: "=HYPERLINK(1)", c: -12.5 }]);
  assert.ok(csv.includes('"x, ""y"""'));
  assert.ok(csv.includes("'=HYPERLINK(1)"));
  assert.ok(csv.includes(",-12.5"));
});

test("SQL literals escape quotes and refuse non-finite numbers", () => {
  assert.equal(sqlValue("O'Neill"), "'O''Neill'");
  assert.equal(sqlValue(Number.NaN), "NULL");
  assert.equal(sqlValue(null), "NULL");
  assert.equal(sqlValue(3.5), "3.5");
});

test("name normalization ignores case, accents, apostrophes and stray spaces", () => {
  assert.equal(normalizeName(" O'Néill "), "oneill");
});

test("name search: each typed word must start a different word of the name", () => {
  const guests = [
    { id: 1, first_name: "Conor", last_name: "Marley" },
    { id: 2, first_name: "Conner", last_name: "Moore" },
    { id: 3, first_name: "Mary-Kate", last_name: "O'Neill" },
    { id: 4, first_name: "Anna", last_name: "Mars" },
  ];
  const names = (q) => searchGuests(guests, q).map((g) => g.id);
  assert.deepEqual(names("Con"), [2, 1], "first-name prefix finds both, alphabetically (Conner, Conor)");
  assert.deepEqual(names("mar"), [3, 4, 1], "first-name hits (Mary-Kate) sort ahead of last-name hits (Anna Mars, Conor Marley)");
  assert.deepEqual(names("con mar"), [1], "two words narrow it to one person");
  assert.deepEqual(names("mar con"), [1], "word order doesn't matter");
  assert.deepEqual(names("oneill"), [3], "apostrophes are ignored");
  assert.deepEqual(names("kate"), [3], "hyphenated names match on either half");
  assert.deepEqual(names("mar mar"), [], "one typed word can't match the same name word twice");
  assert.deepEqual(names("c"), [], "one letter is too little to search on");
  assert.deepEqual(names("  "), []);
  const many = Array.from({ length: 20 }, (_, i) => ({ id: i, first_name: "Sam", last_name: `Smith${i}` }));
  assert.equal(searchGuests(many, "sam").length, 8, "at most eight suggestions");
});

/* -------------------------------------------------------------------- auth tests -- */

test("admin API refuses a request with no session", async () => {
  const env = makeEnv();
  const r = await call(env, "/api/admin/summary");
  assert.equal(r.status, 401);
});

test("admin API refuses a state-changing request without the X-Wedding header (CSRF)", async () => {
  const env = makeEnv();
  const cookie = await sessionCookie(env);
  const r = await call(env, "/api/admin/expenses", { method: "POST", body: { item: "Cake" }, cookie });
  assert.equal(r.status, 403);
});

test("a valid session for an email removed from ADMIN_EMAILS no longer gets in", async () => {
  const env = makeEnv();
  const cookie = await sessionCookie(env, "former@example.com");
  const r = await call(env, "/api/admin/summary", { cookie });
  assert.equal(r.status, 401);
});

test("OAuth callback rejects a state whose nonce doesn't match the browser's cookie", async () => {
  const env = makeEnv();
  await call(env, "/api/auth/me");
  const state = await sign(env, { kind: "oauth", purpose: "login", nonce: "abc" }, 600);
  const r = await call(env, `/api/auth/callback?code=x&state=${encodeURIComponent(state)}`, { cookie: "wedding_oauth=different" });
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /login\.html\?error=/);
});

test("Google sign-in sets a session only for an allowlisted, verified email", async () => {
  const env = makeEnv();
  await call(env, "/api/auth/me");
  const state = await sign(env, { kind: "oauth", purpose: "login", nonce: "n1" }, 600);
  const google = (email) => (url) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return okJson({ access_token: "at", expires_in: 3600 });
    if (url.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) return okJson({ email, email_verified: true, name: "Pat" });
    throw new Error(`unexpected fetch ${url}`);
  };
  const ok = await withFetch(google("Partner@Example.com"), () =>
    call(env, `/api/auth/callback?code=c&state=${encodeURIComponent(state)}`, { cookie: "wedding_oauth=n1" })
  );
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get("location"), "/admin/index.html");
  assert.match(ok.headers.get("set-cookie"), /wedding_session=/);

  const no = await withFetch(google("stranger@example.com"), () =>
    call(env, `/api/auth/callback?code=c&state=${encodeURIComponent(state)}`, { cookie: "wedding_oauth=n1" })
  );
  assert.match(no.headers.get("location"), /error=/);
  assert.doesNotMatch(no.headers.get("set-cookie") || "", /wedding_session=[^;]/);
});

/* ------------------------------------------------------------------ import tests -- */

test("spreadsheet import brings in households, guests, budget lines and constants", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const r = await api("/api/admin/import", { method: "POST", form: fixtureForm() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual({ ...r.data.summary, constants: undefined }, { households: 3, guests: 4, expenses: 7, payments: 1, constants: undefined });

  const guests = (await api("/api/admin/guests")).data;
  const alex = guests.households.find((h) => h.code === "H-001");
  assert.equal(alex.display_name, "Alex and Sam Example");
  assert.equal(alex.zip, "02134", "a US zip stored as a number keeps its leading zero");
  assert.equal(alex.guests.length, 2);
  assert.equal(alex.guests[0].immediate_family, 1);
  assert.deepEqual([alex.guests[0].invite_ceremony, alex.guests[0].invite_reception], [1, 1],
    "an x in the Ceremony column invites them to the ceremony as well as the reception");
  const jordan = guests.households.find((h) => h.code === "H-002");
  assert.equal(jordan.guests[0].first_name, "Jordan", "trailing spaces are trimmed");
  assert.equal(jordan.guests[0].priority, "Medium");
  assert.deepEqual([jordan.guests[0].invite_ceremony, jordan.guests[0].invite_reception], [0, 1], "no x means reception only");
  assert.equal(jordan.guests.length, 1, 'the "Guest Guest Jordan Sample" placeholder row is not imported as a person');
  assert.equal(jordan.guests[0].plus_one_allowed, 1, "the placeholder becomes a plus-one on its host");
  assert.equal(jordan.guests[0].plus_one_name, null, "with no name, so the guest types it in when they RSVP");
  assert.deepEqual(guests.counts.invites, { ceremony: 2, reception: 4 });
  assert.equal(guests.counts.weighted, 4); // ceil(0.9*3 + 0.6)

  const { expenses } = (await api("/api/admin/expenses")).data;
  const byItem = Object.fromEntries(expenses.map((e) => [e.item, e]));
  assert.equal(byItem["Red Wine"].pricing, "variable");
  assert.equal(byItem["Red Wine"].quantity_source, "drinks:red_bottles");
  assert.equal(byItem["Non-alcoholic drinks"].quantity_source, "drinks:nonalc_drinks");
  assert.equal(byItem["Save the Date Printing"].pricing, "fixed", "a typed-in total becomes a lump sum");
  assert.equal(byItem["Save the Date Printing"].current, 294.01);
  assert.equal(byItem["Save the Date Printing"].status, "paid");
  assert.equal(byItem["Save the Date Printing"].paid, 294.01);
  assert.equal(byItem["Thank You Note Postage"].quantity_source, "guests");
  assert.equal(byItem.Yats.unit_cost, 150, "a unit cost pulled from Constants keeps its value");
  assert.equal(byItem.Yats.total, 1080);
  assert.equal(byItem.Dress.unit_cost, null);
  assert.equal(byItem.Dress.category, "Ceremony & Reception", "the category typo is fixed");
});

test("re-importing replaces guests instead of duplicating them", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  await api("/api/admin/import", { method: "POST", form: fixtureForm({ guests: 1 }) });
  await api("/api/admin/import", { method: "POST", form: fixtureForm({ guests: 1 }) });
  const guests = (await api("/api/admin/guests")).data;
  assert.equal(guests.households.length, 3);
  assert.equal(guests.counts.invited, 5); // 4 guests + Jordan's plus-one
});

/* ---------------------------------------------------------------- expense tests -- */

test("moving an expense from estimate to quote freezes the original estimate and logs history", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const created = await api("/api/admin/expenses", { method: "POST", body: { category: "Venue", item: "Hall", unit_cost: 3000, units: 1 } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.expense.id;
  const quoted = await api(`/api/admin/expenses/${id}`, { method: "PUT", body: { status: "quote", unit_cost: 3300 } });
  assert.equal(quoted.data.expense.estimate, 3000);
  assert.equal(quoted.data.expense.current, 3300);
  assert.equal(quoted.data.expense.projected, 3300);
  const detail = (await api(`/api/admin/expenses/${id}`)).data;
  assert.equal(detail.history.length, 2);
  assert.match(detail.history[1].note, /estimate → quote/);
});

test("skipping straight from estimate to booked still keeps the estimate", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const id = (await api("/api/admin/expenses", { method: "POST", body: { item: "DJ", unit_cost: 1000 } })).data.expense.id;
  const booked = await api(`/api/admin/expenses/${id}`, { method: "PUT", body: { status: "booked", unit_cost: 1200 } });
  assert.equal(booked.data.expense.estimate, 1000);
  assert.equal(booked.data.expense.status, "booked");
});

test("payments advance an expense to partially paid, then paid", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const id = (await api("/api/admin/expenses", { method: "POST", body: { item: "Photographer", unit_cost: 3300, status: "booked" } })).data.expense.id;
  const first = await api(`/api/admin/expenses/${id}/payments`, { method: "POST", body: { amount: 1000, paid_on: "2026-10-01", payer: "Joint" } });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.expense.status, "partially_paid");
  assert.equal(first.data.expense.owed, 2300);
  const second = await api(`/api/admin/expenses/${id}/payments`, { method: "POST", body: { amount: 2300, paid_on: "2026-11-01" } });
  assert.equal(second.data.expense.status, "paid");
  assert.equal(second.data.expense.owed, 0);
});

test("a bad expense patch is refused rather than saved", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const id = (await api("/api/admin/expenses", { method: "POST", body: { item: "Cake", unit_cost: 200 } })).data.expense.id;
  const r = await api(`/api/admin/expenses/${id}`, { method: "PUT", body: { status: "lol" } });
  assert.equal(r.status, 400);
  const r2 = await api(`/api/admin/expenses/${id}`, { method: "PUT", body: { quantity_source: "constructor" } });
  assert.equal(r2.status, 400, "an inherited Object.prototype key is not a valid quantity source");
});

test("'convert to confirmed' re-prices every per-guest expense", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  await api("/api/admin/import", { method: "POST", form: fixtureForm({ guests: 1 }) });
  const id = (await api("/api/admin/expenses", { method: "POST", body: { item: "Dinner", pricing: "variable", quantity_source: "guests", unit_cost: 50 } })).data.expense.id;
  assert.equal((await api(`/api/admin/expenses/${id}`)).data.expense.total, 200); // 4 weighted
  const switched = await api("/api/admin/basis", { method: "POST", body: { basis: "confirmed" } });
  assert.equal(switched.data.basis_count, 0);
  assert.equal((await api(`/api/admin/expenses/${id}`)).data.expense.total, 0);
});

test("dashboard summary totals estimate, projected, paid and what's due", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const a = (await api("/api/admin/expenses", { method: "POST", body: { category: "Venue", item: "Hall", unit_cost: 1000, due_date: "2026-01-01" } })).data.expense.id;
  await api(`/api/admin/expenses/${a}`, { method: "PUT", body: { status: "booked", unit_cost: 1500 } });
  await api(`/api/admin/expenses/${a}/payments`, { method: "POST", body: { amount: 500, paid_on: "2026-02-01" } });
  await api("/api/admin/expenses", { method: "POST", body: { category: "Food", item: "Cake", unit_cost: 200 } });
  const s = (await api("/api/admin/summary")).data;
  assert.equal(s.totals.estimate, 1200);
  assert.equal(s.totals.projected, 1700);
  assert.equal(s.totals.paid, 500);
  assert.equal(s.totals.owed, 1200);
  assert.equal(s.upcoming.length, 1);
  assert.equal(s.upcoming[0].overdue, true);
  assert.deepEqual(s.overdue, { count: 1, amount: 1000 }, "an overdue item with no due amount counts what's owed");
  assert.equal(s.totals.actual, 1500, "only the booked hall has an actual cost; the cake is still an estimate");
  const cake = s.items.find((i) => i.item === "Cake");
  assert.equal(cake.actual, null);
  assert.equal(cake.estimate, 200);
  assert.deepEqual(Object.keys(s.items[0]).sort(), ["actual", "category", "estimate", "id", "item", "projected", "purchases", "status", "subcategory"]);
  assert.deepEqual(s.timeline, [{ date: "2026-02-01", cumulative: 500 }]);
});

/* ------------------------------------------------------------------ invite tests -- */

// The columns every migration after the first touches, as an older database has them.
const OLD_GUEST_COLUMNS = `id INTEGER PRIMARY KEY, household_id INTEGER, first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '', ceremony INTEGER NOT NULL DEFAULT 0,
  plus_one_allowed INTEGER NOT NULL DEFAULT 0, plus_one_name TEXT`;
// The other tables later migrations alter, in their oldest shape.
const OLD_OTHER_TABLES = `
  CREATE TABLE expenses (id INTEGER PRIMARY KEY, vendor TEXT, payer TEXT, status TEXT NOT NULL DEFAULT 'estimate', updated_at TEXT, category TEXT, subcategory TEXT, item TEXT, pricing TEXT, unit_cost REAL, units REAL, quantity_source TEXT, quantity_factor REAL, round_up INTEGER, taxable INTEGER, gratuity_rate REAL, notes TEXT, source TEXT, baseline_total REAL);
  CREATE TABLE payments (id INTEGER PRIMARY KEY, expense_id INTEGER, payer TEXT);`;

test("upgrading from the first schema carries the spreadsheet's ceremony flag all the way through", async () => {
  const env = makeEnv();
  env.DB.db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('_schema_version', '1');${OLD_OTHER_TABLES}
    CREATE TABLE guests (${OLD_GUEST_COLUMNS});
    INSERT INTO guests (id, household_id, first_name, last_name, ceremony) VALUES (1, 1, 'A', 'B', 1), (2, 1, 'C', 'D', 0);
  `);
  // 401 (not signed in) means every migration ran; a failed one would surface as a 500.
  assert.equal((await call(env, "/api/auth/me")).status, 401);
  const rows = env.DB.db.prepare("SELECT invite_ceremony, invite_reception FROM guests ORDER BY id").all();
  assert.deepEqual(rows.map((r) => [r.invite_ceremony, r.invite_reception]), [[1, 1], [0, 1]]);
});

test("upgrading from either/or invite types: ceremony becomes both, reception stays reception only", async () => {
  const env = makeEnv();
  env.DB.db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('_schema_version', '3');${OLD_OTHER_TABLES}
    CREATE TABLE guests (${OLD_GUEST_COLUMNS}, invite_type TEXT NOT NULL DEFAULT 'reception');
    INSERT INTO guests (id, household_id, invite_type) VALUES (1, 1, 'ceremony'), (2, 1, 'reception');
  `);
  assert.equal((await call(env, "/api/auth/me")).status, 401);
  const rows = env.DB.db.prepare("SELECT invite_ceremony, invite_reception FROM guests ORDER BY id").all();
  assert.deepEqual(rows.map((r) => [r.invite_ceremony, r.invite_reception]), [[1, 1], [0, 1]]);
});

test('upgrading a database turns "Guest Guest <host>" rows into a nameless plus-one on the host', async () => {
  const env = makeEnv();
  // As schema version 2 left it, with placeholder rows from the spreadsheet import.
  env.DB.db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('_schema_version', '2');${OLD_OTHER_TABLES}
    CREATE TABLE guests (${OLD_GUEST_COLUMNS}, invite_type TEXT NOT NULL DEFAULT 'reception');
    INSERT INTO guests (id, household_id, first_name, last_name) VALUES
      (1, 1, 'Conor', 'Smith'), (2, 1, 'Guest', 'Guest Conor Smith'),
      (3, 2, 'Ann', 'Lee'), (4, 2, 'Bob ', 'Lee'), (5, 2, 'Guest', 'Guest Bob Lee'),
      (6, 3, 'Dee', 'Fox'), (7, 3, 'Guest', 'Guest Someone Else'),
      (8, 4, 'Guest', 'Guest Nobody');
  `);
  assert.equal((await call(env, "/api/auth/me")).status, 401);
  const rows = env.DB.db.prepare("SELECT id, plus_one_allowed, plus_one_name FROM guests ORDER BY id").all();
  assert.deepEqual(rows.map((r) => [r.id, r.plus_one_allowed]), [
    [1, 1], // host matched by name
    [3, 0], [4, 1], // the named host, not the first in the household (and despite "Bob " with a space)
    [6, 1], // name doesn't match anyone: falls back to the household's first guest
    [8, 0], // a placeholder alone in its household has no host, so it stays
  ]);
  assert.ok(rows.every((r) => r.plus_one_name === null));
});

test("bulk ceremony/reception switches change every guest in the chosen households, and nothing else", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  await api("/api/admin/import", { method: "POST", form: fixtureForm({ guests: 1 }) });
  const { households } = (await api("/api/admin/guests")).data;
  const ids = households.filter((h) => h.code !== "H-003").map((h) => h.id);
  const r = await api("/api/admin/guests/bulk", { method: "POST", body: { household_ids: ids, field: "invite_ceremony", value: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.updated, 3);
  let counts = (await api("/api/admin/guests")).data.counts;
  assert.deepEqual(counts.invites, { ceremony: 3, reception: 4 });
  await api("/api/admin/guests/bulk", { method: "POST", body: { household_ids: ids, field: "invite_reception", value: false } });
  counts = (await api("/api/admin/guests")).data.counts;
  assert.deepEqual(counts.invites, { ceremony: 3, reception: 1 }, "ceremony and reception switch independently");
  const bad = await api("/api/admin/guests/bulk", { method: "POST", body: { household_ids: ids, field: "invite_ceremony", value: "yes" } });
  assert.equal(bad.status, 400, "value must be a real true/false");
  const badField = await api("/api/admin/guests/bulk", { method: "POST", body: { household_ids: ids, field: "rsvp", value: true } });
  assert.equal(badField.status, 400, "bulk only edits the invite switches");
});

test("one guest can be invited to the ceremony only, the reception only, or both", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  await api("/api/admin/import", { method: "POST", form: fixtureForm({ guests: 1 }) });
  const sam = (await api("/api/admin/guests")).data.households.find((h) => h.code === "H-001").guests[1];
  assert.deepEqual([sam.invite_ceremony, sam.invite_reception], [1, 1]);
  const r = await api(`/api/admin/guests/${sam.id}`, { method: "PUT", body: { invite_reception: false } });
  assert.deepEqual([r.data.guest.invite_ceremony, r.data.guest.invite_reception], [1, 0]);
});

/* -------------------------------------------------------- purchases and vendors -- */

test("line items roll up into their item: estimate, actual, paid and projected add up", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const parent = (await api("/api/admin/expenses", { method: "POST", body: { category: "Ceremony & Reception", subcategory: "Decor", item: "Place Settings" } })).data.expense.id;
  const a = await api("/api/admin/expenses", { method: "POST", body: { parent_id: parent, item: "Plates", vendor: "Goodwill", unit_cost: 120, status: "paid" } });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal(a.data.expense.category, "Ceremony & Reception", "a purchase files under its item's category");
  assert.equal(a.data.expense.subcategory, "Decor");
  await api("/api/admin/expenses", { method: "POST", body: { parent_id: parent, item: "Napkins", vendor: "Etsy", unit_cost: 50, status: "booked", due_date: "2026-01-02" } });

  let p = (await api(`/api/admin/expenses/${parent}`)).data.expense;
  assert.equal(p.purchases, 2);
  assert.equal(p.estimate, 170);
  assert.equal(p.actual, 170);
  assert.equal(p.paid, 120);
  assert.equal(p.projected, 170);
  assert.equal(p.owed, 50);
  assert.equal(p.purchase_list.length, 2);

  const s = (await api("/api/admin/summary")).data;
  assert.equal(s.totals.projected, 170, "line items are not counted on top of their item");
  assert.equal(s.totals.paid, 120);
  assert.equal(s.items.length, 1, "the category table lists the item, not each purchase");
  assert.equal(s.upcoming[0].item, "Place Settings: Napkins", "a purchase's due payment names its item");

  await api(`/api/admin/expenses/${parent}`, { method: "PUT", body: { status: "paid" } });
  p = (await api(`/api/admin/expenses/${parent}`)).data.expense;
  assert.equal(p.projected, 170, "done buying changes the stage, not the total");
  assert.equal(p.owed, 50);
  assert.equal((await api(`/api/admin/expenses/${parent}`)).data.payments.length, 0, "marking an item with purchases Paid records no payment of its own");
});

test("a purchase can't have purchases, and deleting an item deletes its purchases", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const parent = (await api("/api/admin/expenses", { method: "POST", body: { item: "Favors", unit_cost: 100 } })).data.expense.id;
  const kid = (await api("/api/admin/expenses", { method: "POST", body: { parent_id: parent, item: "Bags", unit_cost: 20 } })).data.expense.id;
  const nested = await api("/api/admin/expenses", { method: "POST", body: { parent_id: kid, item: "Ribbon", unit_cost: 5 } });
  assert.equal(nested.status, 400);
  await api(`/api/admin/expenses/${parent}`, { method: "DELETE" });
  assert.equal((await api(`/api/admin/expenses/${kid}`)).status, 404);
});

test("vendors are remembered once each, whatever the capitalization", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  await api("/api/admin/expenses", { method: "POST", body: { item: "A", vendor: "Goodwill" } });
  await api("/api/admin/expenses", { method: "POST", body: { item: "B", vendor: "goodwill " } });
  const id = (await api("/api/admin/expenses", { method: "POST", body: { item: "C" } })).data.expense.id;
  await api(`/api/admin/expenses/${id}`, { method: "PUT", body: { vendor: "Etsy" } });
  assert.deepEqual((await api("/api/admin/expenses")).data.vendors, ["Etsy", "Goodwill"]);
});

test("saving an expense as Paid puts its full price in the Paid column", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const made = await api("/api/admin/expenses", { method: "POST", body: { item: "Cake", unit_cost: 400, status: "paid", payer: "Kaitlyn" } });
  assert.equal(made.data.expense.paid, 400);
  assert.equal(made.data.expense.owed, 0);
  const pay = (await api(`/api/admin/expenses/${made.data.expense.id}`)).data.payments;
  assert.equal(pay.length, 1);
  assert.equal(pay[0].payer, "Kaitlyn");

  // Moving a part-paid item to Paid records only what was still owed.
  const dj = (await api("/api/admin/expenses", { method: "POST", body: { item: "DJ", unit_cost: 1000, status: "booked" } })).data.expense.id;
  await api(`/api/admin/expenses/${dj}/payments`, { method: "POST", body: { amount: 300, paid_on: "2026-01-01" } });
  const done = await api(`/api/admin/expenses/${dj}`, { method: "PUT", body: { status: "paid" } });
  assert.equal(done.data.expense.paid, 1000);
  assert.deepEqual((await api(`/api/admin/expenses/${dj}`)).data.payments.map((p) => p.amount), [300, 700]);
  // Saving it again doesn't pay twice.
  await api(`/api/admin/expenses/${dj}`, { method: "PUT", body: { status: "paid", notes: "thanks!" } });
  assert.equal((await api(`/api/admin/expenses/${dj}`)).data.payments.length, 2);
});

async function formKeyFor(api) {
  return new URL((await api("/api/admin/form-link")).data.url).searchParams.get("k");
}
function formOf(fields) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
}

test("the expense form adds a purchase under an existing item, and lists items without purchases or vendors", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const key = await formKeyFor(api);
  const parent = (await api("/api/admin/expenses", { method: "POST", body: { item: "Place Settings", vendor: "Goodwill", unit_cost: 300 } })).data.expense.id;
  const r = await call(env, "/api/public/expense", { method: "POST", form: formOf({
    key, expense_id: String(parent), mode: "purchase", item: "Glasses", vendor: "Target", price: "45", status: "paid",
    payment_amount: "999", paid_on: "2026-03-04", payer: "Kaitlyn", method: "Credit card",
  }) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const kid = (await api(`/api/admin/expenses/${r.data.expense_id}`)).data;
  assert.equal(kid.expense.parent_id, parent);
  assert.equal(kid.expense.vendor, "Target");
  assert.deepEqual(kid.payments.map((p) => [p.amount, p.paid_on, p.payer, p.method]), [[45, "2026-03-04", "Kaitlyn", "Credit card"]],
    "at the Paid stage the price is what's paid; a typed-in amount is ignored");
  const options = (await call(env, `/api/public/expense/options?k=${key}`)).data;
  assert.deepEqual(options.items.map((i) => i.item), ["Place Settings"], "purchases aren't offered as items");
  assert.equal(options.items[0].purchases, 2, "the item's own Goodwill booking became its first line item");
  assert.deepEqual(options.vendors, ["Goodwill", "Target"]);
});

// Bug: an item with purchases kept its own vendor, stage and payments next to theirs, so
// its Pricing column and stage said one thing and its purchases another.
test("the first line item moves the item's own price and booking into a line item; the item just adds them up", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const id = (await api("/api/admin/expenses", { method: "POST", body: {
    category: "Ceremony & Reception", item: "Florals", vendor: "Petal Co", unit_cost: 2000, status: "booked", due_date: "2027-01-05", payer: "Patrick" } })).data.expense.id;
  await api(`/api/admin/expenses/${id}/payments`, { method: "POST", body: { amount: 500, paid_on: "2026-05-01" } });
  await api("/api/admin/expenses", { method: "POST", body: { parent_id: id, item: "Bud vases", vendor: "Etsy", unit_cost: 90, status: "paid" } });

  const d = (await api(`/api/admin/expenses/${id}`)).data;
  assert.equal(d.payments.length, 0, "the deposit moved off the item");
  assert.equal(d.expense.vendor, null);
  assert.equal(d.expense.due_date, null);
  assert.equal(d.expense.unit_cost, null, "no budget left on the item");
  assert.equal(d.expense.estimate, 2090, "the frozen estimate moved with the booking");
  assert.equal(d.expense.projected, 2090);
  assert.equal(d.expense.paid, 590);
  assert.equal(d.expense.status, "partially_paid", "the item's stage comes from its line items");
  const first = d.expense.purchase_list.find((k) => k.vendor === "Petal Co");
  assert.equal(first.item, "Florals");
  assert.equal(first.status, "partially_paid");
  assert.equal(first.due_date, "2027-01-05");
  assert.equal(first.paid, 500);
  assert.equal(first.estimate, 2000);

  const pay = await api(`/api/admin/expenses/${id}/payments`, { method: "POST", body: { amount: 10 } });
  assert.equal(pay.status, 400, "payments go on a line item, not the item");
  const key = await formKeyFor(api);
  const r = await call(env, "/api/public/expense", { method: "POST", form: formOf({ key, expense_id: String(id), mode: "update", price: "1", status: "quote" }) });
  assert.equal(r.status, 400, "the form can't update a split item's price as if it were one booking");
});

test("an item with line items is Booked, In progress, Partially paid or Paid by what its line items are", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const id = (await api("/api/admin/expenses", { method: "POST", body: { item: "Favors" } })).data.expense.id;
  const a = (await api("/api/admin/expenses", { method: "POST", body: { parent_id: id, item: "Bags", unit_cost: 40, status: "quote" } })).data.expense.id;
  assert.equal((await api("/api/admin/expenses", { method: "POST", body: { parent_id: id, item: "Tags", unit_cost: 20 } })).status, 201);
  const stage = async () => (await api(`/api/admin/expenses/${id}`)).data.expense;
  assert.equal((await stage()).status, "quote", "nothing moves when an estimate-stage item gets a line item");
  await api(`/api/admin/expenses/${a}`, { method: "PUT", body: { status: "booked" } });
  assert.equal((await stage()).status, "booked");
  await api(`/api/admin/expenses/${a}`, { method: "PUT", body: { status: "paid" } });
  assert.equal((await stage()).status, "in_progress", "what's bought is paid, and more may come until it's marked done");
  await api(`/api/admin/expenses/${id}`, { method: "PUT", body: { status: "paid" } });
  let e = await stage();
  assert.equal(e.done, true);
  assert.equal(e.status, "partially_paid", "done, but Tags is still owed");
  assert.equal(e.projected, 60);
  const tags = e.purchase_list.find((k) => k.item === "Tags").id;
  await api(`/api/admin/expenses/${tags}`, { method: "PUT", body: { status: "paid" } });
  e = await stage();
  assert.equal(e.status, "paid");
  assert.equal(e.owed, 0);
});

// Bug: place settings bought a few at a time, all paid so far, read "Partially paid"
// as if money were owed; the venue with only its deposit paid read the same.
test("In progress means everything bought so far is paid; Partially paid means a booking still owes", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const venue = (await api("/api/admin/expenses", { method: "POST", body: { item: "Venue" } })).data.expense.id;
  await api("/api/admin/expenses", { method: "POST", body: { parent_id: venue, item: "Security deposit", unit_cost: 1000, status: "paid" } });
  await api("/api/admin/expenses", { method: "POST", body: { parent_id: venue, item: "Remaining cost", unit_cost: 3000, status: "booked" } });
  assert.equal((await api(`/api/admin/expenses/${venue}`)).data.expense.status, "partially_paid");

  const plates = (await api("/api/admin/expenses", { method: "POST", body: { item: "Place Settings" } })).data.expense.id;
  await api("/api/admin/expenses", { method: "POST", body: { parent_id: plates, item: "Plates", unit_cost: 40, status: "paid" } });
  await api("/api/admin/expenses", { method: "POST", body: { parent_id: plates, item: "Glasses", unit_cost: 60, status: "paid" } });
  await api("/api/admin/expenses", { method: "POST", body: { parent_id: plates, item: "Chargers (maybe)", unit_cost: 80, status: "quote" } });
  const e = (await api(`/api/admin/expenses/${plates}`)).data.expense;
  assert.equal(e.status, "in_progress", "a quote isn't owed yet");
  assert.deepEqual([e.incurred, e.estimated], [100, 80], "bought is incurred; the quote is still estimated");
  const v = (await api(`/api/admin/expenses/${venue}`)).data.expense;
  assert.deepEqual([v.incurred, v.estimated], [4000, 0], "a booked balance is incurred even before it's paid");
  assert.equal((await api("/api/admin/expenses")).data.status_labels.in_progress, "In progress");
});

test("an item's cost is estimated until it's booked, then incurred; a cancelled one keeps only what was paid", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const make = async (body) => (await api("/api/admin/expenses", { method: "POST", body })).data.expense;
  const quote = await make({ item: "Band", unit_cost: 2500, status: "quote" });
  assert.deepEqual([quote.estimated, quote.incurred], [2500, 0]);
  const booked = await make({ item: "DJ", unit_cost: 1200, status: "booked" });
  assert.deepEqual([booked.estimated, booked.incurred], [0, 1200]);
  await api(`/api/admin/expenses/${quote.id}/payments`, { method: "POST", body: { amount: 200 } });
  const gone = (await api(`/api/admin/expenses/${quote.id}`, { method: "PUT", body: { status: "cancelled" } })).data.expense;
  assert.deepEqual([gone.estimated, gone.incurred], [0, 200], "the forfeited deposit is incurred");
});

test("an item saved at Booked with a deposit already paid is Partially paid", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const id = (await api("/api/admin/expenses", { method: "POST", body: { item: "Photographer", unit_cost: 3000, status: "booked" } })).data.expense.id;
  await api(`/api/admin/expenses/${id}/payments`, { method: "POST", body: { amount: 500 } });
  assert.equal((await api(`/api/admin/expenses/${id}`)).data.expense.status, "partially_paid");
  const back = await api(`/api/admin/expenses/${id}`, { method: "PUT", body: { status: "booked" } });
  assert.equal(back.data.expense.status, "partially_paid", "the deposit is still paid, so it can't go back to Booked");
});

test("upgrading moves Booked items with payments on them to Partially paid", async () => {
  const env = makeEnv();
  env.DB.db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('_schema_version', '6');
    CREATE TABLE expenses (id INTEGER PRIMARY KEY, parent_id INTEGER, status TEXT NOT NULL, updated_at TEXT, category TEXT, subcategory TEXT, item TEXT, pricing TEXT, unit_cost REAL, units REAL, quantity_source TEXT, quantity_factor REAL, round_up INTEGER, taxable INTEGER, gratuity_rate REAL, notes TEXT, source TEXT, baseline_total REAL);
    CREATE TABLE payments (id INTEGER PRIMARY KEY, expense_id INTEGER);
    INSERT INTO expenses (id, parent_id, status) VALUES (1, NULL, 'booked'), (2, NULL, 'booked'), (3, NULL, 'quote'), (4, 3, 'paid');
    INSERT INTO payments (expense_id) VALUES (1), (3), (4);
  `);
  assert.equal((await call(env, "/api/auth/me")).status, 401);
  const rows = env.DB.db.prepare("SELECT status FROM expenses ORDER BY id").all().map((r) => r.status);
  assert.deepEqual(rows, ["partially_paid", "booked", "estimate", "paid"], "an item with line items isn't moved on by its payments");
});

// Bug: Hair & Makeup, with a quote and an estimate under it, read "$875 spent · no
// budget set" -- nothing was spent, and we don't keep budgets.
test("an item with only a quote and an estimate under it has nothing incurred or paid", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const id = (await api("/api/admin/expenses", { method: "POST", body: { item: "Hair & Makeup" } })).data.expense.id;
  await api("/api/admin/expenses", { method: "POST", body: { parent_id: id, item: "Hair", unit_cost: 600, status: "quote" } });
  await api("/api/admin/expenses", { method: "POST", body: { parent_id: id, item: "Makeup", unit_cost: 275 } });
  const e = (await api(`/api/admin/expenses/${id}`)).data.expense;
  assert.deepEqual([e.estimated, e.incurred, e.paid, e.projected, e.status], [875, 0, 0, 875, "quote"]);
  assert.ok(!("budget" in e) && !("spent" in e));
});

test("upgrading turns an item's leftover budget into an estimate line item and clears the item's price", async () => {
  const env = makeEnv();
  env.DB.db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('_schema_version', '7');
    CREATE TABLE expenses (id INTEGER PRIMARY KEY, parent_id INTEGER, status TEXT NOT NULL, updated_at TEXT, category TEXT, subcategory TEXT,
      item TEXT, pricing TEXT, unit_cost REAL, units REAL, quantity_source TEXT, quantity_factor REAL, round_up INTEGER, taxable INTEGER,
      gratuity_rate REAL, notes TEXT, source TEXT, baseline_total REAL);
    INSERT INTO expenses (id, parent_id, status, item, pricing, unit_cost, units) VALUES
      (1, NULL, 'booked', 'Place Settings', 'fixed', 500, 1), (2, 1, 'paid', 'Plates', 'fixed', 120, 1),
      (3, NULL, 'estimate', 'Hair & Makeup', 'fixed', NULL, 1), (4, 3, 'quote', 'Hair', 'fixed', 600, 1),
      (5, NULL, 'paid', 'Favors', 'fixed', 90, 1), (6, 5, 'paid', 'Bags', 'fixed', 40, 1);
    CREATE TABLE payments (id INTEGER PRIMARY KEY, expense_id INTEGER);
  `);
  assert.equal((await call(env, "/api/auth/me")).status, 401);
  const rows = env.DB.db.prepare("SELECT id, parent_id, status, item, unit_cost FROM expenses ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(rows.find((r) => r.id === 1), { id: 1, parent_id: null, status: "estimate", item: "Place Settings", unit_cost: null });
  assert.deepEqual(rows.filter((r) => r.id > 6).map((r) => [r.parent_id, r.status, r.item, r.unit_cost]), [[1, "estimate", "Place Settings", 500]],
    "only an open item with a price gets one; a done item's budget was already ignored");
  assert.equal(rows.find((r) => r.id === 5).unit_cost, null);
  assert.equal(rows.find((r) => r.id === 5).status, "paid", "done buying stays done");
});

test("the expense form still updates an item itself in update mode", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const key = await formKeyFor(api);
  const id = (await api("/api/admin/expenses", { method: "POST", body: { item: "Florist", unit_cost: 800 } })).data.expense.id;
  await call(env, "/api/public/expense", { method: "POST", form: formOf({ key, expense_id: String(id), mode: "update", price: "950", status: "quote" }) });
  const e = (await api(`/api/admin/expenses/${id}`)).data.expense;
  assert.equal(e.current, 950);
  assert.equal(e.status, "quote");
  assert.equal(e.purchases, 0);
});

test("upgrading renames Partner to Kaitlyn in settings and payments, and seeds the vendor list", async () => {
  const env = makeEnv();
  env.DB.db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('_schema_version', '5');
    INSERT INTO settings VALUES ('payers', '["Patrick","Partner","Joint"]');
    CREATE TABLE expenses (id INTEGER PRIMARY KEY, vendor TEXT, payer TEXT, status TEXT NOT NULL DEFAULT 'estimate', updated_at TEXT, category TEXT, subcategory TEXT, item TEXT, pricing TEXT, unit_cost REAL, units REAL, quantity_source TEXT, quantity_factor REAL, round_up INTEGER, taxable INTEGER, gratuity_rate REAL, notes TEXT, source TEXT, baseline_total REAL);
    CREATE TABLE payments (id INTEGER PRIMARY KEY, expense_id INTEGER, payer TEXT);
    INSERT INTO expenses (id, vendor, payer) VALUES (1, ' Goodwill ', 'Partner'), (2, 'goodwill', NULL), (3, NULL, 'Patrick');
    INSERT INTO payments VALUES (1, 1, 'Partner');
  `);
  assert.equal((await call(env, "/api/auth/me")).status, 401);
  const db = env.DB.db;
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'payers'").get().value)[1], "Kaitlyn");
  assert.equal(db.prepare("SELECT payer FROM expenses WHERE id = 1").get().payer, "Kaitlyn");
  assert.equal(db.prepare("SELECT payer FROM payments WHERE id = 1").get().payer, "Kaitlyn");
  assert.deepEqual(db.prepare("SELECT name FROM vendors").all().map((v) => v.name), ["Goodwill"]);
});

test("a new install lists Kaitlyn as a payer", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  assert.ok((await api("/api/admin/settings")).data.settings.payers.includes("Kaitlyn"));
});

/* -------------------------------------------------------------------- RSVP tests -- */

async function rsvpSetup() {
  const env = makeEnv();
  const api = await adminClient(env);
  await api("/api/admin/import", { method: "POST", form: fixtureForm({ guests: 1 }) });
  const { households } = (await api("/api/admin/guests")).data;
  const jordan = households.find((h) => h.code === "H-002").guests[0];
  await api(`/api/admin/guests/${jordan.id}`, { method: "PUT", body: { plus_one_allowed: true, plus_one_name: "Casey Guest" } });
  return { env, api, households };
}

test("RSVP lookup finds a household by name, forgiving case, apostrophes and short first names", async () => {
  const { env } = await rsvpSetup();
  const r = await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "riley", last: "oplaceholder" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.matches[0].guests[0].first_name, "Riley");
  const nick = await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "Jor", last: "Sample" } });
  assert.equal(nick.status, 200);
  const tooShort = await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "Jo", last: "Sample" } });
  assert.equal(tooShort.status, 404);
  const byPlusOne = await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "Casey", last: "Guest" } });
  assert.equal(byPlusOne.status, 200, "a preloaded plus-one can find their host's invitation");
});

test("RSVP name search returns only names and picks, and a pick opens that guest's household", async () => {
  const { env } = await rsvpSetup();
  const r = await call(env, "/api/public/rsvp/search", { method: "POST", body: { q: "jor" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.results.map((x) => x.name), ["Jordan Sample"]);
  assert.deepEqual(Object.keys(r.data.results[0]).sort(), ["name", "pick"], "no ids, addresses or other fields");
  const lookup = await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { pick: r.data.results[0].pick } });
  assert.equal(lookup.status, 200, JSON.stringify(lookup.data));
  assert.equal(lookup.data.matches.length, 1);
  assert.equal(lookup.data.matches[0].guests[0].first_name, "Jordan");
  assert.ok(lookup.data.matches[0].token);
});

test("RSVP lookup won't open a household from a made-up or plain-id pick", async () => {
  const { env } = await rsvpSetup();
  assert.equal((await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { pick: "1" } })).status, 400);
  assert.equal((await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { pick: 1 } })).status, 400);
  // A real token of a different kind (an RSVP token) isn't a pick either.
  const rsvpToken = await sign(env, { kind: "rsvp", h: 1 }, 600);
  assert.equal((await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { pick: rsvpToken } })).status, 400);
});

test("RSVP name search is off while RSVPs are closed", async () => {
  const { env, api } = await rsvpSetup();
  await api("/api/admin/settings", { method: "PUT", body: { rsvp_open: false } });
  assert.equal((await call(env, "/api/public/rsvp/search", { method: "POST", body: { q: "jor" } })).status, 403);
});

test("RSVP lookup never exposes addresses, priority or budget fields", async () => {
  const { env } = await rsvpSetup();
  const r = await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "Alex", last: "Example" } });
  const text = JSON.stringify(r.data);
  for (const leak of ["Test St", "Springfield", "priority", "High", "side", "Groom"]) assert.ok(!text.includes(leak), `leaked ${leak}`);
});

test("only a guest given a plus-one sees or can add one", async () => {
  const { env } = await rsvpSetup();
  const jordan = (await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "Jordan", last: "Sample" } })).data.matches[0];
  assert.equal(jordan.guests[0].plus_one_allowed, true);
  assert.equal(jordan.guests[0].plus_one_name, "Casey Guest", "the preloaded plus-one name is shown");
  const alex = (await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "Alex", last: "Example" } })).data.matches[0];
  assert.ok(!("plus_one_name" in alex.guests[0]));

  // Alex tries to sneak in a plus-one anyway: ignored.
  const submit = await call(env, "/api/public/rsvp/submit", {
    method: "POST",
    body: {
      token: alex.token,
      guests: alex.guests.map((g) => ({ id: g.id, rsvp: "yes", plus_one_rsvp: "yes", plus_one_name: "Gatecrasher" })),
      email: "alex@example.com",
    },
  });
  assert.equal(submit.status, 200, JSON.stringify(submit.data));
  const env2 = env;
  const api = await adminClient(env2);
  const h = (await api("/api/admin/guests")).data.households.find((x) => x.code === "H-001");
  assert.equal(h.guests[0].rsvp, "yes");
  assert.equal(h.guests[0].plus_one_rsvp, "pending");
  assert.equal(h.guests[0].plus_one_name, null);
  assert.equal(h.email, "alex@example.com");
  assert.ok(h.rsvp_at);
});

test("an RSVP token for one household can't change another household's guests", async () => {
  const { env, households } = await rsvpSetup();
  const alex = (await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "Alex", last: "Example" } })).data.matches[0];
  const riley = households.find((h) => h.code === "H-003").guests[0];
  const r = await call(env, "/api/public/rsvp/submit", { method: "POST", body: { token: alex.token, guests: [{ id: riley.id, rsvp: "no" }] } });
  assert.equal(r.status, 400);
  const api = await adminClient(env);
  const after = (await api("/api/admin/guests")).data.households.find((h) => h.code === "H-003").guests[0];
  assert.equal(after.rsvp, "pending");
});

test("a plus-one RSVP counts toward confirmed guests", async () => {
  const { env, api } = await rsvpSetup();
  const jordan = (await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "Jordan", last: "Sample" } })).data.matches[0];
  await call(env, "/api/public/rsvp/submit", {
    method: "POST",
    body: { token: jordan.token, guests: [{ id: jordan.guests[0].id, rsvp: "yes", plus_one_rsvp: "yes", plus_one_name: "Casey Guest", dietary: "vegetarian" }] },
  });
  const counts = (await api("/api/admin/guests")).data.counts;
  assert.equal(counts.confirmed, 2);
});

test("resetting an RSVP puts the household back to awaiting reply so it can answer fresh", async () => {
  const { env, api } = await rsvpSetup();
  const jordan = (await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "Jordan", last: "Sample" } })).data.matches[0];
  await call(env, "/api/public/rsvp/submit", {
    method: "POST",
    body: { token: jordan.token, guests: [{ id: jordan.guests[0].id, rsvp: "yes", dietary: "vegan", plus_one_rsvp: "yes", plus_one_name: "Casey Guest" }], message: "See you there" },
  });
  const before = (await api("/api/admin/guests")).data.households.find((h) => h.code === "H-002");
  assert.ok(before.rsvp_at);

  const r = await api("/api/admin/households/reset-rsvp", { method: "POST", body: { ids: [before.id] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = (await api("/api/admin/guests")).data;
  const h = after.households.find((x) => x.code === "H-002");
  assert.equal(h.guests[0].rsvp, "pending");
  assert.equal(h.guests[0].plus_one_rsvp, "pending");
  assert.equal(h.guests[0].plus_one_allowed, 1, "the plus-one allowance survives a reset");
  assert.equal(h.guests[0].plus_one_name, null, "the plus-one's name goes back to blank for the next RSVP");
  assert.equal(h.guests[0].dietary, null);
  assert.equal(h.rsvp_at, null);
  assert.equal(h.rsvp_message, null);
  assert.equal(after.counts.confirmed, 0);
  const again = (await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "Jordan", last: "Sample" } })).data.matches[0];
  assert.equal(again.responded, false, "the RSVP page no longer says they've already replied");
});

test("closing RSVPs in settings stops lookups", async () => {
  const { env, api } = await rsvpSetup();
  await api("/api/admin/settings", { method: "PUT", body: { rsvp_open: false } });
  const r = await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "Alex", last: "Example" } });
  assert.equal(r.status, 403);
});

test("public info never includes budget settings", async () => {
  const env = makeEnv();
  const r = await call(env, "/api/public/info");
  assert.equal(r.status, 200);
  assert.ok(!("tax_rate" in r.data) && !("budget_target" in r.data) && !("payers" in r.data));
});

/* ------------------------------------------------------------ expense form tests -- */

test("the expense form refuses a missing or rotated key", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const link = (await api("/api/admin/form-link")).data.url;
  const key = new URL(link).searchParams.get("k");
  assert.equal((await call(env, "/api/public/expense/options?k=wrong")).status, 403);
  assert.equal((await call(env, `/api/public/expense/options?k=${key}`)).status, 200);
  await api("/api/admin/form-link", { method: "POST" });
  assert.equal((await call(env, `/api/public/expense/options?k=${key}`)).status, 403);
});

test("the expense form adds a new item with a payment", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const key = new URL((await api("/api/admin/form-link")).data.url).searchParams.get("k");
  const form = new FormData();
  for (const [k, v] of Object.entries({
    key,
    category: "Attire",
    item: "Tux",
    vendor: "Suit Co",
    status: "booked",
    price: "400",
    payment_amount: "100",
    paid_on: "2026-10-10",
    payer: "Patrick",
  })) form.append(k, v);
  const r = await call(env, "/api/public/expense", { method: "POST", form });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const detail = (await api(`/api/admin/expenses/${r.data.expense_id}`)).data;
  assert.equal(detail.expense.status, "partially_paid");
  assert.equal(detail.expense.vendor, "Suit Co");
  assert.equal(detail.payments[0].payer, "Patrick");
  assert.equal(detail.expense.source, "expense-form");
});

/* ------------------------------------------------------------------- Drive tests -- */

test("Drive sync creates each CSV once, then updates the same files in place", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  await api("/api/admin/import", { method: "POST", form: fixtureForm() });
  const { setSetting } = await import("../src/db.js");
  await setSetting(env, "_google_drive", { refresh_token: "rt", access_token: "at", expires_at: Date.now() + 3600e3, email: "a@example.com" });
  await setSetting(env, "_drive_folder", { id: "folder1", name: "Wedding" });

  const files = new Map();
  const drive = (url, init) => {
    if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
      const q = new URL(url).searchParams.get("q");
      const name = /name = '([^']+)'/.exec(q)?.[1];
      const found = files.get(name);
      return okJson({ files: found ? [{ id: found, name }] : [] });
    }
    if (url.includes("/upload/drive/v3/files?uploadType=multipart")) {
      const id = `file${files.size + 1}`;
      return init.body.text().then((text) => {
        const name = /"name":"([^"]+)"/.exec(text)[1];
        files.set(name, id);
        return okJson({ id, name });
      });
    }
    if (/\/upload\/drive\/v3\/files\/file\d+\?uploadType=media/.test(url) && init.method === "PATCH") return okJson({ id: "patched" });
    throw new Error(`unexpected fetch ${init.method || "GET"} ${url}`);
  };

  const first = await withFetch(drive, () => api("/api/admin/drive/sync", { method: "POST" }));
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual([...files.keys()].sort(), ["expenses.csv", "guests.csv", "payments.csv", "planning_numbers.csv", "price_history.csv"]);
  const second = await withFetch(drive, async (calls) => {
    const r = await api("/api/admin/drive/sync", { method: "POST" });
    assert.equal(calls.filter((c) => c.init.method === "PATCH").length, 5);
    assert.equal(calls.filter((c) => c.url.includes("uploadType=multipart")).length, 0);
    return r;
  });
  assert.equal(second.status, 200);
  const status = (await api("/api/admin/drive/status")).data;
  assert.equal(status.pending_changes, false);
});

test("guests.csv carries addresses and RSVP answers for each guest", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  await api("/api/admin/import", { method: "POST", form: fixtureForm({ guests: 1 }) });
  const { buildExports } = await import("../src/sync.js");
  const csv = (await buildExports(env))["guests.csv"];
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 5);
  assert.ok(lines[0].includes("address1") && lines[0].includes("rsvp") && lines[0].includes("thank_you_sent"));
  assert.ok(csv.includes("1 Test St"));
});

test("connecting Drive refuses a grant without the Drive scope", async () => {
  const env = makeEnv();
  const cookie = await sessionCookie(env);
  const state = await sign(env, { kind: "oauth", purpose: "drive", nonce: "d1" }, 600);
  const r = await withFetch(
    (url) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return okJson({ access_token: "at", refresh_token: "rt", scope: "openid email" });
      return okJson({ email: "admin@example.com", email_verified: true });
    },
    () => call(env, `/api/auth/callback?code=c&state=${encodeURIComponent(state)}`, { cookie: `${cookie}; wedding_oauth=d1` })
  );
  assert.match(r.headers.get("location"), /settings\.html\?error=/);
  const status = await (await adminClient(env))("/api/admin/drive/status");
  assert.equal(status.data.connected, false);
});

/* --------------------------------------------------------------- website copy -- */

import { cleanPage, contrastingColor, fontFacesFor, parseHtml, serialize } from "../src/site.js";

const SLUG = "testcouple2030";
// A made-up page shaped like Zola's server-rendered wedding site.
function zolaPage({ heading = "Welcome", extra = "", footer = true } = {}) {
  const data = { props: { pageProps: { pageData: { travel: { travels: [
    { name: "Grand Test Hotel", url: "https://grandtest.example/rooms", address_1: "1 Main St" },
  ] } } } } };
  return `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><title>Sam &amp; Alex&#x27;s Wedding Website</title>
<link rel="icon" href="https://cdn.zola.example/favicon.ico"/><link rel="preload" href="/x.js" as="script"/>
<link rel="stylesheet" href="https://d1tntvpcrzvon2.cloudfront.net/app.css"/>
<meta name="twitter:site" content="@zola"/><script>window.track=1</script></head>
<body><div id="__next"><div class="unified-nav hidden__x"><span>Loading</span></div>
<div style="background-color:#F5EFE8"><h2><a href="/wedding/${SLUG}">Sam &amp; Alex</a></h2>
<ul style="color:#89645C"><li><a href="/wedding/${SLUG}">Home</a></li><li><a href="/wedding/${SLUG}/travel">Travel</a></li>
<li><a href="/wedding/${SLUG}/registry">Registry</a></li><li><a href="/wedding/${SLUG}/rsvp">RSVP</a></li></ul>
<h1 style="font-family:&#x27;Libre Baskerville&#x27;;color:#89645C">${heading}</h1>
<div data-testid="WeddingCountdown"><span><span>10 days</span><span>10 d</span></span><span><span>2 hours</span><span>2 h</span></span><span><span>0 minutes</span><span>0 min</span></span><span><span>5 seconds</span><span>5 s</span></span></div>
<div class="card"><h3>Grand Test Hotel</h3><address>1 Main St<br/>Testville</address><div><button class="css-btn" style="color:#fff">View</button></div></div>
<div class="card"><h3>Mystery Place</h3><address>9 Elm Rd<br/>Testville</address><div><button>View</button></div></div>
<img src="//images.zola.com/abc?w=100"/><a href="/terms">Terms</a>${extra}</div>
${footer ? `<div class="css-wrap"><div class="css-foot"><div><svg><path d="M0 0"></path></svg></div><span>For all the days along the way</span>
<div><a href="/">About Zola</a><a href="mailto:support@zola.com">support@zola.com</a></div><div><span>© <!-- -->2030<!-- --> Zola, Inc. All rights reserved. </span></div></div></div>` : ""}
</div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script><script src="/app.js"></script></body></html>`;
}

test("the HTML parser round-trips a page byte for byte", () => {
  const src = zolaPage();
  assert.equal(serialize(parseHtml(src)), src.replace(/<(meta|link|img|br)([^>]*?)\/?>/g, "<$1$2/>"));
});

test("cleaning a Zola page strips Zola's app, branding and footer, and adds the RSVP pill", () => {
  const out = cleanPage(zolaPage(), { slug: SLUG, pages: new Set(["travel"]), fetchedAt: 1_000_000, currentPath: "/" });
  const html = out.html;
  assert.deepEqual(out.warnings, []);
  assert.equal(out.title, "Sam & Alex's Wedding Website");
  assert.ok(!/window\.track|__NEXT_DATA__|app\.js/.test(html), "no Zola scripts or page data");
  assert.ok(!html.includes("unified-nav"), "Zola's account bar is gone");
  assert.ok(!/For all the days|About Zola|Zola, Inc|css-wrap/.test(html), "the footer and its now-empty wrapper are gone");
  assert.ok(!/twitter:site|rel="preload"|cdn\.zola\.example\/favicon/.test(html));
  assert.ok(html.includes('<a class="wm-rsvp" href="/rsvp/">RSVP</a>'));
  assert.ok(html.indexOf("wm-rsvp-bar") < html.indexOf("Sam &amp; Alex</a>"), "the RSVP bar comes first");
  assert.ok(html.includes("app.css"), "Zola's stylesheet stays");
  assert.ok(html.includes("//images.zola.com/abc"), "images stay on Zola's CDN");
});

test("the copy's links point at its own pages, our RSVP page, and Zola for anything else", () => {
  const html = cleanPage(zolaPage(), { slug: SLUG, pages: new Set(["travel"]), currentPath: "/" }).html;
  assert.ok(html.includes('<a href="/" data-wm-nav="menu">Home</a>'));
  assert.ok(html.includes('<a href="/travel" data-wm-nav="menu">Travel</a>'));
  assert.ok(html.includes(`href="https://www.zola.com/wedding/${SLUG}/registry"`), "the registry stays on Zola, where gifts work");
  assert.ok(html.includes('<a href="/rsvp/">RSVP</a>'), "Zola's RSVP page becomes ours");
  assert.ok(html.includes('href="https://www.zola.com/terms"'), "other relative links go to Zola, not to us");
  // Our phone menu names "/" by its menu label, not the site title that also links home.
  const menu = /<nav id="wm-menu"[^>]*>(.*?)<\/nav>/.exec(html)[1];
  assert.ok(menu.startsWith('<a href="/" aria-current="page">Home</a>'), menu);
});

test('"View" buttons become links: the place\'s website by name, else its address on a map', () => {
  const html = cleanPage(zolaPage(), { slug: SLUG, pages: new Set(), currentPath: "/" }).html;
  assert.ok(/<a class="css-btn" href="https:\/\/grandtest\.example\/rooms" target="_blank"[^>]*>View<\/a>/.test(html));
  assert.ok(html.includes("https://www.google.com/maps/search/?api=1&amp;query=9%20Elm%20Rd%2C%20Testville")
    || html.includes("https://www.google.com/maps/search/?api=1&query=9%20Elm%20Rd%2C%20Testville"));
  assert.ok(!/<button[^>]*>View<\/button>/.test(html));
});

test("the countdown keeps ticking: its end time is worked out from what Zola showed", () => {
  const out = cleanPage(zolaPage(), { slug: SLUG, pages: new Set(), fetchedAt: 1_000_000, currentPath: "/" });
  const seconds = 10 * 86400 + 2 * 3600 + 5;
  assert.ok(out.html.includes(`data-wm-target="${1_000_000 + seconds * 1000}"`));
  const later = cleanPage(zolaPage(), { slug: SLUG, pages: new Set(), fetchedAt: 9_999_999, currentPath: "/" });
  assert.equal(out.hashSource, later.hashSource, "the countdown alone never counts as a change");
});

test("a page whose footer can't be found is still copied, with a warning", () => {
  const out = cleanPage(zolaPage({ footer: false, extra: "<p>Powered by Zola</p>" }), { slug: SLUG, pages: new Set(), currentPath: "/" });
  assert.ok(out.warnings.some((w) => /footer/.test(w)));
  assert.ok(out.warnings.some((w) => /"Zola" still appears 1 time/.test(w)));
});

test("the RSVP pill's automatic color sits opposite the theme's color", () => {
  assert.equal(contrastingColor("#89645c"), "hsl(191 35% 30%)");
  const html = cleanPage(zolaPage(), { slug: SLUG, pages: new Set(), rsvpColor: "#123456", currentPath: "/" }).html;
  assert.ok(html.includes("background:#123456"), "a color set in Settings wins");
});

test("only the fonts the page uses are inlined, pointed at our font route", () => {
  const css = `@font-face{font-family:'Libre Baskerville';src:url('https://d1tntvpcrzvon2.cloudfront.net/static-assets/fonts/LB.ttf')}
@font-face{font-family:'Unused Font';src:url('https://d1tntvpcrzvon2.cloudfront.net/static-assets/fonts/U.ttf')}`;
  const faces = fontFacesFor(css, zolaPage());
  assert.ok(faces.includes("url('/_site/fonts/LB.ttf')"));
  assert.ok(!faces.includes("Unused"));
});

function zolaFetch(pages, calls = []) {
  return (url) => {
    calls.push(url);
    if (url.endsWith("fonts.css")) return new Response("@font-face{font-family:'Libre Baskerville';src:url('x')}");
    const key = url.replace(`https://www.zola.com/wedding/${SLUG}`, "") || "/";
    if (pages[key] === undefined) return new Response("nope", { status: 404 });
    return new Response(pages[key], { headers: { "content-type": "text/html" } });
  };
}

test("Refresh from Zola copies the home page and its own pages, but not the registry or RSVP", async () => {
  const env = makeEnv({ ZOLA_URL: `https://www.zola.com/wedding/${SLUG}` });
  const api = await adminClient(env);
  const calls = [];
  const r = await withFetch(zolaFetch({ "/": zolaPage(), "/travel": zolaPage({ heading: "Getting there" }) }, calls), () =>
    api("/api/admin/site/refresh", { method: "POST" }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.status.pages.map((p) => p.path), ["/", "/travel"]);
  assert.ok(!calls.some((u) => /registry|\/rsvp/.test(u)), "registry and RSVP pages aren't fetched");
  const home = await call(env, "/");
  assert.equal(home.status, 200);
  assert.ok(home.data.includes("wm-rsvp"));
  const travel = await call(env, "/travel");
  assert.ok(travel.data.includes("Getting there"));
  assert.equal((await call(env, "/travel/")).status, 200, "a trailing slash finds the same page");
  assert.equal(await (await call(env, "/registry")).data, "asset", "anything not copied falls through to the static files");
});

test("a refresh only marks the site changed when Zola's content changed", async () => {
  const env = makeEnv({ ZOLA_URL: `https://www.zola.com/wedding/${SLUG}` });
  const api = await adminClient(env);
  const pages = { "/": zolaPage(), "/travel": zolaPage({ heading: "Getting there" }) };
  const first = await withFetch(zolaFetch(pages), () => api("/api/admin/site/refresh", { method: "POST" }));
  assert.equal(first.data.status.changed, true);
  const same = await withFetch(zolaFetch(pages), () => api("/api/admin/site/refresh", { method: "POST" }));
  assert.equal(same.data.status.changed, false, "nothing changed on Zola");
  assert.equal(same.data.status.changed_at, first.data.status.changed_at);
  pages["/travel"] = zolaPage({ heading: "New hotel block!" });
  const edited = await withFetch(zolaFetch(pages), () => api("/api/admin/site/refresh", { method: "POST" }));
  assert.equal(edited.data.status.changed, true);
  assert.ok((await call(env, "/travel")).data.includes("New hotel block!"));
  // Zola drops the travel page: so do we.
  const noTravel = zolaPage().replace(`<li><a href="/wedding/${SLUG}/travel">Travel</a></li>`, "");
  await withFetch(zolaFetch({ "/": noTravel }), () => api("/api/admin/site/refresh", { method: "POST" }));
  assert.equal((await call(env, "/travel")).data, "asset");
});

test("a failed refresh keeps the last good copy up and says why", async () => {
  const env = makeEnv({ ZOLA_URL: `https://www.zola.com/wedding/${SLUG}` });
  const api = await adminClient(env);
  // The home page links to /travel, which 404s: one broken page doesn't sink the refresh.
  const partial = await withFetch(zolaFetch({ "/": zolaPage() }), () => api("/api/admin/site/refresh", { method: "POST" }));
  assert.equal(partial.status, 200, JSON.stringify(partial.data));
  assert.ok(partial.data.status.warnings.some((w) => /^\/travel: couldn't fetch it/.test(w)));
  const failed = await withFetch(() => new Response("blocked", { status: 403 }), () => api("/api/admin/site/refresh", { method: "POST" }));
  assert.equal(failed.status, 400);
  assert.match(failed.data.error, /403/);
  assert.equal((await call(env, "/")).status, 200, "the previous copy is still served");
  const status = (await api("/api/admin/site/status")).data.status;
  assert.match(status.error, /403/);
});

test("with no copy yet, the home page is the RSVP page", async () => {
  const env = makeEnv();
  const r = await call(env, "/");
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /\/rsvp\/$/);
  assert.equal((await call(env, "/rsvp/")).data, "asset", "/rsvp/ is the static RSVP page");
});

const INGEST = "s3cret-ingest-value";
const siteEnv = (extra = {}) => makeEnv({ ZOLA_URL: `https://www.zola.com/wedding/${SLUG}`, ZOLA_INGEST_SECRET: INGEST, ...extra });
const ingest = (env, payload, secret = INGEST) => call(env, "/api/site/ingest", {
  method: "POST", body: payload, headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

test("the GitHub Action's routes need the shared secret", async () => {
  const env = siteEnv();
  assert.equal((await call(env, "/api/site/config")).status, 401);
  assert.equal((await call(env, "/api/site/config", { headers: { authorization: "Bearer nope" } })).status, 401);
  const ok = await call(env, "/api/site/config", { headers: { authorization: `Bearer ${INGEST}` } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.zola_url, `https://www.zola.com/wedding/${SLUG}`);
  assert.equal((await ingest(env, { pages: [] }, "nope")).status, 401);
  // Not set up at all: say so rather than accept anything.
  assert.equal((await call(makeEnv(), "/api/site/config", { headers: { authorization: "Bearer " } })).status, 503);
});

test("a site built on GitHub is stored and served, and resending it isn't a change", async () => {
  const { buildSite } = await import("../src/site.js");
  const env = siteEnv();
  const built = await buildSite({ zolaUrl: `https://www.zola.com/wedding/${SLUG}`, fetchPage: async (url) => {
    if (url.endsWith("fonts.css")) return "";
    if (url.endsWith("/travel")) return zolaPage({ heading: "Getting there" });
    if (url.endsWith(SLUG)) return zolaPage();
    throw new Error(`Zola returned 404 for ${url}`);
  } });
  const first = await ingest(env, JSON.parse(JSON.stringify(built)));
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.status.source, "github");
  assert.equal(first.data.status.changed, true);
  assert.ok((await call(env, "/travel")).data.includes("Getting there"));
  const again = await ingest(env, JSON.parse(JSON.stringify(built)));
  assert.equal(again.data.status.changed, false);
});

// Bug: with Zola's footer taken off, the copied pages ended flush at the last section,
// with no footer and no way to get in touch.
test("copied pages get our footer with a Contact us link from Settings, as they're served", async () => {
  const { buildSite } = await import("../src/site.js");
  const env = siteEnv();
  const built = await buildSite({ zolaUrl: `https://www.zola.com/wedding/${SLUG}`, fetchPage: async (url) => {
    if (url.endsWith("fonts.css")) return "";
    if (url.endsWith(SLUG)) return zolaPage();
    throw new Error(`Zola returned 404 for ${url}`);
  } });
  assert.equal((await ingest(env, JSON.parse(JSON.stringify(built)))).status, 200);
  let page = (await call(env, "/")).data;
  assert.match(page, /<footer class="wm-footer">.*href="mailto:patricko\.indy@gmail\.com">Contact us<\/a>.*<\/footer><script>.*<\/script><\/body>/s);
  assert.ok(!page.slice(page.indexOf("wm-footer")).includes('href="/rsvp/"'), "the footer's only link is Contact us; RSVP lives in the menu row");
  const api = await adminClient(env);
  assert.equal((await api("/api/admin/settings", { method: "PUT", body: { contact_email: "not an email" } })).status, 400);
  await api("/api/admin/settings", { method: "PUT", body: { contact_email: "us@example.com", couple_names: "A & <B>" } });
  page = (await call(env, "/")).data;
  assert.ok(page.includes('href="mailto:us@example.com"'), "a new address shows without a refresh");
  assert.ok(page.includes("<p>A &#38; &#60;B&#62;</p>"), "names are escaped");
  assert.equal((await call(env, "/api/public/info")).data.contact_email, "us@example.com");
  await api("/api/admin/settings", { method: "PUT", body: { contact_email: "" } });
  assert.ok(!(await call(env, "/")).data.includes("mailto:"), "no address, no link");
});

// Bug: on an iPad the RSVP pill stayed centered at the top, because pages copied before
// the pill learned to sit in the menu row carried the old script with them.
test("pages get the current page script as they're served, replacing any copy stored with them", async () => {
  const { PAGE_SCRIPT } = await import("../src/site.js");
  const env = siteEnv();
  const oldScript = `${PAGE_SCRIPT.slice(0, 60)}/* an older version */})();`;
  await ingest(env, { pages: [{ path: "/", title: "t", html: `<html><body><p>home</p><script>${oldScript}</script></body></html>`, hash: "c".repeat(64) }] });
  const page = (await call(env, "/")).data;
  assert.ok(!page.includes("an older version"), "the stored copy is gone");
  assert.equal(page.split(PAGE_SCRIPT).length, 2, "the current script appears once");
  assert.ok(PAGE_SCRIPT.includes("wm-in-nav") && PAGE_SCRIPT.includes("br.right-24-w-16<row.right"), "the pill only joins the menu row when it fits");
});

test("the ingest route only accepts pages the site would make itself", async () => {
  const env = siteEnv();
  const page = (path, extra = {}) => ({ path, title: "t", html: "<p>x</p>", hash: "a".repeat(64), ...extra });
  for (const [payload, why] of [
    [{ pages: [page("/admin")] }, "a reserved path"],
    [{ pages: [page("/"), page("/../etc")] }, "a path that isn't a simple page name"],
    [{ pages: [page("/travel")] }, "no home page"],
    [{ pages: [page("/", { hash: "zz" })] }, "a bad hash"],
    [{ pages: [page("/", { html: "x".repeat(1_500_001) })] }, "oversized HTML"],
    [{ pages: [] }, "no pages"],
  ]) {
    assert.equal((await ingest(env, payload)).status, 400, why);
  }
  assert.equal((await call(env, "/")).status, 302, "nothing was stored");
});

test("when GitHub can't reach Zola it reports why, and the last copy stays up", async () => {
  const env = siteEnv();
  await ingest(env, { pages: [{ path: "/", title: "t", html: "<p>home</p>", hash: "b".repeat(64) }] });
  const r = await ingest(env, { error: "Zola returned 403 for https://www.zola.com/wedding/x" });
  assert.equal(r.status, 200);
  assert.match(r.data.status.error, /GitHub couldn't refresh it: Zola returned 403/);
  assert.ok((await call(env, "/")).data.startsWith("<p>home</p>"));
});

test("Refresh from Zola starts the GitHub workflow when it's set up, without fetching Zola itself", async () => {
  const env = siteEnv({ GH_DISPATCH_TOKEN: "gh-token", GITHUB_REPO: "owner/wedding" });
  const api = await adminClient(env);
  const r = await withFetch((url, init) => {
    assert.equal(url, "https://api.github.com/repos/owner/wedding/actions/workflows/zola-refresh.yml/dispatches");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.authorization, "Bearer gh-token");
    assert.deepEqual(JSON.parse(init.body), { ref: "main" });
    return new Response(null, { status: 204 });
  }, async (calls) => {
    const res = await api("/api/admin/site/refresh", { method: "POST" });
    assert.equal(calls.length, 1, "only GitHub is called");
    return res;
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.requested, true);
  assert.ok(r.data.status.requested_at);
  assert.equal((await api("/api/admin/site/status")).data.via_github, true);
  const refused = await withFetch(() => new Response("Bad credentials", { status: 401 }), () => api("/api/admin/site/refresh", { method: "POST" }));
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /PANEL_GITHUB_TOKEN/);
});

test("without the GitHub setup, a 403 from Zola explains what to set up", async () => {
  const env = siteEnv();
  const api = await adminClient(env);
  const r = await withFetch(() => new Response("blocked", { status: 403 }), () => api("/api/admin/site/refresh", { method: "POST" }));
  assert.equal(r.status, 400);
  assert.match(r.data.error, /refuses requests from Cloudflare/);
});

test("the font route only serves font files from Zola's font folder", async () => {
  const env = makeEnv();
  const seen = [];
  await withFetch((url) => { seen.push(url); return new Response("FONT"); }, async () => {
    assert.equal((await call(env, "/_site/fonts/Radiograph-Regular.otf")).data, "FONT");
    assert.equal((await call(env, "/_site/fonts/..%2Fsecret.otf")).status, 404);
    assert.equal((await call(env, "/_site/fonts/evil.js")).status, 404);
  });
  assert.deepEqual(seen, ["https://d1tntvpcrzvon2.cloudfront.net/static-assets/fonts/Radiograph-Regular.otf"]);
});

test("Settings only accepts a Zola wedding address and a hex RSVP color", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  assert.equal((await api("/api/admin/settings", { method: "PUT", body: { zola_url: "https://evil.example/wedding/x" } })).status, 400);
  assert.equal((await api("/api/admin/settings", { method: "PUT", body: { rsvp_button_color: "red" } })).status, 400);
  const ok = await api("/api/admin/settings", { method: "PUT", body: { zola_url: `https://www.zola.com/wedding/${SLUG}/`, rsvp_button_color: "#2F5D62" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.settings.zola_url, `https://www.zola.com/wedding/${SLUG}`);
});

/* ------------------------------------------------------------------------- runner -- */
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${error.stack.split("\n").slice(0, 4).join("\n     ")}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
