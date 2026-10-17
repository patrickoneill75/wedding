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
import { normalizeName } from "../src/public_api.js";

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
  assert.deepEqual(Object.keys(s.items[0]).sort(), ["actual", "category", "estimate", "id", "item", "projected", "status", "subcategory"]);
  assert.deepEqual(s.timeline, [{ date: "2026-02-01", cumulative: 500 }]);
});

/* ------------------------------------------------------------------ invite tests -- */

// The columns every migration after the first touches, as an older database has them.
const OLD_GUEST_COLUMNS = `id INTEGER PRIMARY KEY, household_id INTEGER, first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '', ceremony INTEGER NOT NULL DEFAULT 0,
  plus_one_allowed INTEGER NOT NULL DEFAULT 0, plus_one_name TEXT`;

test("upgrading from the first schema carries the spreadsheet's ceremony flag all the way through", async () => {
  const env = makeEnv();
  env.DB.db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('_schema_version', '1');
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
    INSERT INTO settings VALUES ('_schema_version', '3');
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
    INSERT INTO settings VALUES ('_schema_version', '2');
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
