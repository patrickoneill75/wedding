/**
 * Public API, mounted under /api/public/*. No sign-in.
 *
 * RSVP (the public site):
 *   GET  info              names, date, venue, deadline, whether RSVPs are open.
 *                          Never anything budget-related.
 *   POST rsvp/search       { q } -> up to 8 guests whose names match as the guest types:
 *                          every word typed must start a different word of the name, so
 *                          "con" finds Conor Marley and Conner Moore, "mar" finds Conor
 *                          Marley, and "con mar" only him. Needs 2+ letters. Returns the
 *                          full name and a signed "pick" token per guest -- never an id,
 *                          an address or anything else.
 *   POST rsvp/lookup       { pick } (from search) or { first, last } -> the household:
 *                          first names, current answers, who may bring a plus-one, what
 *                          each guest is invited to (ceremony, reception, rehearsal
 *                          dinner) and, for a household with a rehearsal dinner guest,
 *                          when and where it is, plus a signed token good for two hours.
 *   POST rsvp/submit       { token, guests: [...], email, message }
 *   While RSVPs are closed these answer only a signed-in admin, as a preview: submit
 *   then checks the answers but saves nothing and sends no emails.
 *   A guest can only answer for their own household (the token names it), and a
 *   plus-one is only accepted for a guest who was given one, and a rehearsal dinner
 *   answer only from a guest invited to it.
 *
 * Expense form (/submit, for the two of us): every route needs the control panel's
 * Google sign-in (and the X-Wedding header on POSTs), and knows who is signed in.
 *   GET  expense/options      categories, items (top level, not line items), vendors,
 *                             payers, methods, and `me`: the payer who is signed in
 *   POST expense/chat         { messages, who, today }: one turn of the conversational
 *                             form (src/intake.js). Proposes an entry; never saves one.
 *   POST expense              multipart: a new item, a line item under an existing item
 *                             (mode=purchase), or an update to an item that isn't split
 *                             into line items (mode=update); a
 *                             payment; a receipt (to Drive). Saving at the Paid stage
 *                             records the payment by itself, so no amount is needed.
 */

import { currentUser, json, requirePage, sign, verify } from "./auth.js";
import { all, first, markDirty, run } from "./db.js";
import { STATUSES, STATUS_LABELS } from "./calc.js";
import { addPayment, createExpense, loadContext, loadSettings, listExpenses, listVendors, updateExpense } from "./store.js";
import { uploadReceipt } from "./google.js";
import { intakeTurn, payerFor } from "./intake.js";
import { householdIcs, queueAfterRsvp } from "./comms.js";

export { payerFor };

const RSVP_TOKEN_TTL = 60 * 60 * 2;
const CALENDAR_TOKEN_TTL = 60 * 60 * 24 * 500;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i;
const PICK_TOKEN_TTL = 60 * 30;
const SEARCH_LIMIT = 8;
const SEARCH_MIN_LETTERS = 2;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

async function body(request) {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Lowercase, strip accents and anything that isn't a letter: "O'Neill " -> "oneill". */
export function normalizeName(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function firstNameMatches(stored, typed) {
  if (!stored || !typed) return false;
  if (stored === typed) return true;
  // "Pat" finds "Patricia" and "Patricia" finds "Pat" -- but not on one or two letters.
  const shorter = stored.length < typed.length ? stored : typed;
  const longer = stored.length < typed.length ? typed : stored;
  return shorter.length >= 3 && longer.startsWith(shorter);
}

/** When and where the rehearsal dinner is, from its calendar invite entry, if there is one. */
function rehearsalDetails(settings) {
  const event = (settings.calendar_events || []).find((e) => e.for === "rehearsal");
  return event ? { date: event.date || "", start: event.start || "", location: event.location || "" } : null;
}

async function householdForRsvp(env, householdId, settings) {
  const household = await first(env, "SELECT id, greeting, display_name, email, rsvp_message, rsvp_at FROM households WHERE id = ?", householdId);
  if (!household) return null;
  const guests = await all(
    env,
    `SELECT id, first_name, last_name, email, rsvp, dietary, plus_one_allowed, plus_one_name, plus_one_rsvp, plus_one_dietary,
            invite_ceremony, invite_reception, invite_rehearsal, rehearsal_rsvp, plus_one_rehearsal_rsvp
       FROM guests WHERE household_id = ? ORDER BY sort_order, id`,
    householdId
  );
  const rehearsal = guests.some((g) => g.invite_rehearsal) ? rehearsalDetails(settings) : null;
  return {
    greeting: household.greeting || household.display_name,
    email: household.email || "",
    message: household.rsvp_message || "",
    responded: Boolean(household.rsvp_at),
    // Only a household with someone invited to the rehearsal dinner hears when it is.
    ...(rehearsal ? { rehearsal } : {}),
    guests: guests.map((g) => ({
      id: g.id,
      first_name: g.first_name,
      last_name: g.last_name,
      email: g.email || "",
      // What each guest is invited to, so the page can say so under their name.
      ceremony: Boolean(g.invite_ceremony),
      reception: Boolean(g.invite_reception),
      rehearsal: Boolean(g.invite_rehearsal),
      rsvp: g.rsvp,
      dietary: g.dietary || "",
      ...(g.invite_rehearsal ? { rehearsal_rsvp: g.rehearsal_rsvp } : {}),
      plus_one_allowed: Boolean(g.plus_one_allowed),
      // Only a guest who was given a plus-one sees anything about one.
      ...(g.plus_one_allowed
        ? { plus_one_name: g.plus_one_name || "", plus_one_rsvp: g.plus_one_rsvp, plus_one_dietary: g.plus_one_dietary || "",
            ...(g.invite_rehearsal ? { plus_one_rehearsal_rsvp: g.plus_one_rehearsal_rsvp } : {}) }
        : {}),
    })),
  };
}

/** "Mary-Kate O'Neill" -> ["mary", "kate", "oneill"]. */
export function nameWords(text) {
  return String(text || "")
    .split(/[\s-]+/)
    .map(normalizeName)
    .filter(Boolean);
}

/**
 * Guests whose names match a partial query: each typed word must be the start of a
 * different word in the guest's name. Guests matched on their first name sort first.
 */
export function searchGuests(guests, query, limit = SEARCH_LIMIT) {
  const typed = nameWords(query);
  if (typed.join("").length < SEARCH_MIN_LETTERS) return [];
  const hits = [];
  for (const g of guests) {
    const words = nameWords(`${g.first_name} ${g.last_name}`);
    const used = new Set();
    let firstWordHit = false;
    const ok = typed.every((t) => {
      const i = words.findIndex((w, idx) => !used.has(idx) && w.startsWith(t));
      if (i < 0) return false;
      used.add(i);
      if (i === 0) firstWordHit = true;
      return true;
    });
    if (ok) hits.push({ g, rank: firstWordHit ? 0 : 1 });
  }
  hits.sort((a, b) => a.rank - b.rank
    || String(a.g.first_name).localeCompare(String(b.g.first_name))
    || String(a.g.last_name).localeCompare(String(b.g.last_name)));
  return hits.slice(0, limit).map((h) => h.g);
}

async function rsvpSearch(env, input) {
  const guests = await all(env, "SELECT id, first_name, last_name FROM guests");
  const results = [];
  for (const g of searchGuests(guests, input.q)) {
    results.push({
      name: `${String(g.first_name).trim()} ${String(g.last_name).trim()}`.trim(),
      pick: await sign(env, { kind: "pick", g: g.id }, PICK_TOKEN_TTL),
    });
  }
  return json({ results });
}

async function rsvpLookup(env, input) {
  if (input.pick !== undefined) {
    const pick = await verify(env, input.pick);
    if (!pick || pick.kind !== "pick") return json({ error: "That search expired. Type your name again." }, 400);
    const guest = await first(env, "SELECT household_id FROM guests WHERE id = ?", pick.g);
    const household = guest ? await householdForRsvp(env, guest.household_id, await loadSettings(env)) : null;
    if (!household) return json({ error: "We couldn't find that invitation any more. Please contact us." }, 404);
    return json({ matches: [{ token: await sign(env, { kind: "rsvp", h: guest.household_id }, RSVP_TOKEN_TTL), ...household }] });
  }
  const firstName = normalizeName(input.first);
  const lastName = normalizeName(input.last);
  if (!firstName || !lastName) return json({ error: "Enter your first and last name as they appear on your invitation." }, 400);
  const guests = await all(env, "SELECT id, household_id, first_name, last_name, plus_one_allowed, plus_one_name FROM guests");
  const householdIds = new Set();
  for (const g of guests) {
    if (normalizeName(g.last_name) === lastName && firstNameMatches(normalizeName(g.first_name), firstName)) {
      householdIds.add(g.household_id);
    }
    // A plus-one whose name was preloaded can find their host's invitation.
    if (g.plus_one_allowed && g.plus_one_name && normalizeName(g.plus_one_name) === firstName + lastName) {
      householdIds.add(g.household_id);
    }
  }
  if (!householdIds.size) {
    return json({ error: "We couldn't find that name on the guest list. Try the name on your invitation, or contact us." }, 404);
  }
  const matches = [];
  const settings = await loadSettings(env);
  for (const householdId of [...householdIds].slice(0, 5)) {
    const household = await householdForRsvp(env, householdId, settings);
    if (household) matches.push({ token: await sign(env, { kind: "rsvp", h: householdId }, RSVP_TOKEN_TTL), ...household });
  }
  return json({ matches });
}

/**
 * Saves a household's RSVP. A preview (an admin trying the page while RSVPs are closed)
 * runs every check but saves nothing and queues no emails; it answers with the
 * household as it would look.
 */
async function rsvpSubmit(env, input, { preview = false } = {}) {
  const token = await verify(env, input.token);
  if (!token || token.kind !== "rsvp") return json({ error: "This RSVP page expired. Look up your name again." }, 400);
  const householdId = token.h;
  // One email for the household is required: it's where the details and reminders go.
  const email = String(input.email ?? "").trim().slice(0, 200);
  if (!EMAIL.test(email)) return json({ error: email ? "That email address doesn't look right." : "Add an email address so we can send you the details." }, 400);
  const members = await all(env, "SELECT id, plus_one_allowed, invite_rehearsal FROM guests WHERE household_id = ?", householdId);
  const byId = new Map(members.map((m) => [m.id, m]));
  const answers = Array.isArray(input.guests) ? input.guests : [];
  const clip = (v, n = 500) => (v == null ? null : String(v).trim().slice(0, n) || null);
  // Each guest's new values, checked in full before anything is written.
  const changes = new Map();
  for (const answer of answers) {
    const guest = byId.get(Number(answer?.id));
    if (!guest) continue;
    if (!["yes", "no"].includes(answer.rsvp)) return json({ error: "Let us know whether each person is coming." }, 400);
    const set = { rsvp: answer.rsvp, dietary: clip(answer.dietary) };
    // A guest's own email is optional; a blank one leaves what's on file.
    const guestEmail = clip(answer.email, 200);
    if (guestEmail && !EMAIL.test(guestEmail)) return json({ error: `The email for one of your guests doesn't look right.` }, 400);
    if (guestEmail) set.email = guestEmail;
    // Guests invited to the rehearsal dinner answer for it too; declining the wedding
    // declines the dinner. Anyone else's rehearsal answer is ignored.
    if (guest.invite_rehearsal) {
      if (answer.rsvp === "yes" && !["yes", "no"].includes(answer.rehearsal_rsvp)) {
        return json({ error: "Let us know whether each person invited to the rehearsal dinner is coming to it." }, 400);
      }
      set.rehearsal_rsvp = answer.rsvp === "yes" ? answer.rehearsal_rsvp : "no";
    }
    // Any plus-one fields sent for a guest without one are ignored.
    if (guest.plus_one_allowed) {
      const plusOne = answer.rsvp === "yes" && answer.plus_one_rsvp === "yes" ? "yes" : "no";
      const plusOneName = plusOne === "yes" ? clip(answer.plus_one_name, 200) : null;
      if (plusOne === "yes" && !plusOneName) return json({ error: "Tell us your guest's name." }, 400);
      set.plus_one_rsvp = plusOne;
      // A blank name leaves a preloaded one in place.
      if (plusOneName) set.plus_one_name = plusOneName;
      set.plus_one_dietary = plusOne === "yes" ? clip(answer.plus_one_dietary) : null;
      // A plus-one comes to the rehearsal dinner only with a host who is coming to it.
      if (guest.invite_rehearsal) {
        const dinner = plusOne === "yes" && set.rehearsal_rsvp === "yes" ? answer.plus_one_rehearsal_rsvp : "no";
        if (!["yes", "no"].includes(dinner)) return json({ error: "Let us know whether your guest is joining you at the rehearsal dinner." }, 400);
        set.plus_one_rehearsal_rsvp = dinner;
      }
    }
    changes.set(guest.id, set);
  }
  if (!changes.size) return json({ error: "Let us know whether each person is coming." }, 400);
  const message = clip(input.message, 2000);
  const settings = await loadSettings(env);
  const calendarUrl = async () => ((await householdIcs(env, settings, householdId))
    ? `/api/public/calendar?t=${encodeURIComponent(await sign(env, { kind: "cal", h: householdId }, CALENDAR_TOKEN_TTL))}`
    : null);

  if (preview) {
    const household = await householdForRsvp(env, householdId, settings);
    return json({
      ok: true,
      preview: true,
      household: {
        ...household,
        email,
        message: message || "",
        responded: true,
        guests: household.guests.map((g) => ({ ...g, ...Object.fromEntries(Object.entries(changes.get(g.id) || {}).map(([k, v]) => [k, v ?? ""])) })),
      },
      calendar_url: await calendarUrl(),
    });
  }

  for (const [id, set] of changes) {
    const columns = Object.keys(set);
    await run(env, `UPDATE guests SET ${columns.map((c) => `${c} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`, ...columns.map((c) => set[c]), id);
  }
  await run(
    env,
    "UPDATE households SET email = ?, rsvp_message = ?, rsvp_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    email,
    message,
    householdId
  );
  await markDirty(env);
  // Emails set to go out after an RSVP are queued; the cron sends them within minutes.
  await queueAfterRsvp(env, householdId);
  return json({ ok: true, household: await householdForRsvp(env, householdId, settings), calendar_url: await calendarUrl() });
}

/** GET calendar?t=: the household's calendar invite (the token comes from the RSVP or an email). */
async function calendarDownload(env, request) {
  const token = await verify(env, new URL(request.url).searchParams.get("t"));
  if (!token || token.kind !== "cal") return json({ error: "That calendar link isn't valid. RSVP again to get a new one." }, 400);
  const ics = await householdIcs(env, await loadSettings(env), token.h);
  if (!ics) return json({ error: "There's nothing on the calendar yet." }, 404);
  return new Response(ics, {
    headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'attachment; filename="wedding.ics"', "cache-control": "no-store" },
  });
}

/* ------------------------------------------------------------- expense form ---- */

async function expenseOptions(env, user) {
  const ctx = await loadContext(env);
  const expenses = await listExpenses(env, ctx);
  return {
    statuses: STATUSES.filter((s) => s !== "cancelled").map((s) => ({ value: s, label: STATUS_LABELS[s] })),
    payers: ctx.settings.payers,
    me: payerFor(user, ctx.settings.payers),
    categories: [...new Set(expenses.map((e) => e.category).filter(Boolean))].sort(),
    subcategories: [...new Set(expenses.map((e) => e.subcategory).filter(Boolean))].sort(),
    vendors: await listVendors(env),
    items: expenses
      .filter((e) => e.status !== "cancelled" && !e.parent_id)
      .map((e) => ({
        id: e.id,
        category: e.category,
        subcategory: e.subcategory,
        item: e.item,
        vendor: e.vendor || "",
        purchases: e.purchases,
        status: e.status,
        pricing: e.pricing,
        unit_cost: e.unit_cost,
        quantity: e.quantity,
        total: e.current,
        estimated: e.estimated,
        incurred: e.incurred,
        paid: e.paid,
        owed: e.owed,
      })),
  };
}

async function submitExpense(env, form) {
  const field = (name) => {
    const v = form.get(name);
    return typeof v === "string" ? v.trim() : "";
  };
  const by = field("submitted_by") || "Expense form";
  const ctx = await loadContext(env);
  const status = field("status") || "estimate";
  if (!STATUSES.includes(status)) return json({ error: "Pick a stage." }, 400);

  let expenseId = Number(field("expense_id")) || null;
  const price = field("price");
  const note = field("notes");
  // Who/when/how it was paid: used for the payment Paid records, or the one typed in.
  const payment = { paid_on: field("paid_on"), payer: field("payer"), method: field("method") };
  if (expenseId) {
    const existing = await first(env, "SELECT id, pricing, parent_id FROM expenses WHERE id = ?", expenseId);
    if (!existing) return json({ error: "That item no longer exists. Reload the form." }, 400);
    // A line item can be updated (its quote went up), but takes no line items of its own.
    if (existing.parent_id && field("mode") === "purchase") return json({ error: "A line item can't have line items of its own." }, 400);
    const split = await first(env, "SELECT id FROM expenses WHERE parent_id = ? LIMIT 1", existing.id);
    if (field("mode") !== "purchase" && split) {
      return json({ error: "That item is split into line items. Add a line item to it instead." }, 400);
    }
    if (field("mode") === "purchase") {
      // A new line item filed under the chosen item.
      expenseId = await createExpense(
        env,
        {
          parent_id: existing.id,
          item: field("item") || "Line item",
          vendor: field("vendor"),
          status,
          pricing: "fixed",
          unit_cost: price === "" ? null : price,
          units: field("units") || 1,
          taxable: field("taxable") === "on" || field("taxable") === "1",
          gratuity_rate: field("gratuity_percent") ? Number(field("gratuity_percent")) / 100 : 0,
          due_date: field("due_date"),
          notes: note,
          history_note: "Added from the expense form",
          ...payment,
        },
        ctx,
        by,
        "expense-form"
      );
    } else {
      const patch = { status, history_note: note ? `Form: ${note}` : "Updated from the expense form", ...payment };
      if (price !== "") patch.unit_cost = price;
      if (field("units")) patch.units = field("units");
      if (field("vendor")) patch.vendor = field("vendor");
      if (field("due_date")) patch.due_date = field("due_date");
      if (!payment.payer) delete patch.payer;
      await updateExpense(env, expenseId, patch, ctx, by);
    }
  } else {
    if (!field("item")) return json({ error: "Name the expense." }, 400);
    expenseId = await createExpense(
      env,
      {
        category: field("category") || "Other",
        subcategory: field("subcategory"),
        item: field("item"),
        vendor: field("vendor"),
        status,
        pricing: "fixed",
        unit_cost: price === "" ? null : price,
        units: field("units") || 1,
        taxable: field("taxable") === "on" || field("taxable") === "1",
        gratuity_rate: field("gratuity_percent") ? Number(field("gratuity_percent")) / 100 : 0,
        due_date: field("due_date"),
        notes: note,
        history_note: "Added from the expense form",
        ...payment,
      },
      ctx,
      by,
      "expense-form"
    );
  }

  let paymentId = null;
  // At the Paid stage the payment was already recorded for the full amount.
  if (field("payment_amount") && status !== "paid") {
    paymentId = await addPayment(
      env,
      expenseId,
      {
        amount: field("payment_amount"),
        paid_on: field("paid_on"),
        payer: field("payer"),
        method: field("method"),
        note: note || null,
      },
      ctx,
      by
    );
  }

  let receipt = null;
  let receiptError = null;
  const file = form.get("file");
  if (file && typeof file !== "string" && file.size > 0) {
    if (file.size > MAX_UPLOAD_BYTES) {
      receiptError = "The file was over 20 MB, so it wasn't saved.";
    } else {
      try {
        const expense = await first(env, "SELECT item, vendor FROM expenses WHERE id = ?", expenseId);
        receipt = await uploadReceipt(env, file, [expense.vendor, expense.item].filter(Boolean).join(" "));
        await run(
          env,
          "INSERT INTO attachments (expense_id, payment_id, drive_file_id, name, web_link, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)",
          expenseId,
          paymentId,
          receipt.id,
          receipt.name,
          receipt.webViewLink || null,
          by
        );
      } catch (error) {
        receiptError = `The expense was saved, but the file wasn't: ${error.message}`;
      }
    }
  }
  await markDirty(env);
  return json({ ok: true, expense_id: expenseId, payment_id: paymentId, receipt: receipt ? receipt.name : null, receipt_error: receiptError }, 201);
}

/** A signed-in admin, who may preview the RSVP page while it's closed to guests. */
async function previewer(request, env) {
  const user = await currentUser(request, env);
  return user?.role === "admin";
}

export async function handlePublicApi(route, request, env) {
  const method = request.method.toUpperCase();
  try {
    if (route === "info" && method === "GET") {
      const s = await loadSettings(env);
      return json({
        couple_names: s.couple_names,
        wedding_date: s.wedding_date,
        venue: s.venue,
        rsvp_deadline: s.rsvp_deadline,
        rsvp_open: Boolean(s.rsvp_open),
        // While RSVPs are closed, a signed-in admin can still try the page.
        ...(!s.rsvp_open && (await previewer(request, env)) ? { preview: true } : {}),
        rsvp_intro: s.rsvp_intro,
        rsvp_page: s.rsvp_page,
        contact_email: s.contact_email,
      });
    }
    if (route === "calendar" && method === "GET") return calendarDownload(env, request);
    if (route.startsWith("rsvp/")) {
      const s = await loadSettings(env);
      const preview = !s.rsvp_open && (await previewer(request, env));
      if (!s.rsvp_open && !preview) return json({ error: "RSVPs are closed. Please contact us directly." }, 403);
      if (route === "rsvp/search" && method === "POST") return rsvpSearch(env, await body(request));
      if (route === "rsvp/lookup" && method === "POST") return rsvpLookup(env, await body(request));
      if (route === "rsvp/submit" && method === "POST") return rsvpSubmit(env, await body(request), { preview });
    }
    // The expense form takes the control panel's sign-in, with access to Expenses.
    let user = null;
    if (route === "expense" || route.startsWith("expense/")) {
      const [admin, denied] = await requirePage(request, env, "expenses");
      if (denied) return denied;
      user = admin;
    }
    if (route === "expense/options" && method === "GET") return json(await expenseOptions(env, user));
    if (route === "expense/chat" && method === "POST") {
      const input = await body(request);
      const turn = await intakeTurn(env, input, await loadContext(env), user);
      if (turn.stream) return new Response(turn.stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
      return json(turn.body, turn.status);
    }
    if (route === "expense" && method === "POST") {
      const form = await request.formData();
      if (!form.get("submitted_by")) form.set("submitted_by", payerFor(user, (await loadSettings(env)).payers) || user.name);
      return submitExpense(env, form);
    }
    return json({ error: "Not found." }, 404);
  } catch (error) {
    return json({ error: error.message || String(error) }, 400);
  }
}
