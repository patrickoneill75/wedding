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
import { sign, verify } from "../src/auth.js";
import { buildContext, drinksPlan, enrichExpense, guestCounts, mergeSettings, statusAfterPayment } from "../src/calc.js";
import { buildExports, toCsv } from "../src/sync.js";
import { sqlValue } from "../src/importer.js";
import { normalizeName, searchGuests } from "../src/public_api.js";
import { buildIcs, cleanEvents, zonedTime } from "../src/calendar.js";
import { fillIn, processComms, SEND_BATCH } from "../src/comms.js";
import { htmlToText, sanitizeHtml, themeFrom } from "../src/email_html.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "sample_wedding.xlsx");
const ROOT = path.join(HERE, "..");

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
  // Like D1, a batch is one transaction: all of it applies, or none of it.
  async batch(statements) {
    const out = [];
    this.db.exec("BEGIN");
    try {
      for (const s of statements) out.push(await s.run());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
  // The expense chat streams newline-delimited events: report the last ("done" or
  // "error") with the text that streamed before it.
  if ((response.headers.get("content-type") || "").includes("ndjson")) {
    const events = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const last = events[events.length - 1] || {};
    data = { ...last, streamed: events.filter((e) => e.type === "text").map((e) => e.text).join(""), events };
    return { status: response.status, data, headers: response.headers };
  }
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
  assert.deepEqual(guests.counts.invites, { ceremony: 2, reception: 5 }, "Jordan's plus-one counts for the reception, as in Head count");
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
  CREATE TABLE payments (id INTEGER PRIMARY KEY, expense_id INTEGER, payer TEXT);
  CREATE TABLE households (id INTEGER PRIMARY KEY);`;

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

// Bug guard: bulk actions bound one SQL parameter per household, and D1 refuses more
// than 100, so selecting 100+ households failed.
test("bulk actions work on more than 100 households", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    const statement = prepare(sql);
    const bind = statement.bind.bind(statement);
    statement.bind = (...params) => {
      if (params.length > 100) throw new Error("too many SQL variables");
      return bind(...params);
    };
    return statement;
  };
  const rows = Array.from({ length: 120 }, (_, i) => `('H-${i + 1}', 'Household ${i + 1}')`).join(", ");
  await call(env, "/api/auth/me");
  env.DB.db.exec(`INSERT INTO households (code, display_name) VALUES ${rows}`);
  env.DB.db.exec("INSERT INTO guests (household_id, first_name, last_name) SELECT id, 'G', 'Test' FROM households");
  const ids = env.DB.db.prepare("SELECT id FROM households").all().map((r) => r.id);
  assert.equal((await api("/api/admin/households/bulk", { method: "POST", body: { ids, field: "invite_sent", value: true } })).status, 200);
  assert.equal((await api("/api/admin/guests/bulk", { method: "POST", body: { household_ids: ids, field: "invite_ceremony", value: true } })).status, 200);
  assert.equal((await api("/api/admin/households/reset-rsvp", { method: "POST", body: { ids } })).status, 200);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM households WHERE invite_sent = 1").get().n, 120);
});

// Bug guards: a blank guest card saved a nameless guest who counted in the budget; a
// guest added later jumped ahead of imported ones; the import put a row with no
// Household ID into another family's household, lost a US ZIP's leading zero when the
// country was filled in, and dropped "groom" or "low" typed in lower case.
test("guests: no nameless guests, added guests go last, and the import keeps households, ZIPs and case straight", async () => {
  const { parseGuests } = await import("../src/importer.js");
  const env = makeEnv();
  const api = await adminClient(env);
  await api("/api/admin/import", { method: "POST", form: fixtureForm({ guests: 1 }) });
  const h3 = (await api("/api/admin/guests")).data.households.find((h) => h.code === "H-003");
  assert.equal((await api("/api/admin/guests", { method: "POST", body: { household_id: h3.id, first_name: " ", last_name: "" } })).status, 400);
  await api("/api/admin/guests", { method: "POST", body: { household_id: h3.id, first_name: "Newer", last_name: "Test" } });
  const names = (await api("/api/admin/guests")).data.households.find((h) => h.code === "H-003").guests.map((g) => g.first_name);
  assert.equal(names[names.length - 1], "Newer");
  const made = await api("/api/admin/households", { method: "POST", body: { display_name: "Blank card", guests: [{ first_name: "Ann" }, { first_name: "", last_name: "" }] } });
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM guests WHERE household_id = ?").get(made.data.id).n, 1);

  const sheet = new Map(Object.entries({
    A1: { v: "Household ID" }, B1: { v: "First" }, C1: { v: "Last" }, D1: { v: "Full Name(s)" }, E1: { v: "Zip" }, F1: { v: "Country" }, G1: { v: "Priority" }, H1: { v: "Bride/Groom" },
    B2: { v: "Ann" }, C2: { v: "Blank" }, D2: { v: "Ann Blank" }, E2: { v: 2134 }, F2: { v: "USA" }, G2: { v: "low" }, H2: { v: "groom" },
    A3: { v: "H-001" }, B3: { v: "Bo" }, C3: { v: "Typed" }, D3: { v: "Bo Typed" },
  }));
  const parsed = parseGuests(sheet);
  assert.deepEqual(parsed.guests.map((g) => [g.first_name, g.household_code, g.priority, g.side]), [["Ann", "H-002", "Low", "Groom"], ["Bo", "H-001", "High", null]]);
  assert.equal(parsed.households.find((h) => h.code === "H-002").zip, "02134");
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
  assert.deepEqual(counts.invites, { ceremony: 4, reception: 5 }, "plus-ones included");
  await api("/api/admin/guests/bulk", { method: "POST", body: { household_ids: ids, field: "invite_reception", value: false } });
  counts = (await api("/api/admin/guests")).data.counts;
  assert.deepEqual(counts.invites, { ceremony: 4, reception: 1 }, "ceremony and reception switch independently");
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

// The expense form used to take a key in its link; it now takes the admin sign-in.
async function formKeyFor() {
  return "";
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
  const r = await api("/api/public/expense", { method: "POST", form: formOf({
    key, expense_id: String(parent), mode: "purchase", item: "Glasses", vendor: "Target", price: "45", status: "paid",
    payment_amount: "999", paid_on: "2026-03-04", payer: "Kaitlyn", method: "Credit card",
  }) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const kid = (await api(`/api/admin/expenses/${r.data.expense_id}`)).data;
  assert.equal(kid.expense.parent_id, parent);
  assert.equal(kid.expense.vendor, "Target");
  assert.deepEqual(kid.payments.map((p) => [p.amount, p.paid_on, p.payer, p.method]), [[45, "2026-03-04", "Kaitlyn", "Credit card"]],
    "at the Paid stage the price is what's paid; a typed-in amount is ignored");
  const options = (await api(`/api/public/expense/options?k=${key}`)).data;
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
  const r = await api("/api/public/expense", { method: "POST", form: formOf({ key, expense_id: String(id), mode: "update", price: "1", status: "quote" }) });
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
    CREATE TABLE households (id INTEGER PRIMARY KEY);
    CREATE TABLE guests (id INTEGER PRIMARY KEY, household_id INTEGER);
    CREATE TABLE vendors (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT);
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
    CREATE TABLE households (id INTEGER PRIMARY KEY);
    CREATE TABLE guests (id INTEGER PRIMARY KEY, household_id INTEGER);
    CREATE TABLE vendors (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT);
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
  await api("/api/public/expense", { method: "POST", form: formOf({ key, expense_id: String(id), mode: "update", price: "950", status: "quote" }) });
  const e = (await api(`/api/admin/expenses/${id}`)).data.expense;
  assert.equal(e.current, 950);
  assert.equal(e.status, "quote");
  assert.equal(e.purchases, 0);
});

/* ------------------------------------------------------ conversational form -- */

/** A streamed Messages API reply, as server-sent events, for the given content blocks. */
function claudeReply(content, stop_reason = "end_turn") {
  const events = [{ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [] } }];
  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      // Two pieces, so the test sees text arrive in parts.
      const half = Math.ceil(block.text.length / 2);
      for (const text of [block.text.slice(0, half), block.text.slice(half)]) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
    } else if (block.type === "tool_use") {
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      const json = JSON.stringify(block.input);
      const half = Math.ceil(json.length / 2);
      for (const partial_json of [json.slice(0, half), json.slice(half)]) events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason } }, { type: "message_stop" });
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const proposeCall = (input, id = "toolu_1") => ({ type: "tool_use", id, name: "propose_expense", input: {
  mode: "new", expense_id: null, item: null, category: null, subcategory: null, vendor: null, stage: "paid", price: null, quantity: 1,
  taxable: false, gratuity_percent: 0, due_date: null, payment_amount: null, paid_on: null, payer: null, notes: null, ...input,
} });

test("the conversational form needs the sign-in, and says when Claude isn't set up", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const key = await formKeyFor(api);
  const messages = [{ role: "user", content: "glassware" }];
  assert.equal((await call(env, "/api/public/expense/chat", { method: "POST", body: { messages } })).status, 401, "signed out");
  const r = await api("/api/public/expense/chat", { method: "POST", body: { key, messages } });
  assert.equal(r.status, 503);
  assert.equal(r.data.setup, true);
});

// Bug: searching the form for "glassware" found nothing, so it went in as a new item
// when it belonged under Place Settings.
test("Claude sees the items, line items and vendors, and its proposal saves through the expense form", async () => {
  const env = makeEnv({ ANTHROPIC_API_KEY: "sk-test" });
  const api = await adminClient(env);
  const key = await formKeyFor(api);
  const ps = (await api("/api/admin/expenses", { method: "POST", body: { category: "Ceremony & Reception", subcategory: "Decor", item: "Place Settings" } })).data.expense.id;
  await api("/api/admin/expenses", { method: "POST", body: { parent_id: ps, item: "Plates", vendor: "Goodwill", unit_cost: 38.5, status: "paid" } });
  const r = await withFetch(async (url, init) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(init.headers["x-api-key"], "sk-test");
    const req = JSON.parse(init.body);
    assert.equal(req.model, "claude-sonnet-5-5");
    assert.equal(req.stream, true);
    assert.deepEqual(req.thinking, { type: "between_tools" });
    assert.equal(req.fallbacks, "default");
    const sys = req.system.map((b) => b.text).join("\n");
    assert.match(sys, new RegExp(`#${ps} Place Settings · Ceremony & Reception › Decor`));
    assert.match(sys, /Plates · Goodwill · Paid · \$38\.50/);
    assert.match(sys, /Signed in and filling this in: Kaitlyn/);
    // Asked for: she's signed in, so don't ask who made the purchase.
    assert.match(sys, /Unless they say someone else paid, Kaitlyn paid: set payer to Kaitlyn and don't ask\./);
    assert.match(sys, /Never ask who paid/);
    assert.ok(!("method" in req.tools[0].input_schema.properties), "no payment method");
    // Asked for: a new line item under the item it fits, rather than changing that item.
    assert.match(sys, /By default, record an expense as a new line item/);
    assert.equal(req.tools[0].input_schema.properties.mode.enum[0], "line_item");
    return claudeReply([
      { type: "text", text: "That sounds like it goes under Place Settings." },
      proposeCall({ mode: "line_item", expense_id: ps, item: "Glassware", vendor: "Target", price: 45, paid_on: "2026-10-18" }),
    ], "tool_use");
  }, () => api("/api/public/expense/chat", { method: "POST", body: { key, who: "Kaitlyn", today: "2026-10-18", messages: [{ role: "user", content: "bought glassware at target, $45" }] } }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.type, "done");
  assert.equal(r.data.reply, "That sounds like it goes under Place Settings.");
  assert.equal(r.data.streamed, "That sounds like it goes under Place Settings.", "the reply streams to the page as it's written");
  assert.ok(r.data.events.filter((e) => e.type === "text").length >= 2);
  assert.equal(r.data.messages.length, 2, "the browser gets the conversation back to send next time");
  const { form, summary } = r.data.proposal;
  assert.deepEqual([form.mode, form.expense_id, form.item, form.status, form.price], ["purchase", String(ps), "Glassware", "paid", "45"]);
  assert.deepEqual(summary[0], ["Line item", "Glassware, under Place Settings"]);

  const saved = await api("/api/public/expense", { method: "POST", form: formOf({ key, submitted_by: "Kaitlyn", ...Object.fromEntries(Object.entries(form).filter(([, v]) => v !== "")) }) });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const kid = (await api(`/api/admin/expenses/${saved.data.expense_id}`)).data;
  assert.equal(kid.expense.parent_id, ps);
  assert.deepEqual(kid.payments.map((p) => [p.amount, p.payer]), [[45, "Kaitlyn"]], "the signed-in person paid, without being asked");
});

test("when Claude is unavailable, the chat says so instead of hanging", async () => {
  const env = makeEnv({ ANTHROPIC_API_KEY: "sk-test" });
  const api = await adminClient(env);
  const key = await formKeyFor(api);
  const r = await withFetch(async () => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529 }),
    () => api("/api/public/expense/chat", { method: "POST", body: { key, messages: [{ role: "user", content: "cake $400" }] } }));
  assert.equal(r.data.type, "error");
  assert.match(r.data.error, /Claude couldn't answer \(Overloaded\)/);
});

test("a proposal that doesn't check out goes back to Claude to fix before anyone sees it", async () => {
  const env = makeEnv({ ANTHROPIC_API_KEY: "sk-test" });
  const api = await adminClient(env);
  const key = await formKeyFor(api);
  const dj = (await api("/api/admin/expenses", { method: "POST", body: { category: "Entertainment", item: "DJ", unit_cost: 1200, status: "booked" } })).data.expense.id;
  const r = await withFetch(async (url, init, calls) => {
    const req = JSON.parse(init.body);
    if (calls.length === 1) return claudeReply([proposeCall({ mode: "update", expense_id: 9999, stage: "booked", payment_amount: 300 })], "tool_use");
    const last = req.messages[req.messages.length - 1].content[0];
    assert.equal(last.type, "tool_result");
    assert.equal(last.is_error, true);
    assert.match(last.content, /#9999 isn't an open item/);
    return claudeReply([proposeCall({ mode: "update", expense_id: dj, stage: "booked", price: 1200, payment_amount: 300, payer: "Patrick" }, "toolu_2")], "tool_use");
  }, () => api("/api/public/expense/chat", { method: "POST", body: { key, who: "Patrick", messages: [{ role: "user", content: "paid the DJ a $300 deposit" }] } }));
  assert.equal(r.status, 200);
  assert.equal(r.data.proposal.tool_use_id, "toolu_2");
  assert.deepEqual([r.data.proposal.form.mode, r.data.proposal.form.payment_amount], ["update", "300"]);
});

// Bug: "messages.2: tool_use ids were found without tool_result blocks immediately
// after" -- a reply that held two proposals, or one replied to without the page
// answering it, broke the next turn.
test("every proposal in the conversation is answered before it goes back to Claude, and Claude proposes one at a time", async () => {
  const env = makeEnv({ ANTHROPIC_API_KEY: "sk-test" });
  const api = await adminClient(env);
  const key = await formKeyFor(api);
  const messages = [
    { role: "user", content: "receipt from target: glasses $45, napkins $20" },
    { role: "assistant", content: [{ type: "text", text: "Two things:" }, proposeCall({ item: "Glasses", category: "Decor", price: 45 }, "t1"), proposeCall({ item: "Napkins", category: "Decor", price: 20 }, "t2")] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Not saved. They replied instead:" }, { type: "text", text: "put both under Place Settings" }] },
  ];
  let sent;
  const r = await withFetch(async (url, init) => {
    sent = JSON.parse(init.body);
    return claudeReply([{ type: "text", text: "Which first?" }]);
  }, () => api("/api/public/expense/chat", { method: "POST", body: { key, messages } }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(sent.tool_choice, { type: "auto", disable_parallel_tool_use: true });
  const answer = sent.messages[2].content;
  assert.deepEqual(answer.map((b) => b.type), ["tool_result", "tool_result", "text"], "results first, then the reply");
  assert.deepEqual(answer.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id).sort(), ["t1", "t2"]);
  // A plain-text reply to a proposal gets its answer too.
  const plain = await withFetch(async (url, init) => { sent = JSON.parse(init.body); return claudeReply([{ type: "text", text: "ok" }]); },
    () => api("/api/public/expense/chat", { method: "POST", body: { key, messages: [messages[0], messages[1], { role: "user", content: "never mind" }] } }));
  assert.equal(plain.status, 200);
  assert.deepEqual(sent.messages[2].content.map((b) => b.type), ["tool_result", "tool_result", "text"]);
});

// Bug guards for the expense form and chat: a bad payment amount used to fail after the
// item was saved (so Save again duplicated it); a "new item" carrying an id saved over
// that item; an update's tax and tip never saved; an update always reset the units.
test("expense form: payment checked before saving, new items never overwrite, updates keep units and add tax", async () => {
  const { checkProposal } = await import("../src/intake.js");
  const env = makeEnv();
  const api = await adminClient(env);
  const post = (fields) => api("/api/public/expense", { method: "POST", form: formOf(fields) });
  const count = () => env.DB.db.prepare("SELECT COUNT(*) AS n FROM expenses").get().n;
  assert.equal((await post({ item: "Florist", status: "quote", price: "500", payment_amount: "-200" })).status, 400);
  assert.equal(count(), 0, "nothing saved before the bad amount was caught");
  const florist = (await post({ item: "Florist", status: "quote", price: "500", payment_amount: "0" })).data.expense_id;
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM payments").get().n, 0, "0 paid is no payment");

  const catering = (await api("/api/admin/expenses", { method: "POST", body: { category: "Food", item: "Catering", pricing: "variable", quantity_source: "guests", unit_cost: 80, status: "quote" } })).data.expense.id;
  const expenses = (await api("/api/admin/expenses")).data.expenses;
  const settings = { payers: ["Patrick"], payment_methods: [] };
  const base = { mode: "new", expense_id: florist, item: "Cake", category: "Food", subcategory: null, vendor: null, stage: "quote", price: 300, quantity: 1,
    taxable: false, gratuity_percent: 0, due_date: null, payment_amount: 0, paid_on: null, payer: null, notes: null };
  const fresh = checkProposal(base, expenses, settings);
  assert.deepEqual([fresh.form.expense_id, fresh.form.payment_amount], ["", ""]);
  const viaForm = await post({ ...fresh.form, mode: "", expense_id: String(florist) });
  assert.equal(viaForm.status, 201);
  assert.notEqual(viaForm.data.expense_id, florist, "a new item never saves over the item named by the id");
  assert.equal((await api(`/api/admin/expenses/${florist}`)).data.expense.item, "Florist");

  const update = checkProposal({ ...base, mode: "update", expense_id: catering, item: null, category: null, price: 85, quantity: null, taxable: true, gratuity_percent: 20 }, expenses, settings);
  assert.equal(update.form.units, "", "an update without a quantity keeps the units");
  assert.match(update.summary.find(([k]) => k === "Price")[1], /per guest .*\+ tax \+ 20% tip/);
  assert.equal((await post(Object.fromEntries(Object.entries(update.form).filter(([, v]) => v !== "")))).status, 201);
  const after = (await api(`/api/admin/expenses/${catering}`)).data.expense;
  assert.deepEqual([after.unit_cost, after.pricing, after.taxable, after.gratuity_rate], [85, "variable", 1, 0.2]);
  const plain = checkProposal({ ...base, mode: "update", expense_id: catering, item: null, category: null, price: 90, quantity: null }, expenses, settings);
  await post(Object.fromEntries(Object.entries(plain.form).filter(([, v]) => v !== "")));
  const kept = (await api(`/api/admin/expenses/${catering}`)).data.expense;
  assert.deepEqual([kept.unit_cost, kept.taxable, kept.gratuity_rate], [90, 1, 0.2], "an update without tax or tip leaves them on");
});

// Bug guards for the budget math: a cancelled item's line items stayed due; paying what
// was due left the date to go overdue; a deposit on an unpriced item projected $0;
// line items kept the old category; editing a Paid item put a deleted payment back; an
// item saved down to what's paid stayed Partially paid; and an item created past
// Estimate never froze its original estimate.
test("budget: cancelled items, due dates, deposits, categories and Paid behave", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const make = async (body) => (await api("/api/admin/expenses", { method: "POST", body })).data.expense.id;
  const summary = async () => (await api("/api/admin/summary")).data;

  const venue = await make({ category: "Venue", item: "Venue" });
  const balance = await make({ parent_id: venue, item: "Balance", unit_cost: 9000, status: "booked", due_date: "2020-01-01" });
  await api(`/api/admin/expenses/${venue}`, { method: "PUT", body: { status: "cancelled" } });
  const s1 = await summary();
  assert.equal(s1.overdue.count, 0, "nothing on a cancelled item is overdue");
  assert.equal(s1.totals.owed, 0);
  await api(`/api/admin/expenses/${venue}`, { method: "PUT", body: { category: "Reception venue" } });
  assert.equal((await api(`/api/admin/expenses/${balance}`)).data.expense.category, "Reception venue", "line items follow the item's category");

  const dj = await make({ category: "Music", item: "DJ", unit_cost: 2000, status: "booked", due_date: "2020-01-01", due_amount: 500 });
  await api(`/api/admin/expenses/${dj}/payments`, { method: "POST", body: { amount: 500, paid_on: "2019-12-30" } });
  const djRow = (await api(`/api/admin/expenses/${dj}`)).data.expense;
  assert.deepEqual([djRow.due_date, djRow.due_amount, djRow.status], [null, null, "partially_paid"], "paying what was due clears the due date");

  const cake = await make({ category: "Food", item: "Cake", status: "quote" });
  await api(`/api/admin/expenses/${cake}/payments`, { method: "POST", body: { amount: 100 } });
  assert.equal((await api(`/api/admin/expenses/${cake}`)).data.expense.projected, 100, "a deposit counts before there's a price");

  const flowers = await make({ category: "Flowers", item: "Flowers", unit_cost: 400, status: "paid" });
  const pay = (await api(`/api/admin/expenses/${flowers}`)).data.payments[0];
  await api(`/api/admin/payments/${pay.id}`, { method: "DELETE" });
  await api(`/api/admin/expenses/${flowers}`, { method: "PUT", body: { notes: "refunded" } });
  assert.equal((await api(`/api/admin/expenses/${flowers}`)).data.payments.length, 0, "editing a Paid item doesn't add the payment back");

  const band = await make({ category: "Music", item: "Band", unit_cost: 1000, status: "booked" });
  assert.equal(env.DB.db.prepare("SELECT baseline_total FROM expenses WHERE id = ?").get(band).baseline_total, 1000, "created past Estimate: its price is the original estimate");
  await api(`/api/admin/expenses/${band}/payments`, { method: "POST", body: { amount: 600 } });
  await api(`/api/admin/expenses/${band}`, { method: "PUT", body: { unit_cost: 600 } });
  assert.equal((await api(`/api/admin/expenses/${band}`)).data.expense.status, "paid", "saved down to what's paid, it's Paid");
});

// Bug guard: GET guests sent the budget settings to a user who only has the Guests page.
test("a Guests-only user's guest list carries no budget settings", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  await api("/api/admin/settings", { method: "PUT", body: { budget_target: 42000 } });
  await api("/api/admin/users", { method: "POST", body: { email: "mom@example.com", role: "user", pages: ["guests"] } });
  const mom = await sessionCookie(env, "mom@example.com");
  const r = await call(env, "/api/admin/guests", { cookie: mom });
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.data).includes("42000") && !("settings" in r.data));
});

test("drinks: a bottle or beer size of 0 or blank uses the usual size", () => {
  const usual = drinksPlan({}, 100);
  assert.deepEqual(drinksPlan({ drinks_per_wine_bottle: 0, drinks_per_liquor_bottle: "", ounces_per_beer: -1 }, 100), usual);
});

// Asked for after saving books as a quote: "update the quote for the book to $25 a piece"
// -- a line item couldn't be updated, by the form or by Claude.
test("a line item can be updated through the expense form, and Claude may propose that", async () => {
  const { checkProposal } = await import("../src/intake.js");
  const env = makeEnv();
  const api = await adminClient(env);
  const key = await formKeyFor(api);
  const gifts = (await api("/api/admin/expenses", { method: "POST", body: { category: "Wedding Party", item: "Groom Party Gifts" } })).data.expense.id;
  const books = (await api("/api/admin/expenses", { method: "POST", body: { parent_id: gifts, item: "Books", unit_cost: 22.5, units: 4, status: "quote" } })).data.expense.id;
  const expenses = (await api("/api/admin/expenses")).data.expenses;
  const settings = { payers: ["Patrick"], payment_methods: [] };
  const base = { mode: "update", expense_id: books, item: null, category: null, subcategory: null, vendor: null, stage: "quote", price: 25, quantity: 4,
    taxable: false, gratuity_percent: 0, due_date: null, payment_amount: null, paid_on: null, payer: null, notes: null };
  const checked = checkProposal(base, expenses, settings);
  assert.equal(checked.error, undefined);
  assert.deepEqual(checked.summary[0], ["Update", "Books, under Groom Party Gifts"]);
  assert.match(checkProposal({ ...base, mode: "line_item", item: "Bookmarks" }, expenses, settings).error, /is a line item/);
  const r = await api("/api/public/expense", { method: "POST", form: formOf({ key, ...Object.fromEntries(Object.entries(checked.form).filter(([, v]) => v !== "")) }) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const e = (await api(`/api/admin/expenses/${books}`)).data.expense;
  assert.deepEqual([e.unit_cost, e.units, e.current, e.parent_id], [25, 4, 100, gifts]);
  const nested = await api("/api/public/expense", { method: "POST", form: formOf({ key, expense_id: String(books), mode: "purchase", item: "Bookmarks", status: "quote" }) });
  assert.equal(nested.status, 400, "a line item still takes no line items");
});

test("a proposal is checked: paid in full ignores a payment amount, and payers and items must exist", async () => {
  const { checkProposal } = await import("../src/intake.js");
  const settings = { payers: ["Patrick", "Kaitlyn"], payment_methods: ["Cash"] };
  const expenses = [{ id: 1, item: "Venue", status: "booked", purchases: 2 }, { id: 2, item: "Deposit", parent_id: 1, status: "paid" }];
  const base = { mode: "new", expense_id: null, item: "Cake", category: "Food", subcategory: null, vendor: null, stage: "paid", price: 400, quantity: 1,
    taxable: false, gratuity_percent: 0, due_date: "2027-01-01", payment_amount: 100, paid_on: null, payer: null, notes: null };
  const ok = checkProposal(base, expenses, settings);
  assert.equal(ok.form.payment_amount, "", "at Paid the price is what's paid");
  assert.equal(ok.form.due_date, "");
  assert.match(checkProposal({ ...base, payer: "Grandma" }, expenses, settings).error, /Payer must be one of/);
  assert.match(checkProposal({ ...base, mode: "update", expense_id: 1 }, expenses, settings).error, /has line items/);
  assert.match(checkProposal({ ...base, mode: "line_item", expense_id: 2 }, expenses, settings).error, /is a line item\. Add the line item under its item, #1/);
  assert.match(checkProposal({ ...base, category: "" }, expenses, settings).error, /needs a category/);
});

test("upgrading renames Partner to Kaitlyn in settings and payments, and seeds the vendor list", async () => {
  const env = makeEnv();
  env.DB.db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('_schema_version', '5');
    INSERT INTO settings VALUES ('payers', '["Patrick","Partner","Joint"]');
    CREATE TABLE households (id INTEGER PRIMARY KEY);
    CREATE TABLE guests (id INTEGER PRIMARY KEY, household_id INTEGER);
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

test("RSVP preview: while RSVPs are closed only a signed-in admin can try the page, and nothing they send is saved", async () => {
  const { env, api } = await rsvpSetup();
  await api("/api/admin/settings", { method: "PUT", body: { rsvp_open: false } });
  const auto = (await api("/api/admin/comms/messages", { method: "POST", body: { subject: "Thanks", body: "Hi" } })).data.id;
  await api(`/api/admin/comms/messages/${auto}/automate`, { method: "POST", body: {} });
  const owner = await sessionCookie(env);
  await api("/api/admin/users", { method: "POST", body: { email: "jo@example.com", role: "user", pages: ["guests"] } });
  const jo = await sessionCookie(env, "jo@example.com");

  assert.ok(!("preview" in (await call(env, "/api/public/info")).data), "guests see it closed");
  assert.ok(!("preview" in (await call(env, "/api/public/info", { cookie: jo })).data), "so does a user who isn't an admin");
  assert.equal((await call(env, "/api/public/info", { cookie: owner })).data.preview, true);
  assert.equal((await call(env, "/api/public/rsvp/search", { method: "POST", body: { q: "jor" }, cookie: jo })).status, 403);

  const pick = (await call(env, "/api/public/rsvp/search", { method: "POST", body: { q: "alex" }, cookie: owner })).data.results[0].pick;
  const alex = (await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { pick }, cookie: owner })).data.matches[0];
  const submit = (guests) => call(env, "/api/public/rsvp/submit", { method: "POST", cookie: owner,
    body: { token: alex.token, email: "preview@example.com", message: "testing", guests } });
  assert.equal((await submit([{ id: alex.guests[0].id }])).status, 400, "a preview still checks the answers");
  const sent = await submit(alex.guests.map((g) => ({ id: g.id, rsvp: "yes", dietary: "Vegan" })));
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.preview, true);
  assert.deepEqual(sent.data.household.guests.map((g) => [g.rsvp, g.dietary]), alex.guests.map(() => ["yes", "Vegan"]), "it shows what would be saved");
  const stored = (await api("/api/admin/guests")).data.households.find((h) => h.code === "H-001");
  assert.deepEqual([stored.rsvp_at, stored.email === "preview@example.com", ...stored.guests.map((g) => g.rsvp)], [null, false, ...alex.guests.map(() => "pending")], "nothing is saved");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM comm_sends").get().n, 0, "and no after-RSVP email is queued");
});

// Bug guard: a visitor could walk the name search and read every household's email
// addresses; the page now gets them masked, and a blank box keeps the one on file.
test("RSVP: emails come back masked, a blank keeps the one on file, and a typed one replaces it", async () => {
  const { env, api, households } = await rsvpSetup();
  const h1 = households.find((h) => h.code === "H-001");
  await api(`/api/admin/households/${h1.id}`, { method: "PUT", body: { email: "alex@example.com" } });
  await api(`/api/admin/guests/${h1.guests[1].id}`, { method: "PUT", body: { email: "sam@own.example.com" } });
  const pick = (await call(env, "/api/public/rsvp/search", { method: "POST", body: { q: "alex" } })).data.results[0].pick;
  const alex = (await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { pick } })).data.matches[0];
  const text = JSON.stringify(alex);
  assert.ok(!text.includes("alex@example.com") && !text.includes("sam@own.example.com"), "no address in the lookup");
  assert.equal(alex.email_hint, "a•••@example.com");
  assert.equal(alex.guests[1].email_hint, "s•••@own.example.com");
  const submit = (email) => call(env, "/api/public/rsvp/submit", { method: "POST", body: { token: alex.token, email, guests: alex.guests.map((g) => ({ id: g.id, rsvp: "yes", email: "" })) } });
  assert.equal((await submit("")).status, 200, "a blank keeps the email on file");
  const stored = () => env.DB.db.prepare("SELECT h.email AS h, g.email AS g FROM households h JOIN guests g ON g.household_id = h.id WHERE h.id = ? ORDER BY g.sort_order, g.id").all(h1.id);
  assert.deepEqual(stored().map((r) => [r.h, r.g]), [["alex@example.com", null], ["alex@example.com", "sam@own.example.com"]]);
  assert.equal((await submit("new@example.com")).status, 200);
  assert.equal(stored()[0].h, "new@example.com");
  // A household with no email on file still has to give one.
  const jordan = (await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "Jordan", last: "Sample" } })).data.matches[0];
  const none = await call(env, "/api/public/rsvp/submit", { method: "POST", body: { token: jordan.token, email: "", guests: [{ id: jordan.guests[0].id, rsvp: "no" }] } });
  assert.equal(none.status, 400);
});

// Bug guard: the type-ahead search replaced the first/last form and only searched
// guests, so a preloaded plus-one could no longer find their host's invitation.
test("RSVP: a preloaded plus-one finds their host through the name search; names in any script are found", async () => {
  const { env, api, households } = await rsvpSetup();
  const results = (await call(env, "/api/public/rsvp/search", { method: "POST", body: { q: "casey" } })).data.results;
  assert.deepEqual(results.map((r) => r.name), ["Casey Guest"]);
  const opened = (await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { pick: results[0].pick } })).data.matches[0];
  assert.equal(opened.guests[0].first_name, "Jordan", "the pick opens the host's household");
  await api("/api/admin/households", { method: "POST", body: { display_name: "Ivanova", guests: [{ first_name: "Ольга", last_name: "Иванова" }] } });
  assert.deepEqual((await call(env, "/api/public/rsvp/search", { method: "POST", body: { q: "Ольга" } })).data.results.map((r) => r.name), ["Ольга Иванова"]);
});

// Bug guard: a cleared wording box saved "" and the RSVP page showed empty yes/no buttons.
test("RSVP page: a blank wording field falls back to the default, except the heading", async () => {
  const { env, api } = await rsvpSetup();
  await api("/api/admin/comms/rsvp-page", { method: "PUT", body: { page: { accept_label: "", decline_label: "  ", heading: "", thanks_yes: "Yay" } } });
  const page = (await call(env, "/api/public/info")).data.rsvp_page;
  assert.deepEqual([page.accept_label, page.decline_label, page.heading, page.thanks_yes], ["Joyfully accepts", "Regretfully declines", "", "Yay"]);
});

// Bug guard: an all-day rehearsal dinner still showed the time typed before "All day"
// was ticked, and an admin's preview showed the calendar button from the saved answers.
test("RSVP: an all-day dinner shows no time, and a preview's calendar button follows the previewed answers", async () => {
  const { env, api, households } = await rsvpSetup();
  const alexRow = households.find((h) => h.code === "H-001").guests[0];
  await api(`/api/admin/guests/${alexRow.id}`, { method: "PUT", body: { invite_rehearsal: true, rsvp: "no" } });
  await api(`/api/admin/guests/${households.find((h) => h.code === "H-001").guests[1].id}`, { method: "PUT", body: { rsvp: "no" } });
  await api("/api/admin/comms/calendar", { method: "PUT", body: { events: [{ title: "Dinner", date: "2027-06-11", start: "18:30", all_day: true, for: "rehearsal" }, { title: "Wedding", date: "2027-06-12", start: "16:00", for: "everyone" }] } });
  await api("/api/admin/settings", { method: "PUT", body: { rsvp_open: false } });
  const owner = await sessionCookie(env);
  const pick = (await call(env, "/api/public/rsvp/search", { method: "POST", body: { q: "alex" }, cookie: owner })).data.results[0].pick;
  const alex = (await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { pick }, cookie: owner })).data.matches[0];
  assert.deepEqual(alex.rehearsal, { date: "2027-06-11", start: "", location: "" });
  const sent = await call(env, "/api/public/rsvp/submit", { method: "POST", cookie: owner, body: { token: alex.token, email: "a@example.com",
    guests: alex.guests.map((g) => ({ id: g.id, rsvp: "yes", rehearsal_rsvp: "yes" })) } });
  assert.equal(sent.data.preview, true);
  assert.ok(sent.data.calendar_url, "a previewed yes shows the calendar button even though the saved answers are no");
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
  const r = await call(env, "/api/public/rsvp/submit", { method: "POST", body: { token: alex.token, email: "alex@example.com", guests: [{ id: riley.id, rsvp: "no" }] } });
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
    body: { token: jordan.token, email: "jordan@example.com", guests: [{ id: jordan.guests[0].id, rsvp: "yes", plus_one_rsvp: "yes", plus_one_name: "Casey Guest", dietary: "vegetarian" }] },
  });
  const counts = (await api("/api/admin/guests")).data.counts;
  assert.equal(counts.confirmed, 2);
});

test("resetting an RSVP puts the household back to awaiting reply so it can answer fresh", async () => {
  const { env, api } = await rsvpSetup();
  const jordan = (await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "Jordan", last: "Sample" } })).data.matches[0];
  await call(env, "/api/public/rsvp/submit", {
    method: "POST",
    body: { token: jordan.token, email: "jordan@example.com", guests: [{ id: jordan.guests[0].id, rsvp: "yes", dietary: "vegan", plus_one_rsvp: "yes", plus_one_name: "Casey Guest" }], message: "See you there" },
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

// Asked for: the expense form always at www.patrickandkaitlyn.com/submit, behind the
// Google sign-in, picking whoever is signed in.
test("the expense form takes the admin sign-in, lives at PUBLIC_URL/submit, and knows who is signed in", async () => {
  const env = makeEnv({ PUBLIC_URL: "https://www.patrickandkaitlyn.com" });
  for (const [path, init] of [["/api/public/expense/options", {}], ["/api/public/expense/chat", { method: "POST", body: { messages: [] } }],
    ["/api/public/expense", { method: "POST", form: formOf({ item: "Cake", category: "Food", status: "quote" }) }]]) {
    assert.equal((await call(env, path, init)).status, 401, `${path} needs sign-in`);
  }
  const cookie = await sessionCookie(env);
  const noHeader = await call(env, "/api/public/expense", { method: "POST", cookie, form: formOf({ item: "Cake", category: "Food", status: "quote" }) });
  assert.equal(noHeader.status, 403, "POSTs need the X-Wedding header, like the control panel");
  const api = await adminClient(env);
  assert.equal((await api("/api/admin/form-link")).data.url, "https://www.patrickandkaitlyn.com/submit");
  const { payerFor } = await import("../src/public_api.js");
  const payers = ["Patrick", "Kaitlyn", "Joint"];
  assert.equal(payerFor({ name: "Kaitlyn Wright", email: "kw@example.com" }, payers), "Kaitlyn");
  assert.equal(payerFor({ name: "pat", email: "patrick.oneill@example.com" }, payers), "Patrick", "by email when the name doesn't match");
  assert.equal(payerFor({ name: "K Wright", email: "wright.kaitlyn@example.com" }, payers), "Kaitlyn", "a payer's name anywhere in the email");
  assert.equal(payerFor({ name: "Someone", email: "x@example.com" }, payers), "");
  const { checkProposal } = await import("../src/intake.js");
  const p = { mode: "new", expense_id: null, item: "Cake", category: "Food", subcategory: null, vendor: null, stage: "paid", price: 400, quantity: 1,
    taxable: false, gratuity_percent: 0, due_date: null, payment_amount: null, paid_on: null, payer: null, notes: null };
  assert.equal(checkProposal(p, [], { payers }, "Kaitlyn").form.payer, "Kaitlyn", "whoever is signed in paid");
  assert.equal(checkProposal({ ...p, payer: "Patrick" }, [], { payers }, "Kaitlyn").form.payer, "Patrick", "unless they said otherwise");
});

test("signing in returns to the page that asked, and the bare domain redirects to www", async () => {
  const { safeNext } = await import("../src/auth.js");
  assert.equal(safeNext("/submit"), "/submit");
  for (const bad of ["//evil.example", "https://evil.example", "/\\evil", "javascript:alert(1)", ""]) assert.equal(safeNext(bad), "", bad);
  const env = makeEnv({ PUBLIC_URL: "https://www.patrickandkaitlyn.com", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" });
  const login = await worker.fetch(new Request(`${ORIGIN}/api/auth/login?next=/submit`), env);
  const state = new URL(login.headers.get("location")).searchParams.get("state");
  const { verify } = await import("../src/auth.js");
  assert.equal((await verify(env, state)).next, "/submit");
  const r = await worker.fetch(new Request("https://patrickandkaitlyn.com/submit?x=1"), env);
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "https://www.patrickandkaitlyn.com/submit?x=1");
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
  const r = await api("/api/public/expense", { method: "POST", form });
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
  assert.deepEqual([...files.keys()].sort(), ["expenses.csv", "guests.csv", "payments.csv", "planning_numbers.csv", "price_history.csv", "vendors.csv"]);
  const second = await withFetch(drive, async (calls) => {
    const r = await api("/api/admin/drive/sync", { method: "POST" });
    assert.equal(calls.filter((c) => c.init.method === "PATCH").length, 6);
    assert.equal(calls.filter((c) => c.url.includes("uploadType=multipart")).length, 0);
    return r;
  });
  assert.equal(second.status, 200);
  const status = (await api("/api/admin/drive/status")).data;
  assert.equal(status.pending_changes, false);
});

// Bug guard: two syncs into an empty folder each created every file, leaving a stale
// second copy; the next sync now keeps the oldest and bins the rest.
test("Drive sync keeps one copy of each file when a race made two", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const { setSetting } = await import("../src/db.js");
  await setSetting(env, "_google_drive", { refresh_token: "rt", access_token: "at", expires_at: Date.now() + 3600e3, email: "a@example.com" });
  await setSetting(env, "_drive_folder", { id: "folder1", name: "Wedding" });
  const trashed = [];
  const r = await withFetch((url, init) => {
    if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
      const name = /name = '([^']+)'/.exec(new URL(url).searchParams.get("q"))?.[1];
      return okJson({ files: [{ id: `${name}-old`, name }, { id: `${name}-new`, name }] });
    }
    if (/\/drive\/v3\/files\/[^?]+-new\?/.test(url) && init.method === "PATCH") {
      trashed.push(decodeURIComponent(url.split("/files/")[1].split("?")[0]));
      return okJson({});
    }
    if (/\/upload\/drive\/v3\/files\/[^?]+-old\?uploadType=media/.test(url) && init.method === "PATCH") return okJson({ id: "patched" });
    throw new Error(`unexpected fetch ${init.method || "GET"} ${url}`);
  }, () => api("/api/admin/drive/sync", { method: "POST" }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(trashed.includes("guests.csv-new") && trashed.length === 6, trashed.join(","));
});

// Bug guard: the cron entry point had no test, so breaking "a run that sent email
// leaves the Drive sync to the next run" would have passed.
test("cron: a run that sends email skips the Drive sync; the next quiet run syncs", async () => {
  const { env, api } = await commsSetup({ households: 2 });
  const { setSetting } = await import("../src/db.js");
  await setSetting(env, "_google_drive", { refresh_token: "rt", access_token: "at", expires_at: Date.now() + 3600e3, email: "a@example.com" });
  await setSetting(env, "_drive_folder", { id: "folder1", name: "Wedding" });
  await setSetting(env, "_sync_dirty_at", new Date().toISOString());
  const id = (await api("/api/admin/comms/messages", { method: "POST", body: { subject: "Hi", body: "Hi" } })).data.id;
  await api(`/api/admin/comms/messages/${id}/schedule`, { method: "POST", body: { send_at: "2099-01-01T09:00" } });
  env.DB.db.prepare("UPDATE comm_messages SET send_at = '2000-01-01T00:00:00Z'").run();
  const cron = async () => {
    const waits = [];
    const calls = [];
    await withFetch((url, init) => {
      calls.push(url);
      if (url.includes("gmail.googleapis.com")) return okJson({ id: "m" });
      if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) return okJson({ files: [] });
      if (url.includes("uploadType=multipart")) return okJson({ id: "f", name: "x" });
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
      await Promise.all(waits);
    });
    return calls;
  };
  const first = await cron();
  assert.ok(first.some((u) => u.includes("gmail")) && !first.some((u) => u.includes("drive")), "emails, and no Drive calls");
  const second = await cron();
  assert.ok(second.some((u) => u.includes("drive")), "the next run syncs Drive");
});

// Coverage the audit found missing: receipts never overwrite each other; a day-of link
// turned off stops working; deleting a household takes its guests' seats and groups.
test("receipts upload as new files every time, a turned-off day-of link stops working, and a deleted household leaves nothing behind", async () => {
  const { env, api, id, roomId } = await seatingSetup();
  const { setSetting } = await import("../src/db.js");
  await setSetting(env, "_google_drive", { refresh_token: "rt", access_token: "at", expires_at: Date.now() + 3600e3, email: "a@example.com" });
  await setSetting(env, "_drive_folder", { id: "folder1", name: "Wedding" });
  const expense = (await api("/api/admin/expenses", { method: "POST", body: { item: "Cake", vendor: "Bakery", unit_cost: 300 } })).data.expense.id;
  const created = [];
  const upload = () => {
    const form = new FormData();
    form.append("file", new File(["receipt"], "receipt.pdf", { type: "application/pdf" }));
    return api(`/api/admin/expenses/${expense}/attachments`, { method: "POST", form });
  };
  await withFetch((url, init) => {
    if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) return okJson({ files: [{ id: "receipts", name: "Receipts" }] });
    if (url.includes("uploadType=multipart")) {
      created.push(url);
      return okJson({ id: `r${created.length}`, name: "x", webViewLink: "https://drive.example/x" });
    }
    throw new Error(`unexpected fetch ${init.method || "GET"} ${url}`);
  }, async () => {
    assert.equal((await upload()).status, 201);
    assert.equal((await upload()).status, 201);
  });
  assert.equal(created.length, 2, "two receipts, two files: never an update of the first");

  const key = new URL((await api("/api/admin/runofshow/link", { method: "POST" })).data.url).hash.slice(3);
  await api("/api/admin/runofshow/link", { method: "DELETE" });
  assert.equal((await call(env, "/api/dayof", { headers: { "x-dayof-key": key } })).status, 401);

  const table = (await api("/api/admin/seating/items", { method: "POST", body: { room_id: roomId, kind: "table", seats: 4 } })).data.ids[0];
  await api("/api/admin/seating/assign", { method: "POST", body: { item_id: table, seat_letter: "A", guest_id: id.Avery } });
  await api("/api/admin/runofshow/groups", { method: "POST", body: { name: "Photos", members: [`${id.Avery}:0`] } });
  const household = env.DB.db.prepare("SELECT household_id FROM guests WHERE id = ?").get(id.Avery).household_id;
  assert.equal((await api(`/api/admin/households/${household}`, { method: "DELETE" })).status, 200);
  for (const table of ["guests", "seat_assignments", "guest_group_members"]) {
    assert.equal(env.DB.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} is empty`);
  }
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
  assert.match(r.headers.get("location"), /settings\.html\?error=[^#]+#drive$/, "the error comes back to the Drive card");
  const status = await (await adminClient(env))("/api/admin/drive/status");
  assert.equal(status.data.connected, false);
});

// Bug guard: a Gmail connection error landed in the Drive card (no hash on the redirect).
test("a failed Gmail connection reports back to the Gmail card", async () => {
  const env = makeEnv();
  const cookie = await sessionCookie(env);
  const state = await sign(env, { kind: "oauth", purpose: "gmail", nonce: "g1" }, 600);
  const r = await call(env, `/api/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`, { cookie: `${cookie}; wedding_oauth=g1` });
  assert.match(r.headers.get("location"), /^\/admin\/settings\.html\?error=Google%20said%3A%20access_denied#gmail$/);
});

// Bug guard: two requests on a fresh database each made a signing key and the later
// write won, so tokens signed with the losing key stopped verifying.
test("the first signing key is created once even when requests race for it", async () => {
  const env = makeEnv();
  await call(env, "/api/auth/me"); // migrations
  const tokens = await Promise.all([1, 2, 3].map((n) => sign(env, { kind: "test", n }, 60)));
  const fresh = { ...env }; // a new isolate: no cached key
  for (const t of tokens) assert.ok(await verify(fresh, t), "every token verifies with the stored key");
});

// Bug guard: login.html's ?next= check was weaker than the server's, so "/\\evil.example"
// sent a signed-in visitor to another site.
test("login.html only follows a ?next= path on this site", () => {
  const html = fs.readFileSync(path.join(ROOT, "public/admin/login.html"), "utf8");
  const rule = new RegExp(html.match(/const next = \/(.+)\/\.test\(raw\)/)[1]);
  for (const bad of ["//evil.example", "/\\evil.example", "/\t/evil.example", "https://evil.example", "/x?y=//z"]) assert.ok(!rule.test(bad), bad);
  for (const ok of ["/submit", "/admin/index.html", "/submit/form.html#x"]) assert.ok(rule.test(ok), ok);
});

// Bug guard: /dayof was added to public/ but not to the reserved paths, so a Zola page
// with that slug would have replaced the coordinator's view.
test("every top-level folder and file in public/ is reserved from the copied website", () => {
  for (const name of fs.readdirSync(path.join(ROOT, "public"))) assert.ok(RESERVED.has(name), `${name} is not in RESERVED`);
});

/* --------------------------------------------------------------- website copy -- */

import { cleanPage, fontFacesFor, PAGE_SCRIPT, parseHtml, RESERVED, serialize } from "../src/site.js";

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

// Bug guards: the phone menu left out Registry (it stays on Zola), so phone guests
// couldn't reach it; menu labels were written back unescaped; the phone menu button
// never showed while the site title linked home; and the desktop pill sat on Registry.
test("the phone menu includes Registry, labels stay text, and the page script measures only the menu row", () => {
  const page = zolaPage().replace(">Travel</a>", ">Travel &amp;lt;b&amp;gt;</a>");
  const html = cleanPage(page, { slug: SLUG, pages: new Set(["travel"]), currentPath: "/" }).html;
  const menu = /<nav id="wm-menu"[^>]*>(.*?)<\/nav>/.exec(html)[1];
  assert.ok(menu.includes(`<a href="https://www.zola.com/wedding/${SLUG}/registry" target="_blank" rel="noopener">Registry</a>`), menu);
  assert.ok(!menu.includes("RSVP"), "the pill already covers RSVP");
  assert.ok(menu.includes("Travel &amp;lt;b&amp;gt;") || menu.includes("Travel &lt;b&gt;"), menu);
  assert.ok(!/<b>/.test(menu), "escaped text never becomes a tag");
  assert.ok(html.includes(`<a href="https://www.zola.com/wedding/${SLUG}/registry" data-wm-nav="menu">Registry</a>`), "Registry counts as part of the menu row");
  assert.ok(PAGE_SCRIPT.includes(`'a[data-wm-nav="menu"]'`), "the phone check looks at the menu links when there are any");
  assert.ok(/box\.querySelectorAll\("a"\)/.test(PAGE_SCRIPT), "the pill clears every link in the row");
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

test("a pill color set in Settings wins", () => {
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
  // Bug guard: a copy the Worker refused never showed in Settings.
  assert.equal((await ingest(env, { pages: [{ path: "/admin", html: "x" }] })).status, 400);
  const status = (await (await adminClient(env))("/api/admin/site/status")).data.status;
  assert.match(status.error, /GitHub's copy was refused/);
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
  assert.ok(PAGE_SCRIPT.includes("wm-in-nav") && PAGE_SCRIPT.includes("row.right+GAP+w>br.right-8"), "the pill only joins the menu row when it fits");
});

// Asked for: no RSVP button on the website while RSVPs are closed, and the button in #A4727E.
test("the RSVP button is #A4727E unless Settings picks a color, and disappears while RSVPs are closed", async () => {
  const { buildSite } = await import("../src/site.js");
  const env = siteEnv();
  const built = await buildSite({ zolaUrl: `https://www.zola.com/wedding/${SLUG}`, fetchPage: async (url) => {
    if (url.endsWith("fonts.css")) return "";
    if (url.endsWith(SLUG)) return zolaPage();
    throw new Error(`Zola returned 404 for ${url}`);
  } });
  assert.equal((await ingest(env, JSON.parse(JSON.stringify(built)))).status, 200);
  let page = (await call(env, "/")).data;
  assert.ok(page.includes('<a class="wm-rsvp" href="/rsvp/">RSVP</a>'));
  assert.ok(page.includes(".wm-rsvp{background:#A4727E}"));
  const api = await adminClient(env);
  await api("/api/admin/settings", { method: "PUT", body: { rsvp_button_color: "#2f5d62" } });
  assert.ok((await call(env, "/")).data.includes(".wm-rsvp{background:#2f5d62}"), "a color from Settings shows without a refresh");
  await api("/api/admin/settings", { method: "PUT", body: { rsvp_open: false } });
  page = (await call(env, "/")).data;
  assert.ok(!page.includes('class="wm-rsvp"'), "no button while RSVPs are closed");
  assert.ok(page.includes("Menu"), "the phone menu stays");
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

/* ----------------------------------------------------------------- seating chart -- */

async function seatingSetup() {
  const env = makeEnv();
  const api = await adminClient(env);
  const made = await api("/api/admin/households", {
    method: "POST",
    body: {
      display_name: "Test Household",
      guests: [
        { first_name: "Avery", last_name: "Test", plus_one_allowed: true },
        { first_name: "Blake", last_name: "Test" },
        { first_name: "Casey", last_name: "Test", invite_reception: false, invite_ceremony: true },
      ],
    },
  });
  assert.equal(made.status, 201);
  const guests = (await api("/api/admin/guests")).data.households[0].guests;
  const id = Object.fromEntries(guests.map((g) => [g.first_name, g.id]));
  const room = await api("/api/admin/seating/rooms", { method: "POST", body: { name: "Hall", kind: "reception", width_ft: 60, length_ft: 40 } });
  assert.equal(room.status, 201, JSON.stringify(room.data));
  return { env, api, id, roomId: room.data.id };
}

test("seating: tables come from templates, get the next table number, and numbers don't repeat in a room", async () => {
  const { api, roomId } = await seatingSetup();
  const start = (await api("/api/admin/seating")).data;
  assert.ok(start.templates.length >= 4, "a new install has the common rental sizes as templates");
  const t = await api("/api/admin/seating/templates", { method: "POST", body: { name: "8 ft round, 6 seats", shape: "round", width_ft: 8, length_ft: 3, seats: 6 } });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  const template = t.data.templates.find((x) => x.id === t.data.id);
  assert.equal(template.length_ft, 8, "a round template's length is its diameter");
  const first = await api("/api/admin/seating/items", { method: "POST", body: { room_id: roomId, kind: "table", template_id: template.id } });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const table = first.data.items.find((i) => i.id === first.data.ids[0]);
  assert.deepEqual([table.label, table.shape, table.width_ft, table.seats], ["1", "round", 8, 6]);
  const second = await api("/api/admin/seating/items", { method: "POST", body: { room_id: roomId, kind: "table", template_id: template.id } });
  assert.equal(second.data.items.find((i) => i.id === second.data.ids[0]).label, "2");
  const clash = await api(`/api/admin/seating/items/${second.data.ids[0]}`, { method: "PUT", body: { label: "1" } });
  assert.equal(clash.status, 400, "two tables in one room can't share a number");
  const note = await api("/api/admin/seating/items", { method: "POST", body: { room_id: roomId, kind: "note", label: "DJ booth" } });
  assert.equal(note.data.items.find((i) => i.id === note.data.ids[0]).label, "DJ booth");
  assert.equal((await api("/api/admin/seating/items", { method: "POST", body: { room_id: roomId, kind: "note", label: " " } })).status, 400);
});

// Bug guards: every reception room numbered its tables from 1, so escort cards said
// "table 1" twice; a ceremony row of chairs with a label couldn't be saved again; a
// reception chair's number could be cleared with someone in it; a room made a
// reception room could seat two people at the same "table 1 A".
test("seating: numbers are unique across reception rooms, ceremony chairs may share labels, seated chairs keep numbers", async () => {
  const { env, api, id, roomId } = await seatingSetup();
  const patio = (await api("/api/admin/seating/rooms", { method: "POST", body: { name: "Patio", kind: "reception", width_ft: 40, length_ft: 30 } })).data.id;
  const hallTable = (await api("/api/admin/seating/items", { method: "POST", body: { room_id: roomId, kind: "table", seats: 4 } })).data;
  const patioTable = (await api("/api/admin/seating/items", { method: "POST", body: { room_id: patio, kind: "table", seats: 4 } })).data;
  const label = (d) => d.items.find((i) => i.id === d.ids[0]).label;
  assert.deepEqual([label(hallTable), label(patioTable)], ["1", "2"], "the Patio's first table is 2");
  assert.equal((await api(`/api/admin/seating/items/${patioTable.ids[0]}`, { method: "PUT", body: { label: "1" } })).status, 400);

  const chapel = (await api("/api/admin/seating/rooms", { method: "POST", body: { name: "Chapel", kind: "ceremony", width_ft: 40, length_ft: 60 } })).data.id;
  const row = (await api("/api/admin/seating/items", { method: "POST", body: { room_id: chapel, kind: "seat", count: 3, label: "Row A" } })).data.ids;
  assert.equal((await api(`/api/admin/seating/items/${row[1]}`, { method: "PUT", body: { label: "Row A", x: 5 } })).status, 200, "ceremony chairs may share a label");

  const chair = (await api("/api/admin/seating/items", { method: "POST", body: { room_id: roomId, kind: "seat" } })).data.ids[0];
  await api("/api/admin/seating/assign", { method: "POST", body: { item_id: chair, seat_letter: "A", guest_id: id.Avery } });
  assert.equal((await api(`/api/admin/seating/items/${chair}`, { method: "PUT", body: { label: "" } })).status, 400, "a reception chair keeps a number");

  // The chapel becomes a reception room: its "Row A" chairs share a number.
  await api(`/api/admin/seating/rooms/${chapel}`, { method: "PUT", body: { kind: "reception" } });
  const seat = await api("/api/admin/seating/assign", { method: "POST", body: { item_id: row[0], seat_letter: "A", guest_id: id.Blake } });
  assert.equal(seat.status, 400);
  assert.match(seat.data.error, /share the number Row A/);
});

// Bug guards: a table typed on the Guests page reached guests.csv but no report; the
// seating board still printed a guest taken off the reception.
test("seating: a typed table shows in reports until the guest has a seat; the board leaves out non-reception guests", async () => {
  const { api, id, roomId } = await seatingSetup();
  await api(`/api/admin/guests/${id.Blake}`, { method: "PUT", body: { table_name: "7" } });
  const table = (await api("/api/admin/seating/items", { method: "POST", body: { room_id: roomId, kind: "table", seats: 4 } })).data.ids[0];
  await api("/api/admin/seating/assign", { method: "POST", body: { item_id: table, seat_letter: "A", guest_id: id.Avery } });
  const cards = await runReport(api, { id: "table-cards" });
  assert.equal(cards.find((r) => r.Name === "Blake Test").Table, "7");
  await api(`/api/admin/guests/${id.Avery}`, { method: "PUT", body: { invite_reception: false } });
  const board = await runReport(api, { id: "seating-board" });
  assert.ok(!board.some((r) => r.Name === "Avery Test"), "off the reception, off the board");
});

test("seating: turns and shape sizes keep two decimals; locked items can't move until unlocked; several move in one query", async () => {
  const { env, api, roomId } = await seatingSetup();
  const shape = (await api("/api/admin/seating/items", { method: "POST", body: { room_id: roomId, kind: "shape", x: 10, y: 10 } })).data.ids[0];
  const table = (await api("/api/admin/seating/items", { method: "POST", body: { room_id: roomId, kind: "table", x: 20, y: 10 } })).data.ids[0];
  const item = async (id) => (await api("/api/admin/seating")).data.items.find((i) => i.id === id);
  await api(`/api/admin/seating/items/${shape}`, { method: "PUT", body: { rotation: 22.456, width_ft: 12.755, length_ft: 0.25, label: "Dance floor" } });
  await api(`/api/admin/seating/items/${table}`, { method: "PUT", body: { rotation: -7.5 } });
  assert.deepEqual([(await item(shape)).rotation, (await item(shape)).width_ft, (await item(shape)).length_ft], [22.46, 12.76, 0.25]);
  assert.equal((await item(table)).rotation, 352.5);

  await api("/api/admin/seating/items/lock", { method: "POST", body: { ids: [shape], locked: true } });
  assert.equal((await api(`/api/admin/seating/items/${shape}`, { method: "PUT", body: { x: 30 } })).status, 400, "locked: no moving");
  assert.equal((await api(`/api/admin/seating/items/${shape}`, { method: "PUT", body: { rotation: 45 } })).status, 400, "or turning");
  assert.equal((await api(`/api/admin/seating/items/${shape}`, { method: "PUT", body: { label: "Floor", color: "blue" } })).status, 200, "its text and color can still change");
  assert.equal((await api("/api/admin/seating/items/arrange", { method: "POST", body: { moves: [{ id: shape, x: 1, y: 1 }] } })).status, 400);
  assert.equal((await api(`/api/admin/seating/items/${shape}`, { method: "PUT", body: { locked: false, x: 30 } })).status, 200, "unlock and move in one save");

  const queries = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { queries.push(sql); return prepare(sql); };
  const moved = await api("/api/admin/seating/items/arrange", { method: "POST", body: { moves: [{ id: shape, x: 5.25, y: 6 }, { id: table, x: 15.5, y: 6 }] } });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(queries.filter((q) => /^UPDATE seating_items SET x/.test(q)).length, 1, "one UPDATE for the lot");
  env.DB.prepare = prepare;
  assert.deepEqual([[(await item(shape)).x, (await item(shape)).y], [(await item(table)).x, (await item(table)).y]], [[5.25, 6], [15.5, 6]]);
});

test("seating: a new shape's text fits itself (size 0) until a size is set, and a blank size goes back to fitting", async () => {
  const { api, roomId } = await seatingSetup();
  const shape = (await api("/api/admin/seating/items", { method: "POST", body: { room_id: roomId, kind: "shape", label: "Bar" } })).data.ids[0];
  const size = async () => (await api("/api/admin/seating")).data.items.find((i) => i.id === shape).font_size;
  assert.equal(await size(), 0);
  assert.equal((await api(`/api/admin/seating/items/${shape}`, { method: "PUT", body: { font_size: "2.25" } })).status, 200);
  assert.equal(await size(), 2.25);
  assert.equal((await api(`/api/admin/seating/items/${shape}`, { method: "PUT", body: { font_size: "0.1" } })).status, 400, "too small to read");
  await api(`/api/admin/seating/items/${shape}`, { method: "PUT", body: { font_size: "" } });
  assert.equal(await size(), 0);
});

test("seating: grouping takes in whole groups, never merges with an old group, stays in one room, and ungroup clears it", async () => {
  const { api, roomId } = await seatingSetup();
  const add = async (room = roomId) => (await api("/api/admin/seating/items", { method: "POST", body: { room_id: room, kind: "shape" } })).data.ids[0];
  const [a, b, c, d] = [await add(), await add(), await add(), await add()];
  const groups = async () => Object.fromEntries((await api("/api/admin/seating")).data.items.map((i) => [i.id, i.group_id]));
  assert.equal((await api("/api/admin/seating/items/group", { method: "POST", body: { ids: [a], grouped: true } })).status, 400, "one is not a group");
  await api("/api/admin/seating/items/group", { method: "POST", body: { ids: [a, b], grouped: true } });
  let g = await groups();
  assert.ok(g[a] && g[a] === g[b] && g[c] === null);
  await api("/api/admin/seating/items/group", { method: "POST", body: { ids: [c, d], grouped: true } });
  g = await groups();
  assert.ok(g[c] === g[d] && g[c] !== g[a], "a second group gets its own number");
  // Grouping b with c takes in a and d too: the two groups become one.
  await api("/api/admin/seating/items/group", { method: "POST", body: { ids: [b, c], grouped: true } });
  g = await groups();
  assert.equal(new Set([g[a], g[b], g[c], g[d]]).size, 1);
  const other = (await api("/api/admin/seating/rooms", { method: "POST", body: { name: "Patio", kind: "other", width_ft: 20, length_ft: 20 } })).data.id;
  const far = await add(other);
  assert.equal((await api("/api/admin/seating/items/group", { method: "POST", body: { ids: [a, far], grouped: true } })).status, 400, "not across rooms");
  await api("/api/admin/seating/items/group", { method: "POST", body: { ids: [d], grouped: false } });
  g = await groups();
  assert.deepEqual([g[a], g[b], g[c], g[d], g[far]], [null, null, null, null, null]);
});

test("seating: a person has one seat; seating them again moves them, and taking a seat bumps whoever had it", async () => {
  const { env, api, id, roomId } = await seatingSetup();
  const tableId = (await api("/api/admin/seating/items", { method: "POST", body: { room_id: roomId, kind: "table", seats: 6 } })).data.ids[0];
  const seat = (letter, guest_id, plus_one = 0) => api("/api/admin/seating/assign", { method: "POST", body: { item_id: tableId, seat_letter: letter, guest_id, plus_one } });
  assert.equal((await seat("B", id.Avery)).status, 200);
  let r = await seat("c", id.Avery);
  assert.equal(r.status, 200, "lowercase letters are fine");
  assert.deepEqual(r.data.assignments.map((a) => [a.seat_letter, a.guest_id]), [["C", id.Avery]], "moving to C leaves B");
  r = await seat("C", id.Blake);
  assert.deepEqual(r.data.assignments.map((a) => [a.seat_letter, a.guest_id]), [["C", id.Blake]], "Blake takes C from Avery");
  r = await seat("D", id.Avery, 1);
  assert.equal(r.status, 200, "a plus-one is a person with a seat of their own");
  assert.equal(r.data.assignments.length, 2);

  const guests = (await api("/api/admin/guests")).data.households[0].guests;
  const blake = guests.find((g) => g.id === id.Blake);
  assert.deepEqual([blake.seat.table, blake.seat.seat], ["1", "C"]);
  assert.deepEqual([guests.find((g) => g.id === id.Avery).plus_one_seat.seat], ["D"]);

  const csv = (await buildExports(env))["guests.csv"];
  const [header, ...lines] = csv.replace(/^\uFEFF/, "").trim().split("\r\n").map((l) => l.split(","));
  const row = lines.find((l) => l[header.indexOf("first_name")] === "Blake");
  assert.deepEqual([row[header.indexOf("table")], row[header.indexOf("seat")]], ["1", "C"], "guests.csv carries the table and seat");

  r = await api("/api/admin/seating/assign", { method: "POST", body: { item_id: tableId, seat_letter: "C", guest_id: null } });
  assert.deepEqual(r.data.assignments.map((a) => a.seat_letter), ["D"], "emptying a seat");
});

test("seating: only reception rooms, reception guests, real seats and real plus-ones can be seated", async () => {
  const { api, id, roomId } = await seatingSetup();
  const tableId = (await api("/api/admin/seating/items", { method: "POST", body: { room_id: roomId, kind: "table", seats: 4 } })).data.ids[0];
  const seat = (body) => api("/api/admin/seating/assign", { method: "POST", body: { item_id: tableId, seat_letter: "A", guest_id: id.Avery, ...body } });
  assert.equal((await seat({ seat_letter: "E" })).status, 400, "a 4-seat table has no seat E");
  assert.equal((await seat({ guest_id: id.Casey })).status, 400, "Casey is invited to the ceremony only");
  assert.equal((await seat({ guest_id: id.Blake, plus_one: 1 })).status, 400, "Blake has no plus-one");
  const chapel = (await api("/api/admin/seating/rooms", { method: "POST", body: { name: "Chapel", kind: "ceremony", width_ft: 30, length_ft: 50 } })).data.id;
  const pew = (await api("/api/admin/seating/items", { method: "POST", body: { room_id: chapel, kind: "table", seats: 4 } })).data.ids[0];
  assert.equal((await seat({ item_id: pew })).status, 400, "no assigned seats at the ceremony");
  assert.equal((await api("/api/admin/seating/rooms", { method: "POST", body: { name: "X", kind: "constructor" } })).status, 400);
});

test("seating: fewer seats, a room that stops being the reception, or a deleted guest unseats people", async () => {
  const { api, id, roomId } = await seatingSetup();
  const tableId = (await api("/api/admin/seating/items", { method: "POST", body: { room_id: roomId, kind: "table", seats: 8 } })).data.ids[0];
  const seat = (letter, guest_id) => api("/api/admin/seating/assign", { method: "POST", body: { item_id: tableId, seat_letter: letter, guest_id } });
  await seat("A", id.Avery);
  await seat("H", id.Blake);
  let r = await api(`/api/admin/seating/items/${tableId}`, { method: "PUT", body: { seats: 6 } });
  assert.deepEqual(r.data.assignments.map((a) => a.seat_letter), ["A"], "seat H is gone, and Blake with it");
  await api(`/api/admin/guests/${id.Avery}`, { method: "DELETE" });
  assert.equal((await api("/api/admin/seating")).data.assignments.length, 0, "a deleted guest's seat is freed");
  await seat("B", id.Blake);
  r = await api(`/api/admin/seating/rooms/${roomId}`, { method: "PUT", body: { kind: "other" } });
  assert.equal(r.data.assignments.length, 0, "only reception rooms keep assigned seats");
});

test("seating: a long row of chairs is one insert, numbered in a reception room and unlabeled at the ceremony", async () => {
  const { api, roomId } = await seatingSetup();
  const row = await api("/api/admin/seating/items", { method: "POST", body: { room_id: roomId, kind: "seat", count: 40 } });
  assert.equal(row.status, 201, JSON.stringify(row.data));
  const chairs = row.data.items.filter((i) => row.data.ids.includes(i.id));
  assert.equal(chairs.length, 40);
  assert.deepEqual(chairs.map((c) => c.label).slice(0, 3), ["1", "2", "3"]);
  assert.equal(chairs[1].x - chairs[0].x, 2, "chairs sit 2 ft apart");
  const chapel = (await api("/api/admin/seating/rooms", { method: "POST", body: { name: "Chapel", kind: "ceremony" } })).data.id;
  const pews = await api("/api/admin/seating/items", { method: "POST", body: { room_id: chapel, kind: "seat", count: 10 } });
  assert.ok(pews.data.items.filter((i) => pews.data.ids.includes(i.id)).every((c) => c.label === ""));
  assert.equal((await api("/api/admin/seating/items", { method: "POST", body: { room_id: chapel, kind: "seat", count: 500 } })).status, 400);
});

/* ----------------------------------------------------------------------- vendors -- */

test("vendors: a day-of vendor is a key vendor unless the same save says not; contacts are optional", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const costco = await api("/api/admin/vendors", { method: "POST", body: { name: "Costco" } });
  assert.equal(costco.status, 201, "a store needs no contact");
  assert.deepEqual([costco.data.vendor.day_of, costco.data.vendor.key_vendor], [0, 0]);
  const dj = await api("/api/admin/vendors", { method: "POST", body: { name: "Spin City DJs", day_of: true, primary_first: "Rae", primary_phone: "555-0100" } });
  assert.equal(dj.data.vendor.key_vendor, 1, "day-of makes it a key vendor");
  const r = await api(`/api/admin/vendors/${dj.data.vendor.id}`, { method: "PUT", body: { key_vendor: false } });
  assert.deepEqual([r.data.vendor.day_of, r.data.vendor.key_vendor], [1, 0], "unchecking key afterwards sticks");
  const both = await api("/api/admin/vendors", { method: "POST", body: { name: "Shuttle Co", day_of: true, key_vendor: false } });
  assert.equal(both.data.vendor.key_vendor, 0, "a save that sets both is taken as sent");
  assert.equal((await api("/api/admin/vendors", { method: "POST", body: { name: "COSTCO" } })).status, 400, "names are unique ignoring case");
  assert.equal((await api("/api/admin/vendors", { method: "POST", body: { name: "Florist", primary_email: "not-an-email" } })).status, 400);
  assert.equal((await api("/api/admin/vendors", { method: "POST", body: { constructor: "x" } })).status, 400, "no name, no vendor");
});

test("vendors: each vendor lists its line items, a rename carries to them, and a vendor in use can't be deleted", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const parent = (await api("/api/admin/expenses", { method: "POST", body: { category: "Decor", item: "Place Settings" } })).data.expense.id;
  await api("/api/admin/expenses", { method: "POST", body: { parent_id: parent, item: "Plates", vendor: "Goodwill", unit_cost: 120, status: "paid" } });
  await api("/api/admin/expenses", { method: "POST", body: { parent_id: parent, item: "Glasses", vendor: "goodwill ", unit_cost: 30, status: "booked" } });
  await api("/api/admin/expenses", { method: "POST", body: { item: "Cake", vendor: "Bakery", unit_cost: 500 } });
  const list = (await api("/api/admin/vendors")).data.vendors;
  const goodwill = list.find((v) => v.name === "Goodwill");
  assert.ok(goodwill, "a vendor named on an expense shows up by itself");
  assert.deepEqual([goodwill.expenses, goodwill.projected, goodwill.paid], [2, 150, 120], "matched ignoring case, and the item they sit under isn't counted twice");
  assert.equal(goodwill.owed, 30, "owed is what's booked and unpaid: the paid plates owe nothing");
  assert.equal(list.find((v) => v.name === "Bakery").owed, 0, "an estimate owes nothing yet");
  const detail = (await api(`/api/admin/vendors/${goodwill.id}`)).data;
  assert.deepEqual(detail.expenses.map((e) => [e.item, e.part_of]).sort(), [["Glasses", "Place Settings"], ["Plates", "Place Settings"]]);
  // Bug: the vendor's Total row read $0.00 because its totals were taken from rows that had lost their vendor.
  assert.deepEqual([detail.vendor.projected, detail.vendor.paid, detail.vendor.owed], [150, 120, 30]);
  await api(`/api/admin/vendors/${goodwill.id}`, { method: "PUT", body: { name: "Goodwill Industries" } });
  const { expenses } = (await api("/api/admin/expenses")).data;
  assert.deepEqual(expenses.filter((e) => e.parent_id === parent).map((e) => e.vendor), ["Goodwill Industries", "Goodwill Industries"]);
  assert.equal((await api(`/api/admin/vendors/${goodwill.id}`, { method: "DELETE" })).status, 400, "two expenses still name it");
});

/* -------------------------------------------------------------- seating shapes -- */

test("seating: shapes take any size and centered text, never take seats, and may share a label", async () => {
  const { api, id, roomId } = await seatingSetup();
  const add = (body) => api("/api/admin/seating/items", { method: "POST", body: { room_id: roomId, kind: "shape", ...body } });
  const floor = await add({ label: "Dance floor\nDJ at the north end", width_ft: 24, length_ft: 18, color: "blue" });
  assert.equal(floor.status, 201, JSON.stringify(floor.data));
  const shape = floor.data.items.find((i) => i.id === floor.data.ids[0]);
  assert.deepEqual([shape.shape, shape.width_ft, shape.length_ft, shape.color, shape.label], ["rect", 24, 18, "blue", "Dance floor\nDJ at the north end"]);
  const oval = await add({ shape: "round", width_ft: 12, length_ft: 6, label: "Dance floor" });
  assert.equal(oval.data.items.find((i) => i.id === oval.data.ids[0]).length_ft, 6, "an oval keeps its own length");
  assert.equal(oval.status, 201, "shapes can share a label; only table numbers are unique");
  assert.equal((await add({ color: "plaid" })).status, 400);
  assert.equal((await add({ width_ft: 900 })).status, 400);
  const seat = await api("/api/admin/seating/assign", { method: "POST", body: { item_id: floor.data.ids[0], seat_letter: "A", guest_id: id.Avery } });
  assert.equal(seat.status, 400, "nobody sits at a shape");
});

/* ----------------------------------------------------------------------- reports -- */

async function reportSetup() {
  const env = makeEnv();
  const api = await adminClient(env);
  const household = (body) => api("/api/admin/households", { method: "POST", body });
  await household({ display_name: "The Smiths", address1: "1 Elm St", city: "Carmel", state: "IN", zip: "46032", email: "smiths@example.com",
    guests: [{ first_name: "Avery", last_name: "Smith", rsvp: "yes", dietary: "Vegan", invite_ceremony: true, wedding_party: true },
      { first_name: "Blake", last_name: "Smith", rsvp: "pending", invite_ceremony: true, plus_one_allowed: true }] });
  await household({ display_name: "=HYPERLINK(1)", guests: [{ first_name: "Casey", last_name: "Jones", rsvp: "no" }] });
  await household({ display_name: "Dana Lee", guests: [{ first_name: "Dana", last_name: "Lee", rsvp: "yes", invite_ceremony: true, invite_reception: false }] });
  return { env, api };
}

const runReport = async (api, body) => {
  const r = await api("/api/admin/reports/run", { method: "POST", body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.rows.map((row) => Object.fromEntries(r.data.columns.map((c, i) => [c.label, row[i]])));
};

test("reports: head count, table cards, chase list and mailing labels count the right people", async () => {
  const { api } = await reportSetup();
  const head = await runReport(api, { id: "headcount" });
  const reception = head.find((r) => r.Event === "Reception");
  assert.deepEqual([reception.Invited, reception.Coming, reception["Awaiting reply"], reception["Not coming"]], [4, 1, 2, 1],
    "Blake's plus-one is invited and awaiting; Dana is ceremony only");
  assert.equal(head.find((r) => r.Event === "Ceremony only").Invited, 1);

  const cards = await runReport(api, { id: "table-cards" });
  assert.deepEqual(cards.map((c) => c.Name), ["Avery Smith", "Blake Smith", "Guest of Blake Smith"],
    "reception guests who haven't declined; an unnamed plus-one has no last name, so it sorts last");
  assert.equal(cards.find((c) => c.Name === "Avery Smith")["Dietary needs"], "Vegan");

  const chase = await runReport(api, { id: "chase-list" });
  assert.deepEqual(chase.map((c) => [c["Name on the envelope"], c["Who hasn't replied"]]), [["The Smiths", "Blake Smith, Guest of Blake Smith"]]);

  const labels = await runReport(api, { id: "mailing-labels" });
  assert.deepEqual(labels.map((l) => [l["Name on the envelope"], l.ZIP]), [["The Smiths", "46032"]], "only households with an address");

  const meals = await runReport(api, { id: "meal-counts" });
  assert.deepEqual(meals, [{ "Dietary needs": "Vegan", Count: 1 }, { "Dietary needs": "Total", Count: 1 }]);
  assert.deepEqual((await runReport(api, { id: "ceremony-only" })).map((r) => r.Name), ["Dana Lee"]);
});

// Bug guards: "is more than"/"is less than" never matched dates or times and "less
// than" took in blanks; counting by a yes/no field labeled No as "(none)"; meal counts
// split "Vegetarian" and "vegetarian"; an RSVP filter typed "Awaiting reply" matched nobody.
test("reports: before/after works on dates and times, counts read Yes/No and 0, and text counts ignore case", async () => {
  const { api } = await reportSetup();
  const run = (definition) => runReport(api, { definition });
  await api("/api/admin/runofshow/items", { method: "POST", body: { title: "Dinner", start_time: "18:00", duration_min: 0 } });
  await api("/api/admin/runofshow/items", { method: "POST", body: { title: "Toasts", start_time: "19:30" } });
  await api("/api/admin/runofshow/items", { method: "POST", body: { title: "Unscheduled" } });
  assert.deepEqual((await run({ source: "run_of_show", columns: ["title"], filters: [{ field: "start_time", op: "gt", value: "18:30" }] })).map((r) => r.Step), ["Toasts"]);
  assert.deepEqual((await run({ source: "run_of_show", columns: ["title"], filters: [{ field: "duration_min", op: "lt", value: "30" }] })).map((r) => r.Step), ["Dinner"], "a blank isn't less than 30");
  const minutes = await run({ source: "run_of_show", group_by: "duration_min", filters: [] });
  assert.ok(minutes.some((r) => r.Minutes === "0"), JSON.stringify(minutes));
  const plusOnes = await run({ source: "people", group_by: "plus_one", filters: [] });
  assert.ok(plusOnes.some((r) => r["Is a plus-one"] === "No") && !plusOnes.some((r) => r["Is a plus-one"] === "(none)"), JSON.stringify(plusOnes));

  const households = (await api("/api/admin/guests")).data.households;
  const [a, b] = households.find((h) => h.display_name === "The Smiths").guests;
  await api(`/api/admin/guests/${a.id}`, { method: "PUT", body: { rsvp: "yes", dietary: "Vegetarian" } });
  await api(`/api/admin/guests/${b.id}`, { method: "PUT", body: { rsvp: "yes", dietary: "vegetarian " } });
  const meals = await runReport(api, { id: "meal-counts" });
  assert.equal(meals.filter((r) => /vegetarian/i.test(r["Dietary needs"])).length, 1, JSON.stringify(meals));

  const fields = (await api("/api/admin/reports")).data.sources.people.fields;
  assert.deepEqual(fields.find((f) => f.key === "rsvp").choices, ["Awaiting", "Coming", "Not coming"], "the builder offers the stored words");
});

test("reports: CSV downloads defuse formulas, and custom reports save, filter and count", async () => {
  const { api } = await reportSetup();
  const csv = await api("/api/admin/reports/full-list/csv");
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(csv.headers.get("content-disposition"), /full-guest-list\.csv/);
  assert.ok(csv.data.includes("'=HYPERLINK(1)"), "a household name that looks like a formula is defused");

  const definition = { source: "people", columns: ["name", "side", "rsvp"], filters: [{ field: "ceremony", op: "is", value: "yes" }], sort: [{ field: "name", dir: "desc" }] };
  const saved = await api("/api/admin/reports", { method: "POST", body: { name: "Ceremony crowd", definition } });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.deepEqual((await runReport(api, { id: saved.data.id })).map((r) => r.Name), ["Guest of Blake Smith", "Dana Lee", "Blake Smith", "Avery Smith"]);
  const counted = await runReport(api, { definition: { source: "people", group_by: "rsvp", filters: [] } });
  assert.deepEqual(counted.map((r) => [r.RSVP, r.Count]), [["Awaiting", 2], ["Coming", 2], ["Not coming", 1], ["Total", 5]]);
  const list = (await api("/api/admin/reports")).data;
  assert.ok(list.builtins.length >= 15 && list.custom.some((c) => c.name === "Ceremony crowd"));
  for (const bad of [{ source: "constructor", columns: ["name"] }, { source: "people", columns: ["nope"] }, { source: "people", columns: ["name"], filters: [{ field: "toString", op: "is" }] }]) {
    assert.equal((await api("/api/admin/reports/run", { method: "POST", body: { definition: bad } })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await api("/api/admin/reports/csv", { method: "POST", body: { definition, name: "x" } })).status, 200);
});

/* ------------------------------------------------------------------ run of show -- */

test("run of show: links resolve to the people in them, declined guests drop out, and deleted things unlink", async () => {
  const { api } = await reportSetup();
  const people = (await api("/api/admin/runofshow")).data.people;
  const key = (name) => people.find((p) => p.name === name).key;
  const vendor = (await api("/api/admin/vendors", { method: "POST", body: { name: "Lens Co", day_of: true, primary_first: "Pat", primary_phone: "555-0101" } })).data.vendor;
  const group = await api("/api/admin/runofshow/groups", { method: "POST", body: { name: "Family photos", members: [key("Avery Smith"), key("Casey Jones"), "999:0"] } });
  assert.equal(group.status, 201, JSON.stringify(group.data));
  const groupId = group.data.id;
  assert.equal(group.data.groups[0].members.length, 2, "an unknown guest isn't added");
  const step = await api("/api/admin/runofshow/items", { method: "POST", body: {
    title: "Family photos", day: "2027-06-12", start_time: "15:30", duration_min: 30, location: "Garden",
    links: [{ kind: "vendor", ref_id: vendor.id, role: "shoots" }, { kind: "group", ref_id: groupId }, { kind: "preset", ref_key: "wedding_party" }, { kind: "group", ref_id: groupId }],
  } });
  assert.equal(step.status, 201, JSON.stringify(step.data));
  const s = step.data.steps[0];
  assert.equal(s.links.length, 3, "a repeated link is kept once");
  assert.deepEqual(s.links.find((l) => l.kind === "group").people.map((p) => p.name), ["Avery Smith"], "Casey declined");
  assert.deepEqual(s.links.find((l) => l.kind === "preset").people.map((p) => p.name), ["Avery Smith"]);
  assert.equal(s.links.find((l) => l.kind === "vendor").vendor.primary_phone, "555-0101");
  for (const bad of [{ kind: "vendor", ref_id: 999 }, { kind: "preset", ref_key: "constructor" }, { kind: "spaceship" }]) {
    assert.equal((await api("/api/admin/runofshow/items", { method: "POST", body: { title: "X", links: [bad] } })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await api("/api/admin/runofshow/items", { method: "POST", body: { title: "X", start_time: "25:00" } })).status, 400);
  await api(`/api/admin/runofshow/groups/${groupId}`, { method: "DELETE" });
  const after = (await api("/api/admin/runofshow")).data.steps[0];
  assert.deepEqual(after.links.map((l) => l.kind).sort(), ["preset", "vendor"], "the deleted group's link is gone");
  const rows = await runReport(api, { id: "run-of-show" });
  assert.deepEqual([rows[0].Start, rows[0].End, rows[0]["Supporting vendors"], rows[0]["Guest cohorts"]], ["15:30", "16:00", "Lens Co (shoots)", "Wedding party"],
    "a vendor linked without a lead or support choice supports");

});

test("day-of view: the coordinator's key reads and checks off steps, never budgets or addresses; a replaced key stops working", async () => {
  const { env, api } = await reportSetup();
  await api("/api/admin/vendors", { method: "POST", body: { name: "Lens Co", day_of: true } });
  await api("/api/admin/expenses", { method: "POST", body: { item: "Photos", vendor: "Lens Co", unit_cost: 4321 } });
  const stepId = (await api("/api/admin/runofshow/items", { method: "POST", body: { title: "Ceremony", start_time: "16:00", links: [{ kind: "preset", ref_key: "reception_guests" }] } })).data.id;
  assert.equal((await call(env, "/api/dayof")).status, 401, "no key, no sign-in");
  const made = (await api("/api/admin/runofshow/link", { method: "POST" })).data;
  const key = new URL(made.url).hash.slice(3);
  assert.ok(key.length >= 24);
  const coordinator = (path, opts = {}) => call(env, path, { ...opts, headers: { "x-dayof-key": key } });
  const view = await coordinator("/api/dayof");
  assert.equal(view.status, 200, JSON.stringify(view.data));
  const text = JSON.stringify(view.data);
  for (const leak of ["4321", "projected", "1 Elm St", "smiths@example.com", "Vegan", "budget"]) assert.ok(!text.includes(leak), `day-of view leaks ${leak}`);
  const done = await coordinator("/api/dayof/status", { method: "POST", body: { item_id: stepId, status: "done" } });
  assert.equal(done.status, 200);
  assert.equal(done.data.steps[0].status, "done");
  assert.equal((await api("/api/admin/runofshow")).data.steps[0].status_by, "coordinator", "the couple see who checked it off");
  assert.equal((await coordinator("/api/dayof/status", { method: "POST", body: { item_id: stepId, status: "exploded" } })).status, 400);
  await api("/api/admin/runofshow/link", { method: "POST" });
  assert.equal((await coordinator("/api/dayof")).status, 401, "the old link stops working once replaced");
  const cookie = await sessionCookie(env);
  assert.equal((await call(env, "/api/dayof", { cookie })).status, 200, "a signed-in admin needs no key");
  assert.equal((await call(env, "/api/dayof/status", { method: "POST", cookie, body: { item_id: stepId, status: "todo" } })).status, 401,
    "an admin's POST without the X-Wedding header is refused (CSRF)");
});

// Bug guards: the rehearsal dinner cohort kept guests who declined the dinner; the
// day-of data carried each linked guest's "declined" RSVP flag and kept a declined
// guest linked by name; a step saved with a bad link half-saved.
test("run of show: the dinner cohort drops dinner declines; day-of carries no RSVP flags; a bad link saves nothing", async () => {
  const { env, api } = await reportSetup();
  const households = (await api("/api/admin/guests")).data.households;
  const smiths = households.find((h) => h.display_name === "The Smiths");
  await api("/api/admin/guests/bulk", { method: "POST", body: { household_ids: [smiths.id], field: "invite_rehearsal", value: true } });
  const [avery, blake] = smiths.guests;
  await api(`/api/admin/guests/${avery.id}`, { method: "PUT", body: { rsvp: "yes", rehearsal_rsvp: "no" } });
  await api(`/api/admin/guests/${blake.id}`, { method: "PUT", body: { rsvp: "yes", rehearsal_rsvp: "yes" } });
  const people = (await api("/api/admin/runofshow")).data.people;
  const casey = people.find((p) => p.name === "Casey Jones");
  const step = await api("/api/admin/runofshow/items", { method: "POST", body: { title: "Toasts", start_time: "19:00",
    links: [{ kind: "preset", ref_key: "rehearsal_dinner" }, { kind: "guest", ref_id: Number(casey.key.split(":")[0]), plus_one: 0 }] } });
  const s = step.data.steps[0];
  assert.ok(!s.links.find((l) => l.kind === "preset").people.some((p) => p.name === "Avery Smith"), "Avery said no to the dinner");
  assert.ok(s.links.find((l) => l.kind === "preset").people.some((p) => p.name === "Blake Smith"));
  assert.equal(s.links.find((l) => l.kind === "guest").declined, true, "the couple see a declined guest flagged");

  const key = new URL((await api("/api/admin/runofshow/link", { method: "POST" })).data.url).hash.slice(3);
  const view = await call(env, "/api/dayof", { headers: { "x-dayof-key": key } });
  assert.ok(!JSON.stringify(view.data).includes("declined"), "no RSVP flags on the day-of view");
  assert.ok(!view.data.steps[0].links.some((l) => l.kind === "guest"), "a declined guest linked by name is left off");

  const bad = await api(`/api/admin/runofshow/items/${step.data.id}`, { method: "PUT", body: { title: "Renamed", links: [{ kind: "vendor", ref_id: 999 }] } });
  assert.equal(bad.status, 400);
  assert.equal((await api("/api/admin/runofshow")).data.steps[0].title, "Toasts", "nothing saved");
});

// Bug guard: the Guests page could save answers the RSVP page forbids (a declined guest
// still bringing a plus-one, or at the rehearsal dinner), and reports counted them.
test("guests: a guest marked not coming brings no plus-one and skips the rehearsal dinner", async () => {
  const { api, id } = await seatingSetup();
  await api(`/api/admin/guests/${id.Avery}`, { method: "PUT", body: { invite_rehearsal: true, rsvp: "yes", plus_one_rsvp: "yes", rehearsal_rsvp: "yes", plus_one_rehearsal_rsvp: "yes" } });
  const g = (await api(`/api/admin/guests/${id.Avery}`, { method: "PUT", body: { rsvp: "no" } })).data.guest;
  assert.deepEqual([g.plus_one_rsvp, g.rehearsal_rsvp, g.plus_one_rehearsal_rsvp], ["no", "no", "no"]);
});

test("run of show: one lead vendor per step, listed first, then supporting vendors and guest cohorts", async () => {
  const { api } = await reportSetup();
  const mk = async (name) => (await api("/api/admin/vendors", { method: "POST", body: { name } })).data.vendor.id;
  const [dj, photo, florist] = [await mk("Spin City"), await mk("Lens Co"), await mk("Petals")];
  const two = await api("/api/admin/runofshow/items", { method: "POST", body: { title: "Entrance",
    links: [{ kind: "vendor", ref_id: dj, ref_key: "lead" }, { kind: "vendor", ref_id: photo, ref_key: "lead" }] } });
  assert.equal(two.status, 400, "two leads on one step");
  const ok = await api("/api/admin/runofshow/items", { method: "POST", body: { title: "Entrance", links: [
    { kind: "preset", ref_key: "wedding_party" }, { kind: "vendor", ref_id: photo, ref_key: "support" },
    { kind: "vendor", ref_id: dj, ref_key: "lead", role: "plays the song" }, { kind: "vendor", ref_id: florist, ref_key: "constructor" },
    { kind: "preset", ref_key: "rehearsal_dinner" }] } });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const links = ok.data.steps[0].links;
  assert.deepEqual(links.map((l) => [l.label, l.kind, Boolean(l.lead)]),
    [["Spin City", "vendor", true], ["Lens Co", "vendor", false], ["Petals", "vendor", false], ["Wedding party", "preset", false], ["Rehearsal dinner guests", "preset", false]],
    "lead first; anything but \"lead\" supports");
  const rows = await runReport(api, { id: "run-of-show" });
  assert.deepEqual([rows[0]["Lead vendor"], rows[0]["Supporting vendors"]], ["Spin City (plays the song)", "Lens Co; Petals"]);
});

/* ------------------------------------------------------------- tags and reports -- */

test("contacts: out-of-town, international and rehearsal dinner guests have their own reports", async () => {
  const { api } = await reportSetup();
  const households = (await api("/api/admin/guests")).data.households;
  const smiths = households.find((h) => h.display_name === "The Smiths");
  const lee = households.find((h) => h.display_name === "Dana Lee");
  await api("/api/admin/guests/bulk", { method: "POST", body: { household_ids: [smiths.id], field: "out_of_town", value: true } });
  await api(`/api/admin/households/${lee.id}`, { method: "PUT", body: { country: "Canada" } });
  await api(`/api/admin/guests/${lee.guests[0].id}`, { method: "PUT", body: { out_of_town: true, international: true } });
  await api("/api/admin/guests/bulk", { method: "POST", body: { household_ids: [smiths.id], field: "invite_rehearsal", value: true } });

  const rehearsal = await runReport(api, { id: "rehearsal-dinner" });
  assert.deepEqual(rehearsal.map((r) => r.Name), ["Avery Smith", "Blake Smith", "Guest of Blake Smith"], "a plus-one goes where their guest goes");
  const head = await runReport(api, { id: "headcount" });
  assert.deepEqual(["Rehearsal dinner", "Out of town", "International"].map((e) => head.find((r) => r.Event === e).Invited), [3, 4, 1]);
  assert.deepEqual((await runReport(api, { id: "international" })).map((r) => [r.Name, r.Country]), [["Dana Lee", "Canada"]]);
  assert.deepEqual((await runReport(api, { id: "welcome-bags" })).map((r) => r["Name on the envelope"]), ["Dana Lee", "The Smiths"]);
  assert.equal((await api("/api/admin/households/bulk", { method: "POST", body: { ids: [smiths.id], field: "international", value: true } })).status, 400,
    "international is a guest's tag now, not the household's");
  const ros = (await api("/api/admin/runofshow")).data;
  assert.ok(["out_of_town", "international", "rehearsal_dinner"].every((k) => ros.presets.some((p) => p.key === k)), "each tag is a guest cohort too");
});

// Bug guard: moving the tags from households to guests must not drop tags already set.
test("upgrading copies a household's out-of-town and international tags onto each of its guests", async () => {
  const env = makeEnv();
  env.DB.db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('_schema_version', '11');
    CREATE TABLE households (id INTEGER PRIMARY KEY, out_of_town INTEGER NOT NULL DEFAULT 0, international INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE guests (id INTEGER PRIMARY KEY, household_id INTEGER);
    CREATE TABLE seating_items (id INTEGER PRIMARY KEY);
    INSERT INTO households VALUES (1, 1, 1), (2, 0, 0);
    INSERT INTO guests VALUES (1, 1), (2, 1), (3, 2);
  `);
  assert.equal((await call(env, "/api/auth/me")).status, 401);
  const rows = env.DB.db.prepare("SELECT out_of_town, international FROM guests ORDER BY id").all();
  assert.deepEqual(rows.map((r) => [r.out_of_town, r.international]), [[1, 1], [1, 1], [0, 0]]);
});

/* ------------------------------------------------------------------------ users -- */

// Bug guard: an entry for someone later made an owner was hidden and couldn't be
// removed, so taking them off ADMIN_EMAILS didn't lock them out.
test("users: an owner's old entry is listed and can be removed", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  await api("/api/admin/users", { method: "POST", body: { email: "jo@example.com", role: "admin" } });
  env.ADMIN_EMAILS = "admin@example.com, jo@example.com";
  const listed = (await api("/api/admin/users")).data.users;
  assert.deepEqual(listed.map((u) => [u.email, u.also_owner]), [["jo@example.com", true]]);
  assert.equal((await api("/api/admin/users/jo%40example.com", { method: "PUT", body: { role: "user" } })).status, 400, "an owner can't be edited here");
  assert.equal((await api("/api/admin/users/jo%40example.com", { method: "DELETE" })).status, 200, "but the old entry can go");
  env.ADMIN_EMAILS = "admin@example.com";
  assert.equal((await call(env, "/api/auth/me", { cookie: await sessionCookie(env, "jo@example.com") })).status, 401, "off ADMIN_EMAILS, they're out");
});

test("users: a user sees only their pages, an admin sees everything, and removing someone signs them out", async () => {
  const env = makeEnv();
  const owner = await adminClient(env);
  const add = await owner("/api/admin/users", { method: "POST", body: { email: "Coordinator@Example.com", name: "Jo", role: "user", pages: ["runofshow", "seating", "settings", "constructor"] } });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  assert.deepEqual(add.data.users[0].pages, ["runofshow", "seating"], "only real, grantable pages; Settings is admin-only");
  assert.equal((await owner("/api/admin/users", { method: "POST", body: { email: "admin@example.com" } })).status, 400, "owners come from ADMIN_EMAILS");

  const jo = `wedding_session=${await sign(env, { kind: "session", email: "coordinator@example.com", name: "Jo" }, 3600)}`;
  const as = (path, opts = {}) => call(env, path, { ...opts, cookie: jo, headers: { "x-wedding": "1" } });
  const me = (await as("/api/auth/me")).data.user;
  assert.deepEqual([me.role, me.pages], ["user", ["runofshow", "seating"]]);
  assert.equal((await as("/api/admin/runofshow")).status, 200);
  assert.equal((await as("/api/admin/seating")).status, 200);
  for (const path of ["/api/admin/summary", "/api/admin/expenses", "/api/admin/guests", "/api/admin/reports", "/api/admin/vendors", "/api/admin/settings", "/api/admin/users", "/api/admin/drive/status"]) {
    assert.equal((await as(path)).status, 403, `${path} is off limits`);
  }
  assert.equal((await as("/api/public/expense/options")).status, 403, "the expense form needs Expenses");
  assert.equal((await as("/api/dayof")).status, 200, "Run of show opens the day-of view");
  assert.equal((await as("/api/admin/users", { method: "POST", body: { email: "x@example.com" } })).status, 403, "a user can't add people");

  await owner("/api/admin/users/coordinator%40example.com", { method: "PUT", body: { role: "admin" } });
  assert.equal((await as("/api/admin/settings")).status, 200, "an admin gets everything");
  await owner("/api/admin/users/coordinator%40example.com", { method: "DELETE" });
  assert.equal((await as("/api/admin/runofshow")).status, 401, "removed: the old session no longer works");
  assert.equal((await owner("/api/admin/users/admin%40example.com", { method: "DELETE" })).status, 400, "an owner can't be removed here");
});

test("users: Google sign-in lets in someone added on the Users page, and nobody else", async () => {
  const env = makeEnv();
  const owner = await adminClient(env);
  await owner("/api/admin/users", { method: "POST", body: { email: "jo@example.com", role: "user", pages: ["runofshow"] } });
  const state = await sign(env, { kind: "oauth", purpose: "login", nonce: "n1" }, 600);
  const signIn = (email) => withFetch(
    (url) => (url.startsWith("https://oauth2.googleapis.com/token") ? okJson({ access_token: "at", expires_in: 3600 }) : okJson({ email, email_verified: true, name: "X" })),
    () => call(env, `/api/auth/callback?code=c&state=${encodeURIComponent(state)}`, { cookie: "wedding_oauth=n1" })
  );
  assert.match((await signIn("Jo@Example.com")).headers.get("set-cookie") || "", /wedding_session=[^;]/, "Jo is on the list, whatever the case");
  assert.doesNotMatch((await signIn("stranger@example.com")).headers.get("set-cookie") || "", /wedding_session=[^;]/);
});

/* ---------------------------------------------------------------- communications -- */

/** Households with emails, a connected Gmail (a token that won't need refreshing), and a stubbed Gmail API. */
async function commsSetup({ households = 3 } = {}) {
  const env = makeEnv({ PUBLIC_URL: "https://www.example-wedding.com" });
  const api = await adminClient(env);
  for (let i = 1; i <= households; i++) {
    await api("/api/admin/households", { method: "POST", body: {
      display_name: `Household ${i}`, greeting: `Friends ${i}`, email: `h${i}@example.com`,
      guests: [{ first_name: `Guest${i}`, last_name: "Test", side: i % 2 ? "Bride" : "Groom", invite_ceremony: i === 1, email: i === 1 ? "own1@example.com" : null }],
    } });
  }
  await api("/api/admin/households", { method: "POST", body: { display_name: "No Email", guests: [{ first_name: "Nemo", last_name: "Test", side: "Bride" }] } });
  env.DB.db.prepare("INSERT INTO settings (key, value) VALUES ('_gmail', ?)").run(JSON.stringify({
    refresh_token: "r", access_token: "a", expires_at: Date.now() + 3600000, email: "us@gmail.com",
  }));
  await api("/api/admin/settings", { method: "PUT", body: { couple_names: "Kaitlyn & Patrick", wedding_date: "2027-06-12" } });
  return { env, api };
}

/** Run `fn` with Gmail stubbed; returns { result, sent: [decoded MIME] }. `fail(n)` makes the nth send fail. */
async function withGmail(fn, { status = () => 200 } = {}) {
  const sent = [];
  const result = await withFetch(async (url, init) => {
    if (url.includes("gmail.googleapis.com")) {
      const raw = JSON.parse(init.body).raw.replace(/-/g, "+").replace(/_/g, "/");
      const mime = Buffer.from(raw, "base64").toString("utf8");
      const code = status(sent.length);
      if (code === 200) sent.push(mime);
      return new Response(JSON.stringify(code === 200 ? { id: `m${sent.length}` } : { error: "nope" }), { status: code });
    }
    if (url.includes("oauth2.googleapis.com/token")) return okJson({ access_token: "a2", expires_in: 3600 });
    throw new Error(`unexpected fetch ${url}`);
  }, fn);
  return { result, sent };
}
const decodeParts = (mime) => [...mime.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)].map((m) => Buffer.from(m[1].replace(/\r\n/g, ""), "base64").toString("utf8"));

test("calendar: times are written in UTC from the wedding's time zone, with text escaped and long lines folded", () => {
  assert.equal(zonedTime("2027-06-12", "16:30", "America/Indiana/Indianapolis").toISOString(), "2027-06-12T20:30:00.000Z", "summer is UTC-4");
  assert.equal(zonedTime("2027-01-09", "16:30", "America/Indiana/Indianapolis").toISOString(), "2027-01-09T21:30:00.000Z", "winter is UTC-5");
  const ics = buildIcs([{ id: "ev-1", title: "Ceremony; then dinner, dancing", date: "2027-06-12", start: "16:30", end: "17:00", location: "St. Mary's, 1 Main St, Carmel, IN",
    notes: `Line one\nLine two ${"x".repeat(120)}`, url: "https://example.com", reminder: "1d", for: "everyone" }], { timeZone: "America/Indiana/Indianapolis", host: "example.com" });
  assert.match(ics, /DTSTART:20270612T203000Z\r\nDTEND:20270612T210000Z/);
  assert.match(ics, /SUMMARY:Ceremony\\; then dinner\\, dancing/);
  assert.match(ics, /TRIGGER:-P1D/);
  assert.ok(ics.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75), "no line over 75 octets");
  assert.equal(fillIn("Hi {greeting}, {nope}", { greeting: "Jo" }), "Hi Jo, {nope}", "an unknown fill-in is left as typed");
});

test("RSVP: the household email is required, guests may add their own, and the calendar invite downloads afterwards", async () => {
  const { env, api } = await rsvpSetup();
  await api("/api/admin/comms/calendar", { method: "PUT", body: { time_zone: "America/Indiana/Indianapolis", events: [
    { title: "Ceremony", date: "2027-06-12", start: "16:00", end: "16:45", location: "Chapel", for: "ceremony" },
    { title: "Reception", date: "2027-06-12", start: "18:00", end: "23:00", location: "Hall", for: "reception" },
  ] } });
  const alex = (await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "Alex", last: "Example" } })).data.matches[0];
  const answer = (extra) => call(env, "/api/public/rsvp/submit", { method: "POST", body: { token: alex.token, guests: alex.guests.map((g) => ({ id: g.id, rsvp: "yes" })), ...extra } });
  assert.equal((await answer({})).status, 400, "no email, no RSVP");
  assert.equal((await answer({ email: "not-an-email" })).status, 400);
  const ok = await call(env, "/api/public/rsvp/submit", { method: "POST", body: { token: alex.token, email: "alex@example.com",
    guests: alex.guests.map((g, i) => ({ id: g.id, rsvp: "yes", email: i === 1 ? "sam@example.com" : "" })) } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.household.guests[1].email_hint, "s•••@example.com", "the page only sees emails masked");
  const ics = await call(env, ok.data.calendar_url);
  assert.equal(ics.status, 200);
  assert.match(ics.headers.get("content-type"), /text\/calendar/);
  assert.ok(ics.data.includes("SUMMARY:Ceremony") && ics.data.includes("SUMMARY:Reception"), "Alex is invited to both");
  assert.equal((await call(env, "/api/public/calendar?t=forged")).status, 400);
  const info = (await call(env, "/api/public/info")).data;
  assert.equal(info.rsvp_page.accept_label, "Joyfully accepts", "the RSVP page's wording comes with the info");
  assert.ok(!JSON.stringify(info).includes("calendar_events"), "the info doesn't carry the events themselves");
});

test("RSVP: a guest invited to the rehearsal dinner answers for it on their own, and the page says what each guest is invited to", async () => {
  const { env, api, households } = await rsvpSetup();
  const [alexRow, samRow] = households.find((h) => h.code === "H-001").guests;
  await api(`/api/admin/guests/${alexRow.id}`, { method: "PUT", body: { invite_rehearsal: true, invite_ceremony: true, invite_reception: true } });
  await api(`/api/admin/guests/${samRow.id}`, { method: "PUT", body: { invite_ceremony: false, invite_reception: true } });
  await api("/api/admin/comms/calendar", { method: "PUT", body: { events: [
    { title: "Reception", date: "2027-06-12", start: "18:00", for: "reception" },
    { title: "Rehearsal dinner", date: "2027-06-11", start: "18:30", location: "Trattoria", for: "rehearsal" },
  ] } });
  const look = async () => (await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "Alex", last: "Example" } })).data.matches[0];
  const alex = await look();
  const [a, sam] = alex.guests;
  assert.deepEqual([a.ceremony, a.reception, a.rehearsal, a.rehearsal_rsvp], [true, true, true, "pending"]);
  assert.deepEqual([sam.ceremony, sam.reception, sam.rehearsal, "rehearsal_rsvp" in sam], [false, true, false, false], "Sam is reception only and not asked about the dinner");
  assert.deepEqual(alex.rehearsal, { date: "2027-06-11", start: "18:30", location: "Trattoria" });
  const jordan = (await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "Jordan", last: "Sample" } })).data.matches[0];
  assert.ok(!("rehearsal" in jordan), "a household with nobody invited to the dinner doesn't hear about it");

  const submit = (answers) => call(env, "/api/public/rsvp/submit", { method: "POST", body: { token: alex.token, email: "alex@example.com",
    guests: [{ id: a.id, rsvp: "yes", ...answers[0] }, { id: sam.id, rsvp: "yes", ...answers[1] }] } });
  assert.equal((await submit([{}, {}])).status, 400, "a guest coming to the wedding must answer for the dinner");
  const ok = await submit([{ rehearsal_rsvp: "no" }, { rehearsal_rsvp: "yes" }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const stored = (await api("/api/admin/guests")).data.households.find((h) => h.code === "H-001").guests;
  assert.deepEqual(stored.map((g) => g.rehearsal_rsvp), ["no", "pending"], "Sam isn't invited, so Sam's answer is ignored");
  const ics = (await call(env, ok.data.calendar_url)).data;
  assert.ok(ics.includes("SUMMARY:Reception") && !ics.includes("Rehearsal dinner"), "a declined dinner leaves the calendar invite");

  await submit([{ rehearsal_rsvp: "yes" }, {}]);
  const report = await runReport(api, { id: "rehearsal-dinner" });
  assert.equal(report.find((r) => r.Name === "Alex Example")["Rehearsal dinner RSVP"], "Coming");
  const head = await runReport(api, { id: "headcount" });
  assert.equal(head.find((r) => r.Event === "Rehearsal dinner").Coming, 1, "the head count counts the dinner's own answers");
  const who = (await api("/api/admin/comms/audience", { method: "POST", body: { audience: { ticks: ["rehearsal_rsvp:Coming"] } } })).data.households;
  assert.deepEqual(who.map((x) => x.to), ["alex@example.com"], "emails can go to the guests coming to the dinner");

  // Declining the wedding declines the dinner too, whatever the form sent.
  await call(env, "/api/public/rsvp/submit", { method: "POST", body: { token: alex.token, email: "alex@example.com",
    guests: [{ id: a.id, rsvp: "no", rehearsal_rsvp: "yes" }, { id: sam.id, rsvp: "yes" }] } });
  assert.equal((await look()).guests[0].rehearsal_rsvp, "no");
  const reset = await api("/api/admin/households/reset-rsvp", { method: "POST", body: { ids: [alexRow.household_id] } });
  assert.equal(reset.status, 200);
  assert.equal((await look()).guests[0].rehearsal_rsvp, "pending", "resetting an RSVP resets the dinner's answer");
  assert.equal((await api(`/api/admin/guests/${alexRow.id}`, { method: "PUT", body: { rehearsal_rsvp: "maybe" } })).status, 400);
});

// Bug guard: a plus-one used to count as coming to the rehearsal dinner whenever the
// host was, with no way for the host to say the plus-one wasn't.
test("RSVP: a host coming to the rehearsal dinner says whether their plus-one comes too", async () => {
  const { env, api, households } = await rsvpSetup();
  const jordanRow = households.find((h) => h.code === "H-002").guests[0];
  await api(`/api/admin/guests/${jordanRow.id}`, { method: "PUT", body: { invite_rehearsal: true } });
  const look = async () => (await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "Jordan", last: "Sample" } })).data.matches[0];
  const jordan = await look();
  assert.equal(jordan.guests[0].plus_one_rehearsal_rsvp, "pending");
  const submit = (answer) => call(env, "/api/public/rsvp/submit", { method: "POST", body: { token: jordan.token, email: "jordan@example.com",
    guests: [{ id: jordan.guests[0].id, rsvp: "yes", rehearsal_rsvp: "yes", plus_one_rsvp: "yes", plus_one_name: "Casey Guest", ...answer }] } });
  assert.equal((await submit({})).status, 400, "the plus-one's dinner answer is required");
  assert.equal((await submit({ plus_one_rehearsal_rsvp: "no" })).status, 200);
  const dinner = async () => Object.fromEntries((await runReport(api, { id: "rehearsal-dinner" })).map((r) => [r.Name, r["Rehearsal dinner RSVP"]]));
  assert.deepEqual(await dinner(), { "Jordan Sample": "Coming", "Casey Guest": "Not coming" });
  await submit({ plus_one_rehearsal_rsvp: "yes" });
  assert.deepEqual(await dinner(), { "Jordan Sample": "Coming", "Casey Guest": "Coming" });
  // The host skipping the dinner takes the plus-one off it, whatever the form sent.
  await submit({ rehearsal_rsvp: "no", plus_one_rehearsal_rsvp: "yes" });
  assert.deepEqual(await dinner(), { "Jordan Sample": "Not coming", "Casey Guest": "Not coming" });
  await api("/api/admin/households/reset-rsvp", { method: "POST", body: { ids: [jordanRow.household_id] } });
  assert.equal((await look()).guests[0].plus_one_rehearsal_rsvp, "pending");
});

test("emails: one per household to its email with guests copied, filled in, from Kaitlyn & Patrick, and never twice", async () => {
  const { env, api } = await commsSetup();
  await api("/api/admin/comms/calendar", { method: "PUT", body: { events: [{ title: "Wedding", date: "2027-06-12", start: "16:00", for: "everyone" }] } });
  const created = await api("/api/admin/comms/messages", { method: "POST", body: {
    subject: "Details for {greeting}", body: "Hi {greeting},\n\nSee you {wedding_date}! RSVP: {rsvp_link}", audience: { ticks: ["side:Bride", "constructor:x"] }, attach_ics: true,
  } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.id;
  const who = (await api("/api/admin/comms/audience", { method: "POST", body: { audience: { ticks: ["side:Bride"] } } })).data.households;
  assert.deepEqual(who.map((x) => [x.name, x.to]), [["Household 1", "h1@example.com"], ["Household 3", "h3@example.com"], ["No Email", null]]);

  const { result, sent } = await withGmail(() => api(`/api/admin/comms/messages/${id}/send`, { method: "POST", body: {} }));
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual([result.data.result.sent, sent.length], [2, 2]);
  const first = sent.find((m) => m.includes("To: h1@example.com"));
  assert.match(first, /From: "Kaitlyn & Patrick" <us@gmail\.com>/);
  assert.match(first, /Cc: own1@example\.com/, "a guest's own email is copied");
  assert.match(first, /Subject: Details for Friends 1/);
  assert.match(first, /filename="wedding\.ics"/);
  const [text, html, ics] = decodeParts(first);
  assert.match(text, /See you Saturday, June 12, 2027! RSVP: https:\/\/www\.example-wedding\.com\/rsvp\//);
  assert.match(html, /<a href="https:\/\/www\.example-wedding\.com\/rsvp\/">/);
  assert.match(ics, /SUMMARY:Wedding/);

  const list = (await api("/api/admin/comms")).data.messages.find((m) => m.id === id);
  assert.deepEqual([list.status, list.counts.sent, list.counts.skipped], ["sent", 2, 1], "the household with no email is recorded, not dropped silently");
  assert.equal((await api(`/api/admin/comms/messages/${id}/send`, { method: "POST", body: {} })).status, 400, "a sent email can't go again");
  assert.equal((await api(`/api/admin/comms/messages/${id}`, { method: "PUT", body: { subject: "x" } })).status, 400, "or be edited");
});

test("email editor HTML keeps formatting and links but loses scripts, styles and unsafe links", () => {
  const dirty = `<div style="color:red" onclick="x()">Hi <b>there</b></div><script>alert(1)</script><style>p{}</style>
    <ul><li>One<li>Two</ul><a href="javascript:alert(1)">bad</a> <a href="{rsvp_link}" class="button big">RSVP</a>
    <a href="https://example.com/?a=1&amp;b=2" target="_blank">site</a><img src=x onerror=alert(1)><p>5 < 6 & 7</p><h1>Big</h1><em>open`;
  const clean = sanitizeHtml(dirty);
  assert.equal(clean, `<p>Hi <b>there</b></p>
    <ul><li>One<li>Two</li></li></ul><p>bad <a href="{rsvp_link}" class="button">RSVP</a>
    <a href="https://example.com/?a=1&amp;b=2">site</a></p><p>5 &lt; 6 &amp; 7</p><h2>Big</h2><p><em>open</em></p>`);
  // Bug guard: the editor leaves the first line outside any paragraph, and the wedding
  // design then showed it unstyled.
  assert.equal(sanitizeHtml("Hi {greeting},<p>Body</p>"), "<p>Hi {greeting},</p><p>Body</p>");
  assert.equal(sanitizeHtml("<p>Plan:</p><p><ul><li>A</li></ul><p><b>B</b></p></p>"), "<p>Plan:</p><ul><li>A</li></ul><p><b>B</b></p>",
    "a list the editor nested in a paragraph comes out after it");
  assert.equal(htmlToText("<h2>Plans</h2><p>Hi {greeting},</p><ul><li>Ceremony</li><li>Dinner</li></ul><ol><li>Park</li><li>Walk in</li></ol><p><a href=\"https://x.com/r\" class=\"button\">RSVP</a> &amp; more</p>"),
    "Plans\n\nHi {greeting},\n\n• Ceremony\n• Dinner\n\n1. Park\n2. Walk in\n\nRSVP (https://x.com/r) & more");
  const theme = themeFrom("<style>html,body{background:#faf6f0}:root{--wm-text:#3b4a3f;--wm-font:'Cormorant Garamond',Georgia,serif}</style>", "#A4727E");
  assert.deepEqual(theme, { background: "#faf6f0", text: "#3b4a3f", accent: "#A4727E", font: "Cormorant Garamond" });
  assert.equal(themeFrom("", "nope").accent, "#A4727E", "no site copy yet: the default look");
});

test("emails: a rich-text email goes out in the wedding design with a plain-text twin, and fill-ins can't inject HTML", async () => {
  const { env, api } = await commsSetup({ households: 1 });
  await api("/api/admin/guests").then(async (r) => {
    const h1 = r.data.households.find((h) => h.display_name === "Household 1");
    await api(`/api/admin/households/${h1.id}`, { method: "PUT", body: { greeting: "Ann & <b>Bo</b>" } });
  });
  await api("/api/admin/settings", { method: "PUT", body: { venue: "The Ritz" } });
  env.DB.db.prepare("INSERT INTO site_pages (path, title, html, source_url, content_hash, fetched_at, changed_at) VALUES ('/', 'Home', ?, '', '', '', '')")
    .run("<style>html,body{background:#faf6f0}:root{--wm-text:#3b4a3f;--wm-font:'Cormorant Garamond',Georgia,serif}</style>");
  await api("/api/admin/comms/email-design", { method: "PUT", body: { header_image: "https://example.com/us.jpg", footer_note: "With love from Indiana" } });
  assert.equal((await api("/api/admin/comms/email-design", { method: "PUT", body: { header_image: "javascript:alert(1)" } })).status, 400);
  const id = (await api("/api/admin/comms/messages", { method: "POST", body: { subject: "Details for {greeting}", format: "html", design: "wedding",
    body: '<h2>The plan</h2><p>Hi {greeting},</p><ul><li>Ceremony at 4</li></ul><p><a class="button" href="{rsvp_link}">RSVP</a></p><script>x</script>' } })).data.id;
  const { sent } = await withGmail(() => api(`/api/admin/comms/messages/${id}/send`, { method: "POST", body: {} }));
  assert.equal(sent.length, 1);
  const [text, html] = decodeParts(sent[0]);
  assert.match(text, /^The plan\n\nHi Ann & <b>Bo<\/b>,\n\n• Ceremony at 4\n\nRSVP \(https:\/\/www\.example-wedding\.com\/rsvp\/\)/);
  assert.ok(html.includes("Hi Ann &amp; &lt;b&gt;Bo&lt;/b&gt;,"), "a fill-in is text, never HTML");
  assert.ok(!html.includes("<script"));
  assert.match(html, /<ul style="[^"]+">/);
  assert.match(html, /<a href="https:\/\/www\.example-wedding\.com\/rsvp\/" class="button" style="[^"]*background:#A4727E/);
  assert.ok(html.includes("background:#faf6f0") && html.includes("'Cormorant Garamond'") && html.includes("color:#3b4a3f"), "the website's look");
  assert.ok(html.includes("Kaitlyn &amp; Patrick") && html.includes("Saturday, June 12, 2027") && html.includes("The Ritz"));
  assert.ok(html.includes('src="https://example.com/us.jpg"') && html.includes("With love from Indiana"));

  // An older plain-text email switched to the editor's format is escaped, not run as HTML.
  const old = (await api("/api/admin/comms/messages", { method: "POST", body: { subject: "Old", body: "Hi <script>alert(1)</script>\n\nBye" } })).data.id;
  await api(`/api/admin/comms/messages/${old}`, { method: "PUT", body: { format: "html" } });
  const stored = env.DB.db.prepare("SELECT body FROM comm_messages WHERE id = ?").get(old).body;
  assert.equal(stored, "<p>Hi &lt;script&gt;alert(1)&lt;/script&gt;</p>\n<p>Bye</p>");
});

// Bug guard: the calendar invite went out as a text/calendar part, which Gmail doesn't
// list as an attachment, and households that declined still got the events.
test("emails: the calendar invite attaches as a file, with the events each kind of guest should get", async () => {
  const { env, api } = await commsSetup({ households: 3 });
  await api("/api/admin/comms/calendar", { method: "PUT", body: { events: [
    { title: "Ceremony", date: "2027-06-12", start: "16:00", for: "ceremony" },
    { title: "Reception", date: "2027-06-12", start: "18:00", for: "reception" },
    { title: "Rehearsal dinner", date: "2027-06-11", start: "18:30", for: "rehearsal" },
  ] } });
  const households = (await api("/api/admin/guests")).data.households;
  const h3 = households.find((h) => h.display_name === "Household 3");
  await api(`/api/admin/guests/${h3.guests[0].id}`, { method: "PUT", body: { rsvp: "no" } });
  const id = (await api("/api/admin/comms/messages", { method: "POST", body: { subject: "Hi", body: "<p>Hello</p>", format: "html", design: "wedding", attach_ics: true } })).data.id;
  const { sent } = await withGmail(() => api(`/api/admin/comms/messages/${id}/send`, { method: "POST", body: {} }));
  const to = (n) => sent.find((m) => m.includes(`To: h${n}@example.com`));
  assert.match(to(1), /Content-Type: application\/ics; name="wedding\.ics"/);
  assert.ok(!/text\/calendar/.test(to(1)));
  const icsOf = (mime) => decodeParts(mime)[2] || "";
  assert.ok(icsOf(to(1)).includes("SUMMARY:Ceremony") && icsOf(to(1)).includes("SUMMARY:Reception"));
  assert.ok(!icsOf(to(2)).includes("SUMMARY:Ceremony") && icsOf(to(2)).includes("SUMMARY:Reception"), "reception only");
  assert.ok(!to(3).includes("wedding.ics"), "a household that declined gets no invite");
  assert.ok(decodeParts(to(1))[1].includes("Your calendar invite is attached"));

  const test = async (as) => {
    const r = await withGmail(() => api(`/api/admin/comms/messages/${id}/test`, { method: "POST", body: { as } }));
    assert.equal(r.result.status, 200, JSON.stringify(r.result.data));
    return { ...r.result.data, ics: icsOf(r.sent[0]), mime: r.sent[0] };
  };
  const titles = (ics) => [...ics.matchAll(/SUMMARY:(.+)\r\n/g)].map((m) => m[1]);
  assert.deepEqual(titles((await test("ceremony")).ics), ["Ceremony"]);
  assert.deepEqual(titles((await test("reception")).ics), ["Reception"]);
  assert.deepEqual(titles((await test("both")).ics), ["Ceremony", "Reception"]);
  const rehearsal = await test("rehearsal");
  assert.deepEqual(titles(rehearsal.ics), ["Reception", "Rehearsal dinner"]);
  assert.equal(rehearsal.calendar, "Calendar invite attached with Reception, Rehearsal dinner.");
  const declined = await test("declined");
  assert.ok(!declined.mime.includes("wedding.ics"));
  assert.match(declined.calendar, /gets none of the events/);

  // A test email's {calendar_link} downloads that kind of guest's invite.
  const linkId = (await api("/api/admin/comms/messages", { method: "POST", body: { subject: "Link", body: "<p>{calendar_link}</p>", format: "html" } })).data.id;
  const linked = await withGmail(() => api(`/api/admin/comms/messages/${linkId}/test`, { method: "POST", body: { as: "rehearsal" } }));
  const url = decodeParts(linked.sent[0])[0].match(/https:\/\/www\.example-wedding\.com(\/api\/public\/calendar\?t=\S+)/)[1];
  assert.deepEqual(titles((await call(env, url)).data), ["Reception", "Rehearsal dinner"]);

  const preview = await api("/api/admin/comms/preview", { method: "POST", body: { subject: "S {greeting}", body: "<p>Hi</p>", attach_ics: true, as: "ceremony" } });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.subject, "S Jane and John");
  assert.match(preview.data.html, /Your calendar invite is attached/);
  assert.equal(preview.data.calendar, "Calendar invite attached with Ceremony.");
});

test("emails: a big send goes out in batches, and the cron sends the rest", async () => {
  const { env, api } = await commsSetup({ households: 25 });
  const id = (await api("/api/admin/comms/messages", { method: "POST", body: { subject: "Hello", body: "Hi {greeting}" } })).data.id;
  const now = await withGmail(() => api(`/api/admin/comms/messages/${id}/send`, { method: "POST", body: {} }));
  assert.equal(now.sent.length, SEND_BATCH, "the first batch goes at once");
  const later = await withGmail(() => processComms(env));
  assert.equal(later.sent.length, SEND_BATCH, "the cron sends the next batch");
  const last = await withGmail(() => processComms(env));
  assert.equal(last.sent.length, 25 - 2 * SEND_BATCH, "and the rest");
  const again = await withGmail(() => processComms(env));
  assert.equal(again.sent.length, 0, "and nobody gets it twice");
  assert.equal((await api("/api/admin/comms")).data.messages[0].status, "sent");
});

test("emails: a scheduled email waits for its time; an automatic one goes to each household once after it RSVPs", async () => {
  const { env, api } = await commsSetup();
  const scheduled = (await api("/api/admin/comms/messages", { method: "POST", body: { subject: "A week to go", body: "Soon!" } })).data.id;
  assert.equal((await api(`/api/admin/comms/messages/${scheduled}/schedule`, { method: "POST", body: { send_at: "2020-01-01T09:00" } })).status, 400, "not in the past");
  assert.equal((await api(`/api/admin/comms/messages/${scheduled}/schedule`, { method: "POST", body: { send_at: "2099-06-05T09:00" } })).status, 200);
  assert.equal((await withGmail(() => processComms(env))).sent.length, 0, "not due yet");
  env.DB.db.prepare("UPDATE comm_messages SET send_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(scheduled);
  assert.equal((await withGmail(() => processComms(env))).sent.length, 3, "due: everyone with an email");

  const auto = (await api("/api/admin/comms/messages", { method: "POST", body: { subject: "Thanks for your RSVP", body: "Hi {greeting}", audience: { ticks: ["rsvp:Coming"] } } })).data.id;
  assert.equal((await api(`/api/admin/comms/messages/${auto}/automate`, { method: "POST", body: { on: true } })).status, 200);
  const lookup = (await call(env, "/api/public/rsvp/lookup", { method: "POST", body: { first: "Guest2", last: "Test" } })).data.matches[0];
  const rsvp = (answer) => call(env, "/api/public/rsvp/submit", { method: "POST", body: { token: lookup.token, email: "h2@example.com", guests: [{ id: lookup.guests[0].id, rsvp: answer }] } });
  await rsvp("no");
  assert.equal((await withGmail(() => processComms(env))).sent.length, 0, "a no isn't in a Coming audience");
  await rsvp("yes");
  const sent = (await withGmail(() => processComms(env))).sent;
  assert.equal(sent.length, 1);
  assert.match(sent[0], /To: h2@example\.com/);
  await rsvp("yes");
  assert.equal((await withGmail(() => processComms(env))).sent.length, 0, "changing the RSVP doesn't send it again");
});

test("emails: when Gmail stops working nothing is lost; the emails wait and go once it's back", async () => {
  const { env, api } = await commsSetup();
  const id = (await api("/api/admin/comms/messages", { method: "POST", body: { subject: "Hello", body: "Hi" } })).data.id;
  const down = await withGmail(() => api(`/api/admin/comms/messages/${id}/send`, { method: "POST", body: {} }), { status: () => 401 });
  assert.equal(down.result.data.result.sent, 0);
  assert.match(down.result.data.result.stopped, /Reconnect Gmail/);
  const status = (await api("/api/admin/comms")).data;
  assert.equal(status.messages[0].counts.queued, 3, "all three still waiting");
  assert.match(status.gmail.last_error, /Reconnect Gmail/, "Settings shows the problem");
  const back = await withGmail(() => processComms(env));
  assert.equal(back.sent.length, 3);
  assert.equal((await api("/api/admin/comms")).data.gmail.last_error, null, "and the problem clears once it sends");
});

test("emails: a title names an email for admins only; it never goes to guests, and it can change after sending", async () => {
  const { env, api } = await commsSetup();
  const created = await api("/api/admin/comms/messages", { method: "POST", body: { title: "Secret admin label", subject: "Hello", body: "<p>Hi {greeting}</p>", format: "html" } });
  const id = created.data.id;
  assert.equal(created.data.messages.find((m) => m.id === id).title, "Secret admin label");
  const test = await withGmail(() => api(`/api/admin/comms/messages/${id}/test`, { method: "POST", body: {} }));
  const all = await withGmail(() => api(`/api/admin/comms/messages/${id}/send`, { method: "POST", body: {} }));
  const mail = [...test.sent, ...all.sent];
  assert.ok(mail.length > 1);
  for (const mime of mail) assert.ok(![mime, ...decodeParts(mime)].some((part) => part.includes("Secret admin label")), "the title isn't in any email");
  assert.ok(!JSON.stringify((await call(env, "/api/public/info")).data).includes("Secret admin label"), "or on the RSVP page");
  assert.equal((await api(`/api/admin/comms/messages/${id}`, { method: "PUT", body: { title: "Renamed" } })).status, 200, "a sent email's title can change");
  assert.equal((await api(`/api/admin/comms/messages/${id}`, { method: "PUT", body: { title: "Again", subject: "New" } })).status, 400, "but nothing else");
  const after = (await api("/api/admin/comms")).data.messages.find((m) => m.id === id);
  assert.deepEqual([after.title, after.subject], ["Renamed", "Hello"]);
});

test("post-wedding call: {call_link} is a personal \"click here\" link; the page names only that household's decliners and tags them", async () => {
  const { env, api } = await commsSetup();
  env.DB.db.prepare("UPDATE guests SET rsvp = 'no' WHERE first_name = 'Guest2'").run();
  const guestId = (first) => env.DB.db.prepare("SELECT id FROM guests WHERE first_name = ?").get(first).id;
  const tagged = () => env.DB.db.prepare("SELECT first_name FROM guests WHERE post_wedding_call = 1 ORDER BY id").all().map((g) => g.first_name);

  const id = (await api("/api/admin/comms/messages", { method: "POST", body: {
    subject: "We'll miss you", format: "html", audience: { ticks: ["rsvp:Not coming"] },
    body: '<p>To find a time, {call_link}.</p><p><a href="{call_link}">Or this</a></p>',
  } })).data.id;
  const { sent } = await withGmail(() => api(`/api/admin/comms/messages/${id}/send`, { method: "POST", body: {} }));
  assert.equal(sent.length, 1, "only the household that said no");
  const [text, html] = decodeParts(sent[0]);
  const link = html.match(/To find a time, <a href="(https:\/\/www\.example-wedding\.com\/call\/\?t=[^"]+)">click here<\/a>\./)?.[1];
  assert.ok(link, "an HTML email gets a \"click here\" link");
  assert.ok(html.includes(`<a href="${link}">Or this</a>`), "text linked to {call_link} in the editor links to the page");
  assert.match(text, /To find a time, click here \(https:\/\/www\.example-wedding\.com\/call\/\?t=/, "the plain-text part shows the address");
  const t = new URL(link.replace(/&amp;/g, "&")).searchParams.get("t");

  await api("/api/admin/settings", { method: "PUT", body: { registry_url: "https://example.com/registry" } });
  assert.equal((await api("/api/admin/settings", { method: "PUT", body: { registry_url: "javascript:alert(1)" } })).status, 400);
  const page = await call(env, `/api/public/call?t=${encodeURIComponent(t)}`);
  assert.equal(page.status, 200, JSON.stringify(page.data));
  assert.deepEqual(page.data.guests, [{ id: guestId("Guest2"), name: "Guest2 Test", requested: false }], "names only, and only who said no");
  assert.equal(page.data.registry_url, "https://example.com/registry");
  assert.ok(!JSON.stringify(page.data).includes("h2@example.com"), "no email addresses");

  // Another household's guest id in the form is ignored; on its own it's refused.
  assert.equal((await call(env, "/api/public/call", { method: "POST", body: { t, guests: [guestId("Guest1")] } })).status, 400);
  const asked = await call(env, "/api/public/call", { method: "POST", body: { t, guests: [guestId("Guest2"), guestId("Guest1")] } });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  assert.equal(asked.data.registry_url, "https://example.com/registry");
  assert.deepEqual(tagged(), ["Guest2"]);
  assert.equal((await call(env, `/api/public/call?t=${encodeURIComponent(t)}`)).data.guests[0].requested, true);
  const who = (await api("/api/admin/comms/audience", { method: "POST", body: { audience: { ticks: ["followup:Post-wedding call"] } } })).data.households;
  assert.deepEqual(who.map((x) => x.to), ["h2@example.com"], "emails can go to everyone who asked");

  // A calendar link's token doesn't open the page; a test email's link opens a sample that saves nothing.
  const cal = await sign(env, { kind: "cal", h: 1 }, 600);
  assert.equal((await call(env, `/api/public/call?t=${encodeURIComponent(cal)}`)).status, 400);
  assert.equal((await call(env, "/api/public/call?t=nope")).status, 400);
  const sample = await sign(env, { kind: "call", test: true }, 600);
  const preview = await call(env, `/api/public/call?t=${encodeURIComponent(sample)}`);
  assert.equal(preview.data.sample, true);
  assert.equal((await call(env, "/api/public/call", { method: "POST", body: { t: sample, guests: [preview.data.guests[0].id] } })).data.sample, true);
  assert.deepEqual(tagged(), ["Guest2"], "the sample saved nothing");
  assert.ok(RESERVED.has("call"), "the website copy never takes over /call");
});

// Bug guard: with no registry link typed into Settings, the call page hid its "See our
// registry" button, though the website copies a Zola site that has a registry.
test("post-wedding call: with no registry link in Settings, the button goes to the Zola site's registry", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  const t = await sign(env, { kind: "call", test: true }, 600);
  const page = async () => (await call(env, `/api/public/call?t=${encodeURIComponent(t)}`)).data.registry_url;
  assert.equal(await page(), "", "no registry anywhere: no button");
  await api("/api/admin/settings", { method: "PUT", body: { zola_url: "https://www.zola.com/wedding/sam-and-alex" } });
  assert.equal(await page(), "https://www.zola.com/wedding/sam-and-alex/registry");
  const sent = await call(env, "/api/public/call", { method: "POST", body: { t, guests: [1] } });
  assert.equal(sent.data.registry_url, "https://www.zola.com/wedding/sam-and-alex/registry", "and after submitting");
  await api("/api/admin/settings", { method: "PUT", body: { registry_url: "https://example.com/our-registry" } });
  assert.equal(await page(), "https://example.com/our-registry", "a link typed into Settings wins");
});

test("things to do: hidden from guests until published, previewed by an admin, then added to the site's menu", async () => {
  const env = makeEnv();
  const api = await adminClient(env);
  await api("/api/admin/settings", { method: "PUT", body: { couple_names: "Kaitlyn & Patrick", wedding_date: "2027-05-15" } });
  env.DB.db.prepare("INSERT INTO site_pages (path, title, html, source_url, content_hash, fetched_at, changed_at) VALUES ('/', 'Home', ?, '', '', '', '')")
    .run('<html><head><style data-wm="fonts">@font-face{font-family:Made Up}</style></head><body style="background-color:#faf6ef"><p style="color:#333344">Hi</p>'
      + '<ul><li><a href="/travel" data-wm-nav="menu">Travel</a></li><li><a href="https://www.zola.com/wedding/x/registry" data-wm-nav="menu" target="_blank">Registry</a></li></ul>'
      + '<div class="wm-rsvp-bar"><nav id="wm-menu" aria-label="Site" hidden><a href="/travel">Travel</a></nav></div></body></html>');
  const guest = await call(env, "/things-to-do");
  assert.equal(guest.status, 404, "hidden from guests");
  assert.ok(!String(guest.data).includes("Commissary"));
  const preview = await api("/things-to-do");
  assert.equal(preview.status, 200);
  assert.match(preview.data, /<b>Preview\.<\/b>/, "an admin sees a preview");
  assert.equal(preview.headers.get("cache-control"), "private, no-store", "and the preview is never cached");
  assert.equal((preview.data.match(/class="place"/g) || []).length, 97, "every place links to its map");
  assert.match(preview.data, /May 15, 2027 · Indianapolis/);
  assert.match(preview.data, /--bg:#faf6ef/, "it takes the website's look");
  assert.match(preview.data, /@font-face\{font-family:Made Up\}/, "and its fonts");
  assert.ok(!(await call(env, "/")).data.includes("/things-to-do"), "not in the menu while hidden");

  assert.equal((await api("/api/admin/settings", { method: "PUT", body: { things_to_do_published: true } })).status, 200);
  const live = await call(env, "/things-to-do/");
  assert.equal(live.status, 200);
  assert.ok(!live.data.includes("<b>Preview.</b>"));
  assert.equal(live.headers.get("cache-control"), "public, max-age=300");
  const home = (await call(env, "/")).data;
  // The site's own menu row gets it in the browser (PAGE_SCRIPT copies the last menu item
  // there, wrapper and all, so it's spaced like the rest).
  assert.ok(home.includes('<div class="wm-rsvp-bar" data-wm-guide="/things-to-do" data-wm-guide-label="Things to Do">'), "the bar tells the page script");
  assert.ok(!home.includes('<a href="/things-to-do" data-wm-nav'), "the server doesn't guess at the menu's markup");
  assert.ok(home.includes('<a href="/travel">Travel</a><a href="/things-to-do">Things to Do</a></nav>'), "and in the phone menu");
  assert.equal((await api("/api/admin/settings", { method: "PUT", body: { things_to_do_published: false } })).status, 200);
  assert.equal((await call(env, "/things-to-do")).status, 404, "hidden again");
});

test("things to do: every name links to a place, the copy is escaped, and Zola's own Things to Do link points here", async () => {
  const { SECTIONS, PLACES, guideLine } = await import("../src/guide.js");
  const { addGuideLink } = await import("../src/site.js");
  const lines = SECTIONS.flatMap((s) => [...(s.intro || []), ...s.groups.flatMap((g) => [g.intro || "", ...g.items])]);
  for (const line of lines) for (const m of line.matchAll(/\]\(([^)]+)\)/g)) assert.ok(Object.hasOwn(PLACES, m[1]), `no map link for ${m[1]}`);
  assert.equal(guideLine('Try <b> & [Bodhi](bodhi)'), `Try &#60;b&#62; &#38; <a class="place" href="${PLACES.bodhi.replace(/&/g, "&#38;")}" target="_blank" rel="noopener">Bodhi</a>`);
  const page = '<a href="https://www.zola.com/wedding/x/things-to-do" data-wm-nav="menu">Things To Do</a><nav id="wm-menu" hidden><a href="https://www.zola.com/wedding/x/things-to-do">Things To Do</a></nav>';
  assert.equal(addGuideLink(page), page.replace(/https:\/\/www\.zola\.com\/wedding\/x\/things-to-do/g, "/things-to-do"), "no second link");
});

// Bug guard: a test email that went through left an old Gmail error on the banner, so a
// fixed problem (the Gmail API turned on) still looked broken.
test("emails: a test email that goes through clears an old Gmail error", async () => {
  const { env, api } = await commsSetup();
  const { getSetting, setSetting } = await import("../src/db.js");
  await setSetting(env, "_gmail", { ...(await getSetting(env, "_gmail")), last_error: "Gmail refused to send (403).", last_error_at: new Date().toISOString() });
  const id = (await api("/api/admin/comms/messages", { method: "POST", body: { subject: "Hello", body: "Hi" } })).data.id;
  await withGmail(() => api(`/api/admin/comms/messages/${id}/test`, { method: "POST", body: {} }), { status: () => 403 });
  assert.match((await api("/api/admin/comms")).data.gmail.last_error, /refused/, "a test that fails keeps it");
  await withGmail(() => api(`/api/admin/comms/messages/${id}/test`, { method: "POST", body: {} }));
  assert.equal((await api("/api/admin/comms")).data.gmail.last_error, null);
});

// Bug guard: a cron run that overlapped "Send now" picked the same queued rows and sent
// them twice; a run that died partway left its rows queued to be sent again.
test("emails: two overlapping runs never send the same email twice; a run stuck mid-send is marked failed, not resent", async () => {
  const { env, api } = await commsSetup({ households: 6 });
  const id = (await api("/api/admin/comms/messages", { method: "POST", body: { subject: "Hello", body: "Hi" } })).data.id;
  await api(`/api/admin/comms/messages/${id}/schedule`, { method: "POST", body: { send_at: "2099-01-01T09:00" } });
  env.DB.db.prepare("UPDATE comm_messages SET send_at = '2000-01-01T00:00:00Z'").run();
  const { sent } = await withGmail(() => Promise.all([processComms(env), processComms(env)]));
  const to = sent.map((m) => m.match(/^To: (.+)$/m)[1]).sort();
  assert.deepEqual(to, [...new Set(to)], "nobody got it twice");
  assert.equal(to.length, 6);

  const id2 = (await api("/api/admin/comms/messages", { method: "POST", body: { subject: "Again", body: "Hi" } })).data.id;
  await withGmail(() => api(`/api/admin/comms/messages/${id2}/send`, { method: "POST", body: {} }), { status: () => 500 });
  env.DB.db.prepare("UPDATE comm_sends SET status = 'sending', claimed_at = '2000-01-01T00:00:00Z' WHERE message_id = ?").run(id2);
  const after = await withGmail(() => processComms(env));
  assert.equal(after.sent.length, 0, "rows stuck in sending aren't sent again");
  const rows = env.DB.db.prepare("SELECT status, error FROM comm_sends WHERE message_id = ? AND status != 'skipped'").all(id2);
  assert.ok(rows.every((r) => r.status === "failed" && /may or may not have gone out/.test(r.error)));
  assert.equal(env.DB.db.prepare("SELECT status FROM comm_messages WHERE id = ?").get(id2).status, "sent", "and the email is done");
});

// Bug guards: "Send now" on an automatic email turned its automation off; an email whose
// audience had nobody to send to stayed "Sending" forever; a scheduled email could be
// emptied and still go out; a Gmail error hit during a batch was erased by that batch.
test("emails: Send now keeps automation on, empty sends finish, set emails can't be emptied, a new Gmail error stays", async () => {
  const { env, api } = await commsSetup();
  const auto = (await api("/api/admin/comms/messages", { method: "POST", body: { subject: "Thanks", body: "Hi" } })).data.id;
  await api(`/api/admin/comms/messages/${auto}/automate`, { method: "POST", body: { on: true } });
  await withGmail(() => api(`/api/admin/comms/messages/${auto}/send`, { method: "POST", body: {} }));
  assert.equal(env.DB.db.prepare("SELECT status FROM comm_messages WHERE id = ?").get(auto).status, "automated");
  assert.equal((await api(`/api/admin/comms/messages/${auto}`, { method: "PUT", body: { body: "<p><br></p>", format: "html" } })).status, 400, "can't empty an automatic email");

  const nobody = (await api("/api/admin/comms/messages", { method: "POST", body: { subject: "No email", body: "Hi", audience: { ticks: ["side:Bride"] } } })).data.id;
  env.DB.db.prepare("UPDATE households SET email = NULL").run();
  await withGmail(() => api(`/api/admin/comms/messages/${nobody}/send`, { method: "POST", body: {} }));
  assert.equal(env.DB.db.prepare("SELECT status FROM comm_messages WHERE id = ?").get(nobody).status, "sent", "nothing to send: done, not stuck");

  env.DB.db.prepare("UPDATE households SET email = 'h' || id || '@example.com'").run();
  env.DB.db.prepare("UPDATE settings SET value = json_set(value, '$.last_error', 'old problem') WHERE key = '_gmail'").run();
  const third = (await api("/api/admin/comms/messages", { method: "POST", body: { subject: "Third", body: "Hi" } })).data.id;
  await withGmail(() => api(`/api/admin/comms/messages/${third}/send`, { method: "POST", body: {} }), { status: (n) => (n === 0 ? 200 : 429) });
  assert.match((await api("/api/admin/comms")).data.gmail.last_error, /sending limit/, "the limit hit in this batch is still shown");
});

test("calendar: an event that ends after midnight ends on the next day", () => {
  const events = cleanEvents([{ title: "Reception", date: "2027-06-12", start: "18:00", end: "00:30", for: "everyone" }]);
  const ics = buildIcs(events, { timeZone: "America/Indiana/Indianapolis" });
  assert.match(ics, /DTSTART:20270612T220000Z\r\nDTEND:20270613T043000Z/);
  assert.throws(() => cleanEvents([{ title: "x", date: "2027-06-12", start: "18:00", end: "18:00" }]), /ends when it starts/);
});

test("emails: a Communications user can write and send, but only an admin connects Gmail", async () => {
  const { env, api } = await commsSetup();
  await api("/api/admin/users", { method: "POST", body: { email: "jo@example.com", role: "user", pages: ["communications"] } });
  const jo = `wedding_session=${await sign(env, { kind: "session", email: "jo@example.com", name: "Jo" }, 3600)}`;
  const as = (path, opts = {}) => call(env, path, { ...opts, cookie: jo, headers: { "x-wedding": "1" } });
  assert.equal((await as("/api/admin/comms")).status, 200);
  const made = await as("/api/admin/comms/messages", { method: "POST", body: { subject: "Hi", body: "Hi" } });
  assert.equal(made.status, 201);
  const { sent } = await withGmail(() => as(`/api/admin/comms/messages/${made.data.id}/send`, { method: "POST", body: {} }));
  assert.equal(sent.length, 3, "Jo's send goes out");
  assert.equal((await as("/api/admin/comms/gmail/connect")).status, 403);
  assert.equal((await as("/api/admin/comms/gmail/disconnect", { method: "POST" })).status, 403);
  const nobody = `wedding_session=${await sign(env, { kind: "session", email: "jo@example.com" }, 3600)}`;
  await api("/api/admin/users/jo%40example.com", { method: "PUT", body: { pages: ["seating"] } });
  assert.equal((await call(env, "/api/admin/comms", { cookie: nobody })).status, 403, "without the page, no access");
});

test("RSVP page wording saves, blanks fall back to the default, and the sender name can't break the From line", async () => {
  const { api } = await commsSetup();
  const r = await api("/api/admin/comms/rsvp-page", { method: "PUT", body: { rsvp_open: false, rsvp_deadline: "2027-05-01", email_from_name: 'K & P <evil@x.com>"\r\nBcc: a@b.c',
    page: { accept_label: "Count me in", constructor: "x" } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.rsvp.page.accept_label, "Count me in");
  assert.equal(r.data.rsvp.page.decline_label, "Regretfully declines", "a field not sent keeps its default");
  assert.equal(r.data.email_from_name, "K & P evil@x.comBcc: a@b.c", "no quotes, angle brackets or new lines survive");
  assert.equal(r.data.rsvp.rsvp_open, false);
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
