/**
 * D1 schema and small query helpers.
 *
 * The Worker creates its own tables on the first request each isolate serves
 * (ensureSchema), using CREATE TABLE IF NOT EXISTS, so a fresh database needs no
 * migration step. When the schema changes, append statements to MIGRATIONS -- never
 * edit an entry that has already shipped, because live databases have already run it.
 *
 * Settings live in one key/value table. Keys starting with "_" are internal (Google
 * tokens, the session signing key, the expense-form key) and are never returned by
 * the settings API; see PUBLIC_SETTING_KEYS in src/calc.js.
 */

const MIGRATIONS = [
  // 1 -- initial schema
  [
    `CREATE TABLE IF NOT EXISTS settings (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS households (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       code TEXT,
       display_name TEXT NOT NULL DEFAULT '',
       greeting TEXT NOT NULL DEFAULT '',
       address1 TEXT, address2 TEXT, city TEXT, state TEXT, zip TEXT, country TEXT,
       email TEXT, phone TEXT,
       save_the_date_sent INTEGER NOT NULL DEFAULT 0,
       invite_sent INTEGER NOT NULL DEFAULT 0,
       gift TEXT,
       gift_received INTEGER NOT NULL DEFAULT 0,
       thank_you_sent INTEGER NOT NULL DEFAULT 0,
       rsvp_message TEXT,
       rsvp_at TEXT,
       notes TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS guests (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
       first_name TEXT NOT NULL DEFAULT '',
       last_name TEXT NOT NULL DEFAULT '',
       side TEXT,
       priority TEXT NOT NULL DEFAULT 'High',
       wedding_party INTEGER NOT NULL DEFAULT 0,
       immediate_family INTEGER NOT NULL DEFAULT 0,
       extended_family INTEGER NOT NULL DEFAULT 0,
       ceremony INTEGER NOT NULL DEFAULT 0,
       plus_one_allowed INTEGER NOT NULL DEFAULT 0,
       plus_one_name TEXT,
       rsvp TEXT NOT NULL DEFAULT 'pending',
       plus_one_rsvp TEXT NOT NULL DEFAULT 'pending',
       dietary TEXT,
       plus_one_dietary TEXT,
       table_name TEXT,
       sort_order INTEGER NOT NULL DEFAULT 0,
       notes TEXT,
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS guests_household ON guests(household_id)`,
    `CREATE TABLE IF NOT EXISTS expenses (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       category TEXT NOT NULL DEFAULT '',
       subcategory TEXT NOT NULL DEFAULT '',
       item TEXT NOT NULL DEFAULT '',
       vendor TEXT,
       status TEXT NOT NULL DEFAULT 'estimate',
       pricing TEXT NOT NULL DEFAULT 'fixed',
       unit_cost REAL,
       units REAL NOT NULL DEFAULT 1,
       quantity_source TEXT NOT NULL DEFAULT 'guests',
       quantity_factor REAL NOT NULL DEFAULT 1,
       round_up INTEGER NOT NULL DEFAULT 0,
       taxable INTEGER NOT NULL DEFAULT 0,
       gratuity_rate REAL NOT NULL DEFAULT 0,
       baseline_total REAL,
       due_date TEXT,
       due_amount REAL,
       payer TEXT,
       notes TEXT,
       sort_order INTEGER NOT NULL DEFAULT 0,
       source TEXT NOT NULL DEFAULT 'control-panel',
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS payments (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
       paid_on TEXT,
       amount REAL NOT NULL,
       payer TEXT,
       method TEXT,
       note TEXT,
       created_by TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS payments_expense ON payments(expense_id)`,
    `CREATE TABLE IF NOT EXISTS expense_history (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
       at TEXT NOT NULL DEFAULT (datetime('now')),
       status TEXT NOT NULL,
       total REAL,
       unit_cost REAL,
       quantity REAL,
       note TEXT,
       changed_by TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS history_expense ON expense_history(expense_id)`,
    // Contracts, receipts and quotes uploaded to Google Drive, attached to an expense
    // (and optionally to one payment).
    `CREATE TABLE IF NOT EXISTS attachments (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
       payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
       drive_file_id TEXT NOT NULL,
       name TEXT NOT NULL,
       web_link TEXT,
       uploaded_by TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS attachments_expense ON attachments(expense_id)`,
  ],
];

export const SCHEMA_VERSION = MIGRATIONS.length;

let schemaReady = null;

/** Run any migrations this database hasn't seen. Memoized per isolate. */
export function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = migrate(env).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

/** Tests build a fresh database per case and need the memo cleared. */
export function resetSchemaMemo() {
  schemaReady = null;
}

async function migrate(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
  ).run();
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = '_schema_version'").first();
  const current = row ? Number(JSON.parse(row.value)) : 0;
  for (let version = current; version < MIGRATIONS.length; version++) {
    await env.DB.batch(MIGRATIONS[version].map((sql) => env.DB.prepare(sql)));
    await setSetting(env, "_schema_version", version + 1);
  }
}

export async function all(env, sql, ...params) {
  const result = await env.DB.prepare(sql).bind(...params).all();
  return result.results || [];
}

export async function first(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).first();
}

export async function run(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).run();
}

export async function getSetting(env, key, fallback = null) {
  const row = await first(env, "SELECT value FROM settings WHERE key = ?", key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export async function setSetting(env, key, value) {
  await run(
    env,
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    JSON.stringify(value)
  );
}

export async function deleteSetting(env, key) {
  await run(env, "DELETE FROM settings WHERE key = ?", key);
}

/** Every write that changes what lands in Drive calls this; the cron syncs after it. */
export async function markDirty(env) {
  await setSetting(env, "_sync_dirty_at", new Date().toISOString());
}

/**
 * Build "col = ?, col = ?" for an UPDATE from a patch object, keeping only allowed
 * columns. Own-property checks only: a patch parsed from a request body must not
 * reach Object.prototype keys like "constructor".
 */
export function updateClause(patch, allowed) {
  const columns = [];
  const values = [];
  for (const column of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, column)) {
      columns.push(`${column} = ?`);
      values.push(patch[column]);
    }
  }
  return { sql: columns.join(", "), values };
}
