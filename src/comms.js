/**
 * Communications: emails to guests through the connected Gmail, the calendar invite,
 * and the RSVP page's wording. Control panel routes under /api/admin/comms/* (the
 * Communications page):
 *
 *   GET    comms                     emails with their send counts, Gmail status, the
 *                                    audience choices, fill-ins, calendar events, RSVP page
 *   POST   comms/messages            { title, subject, body, format, design, audience, attach_ics } -> a
 *                                    draft. title names it on the Communications page only:
 *                                    it never goes into an email. format "html" is the rich-text editor's (cleaned
 *                                    by src/email_html.js), "text" the older plain text;
 *                                    design "wedding" or "plain"
 *   PUT    comms/messages/:id        change a draft, scheduled or automatic email (the
 *                                    title alone can change on any email)
 *   DELETE comms/messages/:id
 *   POST   comms/audience            { audience } -> who would get it, and who has no email
 *   POST   comms/messages/:id/test   { to?, as? } send it now to one address (default: you),
 *                                    filled in as a made-up guest (TEST_GUESTS) or the first
 *                                    household in the audience
 *   POST   comms/preview             { subject, body, format, design, attach_ics, as } -> the
 *                                    email's HTML, without sending
 *   PUT    comms/email-design        { header_image, footer_note } for the wedding design
 *   POST   comms/messages/:id/send   send to everyone in the audience now
 *   POST   comms/messages/:id/schedule  { send_at: "YYYY-MM-DDTHH:MM" } in the wedding's time zone
 *   POST   comms/messages/:id/automate  { on } send to each household after it RSVPs
 *   POST   comms/messages/:id/cancel    a scheduled email back to a draft
 *   GET    comms/messages/:id/sends  who it went to, and any failures
 *   PUT    comms/calendar            { events, time_zone }
 *   GET    comms/calendar.ics        every event, to check the invite
 *   PUT    comms/rsvp-page           { rsvp_open, rsvp_deadline, rsvp_intro, page, email_from_name }
 *   GET    comms/gmail/connect / POST comms/gmail/disconnect   admins only (Settings)
 *
 * One email goes to each household: To its required email, Cc any guest who gave their
 * own. A household is in the audience when one of its guests matches the guest boxes
 * ticked (side, RSVP, invitations ...) and the household matches the household ones.
 * comm_sends holds one row per email per household, so a household never gets the same
 * email twice, whether it was sent now, on schedule or after an RSVP.
 *
 * Sending is in batches (SEND_BATCH per run): "Send now" sends the first batch at once
 * and the cron (every five minutes) sends the rest, the scheduled emails when due, and
 * the automatic ones queued by an RSVP. If Gmail stops (disconnected, daily limit),
 * nothing is lost: the emails wait and go out once it works again.
 */

import { json, sign, startOAuth } from "./auth.js";
import { all, first, run, setSetting } from "./db.js";
import { loadSettings } from "./store.js";
import { DEFAULT_SETTINGS } from "./calc.js";
import { sqlValue } from "./importer.js";
import { buildIcs, cleanEvents, eventsFor, validTimeZone, zonedTime } from "./calendar.js";
import { DESIGNS, htmlToText, renderEmail, safeHref, sanitizeHtml, textToContent, themeFrom } from "./email_html.js";
import { RSVP_COLOR } from "./site.js";
import { disconnectGmail, gmailStatus, GmailConnectionError, openGmail, sendGmail } from "./gmail.js";

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
// Ten a run keeps a run well inside the Workers Free limits (one D1 write per email
// sent, and CPU for building each one). The cron sends the rest every five minutes.
export const SEND_BATCH = 10;
const STUCK_MINUTES = 15;
const MAX_ATTEMPTS = 3;
const CALENDAR_TOKEN_TTL = 60 * 60 * 24 * 500;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i;

/* ------------------------------------------------------------------ audience ---- */

// [key, title, any-of?, [[label, test]]]: within an any-of group a guest needs one ticked
// box; every other ticked box must hold. Mirrors More filters on the Guests page.
export const AUDIENCE = [
  ["rsvp", "RSVP", true, [["Coming", (g) => g.rsvp === "yes"], ["Awaiting reply", (g) => g.rsvp === "pending"], ["Not coming", (g) => g.rsvp === "no"]]],
  ["rehearsal_rsvp", "Rehearsal dinner RSVP", true, [
    ["Coming", (g) => g.invite_rehearsal && g.rehearsal_rsvp === "yes"],
    ["Awaiting reply", (g) => g.invite_rehearsal && g.rehearsal_rsvp === "pending"],
    ["Not coming", (g) => g.invite_rehearsal && g.rehearsal_rsvp === "no"]]],
  ["side", "Side", true, [["Bride", (g) => g.side === "Bride"], ["Groom", (g) => g.side === "Groom"], ["No side yet", (g) => !g.side]]],
  ["priority", "Priority", true, [["High", (g) => g.priority === "High"], ["Medium", (g) => g.priority === "Medium"], ["Low", (g) => g.priority === "Low"]]],
  ["invites", "Invited to", false, [["Ceremony", (g) => g.invite_ceremony], ["Reception", (g) => g.invite_reception], ["Rehearsal dinner", (g) => g.invite_rehearsal]]],
  ["family", "Family and party", false, [["Wedding party", (g) => g.wedding_party], ["Immediate family", (g) => g.immediate_family], ["Extended family", (g) => g.extended_family]]],
  ["travel", "Travel", false, [["Out of town", (g) => g.out_of_town], ["International", (g) => g.international]]],
  ["plusone", "Plus-ones", false, [["Has a plus-one", (g) => g.plus_one_allowed]]],
];
export const HOUSEHOLD_AUDIENCE = ["household", "Household", false, [
  ["Save-the-date sent", (h) => h.save_the_date_sent],
  ["Save-the-date not sent", (h) => !h.save_the_date_sent],
  ["Invite sent", (h) => h.invite_sent],
  ["Invite not sent", (h) => !h.invite_sent],
  ["Gift received, no thank-you yet", (h) => h.gift_received && !h.thank_you_sent],
]];

function cleanAudience(input) {
  const known = new Set([...AUDIENCE, HOUSEHOLD_AUDIENCE].flatMap(([key, , , options]) => options.map(([label]) => `${key}:${label}`)));
  const ticks = Array.isArray(input?.ticks) ? input.ticks.filter((t) => typeof t === "string" && known.has(t)) : [];
  return { ticks: [...new Set(ticks)] };
}

function guestPasses(g, ticked) {
  return AUDIENCE.every(([key, , anyOf, options]) => {
    const on = options.filter(([label]) => ticked.has(`${key}:${label}`));
    if (!on.length) return true;
    return anyOf ? on.some(([, test]) => test(g)) : on.every(([, test]) => test(g));
  });
}

export function inAudience(household, guests, audience) {
  const ticked = new Set(audience.ticks || []);
  const guestTicks = [...ticked].some((t) => !t.startsWith("household:"));
  if (guestTicks && !guests.some((g) => guestPasses(g, ticked))) return false;
  if (!guestTicks && !guests.length) return false;
  return HOUSEHOLD_AUDIENCE[3].every(([label, test]) => !ticked.has(`household:${label}`) || test(household));
}

/** Every household with its guests: two queries. */
async function loadHouseholds(env, ids = null) {
  const where = ids ? ` WHERE id IN (${ids.map(Number).join(",") || "0"})` : "";
  const households = await all(env, `SELECT * FROM households${where} ORDER BY display_name COLLATE NOCASE, id`);
  const guests = await all(env, `SELECT * FROM guests${ids ? ` WHERE household_id IN (${ids.map(Number).join(",") || "0"})` : ""} ORDER BY household_id, sort_order, id`);
  const byHousehold = new Map(households.map((h) => [h.id, []]));
  for (const g of guests) byHousehold.get(g.household_id)?.push(g);
  return households.map((h) => ({ household: h, guests: byHousehold.get(h.id) || [] }));
}

/** The To and Cc for a household: its email, then any guest's own (each once). */
export function recipientsFor(household, guests) {
  const to = String(household.email || "").trim();
  if (!EMAIL.test(to)) return null;
  const seen = new Set([to.toLowerCase()]);
  const cc = [];
  for (const g of guests) {
    const e = String(g.email || "").trim();
    if (EMAIL.test(e) && !seen.has(e.toLowerCase())) {
      seen.add(e.toLowerCase());
      cc.push(e);
    }
  }
  return { to: [to], cc };
}

/* ------------------------------------------------------------------ fill-ins ---- */

export const FILL_INS = [
  ["greeting", "The household's greeting (\"Jane and John\")"],
  ["household", "The name on the envelope"],
  ["first_names", "Everyone's first names"],
  ["coming", "Who said yes, plus-ones included"],
  ["couple", "Your names, from Settings"],
  ["wedding_date", "The wedding date, written out"],
  ["venue", "The venue, from Settings"],
  ["rsvp_deadline", "The RSVP deadline, written out"],
  ["rsvp_link", "A link to the RSVP page"],
  ["calendar_link", "A link that downloads their calendar invite"],
];

const longDate = (iso) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ""))) return "";
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const joinNames = (names) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

async function fillInsFor(env, origin, settings, household, guests) {
  const coming = guests.flatMap((g) => [
    g.rsvp === "yes" ? `${g.first_name} ${g.last_name}`.trim() : null,
    g.plus_one_allowed && g.plus_one_rsvp === "yes" && g.plus_one_name ? g.plus_one_name : null,
  ]).filter(Boolean);
  // A test email's made-up household downloads the invite its kind of guest would get.
  const token = household.id
    ? await sign(env, { kind: "cal", h: household.id }, CALENDAR_TOKEN_TTL)
    : await sign(env, { kind: "cal", test: household.test || "both" }, CALENDAR_TOKEN_TTL);
  return {
    greeting: household.greeting || household.display_name || "friends",
    household: household.display_name || "",
    first_names: joinNames(guests.map((g) => g.first_name).filter(Boolean)),
    coming: joinNames(coming),
    couple: settings.couple_names || "",
    wedding_date: longDate(settings.wedding_date),
    venue: settings.venue || "",
    rsvp_deadline: longDate(settings.rsvp_deadline),
    rsvp_link: `${origin}/rsvp/`,
    calendar_link: `${origin}/api/public/calendar?t=${encodeURIComponent(token)}`,
  };
}

/** {name} becomes its value; anything in braces that isn't a fill-in is left as typed. */
export function fillIn(template, values, { html = false } = {}) {
  const put = html ? (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") : String;
  return String(template).replace(/\{([a-z_]+)\}/g, (whole, name) => (has(values, name) ? put(values[name]) : whole));
}

/* ---------------------------------------------------------------- test guests ---- */

// Made-up households for test emails and previews, one per kind of guest: what they're
// invited to and how they answered decide their calendar invite and fill-ins.
const testGuest = (first, flags) => ({ first_name: first, last_name: "Sample", rsvp: "yes", invite_ceremony: 0, invite_reception: 0, invite_rehearsal: 0, rehearsal_rsvp: "pending", ...flags });
export const TEST_GUESTS = {
  both: { label: "RSVP'd yes: ceremony and reception", flags: { invite_ceremony: 1, invite_reception: 1 } },
  ceremony: { label: "RSVP'd yes: ceremony", flags: { invite_ceremony: 1 } },
  reception: { label: "RSVP'd yes: reception", flags: { invite_reception: 1 } },
  rehearsal: { label: "RSVP'd yes: reception and rehearsal dinner", flags: { invite_reception: 1, invite_rehearsal: 1, rehearsal_rsvp: "yes" } },
  declined: { label: "RSVP'd no", flags: { invite_ceremony: 1, invite_reception: 1, rsvp: "no" } },
};
export function testHousehold(kind) {
  const flags = (has(TEST_GUESTS, kind) ? TEST_GUESTS[kind] : TEST_GUESTS.both).flags;
  return {
    household: { id: 0, test: has(TEST_GUESTS, kind) ? kind : "both", greeting: "Jane and John", display_name: "Jane and John Sample", email: "jane@example.com" },
    guests: [testGuest("Jane", flags), testGuest("John", flags)],
  };
}

/** The wedding website's colors and font, for the wedding design. One query. */
async function emailTheme(env, settings) {
  const page = await first(env, "SELECT html FROM site_pages WHERE path = '/'");
  return themeFrom(page?.html, settings.rsvp_button_color || RSVP_COLOR);
}

const originOf = (env, request) => env.PUBLIC_URL || (request ? new URL(request.url).origin : "");

/** The .ics for these guests, or null when they get no events. */
export function icsFor(env, settings, guests) {
  const events = eventsFor(settings.calendar_events, guests);
  if (!events.length) return null;
  return buildIcs(events, { timeZone: settings.time_zone, host: hostOf(env), name: settings.couple_names || "Our wedding" });
}

/** The .ics for a household, or null when it gets no events. */
export async function householdIcs(env, settings, householdId) {
  const [entry] = await loadHouseholds(env, [householdId]);
  return entry ? icsFor(env, settings, entry.guests) : null;
}
const hostOf = (env) => (env.PUBLIC_URL ? new URL(env.PUBLIC_URL).hostname : "wedding.local");

/**
 * One email for one household, ready for sendGmail. `events` lists the calendar
 * invite's events when one is attached. `theme` is from emailTheme (wedding design).
 */
async function compose(env, origin, settings, message, household, guests, recipients, theme) {
  const values = await fillInsFor(env, origin, settings, household, guests);
  const attachments = [];
  const events = message.attach_ics ? eventsFor(settings.calendar_events, guests) : [];
  if (events.length) {
    // application/ics, not text/calendar: Gmail treats a text/calendar part as an
    // invitation to answer and doesn't list it as a file the guest can open.
    attachments.push({
      filename: "wedding.ics",
      type: "application/ics",
      content: buildIcs(events, { timeZone: settings.time_zone, host: hostOf(env), name: settings.couple_names || "Our wedding" }),
    });
  }
  const subject = fillIn(message.subject, values);
  const content = message.format === "html" ? fillIn(message.body, values, { html: true }) : textToContent(fillIn(message.body, values));
  const html = message.format === "html" || message.design === "wedding"
    ? renderEmail({
        design: message.design,
        subject,
        content,
        theme,
        details: {
          couple: settings.couple_names,
          date: longDate(settings.wedding_date),
          venue: settings.venue,
          site: origin ? `${origin}/` : "",
          rsvp: settings.rsvp_open && origin ? `${origin}/rsvp/` : "",
          headerImage: settings.email_design.header_image,
          footerNote: settings.email_design.footer_note,
          calendar: events.length > 0,
        },
      })
    : null;
  return {
    fromName: settings.email_from_name,
    to: recipients.to,
    cc: recipients.cc,
    subject,
    text: message.format === "html" ? htmlToText(content) : fillIn(message.body, values),
    html,
    attachments,
    events,
  };
}

/* -------------------------------------------------------------------- queue ---- */

/**
 * Add a send for each household in the email's audience that hasn't had it. One
 * multi-row INSERT OR IGNORE; households with no email are recorded as skipped.
 */
async function enqueue(env, message, entries) {
  const audience = cleanAudience(JSON.parse(message.audience || "{}"));
  const rows = [];
  for (const { household, guests } of entries) {
    if (!inAudience(household, guests, audience)) continue;
    const recipients = recipientsFor(household, guests);
    rows.push(recipients
      ? [message.id, household.id, [...recipients.to, ...recipients.cc].join(", "), "queued", null]
      : [message.id, household.id, "", "skipped", "This household has no email address."]);
  }
  if (!rows.length) return 0;
  await run(
    env,
    `INSERT OR IGNORE INTO comm_sends (message_id, household_id, recipients, status, error) VALUES ${rows.map((r) => `(${r.map(sqlValue).join(", ")})`).join(", ")}`
  );
  return rows.length;
}

/** After a household RSVPs: queue every automatic email it matches (once each). */
export async function queueAfterRsvp(env, householdId) {
  const automatic = await all(env, "SELECT * FROM comm_messages WHERE status = 'automated'");
  if (!automatic.length) return 0;
  const entries = await loadHouseholds(env, [householdId]);
  let queued = 0;
  for (const message of automatic) queued += await enqueue(env, message, entries);
  return queued;
}

/**
 * Send up to `limit` queued emails. Returns { sent, failed, stopped } -- stopped is the
 * reason Gmail can't send right now, and the rest stay queued for the next run.
 *
 * Each run first claims its rows (queued -> sending, in one statement), so a cron run
 * that overlaps "Send now" can't pick the same rows and send them twice. Each row is
 * marked sent as soon as Gmail takes it. A run that dies partway (a CPU limit, a lost
 * isolate) leaves rows in "sending"; after STUCK_MINUTES they're marked failed, never
 * re-queued, since the one in flight may have gone out.
 */
export async function sendQueued(env, { limit = SEND_BATCH, origin = "" } = {}) {
  const now = new Date().toISOString();
  const stuck = new Date(Date.now() - STUCK_MINUTES * 60000).toISOString();
  await run(
    env,
    `UPDATE comm_sends SET status = 'failed', error = 'Stopped partway through sending, so it may or may not have gone out.'
      WHERE status = 'sending' AND claimed_at < ?`,
    stuck
  );
  const claimed = await all(
    env,
    `UPDATE comm_sends SET status = 'sending', claimed_at = ?
      WHERE id IN (SELECT id FROM comm_sends WHERE status = 'queued' ORDER BY id LIMIT ?) RETURNING id`,
    now,
    limit
  );
  const result = claimed.length ? await sendClaimed(env, claimed.map((c) => Number(c.id)), origin) : { sent: 0, failed: 0, stopped: null };
  // An email with nothing left to send is done (also one whose audience had nobody to send to).
  await run(
    env,
    `UPDATE comm_messages SET status = 'sent', sent_at = ? WHERE status = 'sending'
        AND NOT EXISTS (SELECT 1 FROM comm_sends s WHERE s.message_id = comm_messages.id AND s.status IN ('queued', 'sending'))`,
    now
  );
  return result;
}

async function sendClaimed(env, ids, origin) {
  const queued = await all(
    env,
    `SELECT s.id, s.message_id, s.household_id, s.attempts, m.subject, m.body, m.attach_ics, m.format, m.design
       FROM comm_sends s JOIN comm_messages m ON m.id = s.message_id
      WHERE s.id IN (${ids.join(",")}) ORDER BY s.id`
  );
  const release = (rows) => rows.length
    ? run(env, `UPDATE comm_sends SET status = 'queued', claimed_at = NULL WHERE id IN (${rows.map((r) => Number(r.id)).join(",")}) AND status = 'sending'`)
    : null;
  let session;
  try {
    session = await openGmail(env);
  } catch (error) {
    await release(queued);
    if (error instanceof GmailConnectionError) return { sent: 0, failed: 0, stopped: error.message };
    throw error;
  }
  const settings = await loadSettings(env);
  const theme = await emailTheme(env, settings);
  const entries = new Map((await loadHouseholds(env, [...new Set(queued.map((q) => q.household_id))])).map((e) => [e.household.id, e]));
  let sent = 0;
  const failed = [];
  let stopped = null;
  let next = 0;
  for (; next < queued.length; next++) {
    const item = queued[next];
    const entry = entries.get(item.household_id);
    const recipients = entry && recipientsFor(entry.household, entry.guests);
    if (!recipients) {
      failed.push([item, "This household no longer has an email address."]);
      continue;
    }
    try {
      const email = await compose(env, origin || originOf(env), settings, item, entry.household, entry.guests, recipients, theme);
      await sendGmail(env, session, email);
      await run(env, "UPDATE comm_sends SET status = 'sent', sent_at = ?, error = NULL, attempts = attempts + 1 WHERE id = ?", new Date().toISOString(), item.id);
      sent++;
    } catch (error) {
      if (error instanceof GmailConnectionError) {
        stopped = error.message;
        break;
      }
      failed.push([item, error.message]);
    }
  }
  // What a stop left unsent goes back in the queue for the next run.
  if (stopped) await release(queued.slice(next));
  if (failed.length) {
    // A failed send is tried again on the next runs, up to MAX_ATTEMPTS in all.
    await run(
      env,
      `UPDATE comm_sends SET attempts = attempts + 1, claimed_at = NULL,
              status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
              error = CASE id ${failed.map(([item, msg]) => `WHEN ${Number(item.id)} THEN ${sqlValue(String(msg).slice(0, 500))}`).join(" ")} END
        WHERE id IN (${failed.map(([item]) => Number(item.id)).join(",")})`
    );
  }
  // A send that worked clears an old error, but not one this run hit.
  if (sent && session.last_error && !stopped) await setSetting(env, "_gmail", { ...session.stored, last_error: null, last_error_at: null });
  return { sent, failed: failed.length, stopped };
}

/** The cron's part: start scheduled emails that are due, then send a batch. */
export async function processComms(env) {
  const due = await all(env, "SELECT * FROM comm_messages WHERE status = 'scheduled' AND send_at <= ?", new Date().toISOString());
  if (due.length) {
    // (The run also tells the cron it started emails, so the Drive sync waits a run.)
    const entries = await loadHouseholds(env);
    for (const message of due) {
      await enqueue(env, message, entries);
      await run(env, "UPDATE comm_messages SET status = 'sending', updated_at = datetime('now') WHERE id = ?", message.id);
    }
  }
  return { ...(await sendQueued(env)), started: due.length };
}

/* -------------------------------------------------------------------- API ---- */

function cleanMessage(input) {
  const patch = Object.create(null);
  if (has(input, "title")) patch.title = String(input.title ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 120);
  if (has(input, "subject")) patch.subject = String(input.subject ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
  if (has(input, "format")) {
    if (!["html", "text"].includes(input.format)) throw new Error("Format must be html or text.");
    patch.format = input.format;
  }
  if (has(input, "design")) {
    if (!DESIGNS.includes(input.design)) throw new Error(`Design must be ${DESIGNS.join(" or ")}.`);
    patch.design = input.design;
  }
  if (has(input, "body")) {
    const body = String(input.body ?? "").replace(/\r\n/g, "\n").slice(0, 60000);
    // The rich-text editor's HTML keeps only the tags an email needs (src/email_html.js).
    patch.body = (patch.format ?? input.current_format) === "html" ? sanitizeHtml(body) : body;
  }
  if (has(input, "audience")) patch.audience = JSON.stringify(cleanAudience(input.audience));
  if (has(input, "attach_ics")) patch.attach_ics = input.attach_ics ? 1 : 0;
  return patch;
}

/** A body is empty when it has no words: "<p><br></p>" from a cleared editor counts. */
const isBlank = (message) => !(message.format === "html" ? htmlToText(message.body) : message.body).trim();

async function listMessages(env) {
  const messages = await all(env, "SELECT * FROM comm_messages ORDER BY CASE status WHEN 'draft' THEN 0 ELSE 1 END, COALESCE(send_at, updated_at) DESC, id DESC");
  const counts = await all(env, "SELECT message_id, status, COUNT(*) AS n FROM comm_sends GROUP BY message_id, status");
  const byMessage = new Map();
  for (const c of counts) {
    if (!byMessage.has(c.message_id)) byMessage.set(c.message_id, { queued: 0, sent: 0, failed: 0, skipped: 0 });
    // A row being sent right now still counts as waiting.
    byMessage.get(c.message_id)[c.status === "sending" ? "queued" : c.status] += c.n;
  }
  return messages.map((m) => ({ ...m, audience: JSON.parse(m.audience || "{}"), attach_ics: Boolean(m.attach_ics), counts: byMessage.get(m.id) || { queued: 0, sent: 0, failed: 0, skipped: 0 } }));
}

async function overview(env) {
  const settings = await loadSettings(env);
  return {
    messages: await listMessages(env),
    gmail: await gmailStatus(env),
    audience: [...AUDIENCE, HOUSEHOLD_AUDIENCE].map(([key, title, anyOf, options]) => ({ key, title, any_of: anyOf, options: options.map(([label]) => label) })),
    fill_ins: FILL_INS.map(([key, help]) => ({ key, help })),
    calendar_events: settings.calendar_events,
    time_zone: settings.time_zone,
    email_from_name: settings.email_from_name,
    rsvp: { rsvp_open: settings.rsvp_open, rsvp_deadline: settings.rsvp_deadline, rsvp_intro: settings.rsvp_intro, page: settings.rsvp_page },
    defaults_page: DEFAULT_SETTINGS.rsvp_page,
    email_design: settings.email_design,
    test_guests: Object.entries(TEST_GUESTS).map(([key, t]) => ({ key, label: t.label })),
  };
}

const EDITABLE = ["draft", "scheduled", "automated"];

/**
 * Who a test email or preview is filled in as: a made-up guest of the kind picked
 * (TEST_GUESTS), or by default the first household in the email's audience.
 */
async function testSample(env, message, kind) {
  const audience = cleanAudience(JSON.parse(message.audience || "{}"));
  if (has(TEST_GUESTS, kind)) {
    const sample = testHousehold(kind);
    return { sample, label: `a made-up guest (${TEST_GUESTS[kind].label})`, inAudience: inAudience(sample.household, sample.guests, audience) };
  }
  const entry = (await loadHouseholds(env)).find((e) => inAudience(e.household, e.guests, audience));
  return entry
    ? { sample: entry, label: entry.household.display_name, inAudience: true }
    : { sample: testHousehold("both"), label: "a made-up household (nobody is in the audience yet)", inAudience: false };
}

/** What happened to the calendar invite, in words, for a test or preview. */
function calendarNote(message, settings, events) {
  if (!message.attach_ics) return "No calendar invite: the box to attach it isn't ticked.";
  if (!settings.calendar_events.length) return "No calendar invite: there are no events yet. Add them on the Calendar invite tab.";
  if (!events.length) return "No calendar invite: this guest gets none of the events (they declined, or aren't invited to any).";
  return `Calendar invite attached with ${events.map((e) => e.title || "an untitled event").join(", ")}.`;
}

export async function handleComms(parts, method, request, env, body, user) {
  const [, section, rawId, action] = parts;
  const id = rawId && /^\d+$/.test(rawId) ? Number(rawId) : null;
  const message = id ? await first(env, "SELECT * FROM comm_messages WHERE id = ?", id) : null;
  if (section === "messages" && id && !message) return json({ error: "No such email." }, 404);

  if (!section && method === "GET") return json(await overview(env));

  if (section === "messages" && !id && method === "POST") {
    const patch = cleanMessage(await body(request));
    const result = await run(
      env,
      "INSERT INTO comm_messages (title, subject, body, format, design, audience, attach_ics, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      patch.title ?? "",
      patch.subject ?? "",
      patch.body ?? "",
      patch.format ?? "text",
      patch.design ?? "plain",
      patch.audience ?? "{}",
      patch.attach_ics ?? 0,
      user.email
    );
    return json({ id: result.meta.last_row_id, ...(await overview(env)) }, 201);
  }

  if (section === "messages" && id && !action) {
    if (method === "PUT") {
      const input = await body(request);
      const patch = cleanMessage({ ...input, current_format: message.format });
      // The title is only a name on this page, so it can change after the email has gone.
      const titleOnly = Object.keys(patch).every((k) => k === "title");
      if (!EDITABLE.includes(message.status) && !titleOnly) throw new Error("This email has been sent; duplicate it to send a new version.");
      // Switching format without a new body converts the one on file.
      if (patch.format && patch.format !== message.format && !has(patch, "body")) {
        patch.body = patch.format === "html" ? textToContent(message.body) : htmlToText(message.body);
      }
      // A scheduled or automatic email can't be emptied: it would go out blank.
      if (message.status !== "draft") {
        const merged = { ...message, ...patch };
        if (!String(merged.subject || "").trim()) throw new Error("Give the email a subject. It's set to go out.");
        if (isBlank(merged)) throw new Error("Write the email first. It's set to go out.");
      }
      const columns = Object.keys(patch);
      if (columns.length) await run(env, `UPDATE comm_messages SET ${columns.map((c) => `${c} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`, ...columns.map((c) => patch[c]), id);
      return json(await overview(env));
    }
    if (method === "DELETE") {
      if (message.status === "sending") throw new Error("This email is going out right now. Delete it once it's sent.");
      await run(env, "DELETE FROM comm_sends WHERE message_id = ?", id);
      await run(env, "DELETE FROM comm_messages WHERE id = ?", id);
      return json(await overview(env));
    }
  }

  if (section === "audience" && method === "POST") {
    const audience = cleanAudience((await body(request)).audience);
    const entries = (await loadHouseholds(env)).filter((e) => inAudience(e.household, e.guests, audience));
    return json({
      households: entries.map(({ household, guests }) => {
        const r = recipientsFor(household, guests);
        return { id: household.id, name: household.display_name, guests: guests.length, to: r ? r.to[0] : null, cc: r ? r.cc : [] };
      }),
    });
  }

  if (section === "messages" && id && action === "sends" && method === "GET") {
    const sends = await all(
      env,
      `SELECT s.*, h.display_name FROM comm_sends s LEFT JOIN households h ON h.id = s.household_id
        WHERE s.message_id = ? ORDER BY CASE s.status WHEN 'failed' THEN 0 WHEN 'skipped' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END, h.display_name COLLATE NOCASE`,
      id
    );
    return json({ sends });
  }

  if (section === "messages" && id && method === "POST") {
    const input = await body(request);
    const check = () => {
      if (!message.subject.trim()) throw new Error("Give the email a subject.");
      if (isBlank(message)) throw new Error("Write the email first.");
    };
    if (action === "test") {
      check();
      const to = String(input.to || user.email).trim();
      if (!EMAIL.test(to)) throw new Error("That test address doesn't look like an email address.");
      const settings = await loadSettings(env);
      const { sample, label, inAudience: matches } = await testSample(env, message, input.as);
      const email = await compose(env, originOf(env, request), settings, { ...message, subject: `[Test] ${message.subject}` }, sample.household, sample.guests, { to: [to], cc: [] }, await emailTheme(env, settings));
      const session = await openGmail(env);
      await sendGmail(env, session, email);
      // It went, so an old Gmail error no longer holds (the banner would keep showing it).
      if (session.last_error) await setSetting(env, "_gmail", { ...session.stored, last_error: null, last_error_at: null });
      return json({ ok: true, to, sample: label, in_audience: matches, calendar: calendarNote(message, settings, email.events) });
    }
    if (action === "send") {
      check();
      if (!EDITABLE.includes(message.status)) throw new Error("This email has already been sent.");
      const queued = await enqueue(env, message, await loadHouseholds(env));
      if (!queued) throw new Error("Nobody is in this email's audience yet.");
      // An automatic email stays automatic: this catches up the households that already
      // replied, and each later RSVP still gets it.
      if (message.status !== "automated") {
        await run(env, "UPDATE comm_messages SET status = 'sending', send_at = ?, updated_at = datetime('now') WHERE id = ?", new Date().toISOString(), id);
      }
      // The first batch goes now; the cron sends the rest every five minutes.
      const result = await sendQueued(env, { origin: originOf(env, request) });
      return json({ result, ...(await overview(env)) });
    }
    if (action === "schedule") {
      check();
      if (!EDITABLE.includes(message.status)) throw new Error("This email has already been sent.");
      const local = String(input.send_at || "");
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new Error("Pick a date and time to send it.");
      const settings = await loadSettings(env);
      const at = zonedTime(local.slice(0, 10), local.slice(11), settings.time_zone);
      if (at.getTime() < Date.now() - 60000) throw new Error("That time has passed. Pick a later one, or send it now.");
      await run(env, "UPDATE comm_messages SET status = 'scheduled', send_at = ?, updated_at = datetime('now') WHERE id = ?", at.toISOString(), id);
      return json(await overview(env));
    }
    if (action === "automate") {
      if (input.on) {
        check();
        if (!EDITABLE.includes(message.status)) throw new Error("This email has already been sent.");
        await run(env, "UPDATE comm_messages SET status = 'automated', send_at = NULL, updated_at = datetime('now') WHERE id = ?", id);
      } else if (message.status === "automated") {
        await run(env, "UPDATE comm_messages SET status = 'draft', updated_at = datetime('now') WHERE id = ?", id);
      }
      return json(await overview(env));
    }
    if (action === "cancel") {
      if (message.status === "scheduled") await run(env, "UPDATE comm_messages SET status = 'draft', send_at = NULL, updated_at = datetime('now') WHERE id = ?", id);
      return json(await overview(env));
    }
  }

  // The email as it would look, without saving or sending: the editor's Preview.
  if (section === "preview" && method === "POST") {
    const input = await body(request);
    const patch = cleanMessage({ format: "html", design: "wedding", ...input });
    const draft = { subject: "", body: "", audience: "{}", attach_ics: 0, ...patch };
    const settings = await loadSettings(env);
    const { sample, label, inAudience: matches } = await testSample(env, draft, input.as);
    const email = await compose(env, originOf(env, request), settings, draft, sample.household, sample.guests, { to: [sample.household.email || "guest@example.com"], cc: [] }, await emailTheme(env, settings));
    return json({ subject: email.subject, html: email.html, text: email.text, sample: label, in_audience: matches, calendar: calendarNote(draft, settings, email.events) });
  }

  if (section === "email-design" && method === "PUT") {
    const input = await body(request);
    const image = String(input.header_image ?? "").trim();
    if (image && !(safeHref(image) || "").startsWith("https://")) throw new Error("The header photo needs a link that starts with https://.");
    await setSetting(env, "email_design", { header_image: image.slice(0, 1000), footer_note: String(input.footer_note ?? "").trim().slice(0, 300) });
    return json(await overview(env));
  }

  if (section === "calendar" && method === "PUT") {
    const input = await body(request);
    if (has(input, "time_zone")) {
      if (!validTimeZone(input.time_zone)) throw new Error("Unknown time zone.");
      await setSetting(env, "time_zone", String(input.time_zone));
    }
    if (has(input, "events")) await setSetting(env, "calendar_events", cleanEvents(input.events));
    return json(await overview(env));
  }
  if (section === "calendar.ics" && method === "GET") {
    const settings = await loadSettings(env);
    return new Response(buildIcs(settings.calendar_events, { timeZone: settings.time_zone, host: hostOf(env), name: settings.couple_names || "Our wedding" }), {
      headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'attachment; filename="wedding.ics"', "cache-control": "no-store" },
    });
  }

  if (section === "rsvp-page" && method === "PUT") {
    const input = await body(request);
    const defaults = DEFAULT_SETTINGS;
    if (has(input, "rsvp_open")) await setSetting(env, "rsvp_open", Boolean(input.rsvp_open));
    if (has(input, "rsvp_deadline")) {
      const v = String(input.rsvp_deadline || "").trim();
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error("The RSVP deadline must be a date.");
      await setSetting(env, "rsvp_deadline", v);
    }
    if (has(input, "rsvp_intro")) await setSetting(env, "rsvp_intro", String(input.rsvp_intro ?? "").slice(0, 2000));
    if (has(input, "email_from_name")) {
      const name = String(input.email_from_name ?? "").replace(/[\r\n<>"]/g, "").trim().slice(0, 100);
      await setSetting(env, "email_from_name", name || defaults.email_from_name);
    }
    if (has(input, "page") && input.page && typeof input.page === "object") {
      const page = Object.create(null);
      for (const key of Object.keys(defaults.rsvp_page)) {
        page[key] = has(input.page, key) ? String(input.page[key] ?? "").slice(0, 1000) : defaults.rsvp_page[key];
      }
      await setSetting(env, "rsvp_page", { ...page });
    }
    return json(await overview(env));
  }

  // Which account the emails come from is an admin's call, not every Communications user's.
  if (section === "gmail") {
    if (user.role !== "admin") return json({ error: "Only an admin can connect or disconnect Gmail." }, 403);
    if (rawId === "connect" && method === "GET") return startOAuth(request, env, "gmail", { loginHint: user.email });
    if (rawId === "disconnect" && method === "POST") {
      await disconnectGmail(env);
      return json(await overview(env));
    }
  }

  return json({ error: "Not found." }, 404);
}
