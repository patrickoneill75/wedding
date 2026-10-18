/**
 * The expense form's conversation: describe an expense or send a receipt, and Claude
 * works out where it goes, asks what it can't tell, and proposes an entry. Nothing is
 * saved here -- the proposal comes back as the fields the expense form posts to
 * POST /api/public/expense, and the person taps Save.
 *
 * Claude sees every open item, line item, category and vendor, so it can say "there's
 * already Place Settings -- put the glassware there?" when a search by name would
 * have found nothing.
 *
 * The browser keeps the conversation (the API's own message list, thinking blocks and
 * all, sent back unchanged each turn) and sends it with every request; the Worker
 * keeps nothing between turns. Raw fetch rather than the Anthropic SDK: src/ has no npm
 * runtime dependencies (CLAUDE.md).
 *
 * Needs the ANTHROPIC_API_KEY secret; without it the route says so and the page points
 * to the plain form.
 */

import { STATUSES, STATUS_LABELS } from "./calc.js";
import { listExpenses, listVendors } from "./store.js";

const MODEL = "claude-opus-5-5";
const API_URL = "https://api.anthropic.com/v1/messages";
const MAX_MESSAGES = 60;
const MAX_BODY_CHARS = 12_000_000; // a few downsized receipt photos
// Times Claude may be told its proposal didn't check out before we give up for this turn.
const MAX_RETRIES = 2;

const INSTRUCTIONS = `You help Patrick and Kaitlyn log their wedding expenses from their phones. They describe an expense or send a photo of a receipt; you work out where it belongs, ask for anything you can't tell, and propose an entry with the propose_expense tool. They tap Save on your proposal to record it, or reply to change it.

How the expenses are organized: each item (Florist, DJ, Place Settings) sits in a category and subcategory. An item is either one booking with its own vendor, stage and price, or a container of line items (Place Settings: plates from one shop, glassware from another), each line item with its own vendor, stage and price. The current items are listed below.

How to work:
- First work out what the expense is for. Match it to the existing items by meaning, not just by name: glassware, plates, chargers and napkins belong with Place Settings; a bouquet or centerpieces with flowers; a deposit to the band with the band.
- By default, record an expense as a new line item (mode line_item) under the item it fits, and say which item you put it under so they can ask for a separate item instead. What the item already has becomes its first line item automatically. When no item fits, make a new item (mode new) in the category that fits best, using an existing category whenever one is logical.
- Only change an existing entry (mode update) when they clearly ask to: "the florist's quote went up to $2,400", "mark the DJ paid". An item that already has line items can't be updated; add a line item to it.
- A receipt for things that belong under different items: propose one entry at a time, and the next once they've saved it. Things that belong together can be one entry.
- A receipt: read the vendor, the date, what was bought and the total actually paid. Take a receipt as paid in full unless they say otherwise. The total already includes tax and any tip, so set quantity 1, taxable false and gratuity_percent 0, and put the total in price.
- Stages: estimate (their own guess), quote (a vendor's price), booked (committed to), paid (paid in full). Partially paid comes on its own when a payment is less than the price, so a deposit on a booking (price is the full amount) is stage booked with payment_amount set. At stage paid, the price is recorded as paid; leave payment_amount null.
- Ask only for what you can't work out, one or two short questions at a time. The person filling this in is usually who paid. Don't ask about optional details such as due dates or notes unless they come up.
- Never guess a price or an amount: ask.
- When you have what you need, call propose_expense in the same reply. Don't say it's saved; they save it. If they reply to a proposal instead of saving, adjust and propose again.
- Write short, plain messages for a phone screen: no headings, no tables.`;

const PROPOSE_TOOL = {
  name: "propose_expense",
  description:
    "Propose the entry to record. The person sees a summary with a Save button; nothing is saved until they tap it. "
    + "Call this as soon as you know what to record, and again with changes if they reply instead of saving.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "mode", "expense_id", "item", "category", "subcategory", "vendor", "stage", "price", "quantity", "taxable",
      "gratuity_percent", "due_date", "payment_amount", "paid_on", "payer", "method", "notes",
    ],
    properties: {
      mode: {
        type: "string",
        enum: ["line_item", "new", "update"],
        description: "line_item (the default): a new line item under the item expense_id. new: a new item, when no existing item fits. update: change expense_id itself, only when they ask to (and only an item with no line items).",
      },
      expense_id: { type: ["integer", "null"], description: "The existing item's id (the # number in the list) for line_item and update; null for new." },
      item: { type: ["string", "null"], description: "Name of the new item or line item. null for update." },
      category: { type: ["string", "null"], description: "For new: an existing category if one fits, else a new one. null otherwise." },
      subcategory: { type: ["string", "null"], description: "For new: the subcategory, or null." },
      vendor: { type: ["string", "null"], description: "Vendor or shop, spelled like an existing vendor when it is one." },
      stage: { type: "string", enum: ["estimate", "quote", "booked", "partially_paid", "paid"] },
      price: { type: ["number", "null"], description: "Price per unit in dollars (a receipt's total), or null if unknown." },
      quantity: { type: "number", description: "Units at that price; 1 for a receipt total." },
      taxable: { type: "boolean", description: "Add sales tax on top of the price. false when the price already includes it." },
      gratuity_percent: { type: "number", description: "Tip to add on top, in percent; 0 when none or already included." },
      due_date: { type: ["string", "null"], description: "Next payment due, YYYY-MM-DD, or null." },
      payment_amount: { type: ["number", "null"], description: "An amount paid now, below the full price (a deposit). null at stage paid or when nothing was paid." },
      paid_on: { type: ["string", "null"], description: "Date paid, YYYY-MM-DD, when something was paid." },
      payer: { type: ["string", "null"], description: "Who paid, from the payers list, when something was paid." },
      method: { type: ["string", "null"], description: "How it was paid, from the payment methods list, or null." },
      notes: { type: ["string", "null"], description: "Anything worth keeping that has no field, or null." },
    },
  },
};

const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const where = (e) => [e.category, e.subcategory].filter(Boolean).join(" › ") || "Uncategorized";

/** Everything Claude needs to place an expense: items with their line items, categories, vendors. */
export function catalog(expenses, vendors, settings, { who, today }) {
  const open = expenses.filter((e) => e.status !== "cancelled");
  const kids = new Map();
  for (const e of open) if (e.parent_id) (kids.get(e.parent_id) || kids.set(e.parent_id, []).get(e.parent_id)).push(e);
  const lines = [];
  for (const e of open.filter((x) => !x.parent_id)) {
    const list = kids.get(e.id) || [];
    if (list.length) {
      lines.push(`#${e.id} ${e.item} · ${where(e)} · ${STATUS_LABELS[e.status] || e.status} · ${list.length} line item${list.length === 1 ? "" : "s"}:`);
      for (const k of list) {
        lines.push(`    #${k.id} ${k.item}${k.vendor ? ` · ${k.vendor}` : ""} · ${STATUS_LABELS[k.status]} · ${k.priced ? money(k.current) : "no price"}${k.paid ? ` · ${money(k.paid)} paid` : ""}`);
      }
    } else {
      lines.push(`#${e.id} ${e.item} · ${where(e)} · ${STATUS_LABELS[e.status]} · ${e.priced ? money(e.current) : "no price"}${e.paid ? ` · ${money(e.paid)} paid` : ""}${e.vendor ? ` · vendor ${e.vendor}` : ""}`);
    }
  }
  const categories = [...new Set(open.filter((e) => !e.parent_id).map(where))].sort();
  return [
    `Today is ${today}. Filling this in: ${who || "not said"}.`,
    `Payers: ${settings.payers.join(", ")}. Payment methods: ${settings.payment_methods.join(", ")}.`,
    `Categories in use (category › subcategory): ${categories.join("; ") || "none yet"}.`,
    `Vendors: ${vendors.join(", ") || "none yet"}.`,
    "Items (id · name · category › subcategory · stage · price):",
    ...(lines.length ? lines : ["(no items yet)"]),
  ].join("\n");
}

const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const text = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * Check a proposal against the data and turn it into the expense form's fields and a
 * readable summary. Returns { error } for Claude to fix, or { form, summary }.
 */
export function checkProposal(p, expenses, settings) {
  const byId = new Map(expenses.map((e) => [e.id, e]));
  const target = p.expense_id == null ? null : byId.get(Number(p.expense_id));
  if (!STATUSES.includes(p.stage) || p.stage === "cancelled") return { error: `Unknown stage "${p.stage}".` };
  if (p.mode !== "new") {
    if (!target || target.parent_id || target.status === "cancelled") return { error: `#${p.expense_id} isn't an open item in the list. Use an item's id, not a line item's.` };
    if (p.mode === "update" && target.purchases) return { error: `${target.item} has line items, so it can't be updated directly. Use mode line_item.` };
  }
  if (p.mode !== "update" && !text(p.item)) return { error: "Give the item or line item a name." };
  if (p.mode === "new" && !text(p.category)) return { error: "A new item needs a category." };
  if (p.payer && !settings.payers.includes(p.payer)) return { error: `Payer must be one of: ${settings.payers.join(", ")}.` };
  if (p.method && !settings.payment_methods.includes(p.method)) return { error: `Method must be one of: ${settings.payment_methods.join(", ")}.` };
  for (const k of ["due_date", "paid_on"]) if (p[k] && !isDate(p[k])) return { error: `${k} must be YYYY-MM-DD.` };
  for (const k of ["price", "payment_amount"]) if (p[k] != null && !(Number(p[k]) >= 0)) return { error: `${k} can't be negative.` };

  const paid = p.stage === "paid";
  const form = {
    mode: p.mode === "line_item" ? "purchase" : p.mode === "update" ? "update" : "",
    expense_id: target ? String(target.id) : "",
    item: p.mode === "update" ? "" : text(p.item),
    category: p.mode === "new" ? text(p.category) : "",
    subcategory: p.mode === "new" ? text(p.subcategory) : "",
    vendor: text(p.vendor),
    status: p.stage,
    price: p.price == null ? "" : String(p.price),
    units: String(p.quantity > 0 ? p.quantity : 1),
    taxable: p.taxable ? "on" : "",
    gratuity_percent: String(p.gratuity_percent || 0),
    due_date: paid ? "" : p.due_date || "",
    payment_amount: paid || p.payment_amount == null ? "" : String(p.payment_amount),
    paid_on: p.paid_on || "",
    payer: p.payer || "",
    method: p.method || "",
    notes: text(p.notes),
  };

  const summary = [];
  if (p.mode === "new") summary.push(["New item", `${form.item} · ${[form.category, form.subcategory].filter(Boolean).join(" › ")}`]);
  else if (p.mode === "line_item") summary.push(["Line item", `${form.item}, under ${target.item}`]);
  else summary.push(["Update", target.item]);
  if (form.vendor) summary.push(["Vendor", form.vendor]);
  summary.push(["Stage", STATUS_LABELS[p.stage]]);
  if (form.price !== "") {
    const extras = [p.quantity > 1 ? `× ${p.quantity}` : "", p.taxable ? "+ tax" : "", p.gratuity_percent ? `+ ${p.gratuity_percent}% tip` : ""].filter(Boolean);
    summary.push(["Price", [money(form.price), ...extras].join(" ")]);
  }
  if (paid || form.payment_amount) {
    const how = [form.paid_on || "today", form.payer ? `by ${form.payer}` : "", form.method].filter(Boolean).join(", ");
    summary.push(["Paid", `${paid ? "In full" : money(form.payment_amount)} · ${how}`]);
  }
  if (form.due_date) summary.push(["Due", form.due_date]);
  if (form.notes) summary.push(["Notes", form.notes]);
  return { form, summary };
}

/** Light checks on the conversation the browser sends back; the API validates the rest. */
function cleanMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) return null;
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
    if (typeof m.content !== "string" && !Array.isArray(m.content)) return null;
  }
  if (messages[0].role !== "user" || messages[messages.length - 1].role !== "user") return null;
  return answerOpenCalls(messages.map((m) => ({ role: m.role, content: m.content })));
}

const toolCalls = (m) => (m.role === "assistant" && Array.isArray(m.content) ? m.content.filter((b) => b?.type === "tool_use") : []);

/**
 * The API needs every tool call answered at the start of the next message. A proposal
 * that was replied to instead of saved, or a second proposal in the same reply, gets a
 * "not saved" answer here, so the conversation always goes on.
 */
export function answerOpenCalls(messages) {
  return messages.map((m, i) => {
    const before = i > 0 ? toolCalls(messages[i - 1]) : [];
    if (m.role !== "user" || !before.length) return m;
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : [...m.content];
    const answered = new Set(content.filter((b) => b?.type === "tool_result").map((b) => b.tool_use_id));
    const missing = before.filter((c) => !answered.has(c.id))
      .map((c) => ({ type: "tool_result", tool_use_id: c.id, content: "Not saved. They replied instead." }));
    if (!missing.length) return m;
    // Tool results come first in the message.
    const results = content.filter((b) => b?.type === "tool_result");
    const rest = content.filter((b) => b?.type !== "tool_result");
    return { role: "user", content: [...results, ...missing, ...rest] };
  });
}

async function askClaude(env, system, messages) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      // A safety decline is retried on the model Anthropic recommends for it.
      "anthropic-beta": "server-side-fallback-2026-07-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      fallbacks: "default",
      output_config: { effort: "low" },
      cache_control: { type: "ephemeral" },
      system,
      tools: [PROPOSE_TOOL],
      // One proposal per reply: the page shows one entry to save at a time.
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages,
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const why = body?.error?.message || `status ${response.status}`;
    throw Object.assign(new Error(`Claude couldn't answer (${why}).`), { status: response.status });
  }
  return body;
}

/**
 * One turn: send the conversation, check any proposal (telling Claude what's wrong and
 * asking again, a couple of times at most), and return the updated conversation with
 * Claude's reply and, when it made one that checks out, the proposal.
 */
export async function intakeTurn(env, input, ctx) {
  if (!env.ANTHROPIC_API_KEY) {
    return { status: 503, body: { error: "The conversational form isn't set up yet (no ANTHROPIC_API_KEY). Use the plain form for now.", setup: true } };
  }
  const size = JSON.stringify(input?.messages ?? null).length;
  const messages = size <= MAX_BODY_CHARS ? cleanMessages(input?.messages) : null;
  if (!messages) return { status: 400, body: { error: "That conversation is too long or out of order. Start a new one." } };

  const expenses = await listExpenses(env, ctx);
  const vendors = await listVendors(env);
  const who = ctx.settings.payers.includes(input.who) ? input.who : "";
  const system = [
    { type: "text", text: INSTRUCTIONS },
    { type: "text", text: catalog(expenses, vendors, ctx.settings, { who, today: input.today && isDate(input.today) ? input.today : new Date().toISOString().slice(0, 10) }) },
  ];

  for (let attempt = 0; ; attempt++) {
    const reply = await askClaude(env, system, messages);
    messages.push({ role: "assistant", content: reply.content });
    const said = (reply.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
    if (reply.stop_reason === "refusal") {
      return { status: 200, body: { messages, reply: said || "Sorry, I can't help with that one. Try the plain form.", proposal: null, ended: true } };
    }
    const call = (reply.content || []).find((b) => b.type === "tool_use" && b.name === "propose_expense");
    if (!call) return { status: 200, body: { messages, reply: said, proposal: null } };
    const checked = checkProposal(call.input || {}, expenses, ctx.settings);
    if (!checked.error) {
      return { status: 200, body: { messages, reply: said, proposal: { tool_use_id: call.id, form: checked.form, summary: checked.summary } } };
    }
    if (attempt >= MAX_RETRIES) {
      return { status: 200, body: { messages: messages.slice(0, -1), reply: "I couldn't put that entry together. Could you say it another way?", proposal: null } };
    }
    messages.push({ role: "user", content: (reply.content || []).filter((b) => b.type === "tool_use").map((b) => (b.id === call.id
      ? { type: "tool_result", tool_use_id: b.id, is_error: true, content: checked.error }
      : { type: "tool_result", tool_use_id: b.id, is_error: true, content: "One entry at a time." })) });
  }
}
