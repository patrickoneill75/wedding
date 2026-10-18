/**
 * Everyone on the guest list as one row per person: each guest, and each plus-one a
 * guest was given (named or not), with their household, invitations, RSVP, dietary
 * needs and reception seat. Reports (src/reports.js) and the run of show
 * (src/runofshow.js) both read it. Admin-only data: never hand it to the RSVP page.
 */

import { all } from "./db.js";
import { seatsByGuest } from "./seating.js";

export const RSVP_TEXT = { pending: "Awaiting", yes: "Coming", no: "Not coming" };

function invitedTo(g) {
  if (g.invite_ceremony && g.invite_reception) return "Ceremony and reception";
  if (g.invite_ceremony) return "Ceremony only";
  if (g.invite_reception) return "Reception only";
  return "Neither";
}

/** People and their households. Two queries plus the seat lookup. */
export async function loadPeople(env) {
  const guests = await all(
    env,
    `SELECT g.*, h.code AS household_code, h.display_name AS household, h.greeting, h.address1, h.address2, h.city,
            h.state, h.zip, h.country, h.email, h.phone
       FROM guests g JOIN households h ON h.id = g.household_id
      ORDER BY g.last_name COLLATE NOCASE, g.first_name COLLATE NOCASE, g.id`
  );
  const seats = await seatsByGuest(env);
  const people = [];
  for (const g of guests) {
    const seat = seats.get(g.id) || {};
    const name = `${g.first_name} ${g.last_name}`.trim() || "(no name)";
    const shared = {
      guest_id: g.id,
      household_id: g.household_id,
      household: g.household,
      household_code: g.household_code,
      greeting: g.greeting,
      side: g.side || "",
      priority: g.priority,
      ceremony: Boolean(g.invite_ceremony),
      reception: Boolean(g.invite_reception),
      invited_to: invitedTo(g),
      email: g.email || "",
      phone: g.phone || "",
      address1: g.address1 || "",
      address2: g.address2 || "",
      city: g.city || "",
      state: g.state || "",
      zip: g.zip || "",
      country: g.country || "",
    };
    const at = (s) => ({ table: s?.table || "", seat: s?.seat || "", table_seat: s ? `${s.table}${s.seat}` : "" });
    people.push({
      ...shared,
      key: `${g.id}:0`,
      plus_one: false,
      name,
      first_name: g.first_name,
      last_name: g.last_name,
      guest_of: "",
      rsvp: RSVP_TEXT[g.rsvp] || g.rsvp,
      rsvp_code: g.rsvp,
      dietary: g.dietary || "",
      wedding_party: Boolean(g.wedding_party),
      immediate_family: Boolean(g.immediate_family),
      extended_family: Boolean(g.extended_family),
      notes: g.notes || "",
      ...at(seat.guest),
    });
    if (g.plus_one_allowed) {
      const typed = String(g.plus_one_name || "").trim();
      const [first = "", ...rest] = typed.split(/\s+/);
      people.push({
        ...shared,
        key: `${g.id}:1`,
        plus_one: true,
        name: typed || `Guest of ${name}`,
        first_name: typed ? first : "",
        last_name: typed ? rest.join(" ") : "",
        guest_of: name,
        rsvp: RSVP_TEXT[g.plus_one_rsvp] || g.plus_one_rsvp,
        rsvp_code: g.plus_one_rsvp,
        dietary: g.plus_one_dietary || "",
        wedding_party: false,
        immediate_family: false,
        extended_family: false,
        notes: "",
        ...at(seat.plus_one),
      });
    }
  }
  return people;
}
