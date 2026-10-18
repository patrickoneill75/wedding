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
 *                          first names, current answers, and who may bring a plus-one,
 *                          plus a signed token good for two hours.
 *   POST rsvp/submit       { token, guests: [...], email, message }
 *   A guest can only answer for their own household (the token names it), and a
 *   plus-one is only accepted for a guest who was given one.
 *
 * Expense form (unlisted, for the couple): every route needs the form key from
 * the control panel (?k=... or the "key" field). Rotating the key in Settings kills
 * the old link.
 *   GET  expense/options?k=   categories, items (top level, not line items), vendors,
 *                             payers, methods
 *   POST expense/chat         { key, messages, who, today }: one turn of the conversational
 *                             form (src/intake.js). Proposes an entry; never saves one.
 *   POST expense              multipart: a new item, a line item under an existing item
 *                             (mode=purchase), or an update to an item that isn't split
 *                             into line items (mode=update); a
 *                             payment; a receipt (to Drive). Saving at the Paid stage
 *                             records the payment by itself, so no amount is needed.
 */

import { json, sign, verify } from "./auth.js";
import { all, first, getSetting, markDirty, run } from "./db.js";
import { STATUSES, STATUS_LABELS } from "./calc.js";
import { addPayment, createExpense, loadContext, loadSettings, listExpenses, listVendors, updateExpense } from "./store.js";
import { uploadReceipt } from "./google.js";
import { intakeTurn } from "./intake.js";

const RSVP_TOKEN_TTL = 60 * 60 * 2;
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

async function householdForRsvp(env, householdId) {
  const household = await first(env, "SELECT id, greeting, display_name, email, rsvp_message, rsvp_at FROM households WHERE id = ?", householdId);
  if (!household) return null;
  const guests = await all(
    env,
    `SELECT id, first_name, last_name, rsvp, dietary, plus_one_allowed, plus_one_name, plus_one_rsvp, plus_one_dietary
       FROM guests WHERE household_id = ? ORDER BY sort_order, id`,
    householdId
  );
  return {
    greeting: household.greeting || household.display_name,
    email: household.email || "",
    message: household.rsvp_message || "",
    responded: Boolean(household.rsvp_at),
    guests: guests.map((g) => ({
      id: g.id,
      first_name: g.first_name,
      last_name: g.last_name,
      rsvp: g.rsvp,
      dietary: g.dietary || "",
      plus_one_allowed: Boolean(g.plus_one_allowed),
      // Only a guest who was given a plus-one sees anything about one.
      ...(g.plus_one_allowed
        ? { plus_one_name: g.plus_one_name || "", plus_one_rsvp: g.plus_one_rsvp, plus_one_dietary: g.plus_one_dietary || "" }
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
    const household = guest ? await householdForRsvp(env, guest.household_id) : null;
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
  for (const householdId of [...householdIds].slice(0, 5)) {
    const household = await householdForRsvp(env, householdId);
    if (household) matches.push({ token: await sign(env, { kind: "rsvp", h: householdId }, RSVP_TOKEN_TTL), ...household });
  }
  return json({ matches });
}

async function rsvpSubmit(env, input) {
  const token = await verify(env, input.token);
  if (!token || token.kind !== "rsvp") return json({ error: "This RSVP page expired. Look up your name again." }, 400);
  const householdId = token.h;
  const members = await all(env, "SELECT id, plus_one_allowed FROM guests WHERE household_id = ?", householdId);
  const byId = new Map(members.map((m) => [m.id, m]));
  const answers = Array.isArray(input.guests) ? input.guests : [];
  const clip = (v, n = 500) => (v == null ? null : String(v).trim().slice(0, n) || null);
  let answered = 0;
  for (const answer of answers) {
    const guest = byId.get(Number(answer?.id));
    if (!guest) continue;
    if (!["yes", "no"].includes(answer.rsvp)) return json({ error: "Let us know whether each person is coming." }, 400);
    if (guest.plus_one_allowed) {
      const plusOne = answer.rsvp === "yes" && answer.plus_one_rsvp === "yes" ? "yes" : "no";
      const plusOneName = plusOne === "yes" ? clip(answer.plus_one_name, 200) : null;
      if (plusOne === "yes" && !plusOneName) return json({ error: "Tell us your guest's name." }, 400);
      await run(
        env,
        `UPDATE guests SET rsvp = ?, dietary = ?, plus_one_rsvp = ?, plus_one_name = COALESCE(?, plus_one_name),
                plus_one_dietary = ?, updated_at = datetime('now') WHERE id = ?`,
        answer.rsvp,
        clip(answer.dietary),
        plusOne,
        plusOneName,
        plusOne === "yes" ? clip(answer.plus_one_dietary) : null,
        guest.id
      );
    } else {
      // Any plus-one fields sent for a guest without one are ignored.
      await run(env, "UPDATE guests SET rsvp = ?, dietary = ?, updated_at = datetime('now') WHERE id = ?", answer.rsvp, clip(answer.dietary), guest.id);
    }
    answered++;
  }
  if (!answered) return json({ error: "Let us know whether each person is coming." }, 400);
  await run(
    env,
    "UPDATE households SET email = COALESCE(?, email), rsvp_message = ?, rsvp_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    clip(input.email, 200),
    clip(input.message, 2000),
    householdId
  );
  await markDirty(env);
  return json({ ok: true, household: await householdForRsvp(env, householdId) });
}

/* ------------------------------------------------------------- expense form ---- */

async function checkFormKey(env, key) {
  const expected = await getSetting(env, "_form_key");
  return Boolean(expected && key && String(key) === expected);
}

async function expenseOptions(env) {
  const ctx = await loadContext(env);
  const expenses = await listExpenses(env, ctx);
  return {
    statuses: STATUSES.filter((s) => s !== "cancelled").map((s) => ({ value: s, label: STATUS_LABELS[s] })),
    payers: ctx.settings.payers,
    payment_methods: ctx.settings.payment_methods,
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
    if (!existing || existing.parent_id) return json({ error: "That item no longer exists. Reload the form." }, 400);
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
        rsvp_intro: s.rsvp_intro,
        contact_email: s.contact_email,
      });
    }
    if (route.startsWith("rsvp/")) {
      const s = await loadSettings(env);
      if (!s.rsvp_open) return json({ error: "RSVPs are closed. Please contact us directly." }, 403);
      if (route === "rsvp/search" && method === "POST") return rsvpSearch(env, await body(request));
      if (route === "rsvp/lookup" && method === "POST") return rsvpLookup(env, await body(request));
      if (route === "rsvp/submit" && method === "POST") return rsvpSubmit(env, await body(request));
    }
    if (route === "expense/options" && method === "GET") {
      if (!(await checkFormKey(env, new URL(request.url).searchParams.get("k")))) {
        return json({ error: "This form link isn't valid any more. Get the current one from the control panel." }, 403);
      }
      return json(await expenseOptions(env));
    }
    if (route === "expense/chat" && method === "POST") {
      const input = await body(request);
      if (!(await checkFormKey(env, input.key))) {
        return json({ error: "This form link isn't valid any more. Get the current one from the control panel." }, 403);
      }
      const turn = await intakeTurn(env, input, await loadContext(env));
      return json(turn.body, turn.status);
    }
    if (route === "expense" && method === "POST") {
      const form = await request.formData();
      if (!(await checkFormKey(env, form.get("key")))) {
        return json({ error: "This form link isn't valid any more. Get the current one from the control panel." }, 403);
      }
      return submitExpense(env, form);
    }
    return json({ error: "Not found." }, 404);
  } catch (error) {
    return json({ error: error.message || String(error) }, 400);
  }
}
