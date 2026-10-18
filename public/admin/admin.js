// Shared helpers for every control-panel page: the API client, the top bar,
// formatting, dialogs and a tiny element builder. Loaded as a module.

export async function api(path, { method = "GET", body, form } = {}) {
  const init = { method, headers: { "x-wedding": "1" }, credentials: "same-origin" };
  if (form) init.body = form;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  const response = await fetch(path, init);
  let data = null;
  try {
    data = await response.json();
  } catch {
    throw new Error(`The server sent an unexpected reply (${response.status}).`);
  }
  if (response.status === 401) {
    location.href = "/admin/login.html";
    throw new Error("Not signed in.");
  }
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status}).`);
  return data;
}

const moneyFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const moneyRound = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const money = (n, round = false) => (n == null || Number.isNaN(Number(n)) ? "—" : (round ? moneyRound : moneyFmt).format(Number(n)));
export const compactMoney = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}K`;
  return `$${Math.round(v)}`;
};
export const pct = (n) => `${Math.round((Number(n) || 0) * 1000) / 10}%`;
export function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
export const today = () => new Date().toISOString().slice(0, 10);

/** h("div", { class: "x", onclick }, child, "text", [children]) -> Element */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key in node && typeof value !== "string") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function statusPill(status, labels) {
  return h("span", { class: `pill ${status}` }, labels?.[status] || status.replace(/_/g, " "));
}

export function setMsg(node, text, kind = "") {
  node.textContent = text || "";
  node.className = `msg ${kind}`;
}

const PAGES = [
  ["index.html", "Dashboard"],
  ["expenses.html", "Expenses"],
  ["vendors.html", "Vendors"],
  ["guests.html", "Guests"],
  ["seating.html", "Seating"],
  ["runofshow.html", "Run of show"],
  ["reports.html", "Reports"],
  ["settings.html", "Settings"],
];

/** Render the top bar and confirm the session. Resolves to the signed-in user. */
export async function initPage(active) {
  const bar = document.getElementById("topbar");
  const me = await api("/api/auth/me");
  bar.replaceChildren(
    h("span", { class: "brand" }, "Wedding planner"),
    h(
      "nav",
      {},
      PAGES.map(([href, label]) => h("a", { href: `/admin/${href}`, class: href === active ? "active" : "" }, label))
    ),
    h(
      "span",
      { class: "who" },
      h("span", {}, me.user.email),
      h("a", { class: "btn small", href: "/", target: "_blank", rel: "noopener" }, "Website ↗"),
      h("a", { class: "btn small", href: "/rsvp/", target: "_blank", rel: "noopener" }, "RSVP page ↗"),
      h(
        "button",
        {
          class: "link",
          onclick: async () => {
            await api("/api/auth/logout", { method: "POST" });
            location.href = "/admin/login.html";
          },
        },
        "Sign out"
      )
    )
  );
  return me.user;
}

/** Open a modal dialog. `build(close)` returns the body. Resolves when closed. */
export function openDialog(title, build, { actions = [] } = {}) {
  return new Promise((resolve) => {
    const dialog = h("dialog");
    const close = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.append(
      h("div", { class: "dlg-head" }, h("h2", {}, title), ...actions, h("button", { class: "small", onclick: () => close(null) }, "Close")),
      h("div", { class: "dlg-body" }, build(close))
    );
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      close(null);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Read a form into a plain object; checkboxes become booleans. */
export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === "checkbox") out[el.name] = el.checked;
    else if (el.type === "radio") {
      if (el.checked) out[el.name] = el.value;
    } else if (el.type !== "file") out[el.name] = el.value;
  }
  return out;
}

/** A labelled input. opts: { type, value, options: [[value,label]], step, placeholder, list } */
export function field(label, name, opts = {}) {
  let control;
  if (opts.options) {
    control = h(
      "select",
      { name },
      opts.options.map(([value, text]) => h("option", { value, selected: String(value) === String(opts.value ?? "") }, text))
    );
  } else if (opts.type === "textarea") {
    control = h("textarea", { name, placeholder: opts.placeholder || "" });
    control.value = opts.value ?? "";
  } else {
    control = h("input", {
      name,
      type: opts.type || "text",
      step: opts.step,
      min: opts.min,
      placeholder: opts.placeholder,
      list: opts.list,
      required: opts.required,
    });
    control.value = opts.value ?? "";
  }
  if (opts.oninput) control.addEventListener("input", opts.oninput);
  if (opts.onchange) control.addEventListener("change", opts.onchange);
  return h("label", { class: "field", style: opts.wide ? "grid-column: 1 / -1" : null }, label, control);
}

export function check(label, name, checked, onchange) {
  const box = h("input", { type: "checkbox", name, checked: Boolean(checked) });
  if (onchange) box.addEventListener("change", onchange);
  return h("label", { class: "check" }, box, label);
}

/** One floating tooltip shared by every chart on the page. */
let tooltipNode = null;
export function showTooltip(event, title, rows) {
  if (!tooltipNode) {
    tooltipNode = h("div", { class: "tooltip" });
    document.body.append(tooltipNode);
  }
  tooltipNode.replaceChildren(
    h("div", { class: "t-title" }, title),
    // Spread: replaceChildren() turns an array argument into the text "[object …]".
    ...rows.map(([label, value]) => h("div", { class: "t-row" }, h("span", {}, label), h("b", {}, value)))
  );
  tooltipNode.hidden = false;
  const pad = 14;
  const { innerWidth, innerHeight } = window;
  const rect = tooltipNode.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + rect.width > innerWidth - 8) x = event.clientX - rect.width - pad;
  if (y + rect.height > innerHeight - 8) y = event.clientY - rect.height - pad;
  tooltipNode.style.left = `${Math.max(8, x)}px`;
  tooltipNode.style.top = `${Math.max(8, y)}px`;
}
export function hideTooltip() {
  if (tooltipNode) tooltipNode.hidden = true;
}
