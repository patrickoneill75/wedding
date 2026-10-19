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

import { localToday, STATUSES, STATUS_LABELS } from "./calc.js";
import { listExpenses, listVendors } from "./store.js";

/** Which of the payers a signed-in person is, by their Google name or email ("" if neither fits). */
export function payerFor(user, payers) {
  const words = String(user?.name || "").toLowerCase().split(/\s+/).filter(Boolean);
  const local = String(user?.email || "").split("@")[0].toLowerCase();
  return payers.find((p) => p.toLowerCase() === words[0])
    || payers.find((p) => words.includes(p.toLowerCase()))
    || payers.find((p) => p.length > 2 && local.includes(p.toLowerCase()))
    || "";
}

const MODEL = "claude-sonnet-5-5";
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
- Only change an existing entry (mode update) when they clearly ask to: "the florist's quote went up to $2,400", "mark the DJ paid", "make the books $25 each". Update an item on its own or a single line item, by its id; an item that has line items can't be updated itself. Fields you leave null keep what's there.
- A receipt for things that belong under different items: propose one entry at a time, and the next once they've saved it. Things that belong together can be one entry.
- A receipt: read the vendor, the date, what was bought and the total actually paid. Take a receipt as paid in full unless they say otherwise. The total already includes tax and any tip, so set quantity 1, taxable false and gratuity_percent 0, and put the total in price.
- Stages: estimate (their own guess), quote (a vendor's price), booked (committed to), paid (paid in full). Partially paid comes on its own when a payment is less than the price, so a deposit on a booking (price is the full amount) is stage booked with payment_amount set. At stage paid, the price is recorded as paid; leave payment_amount null.
- Ask only for what you can't work out, one or two short questions at a time. Never ask who paid: they're signed in, so it's the person filling this in unless they say someone else paid. Don't ask about optional details such as due dates or notes unless they come up.
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
      "gratuity_percent", "due_date", "payment_amount", "paid_on", "payer", "notes",
    ],
    properties: {
      mode: {
        type: "string",
        enum: ["line_item", "new", "update"],
        description: "line_item (the default): a new line item under the item expense_id. new: a new item, when no existing item fits. update: change the item or line item expense_id itself, only when they ask to.",
      },
      expense_id: { type: ["integer", "null"], description: "The # number from the list: the item to add a line item under (line_item), or the item or line item to change (update); null for new." },
      item: { type: ["string", "null"], description: "Name of the new item or line item. null for update." },
      category: { type: ["string", "null"], description: "For new: an existing category if one fits, else a new one. null otherwise." },
      subcategory: { type: ["string", "null"], description: "For new: the subcategory, or null." },
      vendor: { type: ["string", "null"], description: "Vendor or shop, spelled like an existing vendor when it is one." },
      stage: { type: "string", enum: ["estimate", "quote", "booked", "partially_paid", "paid"] },
      price: { type: ["number", "null"], description: "Price per unit in dollars (a receipt's total), or null if unknown. For an update of a per-guest item, the price per guest." },
      quantity: { type: ["number", "null"], description: "Units at that price; 1 for a receipt total. For an update, null to keep the item's units as they are." },
      taxable: { type: "boolean", description: "Add sales tax on top of the price. false when the price already includes it." },
      gratuity_percent: { type: "number", description: "Tip to add on top, in percent; 0 when none or already included." },
      due_date: { type: ["string", "null"], description: "Next payment due, YYYY-MM-DD, or null." },
      payment_amount: { type: ["number", "null"], description: "An amount paid now, below the full price (a deposit). null at stage paid or when nothing was paid." },
      paid_on: { type: ["string", "null"], description: "Date paid, YYYY-MM-DD, when something was paid." },
      payer: { type: ["string", "null"], description: "Who paid, from the payers list, when something was paid." },
      notes: { type: ["string", "null"], description: "Anything worth keeping that has no field, or null." },
    },
  },
};

const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const where = (e) => [e.category, e.subcategory].filter(Boolean).join(" › ") || "Uncategorized";

/**
 * An item's price as Claude should read it: per guest (or per unit) and the total, plus
 * tax and tip, so an update to "$85 a head" isn't mistaken for a lump sum.
 */
function priceText(e) {
  if (!e.priced) return "no price";
  const extras = [e.taxable ? "+ tax" : "", Number(e.gratuity_rate) > 0 ? `+ ${Math.round(Number(e.gratuity_rate) * 1000) / 10}% tip` : ""].filter(Boolean).join(" ");
  const each = e.pricing === "variable"
    ? `${money(e.unit_cost)} per guest × ${e.quantity}`
    : Number(e.quantity) !== 1 ? `${money(e.unit_cost)} × ${e.quantity}` : "";
  return [each ? `${each} = ${money(e.current)}` : money(e.current), extras].filter(Boolean).join(" ");
}

/** Everything Claude needs to place an expense: items with their line items, categories, vendors. */
export function catalog(expenses, vendors, settings, { who, signedIn, today }) {
  const open = expenses.filter((e) => e.status !== "cancelled");
  const kids = new Map();
  for (const e of open) if (e.parent_id) (kids.get(e.parent_id) || kids.set(e.parent_id, []).get(e.parent_id)).push(e);
  const lines = [];
  for (const e of open.filter((x) => !x.parent_id)) {
    const list = kids.get(e.id) || [];
    if (list.length) {
      lines.push(`#${e.id} ${e.item} · ${where(e)} · ${STATUS_LABELS[e.status] || e.status} · ${list.length} line item${list.length === 1 ? "" : "s"}:`);
      for (const k of list) {
        lines.push(`    #${k.id} ${k.item}${k.vendor ? ` · ${k.vendor}` : ""} · ${STATUS_LABELS[k.status]} · ${priceText(k)}${k.paid ? ` · ${money(k.paid)} paid` : ""}`);
      }
    } else {
      lines.push(`#${e.id} ${e.item} · ${where(e)} · ${STATUS_LABELS[e.status]} · ${priceText(e)}${e.paid ? ` · ${money(e.paid)} paid` : ""}${e.vendor ? ` · vendor ${e.vendor}` : ""}`);
    }
  }
  const categories = [...new Set(open.filter((e) => !e.parent_id).map(where))].sort();
  return [
    `Today is ${today}. Signed in and filling this in: ${who || "not said"}${signedIn ? ` (${signedIn})` : ""}.`
      + (who ? ` Unless they say someone else paid, ${who} paid: set payer to ${who} and don't ask.` : ""),
    `Payers: ${settings.payers.join(", ")}.`,
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
export function checkProposal(p, expenses, settings, who = "") {
  const byId = new Map(expenses.map((e) => [e.id, e]));
  const target = p.expense_id == null ? null : byId.get(Number(p.expense_id));
  if (!STATUSES.includes(p.stage) || p.stage === "cancelled") return { error: `Unknown stage "${p.stage}".` };
  if (p.mode !== "new") {
    if (!target || target.status === "cancelled") return { error: `#${p.expense_id} isn't an open item or line item in the list.` };
    if (p.mode === "line_item" && target.parent_id) return { error: `#${target.id} is a line item. Add the line item under its item, #${target.parent_id}.` };
    if (p.mode === "update" && target.purchases) return { error: `${target.item} has line items, so it can't be updated directly. Update one of its line items, or add one.` };
  }
  if (p.mode !== "update" && !text(p.item)) return { error: "Give the item or line item a name." };
  if (p.mode === "new" && !text(p.category)) return { error: "A new item needs a category." };
  if (p.payer && !settings.payers.includes(p.payer)) return { error: `Payer must be one of: ${settings.payers.join(", ")}.` };
  for (const k of ["due_date", "paid_on"]) if (p[k] && !isDate(p[k])) return { error: `${k} must be YYYY-MM-DD.` };
  for (const k of ["price", "payment_amount"]) if (p[k] != null && !(Number(p[k]) >= 0)) return { error: `${k} can't be negative.` };
  const update = p.mode === "update";

  const paid = p.stage === "paid";
  // Whoever is signed in paid, unless Claude was told otherwise.
  const payer = p.payer || (paid || p.payment_amount != null ? who : "");
  const form = {
    mode: p.mode === "line_item" ? "purchase" : p.mode === "update" ? "update" : "",
    // A new item never carries an id, so it can't save over the item it was named after.
    expense_id: target && p.mode !== "new" ? String(target.id) : "",
    item: p.mode === "update" ? "" : text(p.item),
    category: p.mode === "new" ? text(p.category) : "",
    subcategory: p.mode === "new" ? text(p.subcategory) : "",
    vendor: text(p.vendor),
    status: p.stage,
    price: p.price == null ? "" : String(p.price),
    // An update without a quantity keeps the item's units (a per-guest count stays one).
    units: update && !(p.quantity > 0) ? "" : String(p.quantity > 0 ? p.quantity : 1),
    taxable: p.taxable ? "on" : "",
    gratuity_percent: String(p.gratuity_percent || 0),
    due_date: paid ? "" : p.due_date || "",
    payment_amount: paid || !(Number(p.payment_amount) > 0) ? "" : String(p.payment_amount),
    paid_on: p.paid_on || "",
    payer: payer || "",
    notes: text(p.notes),
  };

  const summary = [];
  if (p.mode === "new") summary.push(["New item", `${form.item} · ${[form.category, form.subcategory].filter(Boolean).join(" › ")}`]);
  else if (p.mode === "line_item") summary.push(["Line item", `${form.item}, under ${target.item}`]);
  else summary.push(["Update", target.parent_id && byId.get(target.parent_id) ? `${target.item}, under ${byId.get(target.parent_id).item}` : target.item]);
  if (form.vendor) summary.push(["Vendor", form.vendor]);
  summary.push(["Stage", STATUS_LABELS[p.stage]]);
  if (form.price !== "") {
    // An update keeps the item's tax, tip and units unless it adds to them.
    const taxed = p.taxable || (update && target.taxable);
    const tip = p.gratuity_percent || (update ? Math.round(Number(target.gratuity_rate || 0) * 1000) / 10 : 0);
    const per = update && target.pricing === "variable" ? `per guest × ${target.quantity}` : "";
    const units = form.units !== "" ? Number(form.units) : update ? Number(target.quantity) : 1;
    const extras = [per || (units > 1 ? `× ${units}` : ""), taxed ? "+ tax" : "", tip ? `+ ${tip}% tip` : ""].filter(Boolean);
    summary.push(["Price", [money(form.price), ...extras].join(" ")]);
  }
  if (paid || form.payment_amount) {
    const how = [form.paid_on || "today", form.payer ? `by ${form.payer}` : ""].filter(Boolean).join(", ");
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

/**
 * Ask Claude, streaming: each piece of reply text goes to onText as it arrives, and the
 * whole reply comes back at the end, assembled from the stream's events.
 */
async function streamClaude(env, system, messages, onText) {
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
      stream: true,
      fallbacks: "default",
      // No thinking: placing an expense doesn't need it, and the reply starts sooner.
      thinking: { type: "between_tools" },
      output_config: { effort: "low" },
      cache_control: { type: "ephemeral" },
      system,
      tools: [PROPOSE_TOOL],
      // One proposal per reply: the page shows one entry to save at a time.
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages,
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(`Claude couldn't answer (${body?.error?.message || `status ${response.status}`}).`);
  }
  const content = [];
  const json = [];
  let stopReason = null;
  for await (const event of serverSentEvents(response.body)) {
    if (event.type === "content_block_start") {
      content[event.index] = { ...event.content_block };
      if (event.content_block.type === "tool_use") {
        json[event.index] = "";
        content[event.index].input = {};
      }
    } else if (event.type === "content_block_delta") {
      const block = content[event.index];
      const d = event.delta;
      if (d.type === "text_delta") {
        block.text += d.text;
        onText(d.text);
      } else if (d.type === "input_json_delta") json[event.index] += d.partial_json;
      else if (d.type === "thinking_delta") block.thinking += d.thinking;
      else if (d.type === "signature_delta") block.signature = d.signature;
    } else if (event.type === "content_block_stop") {
      if (json[event.index] !== undefined) {
        try {
          content[event.index].input = json[event.index] ? JSON.parse(json[event.index]) : {};
        } catch {
          content[event.index].input = {};
        }
      }
    } else if (event.type === "message_delta") {
      stopReason = event.delta?.stop_reason ?? stopReason;
    } else if (event.type === "error") {
      throw new Error(`Claude couldn't answer (${event.error?.message || "stream error"}).`);
    }
  }
  return { content: content.filter(Boolean), stop_reason: stopReason };
}

/** The `data:` of each server-sent event, parsed. */
async function* serverSentEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const chunks = buffer.split(/\r?\n\r?\n/);
    // The last piece may be an event still arriving.
    buffer = done ? "" : chunks.pop();
    for (const chunk of chunks) {
      const data = chunk.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      try {
        yield JSON.parse(data);
      } catch {
        /* not JSON: skip */
      }
    }
    if (done) return;
  }
}

/**
 * One turn. Errors found before Claude is asked come back as { status, body }; otherwise
 * { stream }: newline-delimited JSON events for the page --
 *   { type: "text", text }     a piece of Claude's reply, as it's written
 *   { type: "break" }          Claude is starting over (a proposal didn't check out)
 *   { type: "done", messages, reply, proposal }   the conversation to send next time,
 *                              and the checked proposal (form fields + summary), if any
 *   { type: "error", error }
 * A proposal that doesn't check out goes back to Claude with what's wrong, a couple of
 * times at most.
 */
export async function intakeTurn(env, input, ctx, user = null) {
  if (!env.ANTHROPIC_API_KEY) {
    return { status: 503, body: { error: "The conversational form isn't set up yet (no ANTHROPIC_API_KEY). Use the plain form for now.", setup: true } };
  }
  const size = JSON.stringify(input?.messages ?? null).length;
  const messages = size <= MAX_BODY_CHARS ? cleanMessages(input?.messages) : null;
  if (!messages) return { status: 400, body: { error: "That conversation is too long or out of order. Start a new one." } };

  const expenses = await listExpenses(env, ctx);
  const vendors = await listVendors(env);
  // Who is filling this in: the signed-in person, else the "I'm" picked on the page.
  const who = payerFor(user, ctx.settings.payers) || (ctx.settings.payers.includes(input.who) ? input.who : "");
  const system = [
    { type: "text", text: INSTRUCTIONS },
    { type: "text", text: catalog(expenses, vendors, ctx.settings, { who, signedIn: user?.name || "", today: input.today && isDate(input.today) ? input.today : localToday(ctx.settings.time_zone) }) },
  ];

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (event) => writer.write(encoder.encode(`${JSON.stringify(event)}\n`));
  (async () => {
    try {
      for (let attempt = 0; ; attempt++) {
        if (attempt) await send({ type: "break" });
        const reply = await streamClaude(env, system, messages, (text) => send({ type: "text", text }));
        messages.push({ role: "assistant", content: reply.content });
        const said = reply.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
        if (reply.stop_reason === "refusal") {
          const sorry = "Sorry, I can't help with that one. Try the plain form.";
          if (!said) await send({ type: "text", text: sorry });
          await send({ type: "done", messages, reply: said || sorry, proposal: null, ended: true });
          break;
        }
        const call = reply.content.find((b) => b.type === "tool_use" && b.name === "propose_expense");
        if (!call) {
          await send({ type: "done", messages, reply: said, proposal: null });
          break;
        }
        const checked = checkProposal(call.input || {}, expenses, ctx.settings, who);
        if (!checked.error) {
          await send({ type: "done", messages, reply: said, proposal: { tool_use_id: call.id, form: checked.form, summary: checked.summary } });
          break;
        }
        if (attempt >= MAX_RETRIES) {
          const giveUp = "I couldn't put that entry together. Could you say it another way?";
          await send({ type: "break" });
          await send({ type: "text", text: giveUp });
          await send({ type: "done", messages: messages.slice(0, -1), reply: giveUp, proposal: null });
          break;
        }
        messages.push({ role: "user", content: reply.content.filter((b) => b.type === "tool_use").map((b) => (b.id === call.id
          ? { type: "tool_result", tool_use_id: b.id, is_error: true, content: checked.error }
          : { type: "tool_result", tool_use_id: b.id, is_error: true, content: "One entry at a time." })) });
      }
    } catch (error) {
      await send({ type: "error", error: error.message || String(error) });
    } finally {
      await writer.close();
    }
  })();
  return { stream: readable };
}
