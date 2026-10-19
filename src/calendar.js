/**
 * The calendar invite: an .ics file (RFC 5545) built from the events edited in
 * Communications (settings.calendar_events). Guests download it after they RSVP, and an
 * email can attach it. Each household gets the events for everyone plus the ones for a
 * part they're invited to (ceremony, reception, rehearsal dinner).
 *
 * Times are entered as wall-clock times in the wedding's time zone and written in UTC,
 * which every calendar app reads the same way.
 */

export const EVENT_AUDIENCES = ["everyone", "ceremony", "reception", "rehearsal"];
export const REMINDERS = { none: null, "1h": "-PT1H", "1d": "-P1D", "1w": "-P7D" };

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Minutes the zone is ahead of UTC at that instant (-300 for Indiana in winter). */
function zoneOffsetMinutes(utcMillis, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMillis));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - utcMillis) / 60000);
}

/** "2027-06-12" + "16:30" in a time zone -> a Date. */
export function zonedTime(date, time, timeZone) {
  const [y, m, d] = String(date).split("-").map(Number);
  const [hh, mm] = String(time || "00:00").split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes settle the offset across a daylight-saving change.
  let utc = wall - zoneOffsetMinutes(wall, timeZone) * 60000;
  utc = wall - zoneOffsetMinutes(utc, timeZone) * 60000;
  return new Date(utc);
}

export function validTimeZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Check the events sent from Communications; returns the cleaned list. */
export function cleanEvents(input) {
  if (!Array.isArray(input)) throw new Error("Events must be a list.");
  if (input.length > 10) throw new Error("A calendar invite holds at most 10 events.");
  const text = (v, n) => String(v ?? "").trim().slice(0, n);
  return input.map((e, i) => {
    if (!e || typeof e !== "object") throw new Error("Each event needs details.");
    const event = {
      id: /^[a-z0-9-]{6,40}$/i.test(String(e.id || "")) ? String(e.id) : `ev-${Date.now().toString(36)}-${i}`,
      title: text(e.title, 200),
      date: text(e.date, 10),
      all_day: Boolean(e.all_day),
      start: text(e.start, 5),
      end: text(e.end, 5),
      location: text(e.location, 500),
      notes: text(e.notes, 4000),
      url: text(e.url, 500),
      reminder: has(REMINDERS, e.reminder) ? e.reminder : "none",
      for: EVENT_AUDIENCES.includes(e.for) ? e.for : "everyone",
    };
    if (!event.title) throw new Error(`Event ${i + 1} needs a title.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date)) throw new Error(`"${event.title}" needs a date.`);
    if (!event.all_day) {
      const time = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (!time.test(event.start)) throw new Error(`"${event.title}" needs a start time.`);
      if (event.end && !time.test(event.end)) throw new Error(`"${event.title}" has an end time that isn't a time.`);
      // An end earlier than the start is the next day (a reception until 12:30 AM).
      if (event.end && event.end === event.start) throw new Error(`"${event.title}" ends when it starts.`);
    }
    if (event.url && !/^https?:\/\//i.test(event.url)) throw new Error(`"${event.title}" has a link that doesn't start with http.`);
    return event;
  });
}

/**
 * The events this household gets: everyone's, and those for a part someone in it is
 * invited to. Only guests who haven't declined count, so a household that said no gets
 * nothing, and the rehearsal dinner drops off once everyone invited to it has declined it.
 */
export function eventsFor(events, guests) {
  const going = guests.filter((g) => g.rsvp !== "no");
  const invited = {
    everyone: going.length > 0,
    ceremony: going.some((g) => g.invite_ceremony),
    reception: going.some((g) => g.invite_reception),
    rehearsal: going.some((g) => g.invite_rehearsal && g.rehearsal_rsvp !== "no"),
  };
  return events.filter((e) => invited[e.for] ?? false);
}

const escape = (value) => String(value).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Fold lines at 75 octets, as the format requires (continuations start with a space). */
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join("\r\n ");
}

/** The .ics text for these events. `host` names the UIDs (the site's domain). */
export function buildIcs(events, { timeZone, host = "wedding.local", name = "Wedding" } = {}) {
  const now = stamp(new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Wedding planner//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${escape(name)}`];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.id}@${host}`, `DTSTAMP:${now}`);
    if (e.all_day) {
      const next = new Date(`${e.date}T12:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      lines.push(`DTSTART;VALUE=DATE:${e.date.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${next.toISOString().slice(0, 10).replace(/-/g, "")}`);
    } else {
      const start = zonedTime(e.date, e.start, timeZone);
      // No end time: an hour, which is what most calendar apps assume. An end before the
      // start is past midnight, on the next day.
      let end = new Date(start.getTime() + 3600000);
      if (e.end) {
        const day = new Date(`${e.date}T12:00:00Z`);
        if (e.end < e.start) day.setUTCDate(day.getUTCDate() + 1);
        end = zonedTime(day.toISOString().slice(0, 10), e.end, timeZone);
      }
      lines.push(`DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`);
    }
    lines.push(`SUMMARY:${escape(e.title)}`);
    if (e.location) lines.push(`LOCATION:${escape(e.location)}`);
    if (e.notes || e.url) lines.push(`DESCRIPTION:${escape([e.notes, e.url].filter(Boolean).join("\n\n"))}`);
    if (e.url) lines.push(`URL:${e.url}`);
    if (REMINDERS[e.reminder]) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escape(e.title)}`, `TRIGGER:${REMINDERS[e.reminder]}`, "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
