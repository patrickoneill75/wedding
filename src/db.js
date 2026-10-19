/**
 * D1 schema and small query helpers.
 *
 * The Worker creates its own tables on the first request each isolate serves
 * (ensureSchema), using CREATE TABLE IF NOT EXISTS, so a fresh database needs no
 * migration step. When the schema changes, append statements to MIGRATIONS -- never
 * edit an entry that has already shipped, because live databases have already run it.
 *
 * Settings live in one key/value table. Keys starting with "_" are internal (Google
 * tokens, the session signing key) and are never returned by
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
  // 2 -- invite type per guest: "ceremony" or "reception". Seeded from the old
  // ceremony flag (the spreadsheet's Ceremony column), which is no longer used.
  [
    `ALTER TABLE guests ADD COLUMN invite_type TEXT NOT NULL DEFAULT 'reception'`,
    `UPDATE guests SET invite_type = 'ceremony' WHERE ceremony = 1`,
  ],
  // 3 -- the spreadsheet listed plus-ones as their own rows ("Guest" / "Guest Conor
  // Smith"). Turn each into a plus-one allowance on its host -- the guest named after
  // "Guest", or failing that the first real guest in the household -- with no name,
  // so whoever RSVPs types it in. Then drop the placeholder row. A placeholder alone in
  // its household has no host and is left alone.
  [
    `UPDATE guests SET plus_one_allowed = 1, plus_one_name = NULL WHERE id IN (
       SELECT COALESCE(
         (SELECT h.id FROM guests h
           WHERE h.household_id = p.household_id
             AND NOT (lower(trim(h.first_name)) = 'guest' AND lower(trim(h.last_name)) LIKE 'guest%')
             AND lower(trim(h.first_name) || ' ' || trim(h.last_name)) = lower(trim(substr(trim(p.last_name), 7)))
           ORDER BY h.id LIMIT 1),
         (SELECT MIN(h.id) FROM guests h
           WHERE h.household_id = p.household_id
             AND NOT (lower(trim(h.first_name)) = 'guest' AND lower(trim(h.last_name)) LIKE 'guest%')))
       FROM guests p
       WHERE lower(trim(p.first_name)) = 'guest' AND lower(trim(p.last_name)) LIKE 'guest%')`,
    `DELETE FROM guests
      WHERE lower(trim(first_name)) = 'guest' AND lower(trim(last_name)) LIKE 'guest%'
        AND EXISTS (SELECT 1 FROM guests h
                     WHERE h.household_id = guests.household_id
                       AND NOT (lower(trim(h.first_name)) = 'guest' AND lower(trim(h.last_name)) LIKE 'guest%'))`,
  ],
  // 4 -- ceremony and reception are separate on/off invitations instead of one
  // either/or invite_type (left in place, no longer read). A ceremony invite becomes
  // both; a reception invite stays reception only.
  [
    `ALTER TABLE guests ADD COLUMN invite_ceremony INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE guests ADD COLUMN invite_reception INTEGER NOT NULL DEFAULT 1`,
    `UPDATE guests SET invite_ceremony = 1 WHERE invite_type = 'ceremony'`,
  ],
  // 5 -- the public website: cleaned copies of the Zola site's pages (src/site.js).
  [
    `CREATE TABLE IF NOT EXISTS site_pages (
       path TEXT PRIMARY KEY,
       title TEXT,
       html TEXT NOT NULL,
       source_url TEXT,
       content_hash TEXT,
       fetched_at TEXT,
       changed_at TEXT
     )`,
  ],
  // 6 -- purchases under an expense (one level: "Place Settings" > each purchase), a
  // remembered list of vendors, and the partner's name in place of "Partner".
  [
    `ALTER TABLE expenses ADD COLUMN parent_id INTEGER REFERENCES expenses(id) ON DELETE CASCADE`,
    `CREATE INDEX IF NOT EXISTS expenses_parent ON expenses(parent_id)`,
    `CREATE TABLE IF NOT EXISTS vendors (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL UNIQUE COLLATE NOCASE,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `INSERT OR IGNORE INTO vendors (name)
       SELECT DISTINCT trim(vendor) FROM expenses WHERE vendor IS NOT NULL AND trim(vendor) <> ''`,
    `UPDATE settings SET value = replace(value, '"Partner"', '"Kaitlyn"') WHERE key = 'payers'`,
    `UPDATE expenses SET payer = 'Kaitlyn' WHERE payer = 'Partner'`,
    `UPDATE payments SET payer = 'Kaitlyn' WHERE payer = 'Partner'`,
  ],
  // 7: an item at Quote or Booked with money paid on it is Partially paid (a deposit is
  // in, the rest is still to pay). Items with line items take their stage from those.
  [
    `UPDATE expenses SET status = 'partially_paid', updated_at = datetime('now')
       WHERE status IN ('quote', 'booked')
         AND EXISTS (SELECT 1 FROM payments p WHERE p.expense_id = expenses.id)
         AND NOT EXISTS (SELECT 1 FROM expenses c WHERE c.parent_id = expenses.id)`,
  ],
  // 8: no more budgets on items with line items -- they only add up their line items.
  // A price an open item still had (its old budget) becomes an estimate line item, so
  // nothing that was entered disappears; then the item's own price is cleared.
  [
    `INSERT INTO expenses (parent_id, category, subcategory, item, status, pricing, unit_cost, units, quantity_source,
       quantity_factor, round_up, taxable, gratuity_rate, notes, source)
     SELECT id, category, subcategory, item, 'estimate', pricing, unit_cost, units, quantity_source,
       quantity_factor, round_up, taxable, gratuity_rate, 'Was the budget for this item', 'split'
     FROM expenses p
     WHERE p.parent_id IS NULL AND p.unit_cost IS NOT NULL AND p.unit_cost <> 0 AND p.status NOT IN ('paid', 'cancelled')
       AND EXISTS (SELECT 1 FROM expenses c WHERE c.parent_id = p.id)`,
    `UPDATE expenses SET unit_cost = NULL, units = 1, pricing = 'fixed', taxable = 0, gratuity_rate = 0, baseline_total = NULL,
       status = CASE WHEN status IN ('paid', 'cancelled') THEN status ELSE 'estimate' END
     WHERE parent_id IS NULL AND EXISTS (SELECT 1 FROM expenses c WHERE c.parent_id = expenses.id)`,
  ],
  // 9: the seating chart (src/seating.js). Rooms with their size in feet; tables, single
  // chairs and text notes placed in a room (x, y is the center, in feet from the room's
  // top-left corner); reusable table templates; and who sits where at the reception.
  // A seat is a table plus a letter (A, B, C ...). A person is a guest or, with
  // plus_one = 1, that guest's plus-one, and has at most one seat.
  [
    `CREATE TABLE IF NOT EXISTS seating_rooms (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL DEFAULT '',
       kind TEXT NOT NULL DEFAULT 'reception',
       width_ft REAL NOT NULL DEFAULT 60,
       length_ft REAL NOT NULL DEFAULT 40,
       sort_order INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS seating_templates (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL DEFAULT '',
       shape TEXT NOT NULL DEFAULT 'round',
       width_ft REAL NOT NULL,
       length_ft REAL NOT NULL,
       seats INTEGER NOT NULL DEFAULT 0,
       seat_sides TEXT NOT NULL DEFAULT 'both',
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `INSERT INTO seating_templates (name, shape, width_ft, length_ft, seats, seat_sides) VALUES
       ('5 ft round, 8 seats', 'round', 5, 5, 8, 'both'),
       ('6 ft round, 10 seats', 'round', 6, 6, 10, 'both'),
       ('6 ft banquet, 6 seats', 'rect', 6, 2.5, 6, 'both'),
       ('8 ft banquet, 8 seats', 'rect', 8, 2.5, 8, 'both')`,
    `CREATE TABLE IF NOT EXISTS seating_items (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       room_id INTEGER NOT NULL REFERENCES seating_rooms(id) ON DELETE CASCADE,
       kind TEXT NOT NULL,
       shape TEXT,
       label TEXT NOT NULL DEFAULT '',
       x REAL NOT NULL DEFAULT 0,
       y REAL NOT NULL DEFAULT 0,
       width_ft REAL NOT NULL DEFAULT 0,
       length_ft REAL NOT NULL DEFAULT 0,
       rotation REAL NOT NULL DEFAULT 0,
       seats INTEGER NOT NULL DEFAULT 0,
       seat_sides TEXT NOT NULL DEFAULT 'both',
       font_size REAL NOT NULL DEFAULT 1.5,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS seating_items_room ON seating_items(room_id)`,
    `CREATE TABLE IF NOT EXISTS seat_assignments (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       item_id INTEGER NOT NULL REFERENCES seating_items(id) ON DELETE CASCADE,
       seat_letter TEXT NOT NULL,
       guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
       plus_one INTEGER NOT NULL DEFAULT 0,
       UNIQUE (item_id, seat_letter),
       UNIQUE (guest_id, plus_one)
     )`,
  ],
  // 10: vendors get contacts and the day-of / key flags (src/vendors.js); seating shapes
  // get a color; saved custom reports (src/reports.js); named groups of guests and the
  // run of show, with what each step involves (src/runofshow.js).
  [
    `ALTER TABLE seating_items ADD COLUMN color TEXT`,
    `ALTER TABLE vendors ADD COLUMN category TEXT`,
    `ALTER TABLE vendors ADD COLUMN website TEXT`,
    `ALTER TABLE vendors ADD COLUMN notes TEXT`,
    `ALTER TABLE vendors ADD COLUMN day_of INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE vendors ADD COLUMN key_vendor INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE vendors ADD COLUMN primary_first TEXT`,
    `ALTER TABLE vendors ADD COLUMN primary_last TEXT`,
    `ALTER TABLE vendors ADD COLUMN primary_email TEXT`,
    `ALTER TABLE vendors ADD COLUMN primary_phone TEXT`,
    `ALTER TABLE vendors ADD COLUMN secondary_first TEXT`,
    `ALTER TABLE vendors ADD COLUMN secondary_last TEXT`,
    `ALTER TABLE vendors ADD COLUMN secondary_email TEXT`,
    `ALTER TABLE vendors ADD COLUMN secondary_phone TEXT`,
    `ALTER TABLE vendors ADD COLUMN updated_at TEXT`,
    `CREATE TABLE IF NOT EXISTS reports (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       definition TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS guest_groups (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       notes TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS guest_group_members (
       group_id INTEGER NOT NULL REFERENCES guest_groups(id) ON DELETE CASCADE,
       guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
       plus_one INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (group_id, guest_id, plus_one)
     )`,
    `CREATE TABLE IF NOT EXISTS ros_items (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       day TEXT NOT NULL DEFAULT '',
       start_time TEXT NOT NULL DEFAULT '',
       duration_min INTEGER,
       title TEXT NOT NULL DEFAULT '',
       location TEXT,
       details TEXT,
       status TEXT NOT NULL DEFAULT 'todo',
       status_at TEXT,
       status_by TEXT,
       sort_order INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    // kind: vendor (ref_id = vendor), guest (ref_id = guest, plus_one), group (ref_id =
    // guest_groups), table (ref_id = seating_items), or preset (ref_key names a built-in
    // set of guests such as the wedding party). A link to something since deleted is
    // dropped when the run of show is read.
    `CREATE TABLE IF NOT EXISTS ros_links (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       item_id INTEGER NOT NULL REFERENCES ros_items(id) ON DELETE CASCADE,
       kind TEXT NOT NULL,
       ref_id INTEGER,
       ref_key TEXT,
       plus_one INTEGER NOT NULL DEFAULT 0,
       role TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS ros_links_item ON ros_links(item_id)`,
  ],
  // 11: people who may sign in besides the ADMIN_EMAILS owners, each an admin or a user
  // limited to some pages (src/users.js); out-of-town and international households; and
  // who is invited to the rehearsal dinner. Run-of-show vendor links say whether the
  // vendor leads the step (ros_links.ref_key = 'lead') or supports it ('support', or
  // NULL on links made before this).
  [
    `CREATE TABLE IF NOT EXISTS users (
       email TEXT PRIMARY KEY COLLATE NOCASE,
       name TEXT,
       role TEXT NOT NULL DEFAULT 'user',
       pages TEXT NOT NULL DEFAULT '[]',
       created_by TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `ALTER TABLE households ADD COLUMN out_of_town INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE households ADD COLUMN international INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE guests ADD COLUMN invite_rehearsal INTEGER NOT NULL DEFAULT 0`,
  ],
  // 12: out of town and international are tags on each guest, next to their invitations,
  // instead of on the household. Each guest starts with their household's setting; the
  // household columns are left in place and no longer read.
  [
    `ALTER TABLE guests ADD COLUMN out_of_town INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE guests ADD COLUMN international INTEGER NOT NULL DEFAULT 0`,
    `UPDATE guests SET
       out_of_town = COALESCE((SELECT h.out_of_town FROM households h WHERE h.id = guests.household_id), 0),
       international = COALESCE((SELECT h.international FROM households h WHERE h.id = guests.household_id), 0)`,
  ],
  // 13: communications (src/comms.js). Each guest may give their own email (the
  // household's stays the required one). An email has an audience of guest tags and is
  // a draft, sent now, scheduled, or sent automatically after an RSVP; comm_sends
  // records one send per household per email, so nobody gets the same email twice.
  [
    `ALTER TABLE guests ADD COLUMN email TEXT`,
    `CREATE TABLE IF NOT EXISTS comm_messages (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       subject TEXT NOT NULL DEFAULT '',
       body TEXT NOT NULL DEFAULT '',
       audience TEXT NOT NULL DEFAULT '{}',
       attach_ics INTEGER NOT NULL DEFAULT 0,
       status TEXT NOT NULL DEFAULT 'draft',
       send_at TEXT,
       sent_at TEXT,
       created_by TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS comm_sends (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       message_id INTEGER NOT NULL REFERENCES comm_messages(id) ON DELETE CASCADE,
       household_id INTEGER NOT NULL,
       recipients TEXT,
       status TEXT NOT NULL DEFAULT 'queued',
       error TEXT,
       attempts INTEGER NOT NULL DEFAULT 0,
       sent_at TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE (message_id, household_id)
     )`,
    `CREATE INDEX IF NOT EXISTS comm_sends_status ON comm_sends(status)`,
  ],
  // 14: each guest invited to the rehearsal dinner answers for it on the RSVP page, apart
  // from the wedding itself: pending, yes or no.
  [
    `ALTER TABLE guests ADD COLUMN rehearsal_rsvp TEXT NOT NULL DEFAULT 'pending'`,
  ],
  // 15: a guest coming to the rehearsal dinner with a plus-one says whether the plus-one
  // comes to the dinner too.
  [
    `ALTER TABLE guests ADD COLUMN plus_one_rehearsal_rsvp TEXT NOT NULL DEFAULT 'pending'`,
  ],
  // 16: guest emails written in the rich-text editor (format 'html', cleaned by
  // src/email_html.js) and sent in a design: 'wedding' (the website's look) or 'plain'.
  // Emails written before stay plain text in the plain design.
  [
    `ALTER TABLE comm_messages ADD COLUMN format TEXT NOT NULL DEFAULT 'text'`,
    `ALTER TABLE comm_messages ADD COLUMN design TEXT NOT NULL DEFAULT 'plain'`,
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
