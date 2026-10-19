/**
 * Communications: emails to guests through the connected Gmail, the calendar invite,
 * and the RSVP page's wording. Control panel routes under /api/admin/comms/* (the
 * Communications page):
 *
 *   GET    comms                     emails with their send counts, Gmail status, the
 *                                    audience choices, fill-ins, calendar events, RSVP page
 *   POST   comms/messages            { subject, body, audience, attach_ics } -> a draft
 *   PUT    comms/messages/:id        change a draft, scheduled or automatic email
 *   DELETE comms/messages/:id
 *   POST   comms/audience            { audience } -> who would get it, and who has no email
 *   POST   comms/messages/:id/test   { to? } send it now to one address (default: you)
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
import { disconnectGmail, gmailStatus, GmailConnectionError, openGmail, sendGmail } from "./gmail.js";

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
export const SEND_BATCH = 20;
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
  const token = household.id ? await sign(env, { kind: "cal", h: household.id }, CALENDAR_TOKEN_TTL) : "sample";
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
export function fillIn(template, values) {
  return String(template).replace(/\{([a-z_]+)\}/g, (whole, name) => (has(values, name) ? values[name] : whole));
}

const originOf = (env, request) => env.PUBLIC_URL || (request ? new URL(request.url).origin : "");

/** The .ics for a household, or null when it gets no events. */
export async function householdIcs(env, settings, householdId) {
  const [entry] = await loadHouseholds(env, [householdId]);
  if (!entry) return null;
  const events = eventsFor(settings.calendar_events, entry.guests);
  if (!events.length) return null;
  return buildIcs(events, { timeZone: settings.time_zone, host: hostOf(env), name: settings.couple_names || "Our wedding" });
}
const hostOf = (env) => (env.PUBLIC_URL ? new URL(env.PUBLIC_URL).hostname : "wedding.local");

/** One email for one household, ready for sendGmail. */
async function compose(env, origin, settings, message, household, guests, recipients) {
  const values = await fillInsFor(env, origin, settings, household, guests);
  const attachments = [];
  if (message.attach_ics) {
    const events = eventsFor(settings.calendar_events, guests);
    if (events.length) {
      attachments.push({
        filename: "wedding.ics",
        type: "text/calendar; charset=UTF-8; method=PUBLISH",
        content: buildIcs(events, { timeZone: settings.time_zone, host: hostOf(env), name: settings.couple_names || "Our wedding" }),
      });
    }
  }
  return {
    fromName: settings.email_from_name,
    to: recipients.to,
    cc: recipients.cc,
    subject: fillIn(message.subject, values),
    text: fillIn(message.body, values),
    attachments,
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
 */
export async function sendQueued(env, { limit = SEND_BATCH, origin = "" } = {}) {
  const queued = await all(
    env,
    `SELECT s.id, s.message_id, s.household_id, s.attempts, m.subject, m.body, m.attach_ics
       FROM comm_sends s JOIN comm_messages m ON m.id = s.message_id
      WHERE s.status = 'queued' ORDER BY s.id LIMIT ?`,
    limit
  );
  if (!queued.length) return { sent: 0, failed: 0, stopped: null };
  let session;
  try {
    session = await openGmail(env);
  } catch (error) {
    if (error instanceof GmailConnectionError) return { sent: 0, failed: 0, stopped: error.message };
    throw error;
  }
  const settings = await loadSettings(env);
  const entries = new Map((await loadHouseholds(env, [...new Set(queued.map((q) => q.household_id))])).map((e) => [e.household.id, e]));
  const sent = [];
  const failed = [];
  let stopped = null;
  for (const item of queued) {
    const entry = entries.get(item.household_id);
    const recipients = entry && recipientsFor(entry.household, entry.guests);
    if (!recipients) {
      failed.push([item, "This household no longer has an email address."]);
      continue;
    }
    try {
      const email = await compose(env, origin || originOf(env), settings, item, entry.household, entry.guests, recipients);
      await sendGmail(env, session, email);
      sent.push(item);
    } catch (error) {
      if (error instanceof GmailConnectionError) {
        stopped = error.message;
        break;
      }
      failed.push([item, error.message]);
    }
  }
  const now = new Date().toISOString();
  if (sent.length) {
    await run(env, `UPDATE comm_sends SET status = 'sent', sent_at = ?, error = NULL, attempts = attempts + 1 WHERE id IN (${sent.map((s) => Number(s.id)).join(",")})`, now);
  }
  if (failed.length) {
    // A failed send is tried again on the next runs, up to MAX_ATTEMPTS in all.
    await run(
      env,
      `UPDATE comm_sends SET attempts = attempts + 1,
              status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
              error = CASE id ${failed.map(([item, msg]) => `WHEN ${Number(item.id)} THEN ${sqlValue(String(msg).slice(0, 500))}`).join(" ")} END
        WHERE id IN (${failed.map(([item]) => Number(item.id)).join(",")})`
    );
  }
  // An email sent to everyone it was going to is done.
  await run(
    env,
    `UPDATE comm_messages SET status = 'sent', sent_at = ? WHERE status = 'sending'
        AND NOT EXISTS (SELECT 1 FROM comm_sends s WHERE s.message_id = comm_messages.id AND s.status = 'queued')`,
    now
  );
  if (sent.length && session.last_error) await setSetting(env, "_gmail", { ...session.stored, last_error: null, last_error_at: null });
  return { sent: sent.length, failed: failed.length, stopped };
}

/** The cron's part: start scheduled emails that are due, then send a batch. */
export async function processComms(env) {
  const due = await all(env, "SELECT * FROM comm_messages WHERE status = 'scheduled' AND send_at <= ?", new Date().toISOString());
  if (due.length) {
    const entries = await loadHouseholds(env);
    for (const message of due) {
      await enqueue(env, message, entries);
      await run(env, "UPDATE comm_messages SET status = 'sending', updated_at = datetime('now') WHERE id = ?", message.id);
    }
  }
  return sendQueued(env);
}

/* -------------------------------------------------------------------- API ---- */

function cleanMessage(input) {
  const patch = Object.create(null);
  if (has(input, "subject")) patch.subject = String(input.subject ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
  if (has(input, "body")) patch.body = String(input.body ?? "").replace(/\r\n/g, "\n").slice(0, 20000);
  if (has(input, "audience")) patch.audience = JSON.stringify(cleanAudience(input.audience));
  if (has(input, "attach_ics")) patch.attach_ics = input.attach_ics ? 1 : 0;
  return patch;
}

async function listMessages(env) {
  const messages = await all(env, "SELECT * FROM comm_messages ORDER BY CASE status WHEN 'draft' THEN 0 ELSE 1 END, COALESCE(send_at, updated_at) DESC, id DESC");
  const counts = await all(env, "SELECT message_id, status, COUNT(*) AS n FROM comm_sends GROUP BY message_id, status");
  const byMessage = new Map();
  for (const c of counts) {
    if (!byMessage.has(c.message_id)) byMessage.set(c.message_id, { queued: 0, sent: 0, failed: 0, skipped: 0 });
    byMessage.get(c.message_id)[c.status] = c.n;
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
  };
}

const EDITABLE = ["draft", "scheduled", "automated"];

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
      "INSERT INTO comm_messages (subject, body, audience, attach_ics, created_by) VALUES (?, ?, ?, ?, ?)",
      patch.subject ?? "",
      patch.body ?? "",
      patch.audience ?? "{}",
      patch.attach_ics ?? 0,
      user.email
    );
    return json({ id: result.meta.last_row_id, ...(await overview(env)) }, 201);
  }

  if (section === "messages" && id && !action) {
    if (method === "PUT") {
      if (!EDITABLE.includes(message.status)) throw new Error("This email has been sent; duplicate it to send a new version.");
      const patch = cleanMessage(await body(request));
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
      if (!message.body.trim()) throw new Error("Write the email first.");
    };
    if (action === "test") {
      check();
      const to = String(input.to || user.email).trim();
      if (!EMAIL.test(to)) throw new Error("That test address doesn't look like an email address.");
      const settings = await loadSettings(env);
      // The fill-ins come from the first household in the audience, or a sample.
      const audience = cleanAudience(JSON.parse(message.audience || "{}"));
      const entry = (await loadHouseholds(env)).find((e) => inAudience(e.household, e.guests, audience));
      const sample = entry || { household: { id: 0, greeting: "Jane and John", display_name: "Jane and John Sample" }, guests: [{ first_name: "Jane", last_name: "Sample", rsvp: "yes", invite_ceremony: 1, invite_reception: 1 }] };
      const email = await compose(env, originOf(env, request), settings, { ...message, subject: `[Test] ${message.subject}` }, sample.household, sample.guests, { to: [to], cc: [] });
      await sendGmail(env, await openGmail(env), email);
      return json({ ok: true, to, sample: entry ? entry.household.display_name : "a made-up household" });
    }
    if (action === "send") {
      check();
      if (!EDITABLE.includes(message.status)) throw new Error("This email has already been sent.");
      const queued = await enqueue(env, message, await loadHouseholds(env));
      if (!queued) throw new Error("Nobody is in this email's audience yet.");
      await run(env, "UPDATE comm_messages SET status = 'sending', send_at = ?, updated_at = datetime('now') WHERE id = ?", new Date().toISOString(), id);
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
