/**
 * The seating chart, mounted under /api/admin/seating/* (admins, and users with the
 * Seating page).
 *
 *   GET    seating                  rooms, templates, everything placed, who sits where,
 *                                   and the people who can be seated
 *   POST   seating/rooms            { name, kind, width_ft, length_ft }
 *   PUT    seating/rooms/:id / DELETE seating/rooms/:id
 *   POST   seating/templates        { name, shape, width_ft, length_ft, seats, seat_sides }
 *   PUT    seating/templates/:id / DELETE seating/templates/:id
 *   POST   seating/items            { room_id, kind: "table" | "seat" | "note" | "shape", template_id?,
 *                                     count? (chairs in a row), ...fields }
 *   PUT    seating/items/:id / DELETE seating/items/:id
 *   POST   seating/assign           { item_id, seat_letter, guest_id, plus_one } puts that
 *                                   person in that seat (moving them from any other);
 *                                   guest_id null empties the seat
 *
 * A shape is a rectangle or oval of any size (a dance floor, the bar, a stage) with optional
 * text centered in it; nobody sits at one.
 *
 * Sizes and positions are in feet. A table's seats are lettered A, B, C ... clockwise
 * from the top (public/admin/seating.html draws them); a single chair has one seat, A. Only reception rooms take seat
 * assignments, and only for guests invited to the reception.
 */

import { json } from "./auth.js";
import { all, first, run, markDirty } from "./db.js";
import { sqlValue } from "./importer.js";

export const ROOM_KINDS = ["ceremony", "reception", "other"];
export const SHAPES = ["round", "rect"];
export const SEAT_SIDES = ["both", "one", "around"];
const ITEM_KINDS = ["table", "seat", "note", "shape"];
export const SHAPE_COLORS = ["gray", "blue", "green", "amber", "rose"];
const MAX_SEATS = 26;
const MAX_ROW = 60;

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** "A".."Z" for a table with `count` seats. */
export function seatLetters(count) {
  return Array.from({ length: Math.max(0, Math.min(MAX_SEATS, count)) }, (_, i) => String.fromCharCode(65 + i));
}

function number(value, name, min, max) {
  const n = Number(value);
  if (value === "" || value === null || !Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}.`);
  }
  return Math.round(n * 100) / 100;
}

function text(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) throw new Error(`${name} must be ${allowed.join(", ")}.`);
  return value;
}

function cleanRoom(input) {
  const patch = Object.create(null);
  if (has(input, "name")) patch.name = text(input.name, 100);
  if (has(input, "kind")) patch.kind = oneOf(input.kind, ROOM_KINDS, "Room type");
  if (has(input, "width_ft")) patch.width_ft = number(input.width_ft, "Room width", 5, 500);
  if (has(input, "length_ft")) patch.length_ft = number(input.length_ft, "Room length", 5, 500);
  if (has(input, "sort_order")) patch.sort_order = Number(input.sort_order) || 0;
  return patch;
}

/** The table fields templates and tables share. A round table's length is its width. */
function cleanTableShape(input, patch) {
  if (has(input, "shape")) patch.shape = oneOf(input.shape, SHAPES, "Shape");
  if (has(input, "width_ft")) patch.width_ft = number(input.width_ft, "Table width", 1, 60);
  if (has(input, "length_ft")) patch.length_ft = number(input.length_ft, "Table length", 1, 60);
  if (has(input, "seats")) patch.seats = Math.round(number(input.seats, "Seats", 0, MAX_SEATS));
  if (has(input, "seat_sides")) patch.seat_sides = oneOf(input.seat_sides, SEAT_SIDES, "Seats on");
  if (patch.shape === "round" && has(patch, "width_ft")) patch.length_ft = patch.width_ft;
  return patch;
}

function cleanTemplate(input) {
  const patch = Object.create(null);
  if (has(input, "name")) patch.name = text(input.name, 100);
  return cleanTableShape(input, patch);
}

function cleanItem(input, kind) {
  const patch = Object.create(null);
  if (has(input, "label")) patch.label = text(input.label, kind === "note" || kind === "shape" ? 200 : 20);
  if (has(input, "x")) patch.x = number(input.x, "Position", -50, 550);
  if (has(input, "y")) patch.y = number(input.y, "Position", -50, 550);
  if (has(input, "rotation")) patch.rotation = ((Math.round(number(input.rotation, "Rotation", -360, 360)) % 360) + 360) % 360;
  if (kind === "table") cleanTableShape(input, patch);
  if ((kind === "note" || kind === "shape") && has(input, "font_size")) patch.font_size = number(input.font_size, "Text size", 0.5, 10);
  if (kind === "shape") {
    if (has(input, "shape")) patch.shape = oneOf(input.shape, SHAPES, "Shape");
    if (has(input, "width_ft")) patch.width_ft = number(input.width_ft, "Width", 0.5, 500);
    if (has(input, "length_ft")) patch.length_ft = number(input.length_ft, "Length", 0.5, 500);
    if (has(input, "color")) patch.color = oneOf(input.color, SHAPE_COLORS, "Color");
  }
  return patch;
}

const insert = (env, table, patch) => {
  const columns = Object.keys(patch);
  return run(env, `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, ...columns.map((c) => patch[c]));
};
const update = (env, table, id, patch) => {
  const columns = Object.keys(patch);
  if (!columns.length) return null;
  return run(env, `UPDATE ${table} SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, ...columns.map((c) => patch[c]), id);
};

/**
 * Where a number must be unique. Reception tables and chairs are numbered across every
 * reception room, since escort cards, reports and the day-of view say "table 1" without
 * the room. Elsewhere only tables are numbered, within their room; chairs there can
 * share a label ("Row A").
 */
const labelScope = (room) => (room.kind === "reception"
  ? { sql: "room_id IN (SELECT id FROM seating_rooms WHERE kind = 'reception') AND kind IN ('table', 'seat')", params: [] }
  : { sql: "room_id = ? AND kind = 'table'", params: [room.id] });

/** Table numbers (and reception chair numbers) are unique, ignoring case; see labelScope. */
async function checkLabel(env, room, label, exceptId = 0, kind = "table") {
  if (!label || (kind === "seat" && room.kind !== "reception")) return;
  const scope = labelScope(room);
  const clash = await first(env, `SELECT id FROM seating_items WHERE ${scope.sql} AND lower(label) = lower(?) AND id <> ?`, ...scope.params, label, exceptId);
  if (clash) throw new Error(`There's already a table or chair ${label}${room.kind === "reception" ? " in a reception room" : " in this room"}.`);
}

/** The next free whole number for a table ("1", "2", ...); see labelScope. */
async function nextLabel(env, room) {
  const scope = labelScope(room);
  const rows = await all(env, `SELECT label FROM seating_items WHERE ${scope.sql}`, ...scope.params);
  const max = rows.reduce((m, r) => (/^\d+$/.test(r.label) ? Math.max(m, Number(r.label)) : m), 0);
  return String(max + 1);
}

/**
 * Who sits where, for the Guests page and guests.csv: guest id -> { guest, plus_one },
 * each { table, seat, room } or undefined.
 */
export async function seatsByGuest(env) {
  const rows = await all(
    env,
    `SELECT a.guest_id, a.plus_one, a.seat_letter, i.label, r.name AS room
       FROM seat_assignments a JOIN seating_items i ON i.id = a.item_id JOIN seating_rooms r ON r.id = i.room_id`
  );
  const out = new Map();
  for (const row of rows) {
    const entry = out.get(row.guest_id) || {};
    entry[row.plus_one ? "plus_one" : "guest"] = { table: row.label, seat: row.seat_letter, room: row.room };
    out.set(row.guest_id, entry);
  }
  return out;
}

async function overview(env) {
  const rooms = await all(env, "SELECT * FROM seating_rooms ORDER BY sort_order, id");
  const templates = await all(env, "SELECT * FROM seating_templates ORDER BY name COLLATE NOCASE, id");
  const items = await all(env, "SELECT * FROM seating_items ORDER BY room_id, id");
  const assignments = await all(env, "SELECT id, item_id, seat_letter, guest_id, plus_one FROM seat_assignments ORDER BY id");
  // Everyone who could take a seat, flagged so the page can point out a seat held by
  // someone who has since declined or lost their reception invitation or plus-one.
  const guests = await all(
    env,
    `SELECT g.id, g.household_id, g.first_name, g.last_name, g.rsvp, g.plus_one_allowed, g.plus_one_name, g.plus_one_rsvp,
            g.invite_reception, h.display_name AS household
       FROM guests g JOIN households h ON h.id = g.household_id
      ORDER BY g.last_name COLLATE NOCASE, g.first_name COLLATE NOCASE, g.id`
  );
  const people = [];
  for (const g of guests) {
    const name = `${g.first_name} ${g.last_name}`.trim() || "(no name)";
    people.push({ guest_id: g.id, plus_one: 0, name, household: g.household, rsvp: g.rsvp, invited: Boolean(g.invite_reception) });
    if (g.plus_one_allowed) {
      people.push({
        guest_id: g.id,
        plus_one: 1,
        name: g.plus_one_name ? g.plus_one_name : `${name}'s plus-one`,
        household: g.household,
        rsvp: g.plus_one_rsvp,
        invited: Boolean(g.invite_reception),
      });
    }
  }
  // A plus-one seat whose host no longer has a plus-one still shows, as a stale seat.
  const known = new Set(people.map((p) => `${p.guest_id}:${p.plus_one}`));
  for (const a of assignments) {
    if (!known.has(`${a.guest_id}:${a.plus_one}`)) {
      const host = guests.find((g) => g.id === a.guest_id);
      people.push({
        guest_id: a.guest_id,
        plus_one: 1,
        name: `${host ? `${host.first_name} ${host.last_name}`.trim() : "Someone"}'s plus-one`,
        household: host?.household || "",
        rsvp: "no",
        invited: false,
        stale: true,
      });
      known.add(`${a.guest_id}:${a.plus_one}`);
    }
  }
  return { rooms, templates, items, assignments, people, room_kinds: ROOM_KINDS, seat_sides: SEAT_SIDES };
}

async function roomOf(env, id) {
  return first(env, "SELECT * FROM seating_rooms WHERE id = ?", id);
}

async function createItem(env, input) {
  const room = await roomOf(env, Number(input.room_id));
  if (!room) throw new Error("Pick a room first.");
  const kind = oneOf(input.kind, ITEM_KINDS, "Kind");
  const base = Object.create(null);
  base.room_id = room.id;
  base.kind = kind;
  base.x = room.width_ft / 2;
  base.y = room.length_ft / 2;

  if (kind === "note") {
    const patch = Object.assign(base, cleanItem(input, kind));
    if (!patch.label) throw new Error("Type the note's text.");
    const result = await insert(env, "seating_items", patch);
    return [result.meta.last_row_id];
  }

  if (kind === "shape") {
    const patch = Object.assign(base, { shape: "rect", width_ft: 10, length_ft: 10, color: "gray", font_size: 1.5 }, cleanItem(input, kind));
    const result = await insert(env, "seating_items", patch);
    return [result.meta.last_row_id];
  }

  if (kind === "seat") {
    // A row of chairs, side by side, 2 ft apart, centered on (x, y).
    const count = has(input, "count") ? Math.round(number(input.count, "Chairs", 1, MAX_ROW)) : 1;
    const patch = Object.assign(base, cleanItem(input, kind));
    patch.seats = 1;
    patch.shape = null;
    let start = 0;
    if (room.kind === "reception") {
      if (patch.label && count === 1) await checkLabel(env, room, patch.label, 0, "seat");
      else start = Number(await nextLabel(env, room));
    }
    const rows = [];
    for (let i = 0; i < count; i++) {
      const label = room.kind !== "reception" ? patch.label || "" : count === 1 && patch.label ? patch.label : String(start + i);
      rows.push({ ...patch, label, x: Math.round((patch.x + (i - (count - 1) / 2) * 2) * 100) / 100 });
    }
    const columns = Object.keys(rows[0]);
    // One multi-row INSERT with escaped literals, so a long row of chairs stays one
    // query and under D1's limit on bound parameters.
    const result = await run(
      env,
      `INSERT INTO seating_items (${columns.join(", ")}) VALUES ${rows.map((row) => `(${columns.map((c) => sqlValue(row[c])).join(", ")})`).join(", ")}`
    );
    const last = result.meta.last_row_id;
    return rows.map((_, i) => last - (count - 1) + i);
  }

  // A table, from a template or from the sizes given.
  let shape = { shape: "round", width_ft: 5, length_ft: 5, seats: 8, seat_sides: "both" };
  if (input.template_id) {
    const template = await first(env, "SELECT * FROM seating_templates WHERE id = ?", Number(input.template_id));
    if (!template) throw new Error("No such template.");
    shape = { shape: template.shape, width_ft: template.width_ft, length_ft: template.length_ft, seats: template.seats, seat_sides: template.seat_sides };
  }
  const patch = Object.assign(base, shape, cleanItem(input, kind));
  if (patch.shape === "round") patch.length_ft = patch.width_ft;
  if (patch.label) await checkLabel(env, room, patch.label);
  else patch.label = await nextLabel(env, room);
  const result = await insert(env, "seating_items", patch);
  return [result.meta.last_row_id];
}

async function updateItem(env, id, input) {
  const item = await first(env, "SELECT i.*, r.kind AS room_kind FROM seating_items i JOIN seating_rooms r ON r.id = i.room_id WHERE i.id = ?", id);
  if (!item) return false;
  const room = { id: item.room_id, kind: item.room_kind };
  const patch = cleanItem(input, item.kind);
  if (item.kind === "table" && (patch.shape || item.shape) === "round") {
    patch.length_ft = has(patch, "width_ft") ? patch.width_ft : item.width_ft;
  }
  if ((item.kind === "table" || item.kind === "seat") && has(patch, "label")) {
    if (!patch.label && item.kind === "table") throw new Error("A table needs a number.");
    // Someone may sit in a reception chair: it keeps a number.
    if (!patch.label && item.kind === "seat" && room.kind === "reception") throw new Error("A chair needs a number.");
    await checkLabel(env, room, patch.label, id, item.kind);
  }
  if (item.kind === "note" && has(patch, "label") && !patch.label) throw new Error("A note needs some text.");
  await update(env, "seating_items", id, patch);
  // Fewer seats: whoever sat in a seat that's gone is unseated.
  if (has(patch, "seats")) {
    const keep = seatLetters(patch.seats);
    await run(
      env,
      `DELETE FROM seat_assignments WHERE item_id = ?${keep.length ? ` AND seat_letter NOT IN (${keep.map(() => "?").join(",")})` : ""}`,
      id,
      ...keep
    );
  }
  return true;
}

async function assign(env, input) {
  const item = await first(
    env,
    "SELECT i.*, r.kind AS room_kind FROM seating_items i JOIN seating_rooms r ON r.id = i.room_id WHERE i.id = ?",
    Number(input.item_id)
  );
  if (!item || (item.kind !== "table" && item.kind !== "seat")) throw new Error("Pick a table.");
  if (item.room_kind !== "reception") throw new Error("Seats are only assigned in a reception room.");
  const letter = String(input.seat_letter || "").toUpperCase();
  if (!seatLetters(item.seats).includes(letter)) throw new Error(`Table ${item.label} has no seat ${letter || "(none)"}.`);
  if (!item.label) throw new Error(`Give this ${item.kind === "seat" ? "chair" : "table"} a number first.`);
  // A room just made a reception room can hold chairs or tables that share a number
  // with others: seating someone there would put two people at "table 1 A".
  const clash = await first(
    env,
    `SELECT i.id FROM seating_items i JOIN seating_rooms r ON r.id = i.room_id
      WHERE r.kind = 'reception' AND i.kind IN ('table', 'seat') AND lower(i.label) = lower(?) AND i.id <> ?`,
    item.label,
    item.id
  );
  if (clash) throw new Error(`Two tables or chairs share the number ${item.label}. Renumber one first.`);

  if (input.guest_id === null || input.guest_id === undefined || input.guest_id === "") {
    await run(env, "DELETE FROM seat_assignments WHERE item_id = ? AND seat_letter = ?", item.id, letter);
    await markDirty(env);
    return;
  }
  const plusOne = input.plus_one ? 1 : 0;
  const guest = await first(env, "SELECT id, invite_reception, plus_one_allowed FROM guests WHERE id = ?", Number(input.guest_id));
  if (!guest) throw new Error("No such guest.");
  if (!guest.invite_reception) throw new Error("That guest isn't invited to the reception.");
  if (plusOne && !guest.plus_one_allowed) throw new Error("That guest doesn't have a plus-one.");
  // One seat per person: leave any other seat, then take this one from whoever had it.
  await run(env, "DELETE FROM seat_assignments WHERE guest_id = ? AND plus_one = ?", guest.id, plusOne);
  await run(
    env,
    `INSERT INTO seat_assignments (item_id, seat_letter, guest_id, plus_one) VALUES (?, ?, ?, ?)
       ON CONFLICT (item_id, seat_letter) DO UPDATE SET guest_id = excluded.guest_id, plus_one = excluded.plus_one`,
    item.id,
    letter,
    guest.id,
    plusOne
  );
  await markDirty(env);
}

export async function handleSeating(parts, method, request, env, body) {
  const [, section, rawId] = parts;
  const id = rawId && /^\d+$/.test(rawId) ? Number(rawId) : null;
  const notFound = (what) => json({ error: `No such ${what}.` }, 404);

  if (!section && method === "GET") return json(await overview(env));

  if (section === "rooms") {
    if (!id && method === "POST") {
      const patch = cleanRoom(await body(request));
      if (!patch.name) throw new Error("Name the room.");
      patch.kind ??= "reception";
      const { n } = await first(env, "SELECT COUNT(*) AS n FROM seating_rooms");
      patch.sort_order = n;
      const result = await insert(env, "seating_rooms", patch);
      return json({ id: result.meta.last_row_id, ...(await overview(env)) }, 201);
    }
    if (id && method === "PUT") {
      const room = await roomOf(env, id);
      if (!room) return notFound("room");
      const patch = cleanRoom(await body(request));
      if (has(patch, "name") && !patch.name) throw new Error("Name the room.");
      await update(env, "seating_rooms", id, patch);
      // No longer a reception room: nobody has a seat in it.
      if (patch.kind && patch.kind !== "reception" && room.kind === "reception") {
        await run(env, "DELETE FROM seat_assignments WHERE item_id IN (SELECT id FROM seating_items WHERE room_id = ?)", id);
        await markDirty(env);
      }
      return json(await overview(env));
    }
    if (id && method === "DELETE") {
      await run(env, "DELETE FROM seat_assignments WHERE item_id IN (SELECT id FROM seating_items WHERE room_id = ?)", id);
      await run(env, "DELETE FROM seating_items WHERE room_id = ?", id);
      await run(env, "DELETE FROM seating_rooms WHERE id = ?", id);
      await markDirty(env);
      return json(await overview(env));
    }
  }

  if (section === "templates") {
    if (!id && method === "POST") {
      const patch = cleanTemplate(await body(request));
      if (!patch.name) throw new Error("Name the template.");
      for (const key of ["shape", "width_ft", "seats"]) if (!has(patch, key)) throw new Error("A template needs a shape, a size and a number of seats.");
      if (!has(patch, "length_ft")) patch.length_ft = patch.width_ft;
      const result = await insert(env, "seating_templates", patch);
      return json({ id: result.meta.last_row_id, ...(await overview(env)) }, 201);
    }
    if (id && method === "PUT") {
      const template = await first(env, "SELECT * FROM seating_templates WHERE id = ?", id);
      if (!template) return notFound("template");
      const patch = cleanTemplate(await body(request));
      if (has(patch, "name") && !patch.name) throw new Error("Name the template.");
      if ((patch.shape || template.shape) === "round") patch.length_ft = has(patch, "width_ft") ? patch.width_ft : template.width_ft;
      // Tables already placed keep their own size; a template only shapes new ones.
      await update(env, "seating_templates", id, patch);
      return json(await overview(env));
    }
    if (id && method === "DELETE") {
      await run(env, "DELETE FROM seating_templates WHERE id = ?", id);
      return json(await overview(env));
    }
  }

  if (section === "items") {
    if (!id && method === "POST") {
      const ids = await createItem(env, await body(request));
      return json({ ids, ...(await overview(env)) }, 201);
    }
    if (id && method === "PUT") {
      const input = await body(request);
      if (!(await updateItem(env, id, input))) return notFound("table");
      // guests.csv shows table numbers; moving a table around changes nothing there.
      if (has(input, "label") || has(input, "seats")) await markDirty(env);
      return json(await overview(env));
    }
    if (id && method === "DELETE") {
      await run(env, "DELETE FROM seat_assignments WHERE item_id = ?", id);
      await run(env, "DELETE FROM seating_items WHERE id = ?", id);
      await markDirty(env);
      return json(await overview(env));
    }
  }

  if (section === "assign" && !id && method === "POST") {
    await assign(env, await body(request));
    return json(await overview(env));
  }

  return json({ error: "Not found." }, 404);
}
