// The finance page: inputs, charts, the year table, scenarios and saving to Drive.
// All the math is in engine.js; this file only draws and edits. Numbers are sent only
// to this site's /api/personal/ routes, in request bodies, and never logged.

import { initPage, h, showTooltip, hideTooltip, openDialog } from "/admin/admin.js";
import * as E from "./engine.js";
import { bandChart, compact, stackedArea, stackedBars } from "./charts.js";

const $ = (id) => document.getElementById(id);
const me = await initPage("personal/");

/* --------------------------------------------------------------------- state -- */

const state = {
  model: null,
  version: null,
  link: { linked: false },
  compare: "",
  overrides: {},
  real: readPref("fin-real", "1") === "1",
  result: null,
  resultB: null,
  dirty: false,
  saving: false,
  saveAgain: false,
  tab: "people",
  expanded: new Set(),
  mc: null,
};
const scenario = () => state.model.scenarios.find((x) => x.id === state.model.active) || state.model.scenarios[0];
const inputs = () => scenario().inputs;

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

/* ----------------------------------------------------------------- formatting -- */

const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const money = (n) => (n == null || !Number.isFinite(n) ? "—" : fmt.format(Math.round(n)));
const pctText = (n, d = 1) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(d)}%`);
const shown = (v, y) => (state.real ? v / (y?.deflator || 1) : v);
const sum = (o) => Object.values(o || {}).reduce((t, v) => t + (Number(v) || 0), 0);
const monthName = (ym) => {
  const i = E.monthIndex(ym);
  return i == null ? ym : new Date(Math.floor(i / 12), i % 12, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
};

/* ---------------------------------------------------------------- server calls -- */

async function call(method, path, body) {
  const init = { method, headers: { "x-wedding": "1" }, credentials: "same-origin", cache: "no-store" };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  const r = await fetch(path, init);
  let data = null;
  try {
    data = await r.json();
  } catch {}
  if (r.status === 401) {
    location.href = "/admin/login.html?next=%2Fadmin%2Fpersonal%2F";
    throw new Error("Not signed in.");
  }
  return { status: r.status, data: data || {} };
}

const canSave = () => state.link.linked && state.link.folder;

function setStatus(text, kind = "") {
  const n = $("saveStatus");
  n.textContent = text;
  n.className = `msg ${kind}`;
}

async function load() {
  setStatus("Loading…");
  const r = await call("GET", "/api/personal/model");
  if (r.status !== 200) {
    setStatus(r.data.error || `Couldn't load (${r.status}).`, "err");
    state.model = E.defaultModel();
  } else {
    state.link = { linked: r.data.linked, email: r.data.email, folder: r.data.folder, has_file: r.data.has_file, linked_by: r.data.linked_by };
    state.version = r.data.version;
    state.model = r.data.model ? E.normalizeModel(r.data.model) : E.defaultModel();
    if (!r.data.model) state.dirty = true;
    if (!canSave()) setStatus(state.link.linked ? "Not saved yet: pick a Drive folder in Settings." : "Not saved: link Google Drive in Settings.", "err");
    else setStatus(r.data.model ? "Loaded from Drive." : "New model. It saves to Drive once you change something.", "ok");
  }
  renderAll();
}

async function save(force = false) {
  if (!canSave()) {
    setStatus(state.link.linked ? "Not saved: pick a Drive folder in Settings." : "Not saved: link Google Drive in Settings.", "err");
    return;
  }
  if (state.saving) {
    state.saveAgain = true;
    return;
  }
  state.saving = true;
  setStatus("Saving…");
  state.model.savedAt = new Date().toISOString();
  state.model.savedBy = me.email;
  try {
    const r = await call("PUT", "/api/personal/model", { model: state.model, base: state.version, force });
    if (r.status === 200) {
      state.version = r.data.version;
      state.dirty = false;
      state.link.has_file = true;
      setStatus(`Saved to Drive at ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`, "ok");
    } else if (r.status === 409 && r.data.conflict) {
      await resolveConflict(r.data);
    } else {
      setStatus(`Couldn't save: ${r.data.error || r.status}`, "err");
    }
  } catch (error) {
    setStatus(`Couldn't save: ${error.message}`, "err");
  } finally {
    state.saving = false;
    if (state.saveAgain) {
      state.saveAgain = false;
      save();
    }
  }
}

async function resolveConflict(theirs) {
  const who = theirs.model?.savedBy || "someone";
  const when = theirs.model?.savedAt ? new Date(theirs.model.savedAt).toLocaleString() : "recently";
  setStatus("Not saved: the file changed in Drive.", "err");
  const choice = await openDialog("The file changed while you had it open", (close) => h("div", {},
    h("p", {}, `${who} saved changes at ${when}, after you opened this page. Choose which version to keep.`),
    h("div", { class: "row" },
      h("button", { onclick: () => close("theirs") }, "Use their version (lose my unsaved changes)"),
      h("button", { class: "primary", onclick: () => close("mine") }, "Keep mine (replace theirs)"))));
  if (choice === "theirs") {
    state.model = E.normalizeModel(theirs.model);
    state.version = theirs.version;
    state.dirty = false;
    setStatus("Loaded their version.", "ok");
    renderAll();
  } else if (choice === "mine") {
    state.saving = false;
    await save(true);
  }
}

let saveTimer = null;
let calcTimer = null;
/** Something changed: recalculate soon, and save to Drive two seconds after the typing stops. */
function changed({ rerender = false } = {}) {
  state.dirty = true;
  if (canSave()) setStatus("Unsaved changes…");
  clearTimeout(calcTimer);
  calcTimer = setTimeout(() => {
    recompute();
    if (rerender) renderTab();
  }, rerender ? 0 : 150);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(), 2000);
}
addEventListener("beforeunload", (e) => {
  if (state.dirty && canSave()) {
    e.preventDefault();
    e.returnValue = "";
  }
});

/* ------------------------------------------------------------------ the shell -- */

function renderAll() {
  renderHeader();
  recompute();
  renderTabs();
  renderTab();
}

function renderHeader() {
  const sel = $("scenarioPick");
  sel.replaceChildren(...state.model.scenarios.map((x) => h("option", { value: x.id, selected: x.id === state.model.active }, x.name)));
  const cmp = $("comparePick");
  cmp.replaceChildren(h("option", { value: "" }, "Compare with: none"), ...state.model.scenarios.filter((x) => x.id !== state.model.active).map((x) => h("option", { value: x.id, selected: x.id === state.compare }, `Compare with: ${x.name}`)));
  $("realToggle").checked = state.real;
  $("driveBanner").hidden = Boolean(canSave());
  $("driveBannerText").textContent = state.link.linked ? "Google Drive is linked. Pick a folder in Settings to start saving." : "Nothing here is saved yet. Link Google Drive in Settings, and your model saves there automatically.";
}

$("scenarioPick").addEventListener("change", (e) => {
  state.model.active = e.target.value;
  if (state.compare === state.model.active) state.compare = "";
  renderHeader();
  recompute();
  renderTab();
  changed();
});
$("comparePick").addEventListener("change", (e) => {
  state.compare = e.target.value;
  recompute();
});
$("realToggle").addEventListener("change", (e) => {
  state.real = e.target.checked;
  writePref("fin-real", state.real ? "1" : "0");
  renderResults();
});
$("driveBannerBtn").addEventListener("click", () => openTab("settings"));

/* ------------------------------------------------------------------ sliders -- */

const SLIDERS = [
  { key: "returnDelta", label: "Investment return", min: -3, max: 3, step: 0.25, toValue: (v) => v / 100, fromValue: (v) => v * 100, base: () => 0, text: (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)} points` },
  { key: "inflation", label: "Inflation", min: 0, max: 8, step: 0.1, toValue: (v) => v / 100, fromValue: (v) => v * 100, base: () => Number(inputs().assumptions.inflation) || 0, text: (v) => pctText(v) },
  { key: "salaryGrowth", label: "Yearly raises", min: 0, max: 8, step: 0.1, toValue: (v) => v / 100, fromValue: (v) => v * 100, base: () => Number(inputs().assumptions.salaryGrowth) || 0, text: (v) => pctText(v) },
  { key: "housePriceMult", label: "House price", min: 50, max: 200, step: 5, toValue: (v) => v / 100, fromValue: (v) => v * 100, base: () => 1, text: (v) => `${Math.round(v * 100)}% of plan` },
];
function renderSliders() {
  const box = $("sliders");
  box.replaceChildren(...SLIDERS.map((sl) => {
    const value = state.overrides[sl.key] ?? sl.base();
    const out = h("b", {}, sl.text(value));
    const input = h("input", { type: "range", min: sl.min, max: sl.max, step: sl.step, "aria-label": sl.label });
    input.value = sl.fromValue(value);
    input.addEventListener("input", () => {
      state.overrides[sl.key] = sl.toValue(Number(input.value));
      out.textContent = sl.text(state.overrides[sl.key]);
      $("sliderNote").hidden = false;
      clearTimeout(calcTimer);
      calcTimer = setTimeout(recompute, 30);
    });
    return h("label", { class: "slider" }, h("span", {}, sl.label, " ", out), input);
  }));
  $("sliderNote").hidden = !Object.keys(state.overrides).length;
}
$("sliderReset").addEventListener("click", () => {
  state.overrides = {};
  renderSliders();
  recompute();
});

/* -------------------------------------------------------------- calculating -- */

function recompute() {
  const t = performance.now();
  state.result = E.simulate(inputs(), { overrides: state.overrides });
  const b = state.model.scenarios.find((x) => x.id === state.compare);
  state.resultB = b ? E.simulate(b.inputs, { overrides: state.overrides }) : null;
  state.calcMs = performance.now() - t;
  renderResults();
}

/* ------------------------------------------------------------------ results -- */

const GROUP_COLORS = {
  cash: "var(--series-1)", brokerage: "var(--series-3)", traditional: "var(--series-7)", roth: "var(--series-5)",
  hsa: "var(--series-6)", college: "var(--series-4)", homeValue: "var(--series-2)", cars: "var(--stage-1)",
  mortgage: "var(--series-8)", carLoans: "color-mix(in srgb, var(--series-8) 65%, var(--page))", debts: "color-mix(in srgb, var(--series-8) 40%, var(--page))", overdrawn: "var(--bad)",
};
const MARKER_COLORS = { wedding: "var(--series-5)", house: "var(--series-2)", kid: "var(--series-4)", car: "var(--stage-2)", debt: "var(--series-3)", retire: "var(--series-7)", ss: "var(--series-7)", fi: "var(--good)", out: "var(--bad)", event: "var(--text-muted)" };

function renderResults() {
  const r = state.result;
  if (!r) return;
  renderSummary(r);
  renderSliders();
  renderNetWorth(r);
  renderCashFlow(r);
  renderChecks(r);
  renderTable(r);
  renderMilestones(r);
  if (state.tab === "house" || state.tab === "debts" || state.tab === "retirement") renderTabResults();
}

function tile(label, value, note, kind = "") {
  return h("div", { class: `tile ${kind}` }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), note ? h("div", { class: "note" }, note) : null);
}

function renderSummary(r) {
  const s = r.summary;
  $("summary").replaceChildren(
    tile("Net worth today", money(s.netWorthToday)),
    tile("Net worth at retirement", money(s.netWorthAtRetirement), `In today's dollars, ${s.retirementYear}`),
    tile("Monthly surplus this year", money(s.monthlySurplus), "Take-home pay after spending and debt minimums", s.monthlySurplus < 0 ? "bad" : ""),
    tile("Savings rate", pctText(s.savingsRate, 0), "Saved, plus employer money and extra debt payments, out of gross pay"),
    tile("Emergency fund", `${s.emergencyMonths.toFixed(1)} months`, `Target ${inputs().settings.emergencyMonths} months`, s.emergencyMonths < Number(inputs().settings.emergencyMonths) ? "warn" : ""),
    tile("Buy the house", s.houseYear ?? (inputs().house.enabled ? "Not before 95" : "Off"), inputs().house.enabled ? (inputs().house.mode === "auto" ? "When the fund reaches the target" : "In the year you picked") : ""),
    tile("Debts paid off", s.debtFreeYear ?? (r.summary.debts.length ? "Not yet" : "None"), "Not counting the mortgage or car loans"),
    tile("Financially independent", s.fiYear ?? "Not reached", `Savings × ${pctText(Number(inputs().settings.fiRate) || 0.04, 0)} cover a year of spending`),
    tile("Money lasts to 95?", s.lasts ? "Yes" : `Runs out ${s.runsOutYear}`, s.lasts ? `Through ${s.endYear}` : "See Things to check", s.lasts ? "good" : "bad"),
  );
}

function yearTooltip(r, idx, ev, extra = []) {
  const y = r.years[idx];
  if (!y) return;
  const ppl = inputs().people;
  const ages = ppl.map((p, n) => `${p.name} ${y.ages[n]}`).join(", ");
  const income = y.income.salary + y.income.bonus + y.income.side + y.income.ss + y.income.windfall;
  const spending = sum(y.housing) + sum(y.cars) + sum(y.kids) + sum(y.categories) + y.pets + sum(y.health) + y.events;
  const ms = r.milestones.filter((m) => m.year === y.year).map((m) => m.label);
  showTooltip(ev, `${y.year}${ages ? ` · ${ages}` : ""}`, [
    ["Net worth", money(shown(y.netWorth, y))],
    ["Income", money(shown(income, y))],
    ["Taxes", money(shown(y.taxes.total, y))],
    ["Spending", money(shown(spending, y))],
    ["Debt payments", money(shown(y.debt.payment + y.debt.extra, y))],
    ["Saved", money(shown(sum(y.savings), y))],
    ...(y.unfunded > 0 ? [["Not covered", money(shown(y.unfunded, y))]] : []),
    ...extra,
    ...ms.map((m) => ["", m]),
  ]);
}

function renderNetWorth(r) {
  const labels = r.years.map((y) => y.year);
  const g = (key) => r.years.map((y) => shown(Math.max(0, y.byGroup?.[key] || 0), y));
  const groups = ["cash", "brokerage", "traditional", "roth", "hsa", "college"];
  const up = groups.map((k) => ({ label: E.GROUP_LABELS[k], color: GROUP_COLORS[k], values: g(k) })).filter((x) => x.values.some((v) => v > 0));
  up.push({ label: "Home value", color: GROUP_COLORS.homeValue, values: g("homeValue") }, { label: "Cars", color: GROUP_COLORS.cars, values: g("cars") });
  const down = [
    { label: "Mortgage", color: GROUP_COLORS.mortgage, values: g("mortgage") },
    { label: "Car loans", color: GROUP_COLORS.carLoans, values: g("carLoans") },
    { label: "Student and other loans", color: GROUP_COLORS.debts, values: g("debts") },
    { label: "Overdrawn", color: GROUP_COLORS.overdrawn, values: r.years.map((y) => shown(Math.max(0, -(y.byGroup?.cash || 0)), y)) },
  ].filter((x) => x.values.some((v) => v > 0));
  const filteredUp = up.filter((x) => x.values.some((v) => v > 0));
  const line = { label: "Net worth", values: r.years.map((y) => shown(y.netWorth, y)) };
  let compare = null;
  const rb = state.resultB;
  if (rb) {
    const byYear = new Map(rb.years.map((y) => [y.year, shown(y.netWorth, y)]));
    compare = { label: `Net worth: ${state.model.scenarios.find((x) => x.id === state.compare)?.name}`, values: labels.map((yy) => byYear.get(yy) ?? null).map((v, i, a) => v ?? a[i - 1] ?? 0) };
  }
  const markers = r.milestones.filter((m) => m.kind !== "event" && m.kind !== "ss").map((m) => ({ index: labels.indexOf(m.year), label: `${monthName(m.month)}: ${m.label}`, color: MARKER_COLORS[m.kind] })).filter((m) => m.index >= 0);
  stackedArea($("nwChart"), {
    labels, up: filteredUp, down, line, compare, markers,
    onHover: (i, ev) => yearTooltip(r, i, ev, compare ? [["Compared scenario", money(compare.values[i])]] : []),
    onLeave: hideTooltip,
  });
  $("nwNote").textContent = `${state.real ? "In today's dollars" : "In future dollars"}. Hover or tap a year for details. Dots mark milestones. Calculated in ${Math.round(state.calcMs || 0)} ms.`;
}

function renderCashFlow(r) {
  const labels = r.years.map((y) => y.year);
  const v = (f) => r.years.map((y) => shown(f(y), y));
  stackedBars($("cfChart"), {
    labels,
    series: [
      { label: "Taxes", color: "var(--series-8)", values: v((y) => y.taxes.total) },
      { label: "Housing", color: "var(--series-2)", values: v((y) => sum(y.housing)) },
      { label: "Cars", color: "var(--stage-2)", values: v((y) => sum(y.cars)) },
      { label: "Kids", color: "var(--series-4)", values: v((y) => sum(y.kids)) },
      { label: "Other spending", color: "var(--series-5)", values: v((y) => sum(y.categories) + y.pets + sum(y.health) + y.events) },
      { label: "Debt", color: "var(--series-7)", values: v((y) => y.debt.payment + y.debt.extra) },
      { label: "Savings", color: "var(--series-3)", values: v((y) => sum(y.savings)) },
    ],
    line: { label: "Income, with employer money", values: v((y) => y.income.salary + y.income.bonus + y.income.side + y.income.ss + y.income.employer + y.income.windfall) },
    onHover: (i, ev) => yearTooltip(r, i, ev),
    onLeave: hideTooltip,
  });
}

function renderMilestones(r) {
  $("milestones").replaceChildren(...r.milestones.filter((m) => m.kind !== "event").map((m) => h("li", {}, h("span", { class: "dot", style: `--swatch: ${MARKER_COLORS[m.kind] || "var(--accent)"}` }), h("b", {}, monthName(m.month)), " ", m.label)));
}

function renderChecks(r) {
  const issues = E.validate(inputs());
  const items = [
    ...issues.map((x) => ({ level: x.level, text: x.message, where: x.where })),
    ...r.flags.map((f) => ({ level: f.level, text: f.message })),
  ];
  $("checkCount").textContent = items.length ? `(${items.length})` : "";
  $("checks").replaceChildren(...(items.length ? items.slice(0, 60).map((x) => h("li", { class: x.level },
    h("span", { class: "pill" }, x.level === "error" ? "Fix" : x.level === "warn" ? "Check" : "Note"), " ", x.text,
    x.where ? h("button", { class: "link", onclick: () => openTab(TAB_FOR[x.where] || "settings") }, ` Go to ${x.where}`) : null)) : [h("li", { class: "ok" }, "Nothing to flag.")]));
}

/* ------------------------------------------------------------------- table -- */

function tableGroups(r) {
  const names = Object.fromEntries((inputs().accounts || []).map((a) => [a.id, a.name]));
  const keysOf = (pick) => [...new Set(r.years.flatMap((y) => Object.keys(pick(y) || {})))];
  const LABEL = { salary: "Salary", bonus: "Bonus", side: "Side income", ss: "Social Security", employer: "Employer money", windfall: "Windfalls", retirement: "401(k)/403(b)", hsa: "HSA", cafeteria: "Health premium and FSA", roth: "Roth 401(k)", federal: "Federal", fica: "FICA", state: "Indiana", county: "County", rent: "Rent", utilities: "Utilities", mortgage: "Mortgage", propertyTax: "Property tax", insurance: "Insurance", hoa: "HOA", upkeep: "Upkeep", pmi: "PMI", bigItems: "Big repairs", closing: "Closing costs", purchase: "Purchases", loan: "Loan payments", gas: "Gas", registration: "Registration", excise: "Excise tax", maintenance: "Maintenance", care: "Care and activities", birth: "Birth", college: "College", premium: "Health premium", outOfPocket: "Out-of-pocket", payment: "Payments", extra: "Extra payments", interest: "Interest", forgiven: "Forgiven" };
  const sub = (pick, keys) => keys.map((k) => ({ label: LABEL[k] || names[k] || k, get: (y) => pick(y)?.[k] || 0 }));
  return [
    { key: "income", label: "Income", total: (y) => y.income.salary + y.income.bonus + y.income.side + y.income.ss + y.income.windfall, items: sub((y) => y.income, ["salary", "bonus", "side", "ss", "windfall", "employer"]) },
    { key: "pretax", label: "Pre-tax", total: (y) => sum(y.pretax), items: sub((y) => y.pretax, keysOf((y) => y.pretax)) },
    { key: "taxes", label: "Taxes", total: (y) => y.taxes.total, items: sub((y) => y.taxes, ["federal", "fica", "state", "county"]) },
    { key: "housing", label: "Housing", total: (y) => sum(y.housing), items: sub((y) => y.housing, keysOf((y) => y.housing)) },
    { key: "cars", label: "Cars", total: (y) => sum(y.cars), items: sub((y) => y.cars, keysOf((y) => y.cars)) },
    { key: "kids", label: "Kids", total: (y) => sum(y.kids), items: sub((y) => y.kids, keysOf((y) => y.kids)) },
    { key: "other", label: "Other spending", total: (y) => sum(y.categories) + y.pets + sum(y.health) + y.events, items: [...sub((y) => y.categories, keysOf((y) => y.categories)), { label: "Pets", get: (y) => y.pets }, ...sub((y) => y.health, ["premium", "outOfPocket"]), { label: "One-time events", get: (y) => y.events }] },
    { key: "debt", label: "Debt", total: (y) => y.debt.payment + y.debt.extra, items: sub((y) => y.debt, ["payment", "extra", "interest", "forgiven"]) },
    { key: "saved", label: "Saved", total: (y) => sum(y.savings), items: sub((y) => y.savings, keysOf((y) => y.savings)) },
    { key: "drawn", label: "Drawn from savings", total: (y) => sum(y.withdrawals), items: sub((y) => y.withdrawals, keysOf((y) => y.withdrawals)) },
    { key: "balances", label: "Balances", total: (y) => sum(y.balances), items: [...sub((y) => y.balances, keysOf((y) => y.balances)), { label: "Home value", get: (y) => y.byGroup?.homeValue || 0 }, { label: "Mortgage", get: (y) => y.byGroup?.mortgage || 0 }, { label: "Car value", get: (y) => y.byGroup?.cars || 0 }, { label: "Car loans", get: (y) => y.byGroup?.carLoans || 0 }, { label: "Other loans", get: (y) => y.byGroup?.debts || 0 }] },
  ];
}

function renderTable(r) {
  const groups = tableGroups(r);
  const cols = [];
  for (const g of groups) {
    if (state.expanded.has(g.key)) for (const it of g.items) cols.push({ group: g, label: it.label, get: it.get, sub: true });
    else cols.push({ group: g, label: g.label, get: g.total });
  }
  const toggle = (g) => h("button", { class: "link small", "aria-expanded": String(state.expanded.has(g.key)), onclick: () => {
    if (state.expanded.has(g.key)) state.expanded.delete(g.key);
    else state.expanded.add(g.key);
    renderTable(state.result);
  } }, state.expanded.has(g.key) ? "−" : "+");
  const head1 = h("tr", {}, h("th", { rowspan: 2 }, "Year"), h("th", { rowspan: 2 }, "Ages"),
    ...groups.map((g) => h("th", { colspan: state.expanded.has(g.key) ? g.items.length || 1 : 1, class: "grp" }, g.label, " ", toggle(g))),
    h("th", { rowspan: 2, class: "num" }, "Net worth"));
  const head2 = h("tr", {}, ...cols.map((c) => h("th", { class: "num sub" }, c.sub ? c.label : "Total")));
  const ppl = inputs().people;
  const rows = r.years.map((y) => h("tr", { class: y.unfunded > 0 ? "short" : "" },
    h("td", {}, y.year),
    h("td", { class: "muted" }, ppl.map((p, n) => y.ages[n]).join(" / ")),
    ...cols.map((c) => h("td", { class: "num" }, compact(shown(c.get(y), y)))),
    h("td", { class: "num" }, h("b", {}, compact(shown(y.netWorth, y))))));
  $("yearTable").replaceChildren(h("thead", {}, head1, head2), h("tbody", {}, rows));
}

$("csvBtn").addEventListener("click", () => {
  const names = Object.fromEntries(inputs().accounts.map((a) => [a.id, a.name]));
  const csv = E.toCsv(E.yearRows(state.result, state.real, names));
  download(`finances-${scenario().name.replace(/[^A-Za-z0-9]+/g, "-")}-${state.real ? "todays-dollars" : "future-dollars"}.csv`, csv, "text/csv");
});

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* -------------------------------------------------------------- Monte Carlo -- */

$("mcRun").addEventListener("click", () => {
  const runs = Number($("mcRuns").value) || 300;
  $("mcResult").textContent = `Running ${runs} simulations…`;
  $("mcRun").disabled = true;
  setTimeout(() => {
    try {
      const t = performance.now();
      const mc = E.monteCarlo(inputs(), { runs, seed: Date.now() % 100000, overrides: state.overrides });
      state.mc = mc;
      $("mcResult").replaceChildren(h("b", {}, `${Math.round(mc.success * 100)}%`), ` of ${runs} runs keep the money lasting to 95, with returns that vary by ±${pctText(Number(inputs().assumptions.returnSd) || 0, 0)} a year (one standard deviation). ${((performance.now() - t) / 1000).toFixed(1)} seconds.`);
      const labels = mc.bands.map((b) => b.year);
      bandChart($("mcChart"), {
        labels, low: mc.bands.map((b) => b.p10), mid: mc.bands.map((b) => b.p50), high: mc.bands.map((b) => b.p90),
        onHover: (i, ev) => showTooltip(ev, String(mc.bands[i].year), [["Bad case (10th percentile)", money(mc.bands[i].p10)], ["Middle", money(mc.bands[i].p50)], ["Good case (90th percentile)", money(mc.bands[i].p90)]]),
        onLeave: hideTooltip,
      });
    } finally {
      $("mcRun").disabled = false;
    }
  }, 30);
});

/* --------------------------------------------------------------- import/export -- */

$("exportBtn").addEventListener("click", () => {
  download(`lifetime-finances-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state.model, null, 2), "application/json");
});
$("importBtn").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    alert("That file isn't valid JSON.");
    return;
  }
  const model = E.normalizeModel(parsed);
  const ok = await openDialog("Import this backup?", (close) => h("div", {},
    h("p", {}, `It has ${model.scenarios.length} scenario${model.scenarios.length === 1 ? "" : "s"}: ${model.scenarios.map((x) => x.name).join(", ")}.`),
    h("p", { class: "desc" }, "It replaces everything on this page, and then saves to Drive. Export first if you want to keep what's here."),
    h("div", { class: "row" }, h("button", { onclick: () => close(false) }, "Cancel"), h("button", { class: "primary", onclick: () => close(true) }, "Replace with the backup"))));
  if (!ok) return;
  state.model = model;
  state.compare = "";
  renderAll();
  changed();
});

/* -------------------------------------------------------------------- inputs -- */

const TABS = [
  ["people", "People & income"], ["taxes", "Taxes"], ["budget", "Budget"], ["accounts", "Accounts"], ["debts", "Debts"],
  ["house", "House"], ["cars", "Cars"], ["kids", "Kids & pets"], ["events", "One-time events"], ["retirement", "Retirement"],
  ["assumptions", "Assumptions"], ["scenarios", "Scenarios"], ["settings", "Settings & Drive"], ["method", "Methodology"],
];
const TAB_FOR = { People: "people", Income: "people", Taxes: "taxes", Budget: "budget", Accounts: "accounts", Debts: "debts", House: "house", Cars: "cars", Kids: "kids", Events: "events", Retirement: "retirement", Assumptions: "assumptions", Settings: "settings" };

function renderTabs() {
  $("tabs").replaceChildren(...TABS.map(([key, label]) => h("button", { role: "tab", class: state.tab === key ? "active" : "", "aria-selected": String(state.tab === key), onclick: () => openTab(key) }, label)));
}
function openTab(key) {
  state.tab = key;
  renderTabs();
  renderTab();
  $("inputsCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* field helpers */
const ACCT_OPTS = (types) => () => [["", "None"], ...inputs().accounts.filter((a) => !types || types.includes(a.type)).map((a) => [a.id, a.name || "(unnamed)"])];
const PERSON_OPTS = () => inputs().people.map((p) => [p.id, p.name || "(unnamed)"]);
const OWNER_OPTS = () => [...PERSON_OPTS(), ["shared", "Shared"]];

/**
 * One input bound to obj[key]. Types: text, money, num, int, pct (shown as 6.5, saved
 * as 0.065), month, bool, select (opts). `nullable`: blank saves null ("use the default").
 */
function input(obj, f) {
  const id = `f-${Math.random().toString(36).slice(2)}`;
  let control;
  const cur = obj[f.key];
  const after = () => changed({ rerender: Boolean(f.rerender) });
  if (f.type === "bool") {
    control = h("input", { type: "checkbox", id, checked: Boolean(cur) });
    control.addEventListener("change", () => {
      obj[f.key] = control.checked;
      changed({ rerender: f.rerender !== false });
    });
  } else if (f.type === "select") {
    const options = typeof f.opts === "function" ? f.opts() : f.opts;
    control = h("select", { id }, options.map(([v, label]) => h("option", { value: v, selected: String(v) === String(cur ?? "") }, label)));
    control.addEventListener("change", () => {
      obj[f.key] = f.numeric ? Number(control.value) : control.value;
      changed({ rerender: f.rerender !== false });
    });
  } else {
    const isNum = ["money", "num", "int", "pct"].includes(f.type);
    control = h("input", { id, type: f.type === "month" ? "month" : isNum ? "number" : "text", step: f.type === "pct" ? "any" : f.type === "int" ? "1" : "any", inputmode: isNum ? "decimal" : null, placeholder: f.placeholder || (f.nullable ? "Default" : null) });
    if (f.type === "pct") control.value = cur == null || cur === "" ? "" : String(Math.round(Number(cur) * 1e6) / 1e4);
    else control.value = cur ?? "";
    control.addEventListener("input", () => {
      const raw = control.value.trim();
      let v;
      if (!isNum) v = raw;
      else if (raw === "") v = f.nullable ? null : 0;
      else v = f.type === "pct" ? Number(raw) / 100 : Number(raw);
      if (isNum && v != null && !Number.isFinite(v)) return;
      obj[f.key] = v;
      after();
    });
  }
  const label = h("span", { class: "lbl" }, f.label, f.type === "pct" ? " (%)" : f.type === "money" ? " ($)" : "");
  const helpBtn = f.help ? h("button", { type: "button", class: "help", "aria-label": `About ${f.label}`, "aria-expanded": "false" }, "?") : null;
  const helpText = f.help ? h("span", { class: "helptext", hidden: true }, f.help) : null;
  if (helpBtn) helpBtn.addEventListener("click", () => {
    helpText.hidden = !helpText.hidden;
    helpBtn.setAttribute("aria-expanded", String(!helpText.hidden));
  });
  if (f.type === "bool") return h("div", { class: "field boolf" }, h("label", { for: id, class: "check" }, control, label), helpBtn, helpText);
  return h("div", { class: `field${f.wide ? " wide" : ""}` }, h("label", { for: id }, label), helpBtn, control, helpText);
}
const grid = (obj, fields) => h("div", { class: "fgrid" }, fields.filter((f) => !f.when || f.when(obj)).map((f) => input(obj, f)));

/** A list with add, duplicate, delete and reorder. */
function list(arr, { title, fields, make, name, nested, empty, addLabel }) {
  const box = h("div", { class: "flist" });
  arr.forEach((item, n) => {
    const actions = h("span", { class: "actions" },
      h("button", { class: "small", title: "Move up", "aria-label": "Move up", disabled: n === 0, onclick: () => {
        [arr[n - 1], arr[n]] = [arr[n], arr[n - 1]];
        changed({ rerender: true });
      } }, "↑"),
      h("button", { class: "small", onclick: () => {
        const copy = structuredClone(item);
        if (copy.id) copy.id = E.newId(String(item.id).split("-")[0] || "id");
        if (copy.name) copy.name = `${copy.name} (copy)`;
        arr.splice(n + 1, 0, copy);
        changed({ rerender: true });
      } }, "Duplicate"),
      h("button", { class: "small danger", onclick: () => {
        if (!confirm(`Delete ${name(item) || "this"}?`)) return;
        arr.splice(n, 1);
        changed({ rerender: true });
      } }, "Delete"));
    box.append(h("div", { class: "fitem" }, h("div", { class: "fhead" }, h("b", {}, name(item) || "(unnamed)"), actions), grid(item, fields), nested ? nested(item) : null));
  });
  if (!arr.length && empty) box.append(h("p", { class: "desc" }, empty));
  box.append(h("button", { class: "small add", onclick: () => {
    arr.push(make());
    changed({ rerender: true });
  } }, addLabel || `Add ${title}`));
  return box;
}
const section = (title, desc, ...kids) => h("section", { class: "fsec" }, h("h3", {}, title), desc ? h("p", { class: "desc" }, desc) : null, ...kids);

/* field lists */
const F = {
  person: [
    { key: "name", label: "Name", type: "text" },
    { key: "birthYear", label: "Birth year", type: "int" },
    { key: "birthMonth", label: "Birth month (1 to 12)", type: "int" },
    { key: "retireAge", label: "Retirement age", type: "num", help: "Every income stream for this person stops at this age." },
    { key: "ssMonthly", label: "Social Security a month", type: "money", help: "Your estimate at the claiming age below, in today's dollars. Get it from ssa.gov/myaccount. It grows with inflation each year." },
    { key: "ssClaimAge", label: "Claiming age", type: "num", help: "62 to 70. Claiming later pays more a month; enter the estimate for the age you pick." },
  ],
  income: [
    { key: "owner", label: "Whose", type: "select", opts: PERSON_OPTS },
    { key: "name", label: "Name", type: "text" },
    { key: "kind", label: "Kind", type: "select", opts: [["salary", "Salary"], ["bonus", "Bonus (once a year)"], ["side", "Side income"]], help: "A bonus is paid once a year in the month below. Side income gets no employer match. Parental leave reduces salaries only." },
    { key: "annual", label: "Amount a year", type: "money", help: "Before taxes, in today's dollars for this year." },
    { key: "payMonth", label: "Bonus month (1 to 12)", type: "int", when: (o) => o.kind === "bonus" },
    { key: "start", label: "Starts", type: "month", help: "Leave blank if it's already paying." },
    { key: "end", label: "Ends", type: "month", help: "Leave blank to run until retirement." },
    { key: "growth", label: "Yearly raise", type: "pct", nullable: true, help: "Blank uses the default raise in Assumptions. Raises apply each January." },
    { key: "retirePct", label: "401(k)/403(b) contribution", type: "pct", help: "Share of each paycheck. It stops at the IRS limit each year. Traditional is pre-tax for income tax (FICA still applies); Roth is after tax." },
    { key: "retireAccount", label: "Into account", type: "select", opts: ACCT_OPTS(["trad401k", "roth401k"]) },
    { key: "matchPct", label: "Employer match rate", type: "pct", help: "100 means dollar for dollar; 50 means 50 cents per dollar." },
    { key: "matchUpTo", label: "Match on up to", type: "pct", help: "The share of pay the employer matches, for example 4." },
    { key: "matchAccount", label: "Match goes to", type: "select", opts: ACCT_OPTS(["trad401k", "roth401k"]), help: "Blank: the same account." },
    { key: "hsaEmployee", label: "Your HSA contribution a year", type: "money", help: "Through payroll: pre-tax for income tax and FICA." },
    { key: "hsaEmployer", label: "Employer HSA contribution a year", type: "money" },
    { key: "hsaAccount", label: "HSA account", type: "select", opts: ACCT_OPTS(["hsa"]) },
  ],
  jump: [
    { key: "date", label: "From", type: "month" },
    { key: "pct", label: "Raise", type: "pct", nullable: true, help: "A one-time jump, for example 10 for a promotion." },
    { key: "newAnnual", label: "Or new salary", type: "money", nullable: true, help: "For a job change: the new yearly pay. Overrides the raise." },
  ],
  gap: [
    { key: "start", label: "From", type: "month" },
    { key: "end", label: "To", type: "month", help: "Blank: no end." },
    { key: "pctPaid", label: "Share of pay", type: "pct", help: "0 for unpaid, 50 for half time." },
  ],
  category: [
    { key: "name", label: "Name", type: "text" },
    { key: "amount", label: "Amount", type: "money", help: "In today's dollars." },
    { key: "freq", label: "How often", type: "select", opts: [["monthly", "Monthly"], ["yearly", "Yearly"]], help: "Yearly items are paid in their start month (January if blank)." },
    { key: "inflation", label: "Inflation", type: "pct", nullable: true, help: "Blank uses general inflation." },
    { key: "start", label: "Starts", type: "month" },
    { key: "end", label: "Ends", type: "month" },
    { key: "owner", label: "Whose", type: "select", opts: OWNER_OPTS },
  ],
  account: [
    { key: "name", label: "Name", type: "text" },
    { key: "type", label: "Type", type: "select", opts: () => Object.entries(E.ACCOUNT_TYPES).map(([k, v]) => [k, v.label]) },
    { key: "owner", label: "Whose", type: "select", opts: OWNER_OPTS, help: "Decides catch-up limits at 50 and the early-withdrawal penalty before 59½." },
    { key: "balance", label: "Balance today", type: "money" },
    { key: "monthly", label: "Monthly contribution", type: "money", help: "From take-home pay, in the savings order below. Payroll 401(k) contributions are set on the income instead." },
    { key: "ret", label: "Expected return", type: "pct", nullable: true, help: "Blank uses the return for this type in Assumptions." },
    { key: "limit", label: "Yearly limit", type: "money", nullable: true, help: "Blank uses the IRS limit for IRAs, 401(k)s and HSAs, growing as set in Assumptions. Other types have none." },
  ],
  debt: [
    { key: "name", label: "Name", type: "text" },
    { key: "kind", label: "Kind", type: "select", opts: [["student", "Student loan"], ["other", "Other loan"]] },
    { key: "balance", label: "Balance today", type: "money" },
    { key: "rate", label: "Interest rate", type: "pct" },
    { key: "minPayment", label: "Monthly payment", type: "money", help: "The required payment. For an income-driven plan, this caps the payment (enter the standard payment)." },
    { key: "termMonths", label: "Or months to pay off", type: "int", nullable: true, help: "Used only when the payment is blank: the payment that clears it in this many months." },
    { key: "extra", label: "Extra a month", type: "money", help: "Paid from what's left after required spending, in the savings order." },
    { key: "start", label: "Starts", type: "month", help: "For a loan you'll take out later. Blank: now." },
    { key: "plan", label: "Repayment plan", type: "select", opts: [["standard", "Standard"], ["idr", "Income-driven"]], help: "Income-driven: a share of last year's income above a multiple of the poverty line, recalculated each year." },
    { key: "idrPct", label: "Share of discretionary income", type: "pct", when: (o) => o.plan === "idr", help: "For example 10. Set it to your plan's current rule." },
    { key: "idrPovertyMult", label: "Poverty-line multiple", type: "num", when: (o) => o.plan === "idr", help: "For example 1.5 (150%). Income below this is protected." },
    { key: "forgive", label: "Forgiveness", type: "bool", help: "PSLF or income-driven forgiveness: whatever is left after the number of qualifying payments below is forgiven. You set the rules; they change often." },
    { key: "forgiveAfterMonths", label: "Qualifying payments needed", type: "int", when: (o) => o.forgive, help: "PSLF: 120." },
    { key: "paymentsMade", label: "Qualifying payments so far", type: "int", when: (o) => o.forgive },
    { key: "forgiveTaxable", label: "Forgiven amount is taxable", type: "bool", when: (o) => o.forgive, help: "PSLF isn't taxed federally. Some other forgiveness may be." },
  ],
  bigItem: [
    { key: "name", label: "Item", type: "text" },
    { key: "year", label: "Year", type: "int" },
    { key: "cost", label: "Cost", type: "money", help: "In today's dollars; it grows with inflation." },
  ],
  car: [
    { key: "name", label: "Name", type: "text" },
    { key: "owner", label: "Whose", type: "select", opts: OWNER_OPTS },
    { key: "price", label: "Price", type: "money", help: "In today's dollars. For a car you already own, what you paid. Each replacement costs this much, grown with inflation." },
    { key: "purchase", label: "Bought (or will buy)", type: "month" },
    { key: "replace", label: "Replace on a cycle", type: "bool" },
    { key: "cycleYears", label: "Replace every (years)", type: "num", when: (o) => o.replace },
    { key: "until", label: "Last replacement year", type: "int", nullable: true, when: (o) => o.replace, help: "Blank: keep replacing for life." },
    { key: "loanMonths", label: "Loan length (months)", type: "int", help: "0 to pay cash." },
    { key: "loanRate", label: "Loan rate", type: "pct" },
    { key: "downPct", label: "Down payment", type: "pct", help: "The trade-in counts toward it." },
    { key: "existingLoanBalance", label: "Loan on it now", type: "money", help: "Only for a car you already own." },
    { key: "existingLoanRate", label: "Current loan rate", type: "pct" },
    { key: "existingLoanPayment", label: "Current loan payment", type: "money" },
    { key: "milesPerYear", label: "Miles a year", type: "num" },
    { key: "mpg", label: "MPG", type: "num" },
    { key: "gasPrice", label: "Gas a gallon", type: "money" },
    { key: "gasInflation", label: "Gas price growth", type: "pct" },
    { key: "insuranceYearly", label: "Insurance a year", type: "money" },
    { key: "registrationYearly", label: "Registration a year", type: "money" },
    { key: "exciseFirstYear", label: "Indiana excise, first year", type: "money", help: "Estimate. Indiana's vehicle excise tax depends on the car's class and drops each year it ages; here it falls about 13% a year to a floor of 10%. Your BMV renewal shows the real figure." },
    { key: "maintBase", label: "Maintenance, first year", type: "money" },
    { key: "maintGrowth", label: "Maintenance growth with age", type: "pct", help: "How much more it costs each year older the car gets." },
    { key: "upkeepMonthly", label: "Flat upkeep a month", type: "money", help: "Optional: a set budget on top (tires, washes)." },
    { key: "depFirstYear", label: "Value lost, first year", type: "pct" },
    { key: "depYearly", label: "Value lost, each later year", type: "pct" },
  ],
  kid: [
    { key: "name", label: "Name", type: "text" },
    { key: "birthYear", label: "Birth year", type: "int" },
    { key: "birthMonth", label: "Birth month", type: "int" },
    { key: "college529Monthly", label: "529 a month", type: "money", help: "Until 18, in the savings order." },
    { key: "account", label: "529 account", type: "select", opts: ACCT_OPTS(["college529"]) },
  ],
  leave: [
    { key: "person", label: "Who takes leave", type: "select", opts: PERSON_OPTS },
    { key: "weeks", label: "Weeks", type: "num" },
    { key: "pctPaid", label: "Share of pay", type: "pct", help: "0 for unpaid, 60 for short-term disability, 100 for fully paid." },
  ],
  band: [
    { key: "label", label: "Stage", type: "text" },
    { key: "fromAge", label: "From age", type: "int" },
    { key: "toAge", label: "To age", type: "int" },
    { key: "annual", label: "Cost a year", type: "money", help: "In today's dollars. Ages under the childcare age in Kids' costs count as childcare for the FSA and the credit." },
  ],
  pet: [
    { key: "name", label: "Name", type: "text" },
    { key: "annual", label: "Cost a year", type: "money" },
    { key: "oneTime", label: "One-time cost", type: "money", help: "Paid in the start month (adoption, supplies)." },
    { key: "start", label: "Starts", type: "month" },
    { key: "endYear", label: "Last year", type: "int", nullable: true },
  ],
  event: [
    { key: "name", label: "Name", type: "text" },
    { key: "date", label: "Month", type: "month" },
    { key: "amount", label: "Amount", type: "money" },
    { key: "kind", label: "Kind", type: "select", opts: [["expense", "Spending"], ["windfall", "Money in (gift, inheritance, sale)"]] },
    { key: "grows", label: "Amount is in today's dollars", type: "bool", help: "Ticked: it grows with inflation until then. Unticked: the amount is exactly what you'll pay." },
  ],
};

function renderTab() {
  const box = $("tabBody");
  const inp = inputs();
  const t = state.tab;
  let body;
  if (t === "people") {
    body = [
      section("People", "Each of you. Ages run until the end age in Settings.", list(inp.people, { title: "person", fields: F.person, make: () => ({ id: E.newId("p"), name: "", birthYear: 1995, birthMonth: 1, retireAge: 65, ssMonthly: 0, ssClaimAge: 67 }), name: (p) => p.name })),
      section("Income", "Every paycheck and side income. Each one stops at its owner's retirement.", list(inp.incomes, {
        title: "income", fields: F.income, name: (x) => `${inp.people.find((p) => p.id === x.owner)?.name || "?"}: ${x.name}`,
        make: () => ({ id: E.newId("inc"), owner: inp.people[0]?.id, name: "Salary", kind: "salary", annual: 0, start: "", end: "", growth: null, payMonth: 12, jumps: [], gaps: [], retirePct: 0, retireAccount: "", matchPct: 0, matchUpTo: 0, matchAccount: "", hsaEmployee: 0, hsaEmployer: 0, hsaAccount: "" }),
        nested: (x) => h("div", { class: "nested" },
          h("h4", {}, "One-time jumps (promotion, job change)"),
          list(x.jumps, { title: "jump", fields: F.jump, name: (j) => j.date || "New jump", make: () => ({ date: "", pct: 0.1, newAnnual: null }) }),
          h("h4", {}, "Gaps (career break, part time). Parental leave is set on each kid."),
          list(x.gaps, { title: "gap", fields: F.gap, name: (g) => `${g.start || "?"} to ${g.end || "?"}`, make: () => ({ start: "", end: "", pctPaid: 0 }) })),
      })),
    ];
  } else if (t === "taxes") body = taxTab(inp);
  else if (t === "budget") {
    body = [
      section("Rent", "Stops when you buy a house, and starts again if you sell without buying.", grid(inp.budget.rent, [
        { key: "monthly", label: "Rent a month", type: "money" },
        { key: "increase", label: "Yearly increase", type: "pct", help: "Applied each January." },
      ])),
      section("Utilities", "Average a month, in today's dollars.", grid(inp.budget.utilities, [
        { key: "rent", label: "While renting", type: "money" },
        { key: "own", label: "As homeowners", type: "money" },
      ])),
      section("Health", null, grid(inp.budget.health, [
        { key: "premiumMonthly", label: "Premiums a month", type: "money", help: "Your share for the whole household. Each kid adds the amount in Kids' costs." },
        { key: "pretax", label: "Paid pre-tax through payroll", type: "bool", help: "Most employer plans are. Pre-tax premiums lower income tax and FICA." },
        { key: "oopYearly", label: "Out-of-pocket a year", type: "money" },
        { key: "inflation", label: "Health cost growth", type: "pct" },
      ])),
      section("Spending categories", "Add as many as you like. Yearly items cover travel, gifts, annual subscriptions and insurance.", list(inp.budget.categories, {
        title: "category", fields: F.category, name: (c) => c.name,
        make: () => ({ id: E.newId("cat"), name: "New category", amount: 0, freq: "monthly", inflation: null, start: "", end: "", owner: "shared" }),
      })),
    ];
  } else if (t === "accounts") {
    body = [
      section("Accounts", null, list(inp.accounts, {
        title: "account", fields: F.account, name: (a) => `${a.name} · ${E.ACCOUNT_TYPES[a.type]?.label || a.type}`,
        make: () => ({ id: E.newId("acct"), name: "New account", type: "savings", owner: "shared", balance: 0, monthly: 0, ret: null, limit: null }),
      })),
      section("Where money goes", null, grid(inp.settings, [
        { key: "surplusAccount", label: "Leftover money goes to", type: "select", opts: ACCT_OPTS(null), help: "Whatever is left each month after spending and the goals below. Shortfalls draw from it first." },
        { key: "emergencyMonths", label: "Emergency fund target (months)", type: "num", help: "Months of required spending. Emergency fund contributions stop once it's reached." },
      ]), priorityList(inp)),
    ];
  } else if (t === "debts") {
    body = [
      section("Loans", "Each student loan on its own, and any other loan. Car loans and the mortgage are set on the car and the house.", list(inp.debts, {
        title: "loan", fields: F.debt, name: (d) => d.name,
        make: () => ({ id: E.newId("debt"), name: "New loan", kind: "student", balance: 0, rate: 0.05, minPayment: 0, extra: 0, start: "", plan: "standard", termMonths: null, idrPct: 0.1, idrPovertyMult: 1.5, forgive: false, forgiveAfterMonths: 120, paymentsMade: 0, forgiveTaxable: false }),
      })),
      h("div", { id: "debtResults" }),
    ];
  } else if (t === "house") {
    const H = inp.house;
    body = [
      h("div", { id: "houseResults" }),
      section("The house", null, grid(H, [
        { key: "enabled", label: "Plan to buy a house", type: "bool" },
        { key: "price", label: "Target price", type: "money", help: "In today's dollars. It grows with home appreciation until you buy." },
        { key: "downPct", label: "Down payment", type: "pct" },
        { key: "closingPct", label: "Closing costs", type: "pct", help: "Usually 2 to 5% of the price." },
        { key: "mode", label: "When to buy", type: "select", opts: [["auto", "When the down payment fund reaches the target"], ["year", "In a year I pick"]] },
        { key: "year", label: "Year", type: "int", when: (o) => o.mode === "year" },
        { key: "month", label: "Month (1 to 12)", type: "int", when: (o) => o.mode === "year" },
        { key: "fundAccount", label: "Down payment fund", type: "select", opts: ACCT_OPTS(["house", "savings"]) },
        { key: "rate", label: "Mortgage rate", type: "pct" },
        { key: "termYears", label: "Mortgage term (years)", type: "int" },
        { key: "pmiRate", label: "PMI a year", type: "pct", help: "Share of the loan, paid while you owe more than 80% of the home's value." },
        { key: "propertyTaxRate", label: "Property tax a year", type: "pct", help: "Estimate. Indiana caps a homestead's property tax at 1% of assessed value, and the homestead deductions lower it further; many Marion County homes pay about 0.8 to 0.9% of value. Check the county's estimate for a real address." },
        { key: "insuranceYearly", label: "Homeowners insurance a year", type: "money" },
        { key: "hoaMonthly", label: "HOA a month", type: "money" },
        { key: "upkeepPct", label: "Upkeep a year", type: "pct", help: "Share of the home's value; 1% is a common rule of thumb." },
      ])),
      section("Big replacements", "Roof, HVAC, water heater and the like, in the year they're due.", list(H.bigItems, { title: "item", fields: F.bigItem, name: (b) => b.name, make: () => ({ id: E.newId("big"), name: "", year: new Date().getFullYear() + 10, cost: 0 }) })),
      section("Sell and buy again", null, grid(H.sell, [
        { key: "enabled", label: "Sell later", type: "bool" },
        { key: "year", label: "Sell in", type: "int", when: (o) => o.enabled },
        { key: "costPct", label: "Selling costs", type: "pct", when: (o) => o.enabled, help: "Agent fees and closing, often about 6%." },
        { key: "rebuy", label: "Buy another", type: "bool", when: (o) => o.enabled, help: "Unticked: back to renting." },
        { key: "newPrice", label: "Next house price", type: "money", when: (o) => o.enabled && o.rebuy, help: "In today's dollars." },
        { key: "newDownPct", label: "Next down payment", type: "pct", when: (o) => o.enabled && o.rebuy },
      ])),
    ];
  } else if (t === "cars") {
    body = [section("Cars", "Each car is replaced on its cycle at an inflation-adjusted price, with its value traded in.", list(inp.cars, {
      title: "car", fields: F.car, name: (c) => c.name,
      make: () => ({ id: E.newId("car"), name: "New car", owner: "shared", price: 30000, purchase: "", cycleYears: 10, replace: true, until: null, loanRate: 0.065, loanMonths: 60, downPct: 0.2, existingLoanBalance: 0, existingLoanRate: 0, existingLoanPayment: 0, milesPerYear: 11000, mpg: 30, gasPrice: 3.1, gasInflation: 0.03, insuranceYearly: 1500, registrationYearly: 60, exciseFirstYear: 350, maintBase: 500, maintGrowth: 0.1, upkeepMonthly: 0, depFirstYear: 0.2, depYearly: 0.15 }),
    }))];
  } else if (t === "kids") {
    body = [
      section("Kids", null, list(inp.kids, {
        title: "kid", fields: F.kid, name: (k) => k.name || `Kid born ${k.birthYear}`,
        make: () => ({ id: E.newId("kid"), name: "", birthYear: new Date().getFullYear() + 3, birthMonth: 6, college529Monthly: 0, account: "", leave: [] }),
        nested: (k) => h("div", { class: "nested" }, h("h4", {}, "Parental leave"), list(k.leave, { title: "leave", fields: F.leave, name: (l) => inp.people.find((p) => p.id === l.person)?.name || "Leave", make: () => ({ person: inp.people[0]?.id, weeks: 12, pctPaid: 0.6 }) })),
        empty: "No kids planned yet.",
      })),
      section("Kids' costs", "The same for each kid, in today's dollars.", grid(inp.kidCosts, [
        { key: "birthCost", label: "Birth, out of pocket", type: "money" },
        { key: "healthAddMonthly", label: "Added health premium a month", type: "money" },
        { key: "collegeGoal", label: "College goal per kid", type: "money", help: "In today's dollars. Paid in four yearly parts from 18, from the 529 first." },
        { key: "childcareUnder", label: "Childcare counts under age", type: "int", help: "Care costs below this age count for the dependent care FSA and credit (13 under IRS rules)." },
      ]), list(inp.kidCosts.bands, { title: "stage", fields: F.band, name: (b) => b.label, make: () => ({ id: E.newId("band"), label: "", fromAge: 0, toAge: 0, annual: 0 }) })),
      section("Pets", null, list(inp.pets, { title: "pet", fields: F.pet, name: (p) => p.name, make: () => ({ id: E.newId("pet"), name: "", annual: 1200, oneTime: 500, start: "", endYear: null }), empty: "No pets yet." })),
    ];
  } else if (t === "events") {
    body = [section("One-time events", "Wedding, honeymoon, big purchases, gifts and windfalls, in the month they happen.", list(inp.events, {
      title: "event", fields: F.event, name: (e) => `${e.name}${e.date ? ` · ${monthName(e.date)}` : ""}`,
      make: () => ({ id: E.newId("ev"), name: "", date: "", amount: 0, kind: "expense", grows: false }),
    }))];
  } else if (t === "retirement") {
    body = [
      h("div", { id: "retResults" }),
      section("Each of you", "Retirement ages and Social Security are also on People.", ...inp.people.map((p) => h("div", { class: "fitem" }, h("div", { class: "fhead" }, h("b", {}, p.name)), grid(p, F.person.slice(3))))),
      section("Spending in retirement", null, grid(inp.retirement, [
        { key: "mode", label: "Spending once you're both retired", type: "select", opts: [["budget", "Keep my budget categories"], ["target", "A target amount a month"], ["rate", "A withdrawal rate"]], help: "Target and rate replace the budget categories; housing, cars, health and debts stay as modeled." },
        { key: "targetMonthly", label: "Target a month", type: "money", when: (o) => o.mode === "target", help: "In today's dollars." },
        { key: "rate", label: "Withdrawal rate", type: "pct", when: (o) => o.mode === "rate", help: "Share of investments at retirement spent the first year, then grown with inflation. 4% is the common rule." },
      ]), h("p", { class: "desc" }, "Shortfalls draw from the leftover account, then checking, savings, emergency fund and house fund, then in this order:"), orderList(inp.retirement)),
      section("End of the plan", null, grid(inp.settings, [
        { key: "endAge", label: "Run until we're both", type: "int", help: "Age. The plan runs month by month until the younger of you reaches it." },
        { key: "fiRate", label: "Financial independence rate", type: "pct", help: "You're financially independent when savings × this rate cover a year's spending." },
      ])),
    ];
  } else if (t === "assumptions") {
    const A = inp.assumptions;
    body = [
      section("General", "All are assumptions. Change them to see what matters.", grid(A, [
        { key: "inflation", label: "Inflation", type: "pct", help: "Assumption. The Federal Reserve targets 2%; 2.5 to 3 is a cautious long-run guess." },
        { key: "salaryGrowth", label: "Default yearly raise", type: "pct", help: "Assumption." },
        { key: "homeAppreciation", label: "Home appreciation", type: "pct", help: "Assumption. Long-run US home prices have grown a little faster than inflation." },
        { key: "bracketIndexing", label: "Tax bracket indexing", type: "pct", help: "Assumption. The IRS raises brackets and deductions with inflation each year." },
        { key: "limitGrowth", label: "Contribution limit growth", type: "pct", help: "Assumption. 401(k), IRA and HSA limits rise with inflation in steps." },
      ])),
      section("Returns by account type", "Assumptions, before inflation, a year.", grid(A.returns, [
        { key: "cash", label: "Checking", type: "pct" },
        { key: "hysa", label: "Savings, emergency and house funds", type: "pct" },
        { key: "brokerage", label: "Brokerage", type: "pct" },
        { key: "retirement", label: "401(k), 403(b) and IRAs", type: "pct" },
        { key: "hsa", label: "HSA", type: "pct" },
        { key: "college", label: "529", type: "pct" },
      ])),
      section("Investment details", null, grid(A, [
        { key: "brokerageGainShare", label: "Share of brokerage withdrawals that's gain", type: "pct", help: "Assumption. Only the gain is taxed, at the capital gains rate in Taxes." },
        { key: "returnSd", label: "Return swing a year (Monte Carlo)", type: "pct", help: "Assumption: one standard deviation. A stock-heavy mix swings about 15 to 18% a year." },
      ])),
    ];
  } else if (t === "scenarios") body = scenariosTab();
  else if (t === "settings") body = settingsTab(inp);
  else if (t === "method") body = [document.getElementById("methodTpl").content.cloneNode(true)];
  box.replaceChildren(...body);
  if (["house", "debts", "retirement"].includes(t)) renderTabResults();
}

function renderTabResults() {
  const r = state.result;
  const s = r.summary;
  const box = $("houseResults") || $("debtResults") || $("retResults");
  if (!box) return;
  if (state.tab === "house") {
    const H = inputs().house;
    const ms = r.milestones.filter((m) => m.kind === "house").map((m) => `${monthName(m.month)}: ${m.label}`);
    box.replaceChildren(h("div", { class: "callout" }, H.enabled ? (ms.length ? h("span", {}, h("b", {}, ms.join(". ")), ". ", H.mode === "auto" ? "That's when the down payment fund first covers the down payment and closing costs at the price then." : "") : "The fund never reaches the target before 95. Raise the house fund's monthly contribution or lower the price.") : "House planning is off."));
  } else if (state.tab === "debts") {
    box.replaceChildren(section("Payoff timeline", `Total interest over the plan: ${money(s.totalInterest)} (future dollars, including car loans while they last).`,
      h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Loan"), h("th", {}, "Paid off"), h("th", { class: "num" }, "Interest paid"))),
        h("tbody", {}, s.debts.map((d) => h("tr", {}, h("td", {}, d.name), h("td", {}, d.paidOff ? `${monthName(d.paidOff)}${d.forgiven ? " (forgiven)" : ""}` : "Not before 95"), h("td", { class: "num" }, money(d.interest)))))))));
  } else if (state.tab === "retirement") {
    box.replaceChildren(h("div", { class: `callout ${s.lasts ? "good" : "bad"}` }, s.lasts ? `The money lasts through ${s.endYear}.` : `The money runs out in ${s.runsOutYear}.`, s.fiYear ? ` Financially independent in ${s.fiYear}.` : "", ` Net worth when you're both retired (${s.retirementYear}): ${money(s.netWorthAtRetirement)} in today's dollars.`));
  }
}

function priorityList(inp) {
  const goals = E.goalOrder(inp);
  const box = h("ol", { class: "order" });
  goals.forEach((g, n) => box.append(h("li", {}, h("span", {}, g.label), h("span", { class: "actions" },
    h("button", { class: "small", disabled: n === 0, "aria-label": `Move ${g.label} up`, onclick: () => {
      const keys = goals.map((x) => x.key);
      [keys[n - 1], keys[n]] = [keys[n], keys[n - 1]];
      inp.settings.priority = keys;
      changed({ rerender: true });
    } }, "↑"),
    h("button", { class: "small", disabled: n === goals.length - 1, "aria-label": `Move ${g.label} down`, onclick: () => {
      const keys = goals.map((x) => x.key);
      [keys[n + 1], keys[n]] = [keys[n], keys[n + 1]];
      inp.settings.priority = keys;
      changed({ rerender: true });
    } }, "↓")))));
  return h("div", {}, h("h4", {}, "Savings order"), h("p", { class: "desc" }, "After taxes and required spending, these get money in this order until it runs out. Accounts with a monthly contribution, extra loan payments and kids' 529s show here."), goals.length ? box : h("p", { class: "desc" }, "Nothing yet: give an account a monthly contribution."));
}

function orderList(ret) {
  const labels = { brokerage: "Brokerage", traditional: "Traditional 401(k) and IRA (taxed as income)", roth: "Roth 401(k) and IRA", hsa: "HSA" };
  const order = ret.order.filter((g) => labels[g]);
  for (const g of Object.keys(labels)) if (!order.includes(g)) order.push(g);
  return h("ol", { class: "order" }, order.map((g, n) => h("li", {}, h("span", {}, labels[g]), h("span", { class: "actions" },
    h("button", { class: "small", disabled: n === 0, "aria-label": "Move up", onclick: () => {
      [order[n - 1], order[n]] = [order[n], order[n - 1]];
      ret.order = order;
      changed({ rerender: true });
    } }, "↑")))));
}

function taxTab(inp) {
  const T = inp.tax;
  const brackets = (set) => h("table", { class: "brackets" }, h("thead", {}, h("tr", {}, h("th", {}, "Income up to ($)"), h("th", {}, "Rate (%)"))),
    h("tbody", {}, set.brackets.map((b, n) => {
      const upTo = h("input", { type: "number", step: "any", placeholder: "and above" });
      upTo.value = b[0] ?? "";
      upTo.addEventListener("input", () => {
        b[0] = upTo.value === "" ? null : Number(upTo.value);
        changed();
      });
      const rate = h("input", { type: "number", step: "any" });
      rate.value = Math.round(b[1] * 1e6) / 1e4;
      rate.addEventListener("input", () => {
        b[1] = Number(rate.value) / 100;
        changed();
      });
      return h("tr", {}, h("td", {}, n === set.brackets.length - 1 ? h("span", { class: "muted" }, "and above") : upTo), h("td", {}, rate));
    })));
  return [
    h("div", { class: "callout" }, h("b", {}, "Estimates, not tax software. "), `Defaults are for the ${T.year} tax year (${T.asOf}). Brackets, deductions and credit thresholds grow with "Tax bracket indexing" in Assumptions after ${T.year}.`,
      h("ul", { class: "sources" }, (T.sources || []).map((x) => h("li", {}, x))),
      h("button", { class: "small", onclick: () => {
        if (!confirm("Put every tax figure back to the built-in defaults?")) return;
        inp.tax = E.defaultTax();
        changed({ rerender: true });
      } }, "Reset taxes to the defaults")),
    section("Federal: single", "Used for each of you until the wedding year.", grid(T.federal.single, [{ key: "standard", label: "Standard deduction", type: "money" }]), brackets(T.federal.single)),
    section("Federal: married filing jointly", "From the wedding year on.", grid(T.federal.married, [{ key: "standard", label: "Standard deduction", type: "money" }]), brackets(T.federal.married)),
    section("FICA", null, grid(T.fica, [
      { key: "ssRate", label: "Social Security rate", type: "pct" },
      { key: "ssWageBase", label: "Social Security wage cap", type: "money" },
      { key: "medicareRate", label: "Medicare rate", type: "pct" },
      { key: "addlRate", label: "Additional Medicare rate", type: "pct" },
      { key: "addlSingle", label: "Additional Medicare over (single)", type: "money" },
      { key: "addlMarried", label: "Additional Medicare over (joint)", type: "money" },
    ])),
    section("Indiana and county", null, grid(T.indiana, [
      { key: "rate", label: "Indiana rate", type: "pct" },
      { key: "rateLater", label: "Indiana rate later", type: "pct", help: "Indiana's rate is scheduled to step down." },
      { key: "rateLaterFrom", label: "Later rate from", type: "int" },
      { key: "countyName", label: "County", type: "text" },
      { key: "county", label: "County rate", type: "pct", help: "Marion County by default. Each Indiana county sets its own." },
      { key: "exemption", label: "Exemption a person", type: "money" },
      { key: "dependentExtra", label: "Extra exemption a child", type: "money" },
    ])),
    section("Credits and kids", null, grid(T.ctc, [
      { key: "perChild", label: "Child tax credit a child", type: "money", help: "For each child under 17. Not refundable in this model." },
      { key: "phaseSingle", label: "Phase-out from (single)", type: "money" },
      { key: "phaseMarried", label: "Phase-out from (joint)", type: "money" },
    ]), grid(T.dependentCare, [
      { key: "useFsa", label: "Use a dependent care FSA", type: "bool" },
      { key: "fsaLimit", label: "Dependent care FSA limit", type: "money" },
      { key: "creditRate", label: "Dependent care credit rate", type: "pct", help: "On care costs not paid through the FSA, up to the caps. Higher-income families get the lowest rate." },
      { key: "capOne", label: "Credit cap, one child", type: "money" },
      { key: "capTwo", label: "Credit cap, two or more", type: "money" },
    ])),
    section("Other", null, grid(T, [
      { key: "ltcgRate", label: "Capital gains rate", type: "pct", help: "Simplified to one rate. 15% covers most incomes." },
      { key: "earlyPenalty", label: "Early withdrawal penalty", type: "pct", help: "On traditional (and half of Roth) withdrawals before 59½." },
    ]), grid(T.ssTaxation, []), grid(T.poverty, [
      { key: "base", label: "Poverty line, one person", type: "money", help: "For income-driven loan payments." },
      { key: "perPerson", label: "Each added person", type: "money" },
    ])),
    section("Contribution limits", "For this tax year; they grow with \"Contribution limit growth\".", grid(T.limits, [
      { key: "k401", label: "401(k)/403(b)", type: "money" },
      { key: "k401Catchup", label: "401(k) catch-up at 50", type: "money" },
      { key: "ira", label: "IRA", type: "money" },
      { key: "iraCatchup", label: "IRA catch-up at 50", type: "money" },
      { key: "hsaSelf", label: "HSA, self-only", type: "money" },
      { key: "hsaFamily", label: "HSA, family", type: "money" },
    ])),
  ];
}

function scenariosTab() {
  const m = state.model;
  const rows = m.scenarios.map((x) => h("div", { class: "fitem" }, h("div", { class: "fhead" },
    h("b", {}, x.name, x.id === m.active ? " (open)" : ""),
    h("span", { class: "actions" },
      x.id === m.active ? null : h("button", { class: "small", onclick: () => {
        m.active = x.id;
        if (state.compare === x.id) state.compare = "";
        renderHeader();
        recompute();
        changed({ rerender: true });
      } }, "Open"),
      h("button", { class: "small", onclick: () => {
        const name = prompt("New name", x.name);
        if (!name) return;
        x.name = name.slice(0, 80);
        renderHeader();
        changed({ rerender: true });
      } }, "Rename"),
      h("button", { class: "small", onclick: () => {
        const name = prompt("Name for the copy", `${x.name} copy`);
        if (!name) return;
        const copy = { id: E.newId("sc"), name: name.slice(0, 80), inputs: structuredClone(x.inputs) };
        m.scenarios.push(copy);
        m.active = copy.id;
        state.compare = x.id;
        renderHeader();
        recompute();
        changed({ rerender: true });
      } }, "Duplicate"),
      m.scenarios.length > 1 ? h("button", { class: "small danger", onclick: () => {
        if (!confirm(`Delete the scenario "${x.name}"?`)) return;
        m.scenarios = m.scenarios.filter((y) => y.id !== x.id);
        if (m.active === x.id) m.active = m.scenarios[0].id;
        if (state.compare === x.id) state.compare = "";
        renderHeader();
        recompute();
        changed({ rerender: true });
      } }, "Delete") : null))));
  return [section("Scenarios", "Each scenario is a full copy of every input. Duplicate one, change a few things, and pick it under \"Compare with\" above the net worth chart. The sliders never change a saved scenario.", ...rows)];
}

function settingsTab(inp) {
  const L = state.link;
  const params = new URLSearchParams(location.search);
  const err = params.get("error");
  const drive = h("div", { class: "fitem" },
    h("div", { class: "fhead" }, h("b", {}, "Google Drive"), L.linked ? h("span", { class: "pill paid" }, "Linked") : h("span", { class: "pill" }, "Not linked")),
    err ? h("p", { class: "msg err" }, err) : null,
    L.linked
      ? h("div", {},
        h("p", {}, "Linked to ", h("b", {}, L.email), L.linked_by && L.linked_by !== L.email ? ` (by ${L.linked_by})` : "", ". Whoever of you is signed in reads and edits the same file through this site."),
        L.folder
          ? h("p", {}, "Saving to the folder ", h("a", { href: L.folder.url, target: "_blank", rel: "noopener noreferrer" }, L.folder.name), ", as lifetime-finances.json.")
          : h("p", { class: "msg err" }, "Pick a folder to start saving."),
        h("div", { class: "row" },
          h("a", { class: "btn primary", href: "/admin/personal/picker.html" }, L.folder ? "Change folder" : "Choose a folder"),
          h("button", { onclick: makeFolder }, "Make a \"Finances\" folder for me"),
          h("button", { class: "danger", onclick: unlink }, "Unlink")),
        h("p", { class: "desc" }, "Changing the folder moves the file there. \"Make a folder\" creates one in My Drive; you can drag it anywhere in Drive afterwards and saving keeps working."))
      : h("div", {},
        h("p", {}, "Link a Google account to save your model as one file in its Drive. This asks only for access to files this tool creates or that you pick for it, not your whole Drive."),
        h("a", { class: "btn primary", href: "/api/personal/drive/link" }, "Link Google Drive")));
  return [
    section("Saving", null, drive, h("div", { class: "row" }, h("button", { onclick: () => $("exportBtn").click() }, "Export JSON"), h("button", { onclick: () => $("importBtn").click() }, "Import JSON")), h("p", { class: "desc" }, "Export a copy now and then as a backup. Import replaces everything with a backup file.")),
    section("Plan", null, grid(inp.settings, [
      { key: "start", label: "Start month", type: "month", help: "Usually this month. Balances are as of this month." },
      { key: "weddingMonth", label: "Wedding month", type: "month", help: "Single filers until the wedding's tax year, married filing jointly from then on." },
      { key: "endAge", label: "Run until we're both", type: "int" },
    ])),
  ];
}

async function makeFolder() {
  const r = await call("POST", "/api/personal/drive/folder/new", {});
  if (r.status !== 200) return alert(r.data.error || "Couldn't make the folder.");
  state.link = { ...state.link, ...r.data };
  renderHeader();
  renderTab();
  if (state.dirty) save();
}
async function unlink() {
  if (!confirm("Unlink Google Drive? The file stays in your Drive; this tool just stops reading and saving it until you link again.")) return;
  const r = await call("POST", "/api/personal/drive/unlink", {});
  if (r.status !== 200) return alert(r.data.error || "Couldn't unlink.");
  state.link = { linked: false };
  state.version = null;
  renderHeader();
  renderTab();
  setStatus("Not saved: link Google Drive in Settings.", "err");
}

/* ---------------------------------------------------------------------- start -- */

if (location.hash === "#drive" || new URLSearchParams(location.search).has("error")) state.tab = "settings";
if (new URLSearchParams(location.search).get("drive") === "linked") state.tab = "settings";
await load();
if (state.tab === "settings") $("inputsCard").scrollIntoView({ block: "start" });
// The link result is shown once; keep it out of the address bar after that.
if (location.search) history.replaceState(null, "", "/admin/personal/");
