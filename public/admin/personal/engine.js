/**
 * The lifetime finance model: plain functions, no page code, no network. The page
 * (app.js) and the tests (tests/finance_test.mjs) both import this file.
 *
 *   defaultInputs(now)        a starting scenario with made-up placeholder numbers
 *   simulate(inputs, opts)    month by month from settings.start until both reach
 *                             settings.endAge; returns months, years, summary,
 *                             milestones and flags. opts.overrides: the sensitivity
 *                             sliders; opts.returns(yearIndex): Monte Carlo returns.
 *   monteCarlo(inputs, opts)  many runs with random yearly returns
 *   validate(inputs)          obvious mistakes, as [{ level, where, message }]
 *   yearTax(...)              one year's federal, FICA, Indiana and county tax
 *   amortizedPayment(...)     a loan's level monthly payment
 *
 * Money is nominal (future dollars) inside; `deflator` turns it into today's dollars.
 * Months are counted as year * 12 + (month - 1) ("2027-05" -> 24316).
 */

export const SCHEMA = 1;

/* ------------------------------------------------------------------- helpers -- */

export const monthIndex = (ym) => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ""));
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null;
};
export const ymOf = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
const num = (v, d = 0) => (v === "" || v == null || Number.isNaN(Number(v)) ? d : Number(v));
const opt = (v) => (v === "" || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const round2 = (n) => Math.round(n * 100) / 100;
let idSeq = 0;
export const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${(idSeq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

/** Level monthly payment on a loan of `principal` at `annualRate` over `months`. */
export function amortizedPayment(principal, annualRate, months) {
  if (!(principal > 0) || !(months > 0)) return 0;
  const r = annualRate / 12;
  if (!r) return principal / months;
  return (principal * r) / (1 - (1 + r) ** -months);
}

/* ---------------------------------------------------------------- account types -- */

export const ACCOUNT_TYPES = {
  checking: { label: "Checking", group: "cash", ret: "cash", cash: true },
  savings: { label: "Savings or HYSA", group: "cash", ret: "hysa", cash: true },
  emergency: { label: "Emergency fund", group: "cash", ret: "hysa", cash: true },
  house: { label: "House down payment fund", group: "cash", ret: "hysa", cash: true },
  brokerage: { label: "Brokerage", group: "brokerage", ret: "brokerage" },
  trad401k: { label: "Traditional 401(k)/403(b)", group: "traditional", ret: "retirement", limit: "k401" },
  roth401k: { label: "Roth 401(k)/403(b)", group: "roth", ret: "retirement", limit: "k401" },
  tradIRA: { label: "Traditional IRA", group: "traditional", ret: "retirement", limit: "ira" },
  rothIRA: { label: "Roth IRA", group: "roth", ret: "retirement", limit: "ira" },
  hsa: { label: "HSA", group: "hsa", ret: "hsa", limit: "hsa" },
  college529: { label: "529 college savings", group: "college", ret: "college" },
  // Money set aside for costs you'd rather pay yourselves than insure (pets, car repairs,
  // travel). Pets and budget categories can be paid from one. Never drawn for shortfalls.
  sinking: { label: "Set-aside fund (self-insure)", group: "cash", ret: "hysa", cash: true },
};
export const GROUP_LABELS = {
  cash: "Cash and savings",
  brokerage: "Brokerage",
  traditional: "Traditional retirement",
  roth: "Roth retirement",
  hsa: "HSA",
  college: "529",
  home: "Home equity",
  cars: "Cars",
  debt: "Debts",
};

/* ------------------------------------------------------------------- defaults -- */

/**
 * Tax figures for 2026, as published in late 2025. Each is an editable assumption.
 * Not re-checked online when this was written: check them before relying on them.
 */
export function defaultTax() {
  return {
    year: 2026,
    federal: {
      single: { standard: 16100, brackets: [[12400, 0.1], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [null, 0.37]] },
      married: { standard: 32200, brackets: [[24800, 0.1], [100800, 0.12], [211400, 0.22], [403550, 0.24], [512450, 0.32], [768700, 0.35], [null, 0.37]] },
    },
    fica: { ssRate: 0.062, ssWageBase: 184500, medicareRate: 0.0145, addlRate: 0.009, addlSingle: 200000, addlMarried: 250000 },
    ssTaxation: { single: [25000, 34000], married: [32000, 44000] },
    ltcgRate: 0.15,
    ctc: { perChild: 2200, phaseSingle: 200000, phaseMarried: 400000 },
    dependentCare: { fsaLimit: 7500, useFsa: true, creditRate: 0.2, capOne: 3000, capTwo: 6000 },
    indiana: { rate: 0.0295, rateLater: 0.029, rateLaterFrom: 2027, exemption: 1000, dependentExtra: 1500, county: 0.0202, countyName: "Marion" },
    limits: { k401: 24500, k401Catchup: 8000, ira: 7500, iraCatchup: 1100, hsaSelf: 4400, hsaFamily: 8750 },
    poverty: { base: 15650, perPerson: 5500 },
    earlyPenalty: 0.1,
    asOf: "2026 tax year, figures published Oct to Nov 2025",
    sources: [
      "Federal brackets and standard deduction: IRS Rev. Proc. 2025-32 (Oct 2025).",
      "401(k) $24,500 and IRA $7,500 limits: IRS Notice 2025-67 (Nov 2025).",
      "HSA $4,400 self / $8,750 family: IRS Rev. Proc. 2025-19 (May 2025).",
      "Social Security wage base $184,500: SSA 2026 COLA fact sheet (Oct 2025).",
      "Child tax credit $2,200 and dependent care FSA $7,500: One Big Beautiful Bill Act (July 2025).",
      "Indiana 2.95% for 2026 and 2.9% from 2027: Indiana Code 6-3-2-1, as amended by HEA 1001 (2023).",
      "Marion County 2.02%: Indiana Department of Revenue county tax rates. Check the current year's notice.",
      "Poverty line $15,650 plus $5,500 a person: HHS 2025 poverty guidelines.",
      "None of these were re-checked online when this tool was built. Confirm them before relying on the results.",
    ],
  };
}

export function defaultInputs(now = new Date()) {
  const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const y = now.getFullYear();
  // Placeholder numbers only. Replace them with yours on the page; they're never saved
  // anywhere but your Drive file.
  return {
    settings: { start, endAge: 95, weddingMonth: "2027-05", surplusAccount: "acct-checking", fiRate: 0.04, emergencyMonths: 6, priority: [] },
    assumptions: {
      inflation: 0.025, salaryGrowth: 0.03, homeAppreciation: 0.035, bracketIndexing: 0.025, limitGrowth: 0.025,
      returns: { cash: 0.0, hysa: 0.035, brokerage: 0.07, retirement: 0.07, hsa: 0.07, college: 0.06 },
      brokerageGainShare: 0.5, returnSd: 0.15,
    },
    tax: defaultTax(),
    people: [
      { id: "p1", name: "Patrick", birthYear: 1995, birthMonth: 1, retireAge: 65, ssMonthly: 2500, ssClaimAge: 67 },
      { id: "p2", name: "Kaitlyn", birthYear: 1995, birthMonth: 1, retireAge: 65, ssMonthly: 2500, ssClaimAge: 67 },
    ],
    incomes: [
      { id: "inc-1", owner: "p1", name: "Salary", kind: "salary", annual: 70000, start: "", end: "", growth: null, payMonth: 12, jumps: [], gaps: [], retirePct: 0.06, retireAccount: "acct-401k-1", matchType: "match", matchPct: 1, matchUpTo: 0.04, matchThreshold: 0.05, employerPct: 0.1, matchAccount: "", hsaEmployee: 0, hsaEmployer: 0, hsaAccount: "" },
      { id: "inc-2", owner: "p2", name: "Salary", kind: "salary", annual: 70000, start: "", end: "", growth: null, payMonth: 12, jumps: [], gaps: [], retirePct: 0.06, retireAccount: "acct-401k-2", matchType: "match", matchPct: 1, matchUpTo: 0.04, matchThreshold: 0.05, employerPct: 0.1, matchAccount: "", hsaEmployee: 0, hsaEmployer: 0, hsaAccount: "" },
    ],
    budget: {
      rent: { monthly: 1600, increase: 0.03 },
      utilities: { rent: 200, own: 350 },
      health: { premiumMonthly: 250, pretax: true, oopYearly: 1500, inflation: 0.05 },
      categories: [
        { id: "cat-1", name: "Groceries", amount: 700, freq: "monthly", inflation: null, start: "", end: "", owner: "shared" },
        { id: "cat-2", name: "Dining and fun", amount: 400, freq: "monthly", inflation: null, start: "", end: "", owner: "shared" },
        { id: "cat-3", name: "Phones and subscriptions", amount: 150, freq: "monthly", inflation: null, start: "", end: "", owner: "shared" },
        { id: "cat-4", name: "Travel", amount: 4000, freq: "yearly", inflation: null, start: "", end: "", owner: "shared" },
        { id: "cat-5", name: "Gifts", amount: 1500, freq: "yearly", inflation: null, start: "", end: "", owner: "shared" },
      ],
    },
    events: [
      { id: "ev-1", name: "Wedding", date: "2027-05", amount: 30000, kind: "expense", grows: false },
      { id: "ev-2", name: "Honeymoon", date: "2027-06", amount: 8000, kind: "expense", grows: false },
    ],
    pets: [],
    accounts: [
      { id: "acct-checking", name: "Checking", type: "checking", owner: "shared", balance: 5000, monthly: 0, ret: null, limit: null },
      { id: "acct-emergency", name: "Emergency fund", type: "emergency", owner: "shared", balance: 10000, monthly: 300, ret: null, limit: null },
      { id: "acct-house", name: "House fund", type: "house", owner: "shared", balance: 10000, monthly: 800, ret: null, limit: null },
      { id: "acct-401k-1", name: "Patrick 401(k)", type: "trad401k", owner: "p1", balance: 20000, monthly: 0, ret: null, limit: null },
      { id: "acct-401k-2", name: "Kaitlyn 401(k)", type: "trad401k", owner: "p2", balance: 20000, monthly: 0, ret: null, limit: null },
      { id: "acct-roth-1", name: "Patrick Roth IRA", type: "rothIRA", owner: "p1", balance: 5000, monthly: 200, ret: null, limit: null },
      { id: "acct-brokerage", name: "Brokerage", type: "brokerage", owner: "shared", balance: 0, monthly: 0, ret: null, limit: null },
    ],
    debts: [
      { id: "debt-1", name: "Student loan", kind: "student", balance: 25000, rate: 0.055, minPayment: 280, extra: 0, start: "", plan: "standard", termMonths: null, idrPct: 0.1, idrPovertyMult: 1.5, forgive: false, forgiveAfterMonths: 120, paymentsMade: 0, forgiveTaxable: false },
    ],
    house: {
      enabled: true, price: 325000, downPct: 0.2, closingPct: 0.03, mode: "auto", year: y + 3, month: 6, fundAccount: "acct-house",
      rate: 0.065, termYears: 30, pmiRate: 0.005, propertyTaxRate: 0.0085, insuranceYearly: 1800, hoaMonthly: 0, upkeepPct: 0.01,
      bigItems: [{ id: "big-1", name: "Roof", year: y + 20, cost: 15000 }, { id: "big-2", name: "HVAC", year: y + 15, cost: 9000 }, { id: "big-3", name: "Water heater", year: y + 12, cost: 2000 }],
      sell: { enabled: false, year: y + 15, costPct: 0.06, rebuy: true, newPrice: 450000, newDownPct: 0.2 },
    },
    cars: [
      { id: "car-1", name: "Car", owner: "shared", price: 30000, purchase: `${y - 2}-06`, cycleYears: 10, replace: true, until: null, loanRate: 0.065, loanMonths: 60, downPct: 0.2,
        existingLoanBalance: 0, existingLoanRate: 0.06, existingLoanPayment: 0,
        milesPerYear: 11000, mpg: 30, gasPrice: 3.1, gasInflation: 0.03, insuranceYearly: 1500, registrationYearly: 60, exciseFirstYear: 350,
        maintBase: 500, maintGrowth: 0.1, upkeepMonthly: 0, depFirstYear: 0.2, depYearly: 0.15 },
    ],
    kids: [],
    kidCosts: {
      bands: [
        { id: "band-1", label: "Infant and toddler childcare", fromAge: 0, toAge: 4, annual: 14000 },
        { id: "band-2", label: "School age", fromAge: 5, toAge: 12, annual: 7000 },
        { id: "band-3", label: "Teen", fromAge: 13, toAge: 17, annual: 9000 },
      ],
      birthCost: 4000, healthAddMonthly: 200, collegeGoal: 100000, childcareUnder: 13,
    },
    retirement: { mode: "budget", targetMonthly: 6000, rate: 0.04, order: ["cash", "brokerage", "traditional", "roth", "hsa"] },
  };
}

export function defaultModel(now = new Date()) {
  return { schema: SCHEMA, active: "base", scenarios: [{ id: "base", name: "Base", inputs: defaultInputs(now) }] };
}

/**
 * Fill in anything a saved or imported file is missing (an older version of the tool,
 * or a hand-edited backup), so the engine and the page never meet an undefined section.
 */
export function normalizeInputs(raw, now = new Date()) {
  const d = defaultInputs(now);
  const inp = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const arr = (v, fallback) => (Array.isArray(v) ? v : fallback);
  const out = {
    settings: { ...d.settings, ...obj(inp.settings) },
    assumptions: { ...d.assumptions, ...obj(inp.assumptions), returns: { ...d.assumptions.returns, ...obj(obj(inp.assumptions).returns) } },
    tax: { ...d.tax, ...obj(inp.tax) },
    people: arr(inp.people, d.people),
    incomes: arr(inp.incomes, []),
    budget: { ...d.budget, ...obj(inp.budget) },
    events: arr(inp.events, []),
    pets: arr(inp.pets, []),
    accounts: arr(inp.accounts, d.accounts),
    debts: arr(inp.debts, []),
    house: { ...d.house, ...obj(inp.house) },
    cars: arr(inp.cars, []),
    kids: arr(inp.kids, []),
    kidCosts: { ...d.kidCosts, ...obj(inp.kidCosts) },
    retirement: { ...d.retirement, ...obj(inp.retirement) },
  };
  for (const k of ["federal", "fica", "ssTaxation", "ctc", "dependentCare", "indiana", "limits", "poverty"]) out.tax[k] = { ...d.tax[k], ...obj(out.tax[k]) };
  for (const k of ["single", "married"]) out.tax.federal[k] = { ...d.tax.federal[k], ...obj(out.tax.federal[k]) };
  for (const k of ["rent", "utilities", "health"]) out.budget[k] = { ...d.budget[k], ...obj(out.budget[k]) };
  out.budget.categories = arr(out.budget.categories, []);
  out.house.bigItems = arr(out.house.bigItems, []);
  out.house.sell = { ...d.house.sell, ...obj(out.house.sell) };
  out.kidCosts.bands = arr(out.kidCosts.bands, d.kidCosts.bands);
  out.settings.priority = arr(out.settings.priority, []);
  out.retirement.order = arr(out.retirement.order, d.retirement.order);
  for (const inc of out.incomes) {
    inc.jumps = arr(inc.jumps, []);
    inc.gaps = arr(inc.gaps, []);
  }
  for (const k of out.kids) k.leave = arr(k.leave, []);
  for (const a of [...out.accounts, ...out.debts]) a.history = arr(a.history, []);
  return out;
}

/** A whole saved file: { schema, active, scenarios: [{ id, name, inputs }] }. Bare inputs become one scenario. */
export function normalizeModel(raw, now = new Date()) {
  if (raw && Array.isArray(raw.scenarios) && raw.scenarios.length) {
    const scenarios = raw.scenarios.filter((x) => x && typeof x === "object").map((x, n) => ({ id: typeof x.id === "string" && x.id ? x.id : `sc-${n}`, name: String(x.name || `Scenario ${n + 1}`), inputs: normalizeInputs(x.inputs, now) }));
    const active = scenarios.some((x) => x.id === raw.active) ? raw.active : scenarios[0].id;
    return { schema: SCHEMA, active, scenarios, savedAt: raw.savedAt || null, savedBy: raw.savedBy || null };
  }
  if (raw && typeof raw === "object" && (raw.people || raw.accounts || raw.incomes)) {
    return { schema: SCHEMA, active: "base", scenarios: [{ id: "base", name: "Base", inputs: normalizeInputs(raw, now) }] };
  }
  return defaultModel(now);
}

/* ------------------------------------------------------------------------ taxes -- */

/** Tax on `taxable` through `brackets` ([[upTo, rate], ..., [null, rate]]), each upTo × index. */
export function bracketTax(taxable, brackets, index = 1) {
  let tax = 0;
  let lower = 0;
  for (const [upTo, rate] of brackets) {
    const top = upTo == null ? Infinity : upTo * index;
    if (taxable > lower) tax += (Math.min(taxable, top) - lower) * rate;
    if (taxable <= top) break;
    lower = top;
  }
  return tax;
}

function marginalRate(taxable, brackets, index) {
  for (const [upTo, rate] of brackets) if (upTo == null || taxable < upTo * index) return rate;
  return brackets[brackets.length - 1][1];
}

/**
 * One filer's (or one couple's) tax for a year. `t` is the tax settings; `index` grows
 * the brackets, deductions and credits' thresholds from t.year. Income items:
 *   wages      wages after pre-tax 401(k)/403(b), HSA and cafeteria deductions
 *   ficaWages  [per person] wages after HSA and cafeteria deductions (401(k) still counts)
 *   ss         Social Security benefits; ordinary: other taxable income (traditional
 *              withdrawals, taxable forgiveness); ltcg: brokerage gains
 */
export function yearTax(t, { married, year, index = 1, wages = 0, ficaWages = [], ss = 0, ordinary = 0, ltcg = 0, people = 1, kidsUnder17 = 0, dependents = 0, childcare = 0, fsa = 0, penalty = 0 }) {
  const fed = married ? t.federal.married : t.federal.single;
  // Social Security: up to 85% is taxable, on the IRS's provisional-income formula.
  const [b1, b2] = (married ? t.ssTaxation.married : t.ssTaxation.single);
  const other = wages + ordinary + ltcg;
  const provisional = other + ss / 2;
  let ssTaxable = 0;
  if (provisional > b1) {
    ssTaxable = Math.min(0.5 * ss, 0.5 * (provisional - b1));
    if (provisional > b2) ssTaxable = Math.min(0.85 * ss, 0.85 * (provisional - b2) + Math.min(0.5 * ss, 0.5 * (b2 - b1)));
  }
  const agi = other + ssTaxable;
  const ordinaryTaxable = Math.max(0, agi - ltcg - fed.standard * index);
  let federal = bracketTax(ordinaryTaxable, fed.brackets, index) + Math.max(0, ltcg) * t.ltcgRate;
  // Child tax credit, $50 less per $1,000 over the phase-out; not refundable here.
  const phase = (married ? t.ctc.phaseMarried : t.ctc.phaseSingle);
  const ctcFull = t.ctc.perChild * index * kidsUnder17;
  const ctc = Math.max(0, ctcFull - Math.ceil(Math.max(0, agi - phase) / 1000) * 50);
  // Dependent care credit on childcare beyond the FSA, up to the cap.
  const cap = dependents >= 2 ? t.dependentCare.capTwo : dependents === 1 ? t.dependentCare.capOne : 0;
  const careCredit = Math.max(0, Math.min(childcare, cap) - fsa) * t.dependentCare.creditRate;
  const credits = Math.min(federal, ctc + careCredit);
  federal -= credits;
  federal += penalty;
  // FICA, per person: Social Security up to the wage base, Medicare on all, plus the
  // additional Medicare tax over the threshold.
  let fica = 0;
  const base = t.fica.ssWageBase * index;
  let medicareWages = 0;
  for (const w of ficaWages) {
    fica += Math.min(w, base) * t.fica.ssRate + w * t.fica.medicareRate;
    medicareWages += w;
  }
  fica += Math.max(0, medicareWages - (married ? t.fica.addlMarried : t.fica.addlSingle)) * t.fica.addlRate;
  // Indiana and county: federal AGI less Social Security, less exemptions.
  const inRate = year >= t.indiana.rateLaterFrom ? t.indiana.rateLater : t.indiana.rate;
  const inBase = Math.max(0, agi - ssTaxable - t.indiana.exemption * (people + dependents) - t.indiana.dependentExtra * dependents);
  const state = inBase * inRate;
  const county = inBase * t.indiana.county;
  const marginal = marginalRate(ordinaryTaxable, fed.brackets, index) + inRate + t.indiana.county;
  return { federal, fica, state, county, total: federal + fica + state + county, agi, ssTaxable, ctc: Math.min(ctc, federal + credits), careCredit, marginal };
}

/* ------------------------------------------------------------------ validation -- */

export function validate(inputs, now = new Date()) {
  const out = [];
  const add = (level, where, message) => out.push({ level, where, message });
  const thisYear = now.getFullYear();
  const peopleIds = new Set((inputs.people || []).map((p) => p.id));
  const accounts = new Map((inputs.accounts || []).map((a) => [a.id, a]));
  for (const p of inputs.people || []) {
    if (!(p.birthYear > 1900)) add("error", "People", `${p.name || "Someone"} needs a birth year.`);
    else if (p.birthYear + num(p.retireAge) < thisYear) add("warn", "People", `${p.name}'s retirement age (${p.retireAge}) has already passed.`);
    if (p.ssClaimAge && (p.ssClaimAge < 62 || p.ssClaimAge > 70)) add("warn", "Retirement", `${p.name}'s Social Security claiming age should be between 62 and 70.`);
  }
  for (const inc of inputs.incomes || []) {
    if (!peopleIds.has(inc.owner)) add("error", "Income", `"${inc.name}" isn't assigned to a person.`);
    if (inc.start && inc.end && monthIndex(inc.end) < monthIndex(inc.start)) add("error", "Income", `"${inc.name}" ends before it starts.`);
    if (num(inc.retirePct) > 0 && !accounts.has(inc.retireAccount)) add("error", "Income", `"${inc.name}" puts ${Math.round(inc.retirePct * 100)}% toward retirement but no retirement account is chosen.`);
    if (inc.matchType === "threshold" && num(inc.employerPct) > 0 && num(inc.retirePct) + 1e-9 < num(inc.matchThreshold)) {
      add("warn", "Income", `"${inc.name}": you put in ${+(num(inc.retirePct) * 100).toFixed(2)}%, under the ${+(num(inc.matchThreshold) * 100).toFixed(2)}% needed for the employer's ${+(num(inc.employerPct) * 100).toFixed(2)}%, so that money is left on the table.`);
    }
    if ((num(inc.hsaEmployee) || num(inc.hsaEmployer)) && !accounts.has(inc.hsaAccount)) add("error", "Income", `"${inc.name}" has HSA contributions but no HSA account is chosen.`);
    if (num(inc.annual) < 0) add("error", "Income", `"${inc.name}" has a negative amount.`);
  }
  for (const d of inputs.debts || []) {
    const interest = num(d.balance) * num(d.rate) / 12;
    if (num(d.balance) > 0 && d.plan !== "idr" && !(num(d.minPayment) > 0) && !(num(d.termMonths) > 0)) add("error", "Debts", `"${d.name}" has a balance but no payment.`);
    else if (d.plan !== "idr" && num(d.minPayment) > 0 && num(d.minPayment) + num(d.extra) <= interest) add("warn", "Debts", `"${d.name}"'s payment doesn't cover its interest, so it never shrinks.`);
    if (num(d.rate) > 1) add("warn", "Debts", `"${d.name}"'s rate looks like a whole number. Enter 6.5% as 6.5, which saves as 0.065.`);
  }
  // Balances last updated more than 90 days ago.
  const stale = (x, what) => {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(x.balanceAsOf || "")) ? new Date(`${x.balanceAsOf}T12:00:00`) : null;
    if (d && now - d > 90 * 864e5) add("warn", what, `"${x.name}"'s balance is from ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}. Update it on the Accounts tab.`);
  };
  for (const a of inputs.accounts || []) stale(a, "Accounts");
  for (const d of inputs.debts || []) stale(d, "Accounts");
  for (const a of inputs.accounts || []) {
    if (!ACCOUNT_TYPES[a.type]) add("error", "Accounts", `"${a.name}" has an unknown type.`);
    if (num(a.balance) < 0) add("warn", "Accounts", `"${a.name}" starts below zero.`);
  }
  if (!accounts.has(inputs.settings?.surplusAccount)) add("error", "Settings", "Choose an account to receive the leftover money each month.");
  const h = inputs.house;
  if (h?.enabled) {
    if (!(num(h.price) > 0)) add("error", "House", "The house is turned on but has no price.");
    if (h.mode === "auto" && !accounts.has(h.fundAccount)) add("error", "House", "Automatic buying needs a down payment fund account.");
    if (h.mode === "year" && num(h.year) < thisYear) add("warn", "House", "The purchase year has already passed.");
  }
  for (const c of inputs.cars || []) {
    if (!(num(c.price) > 0)) add("warn", "Cars", `"${c.name}" has no price.`);
    if (num(c.loanMonths) > 0 && !(num(c.loanRate) >= 0)) add("error", "Cars", `"${c.name}" has a loan with no rate.`);
    if (c.replace && !(num(c.cycleYears) > 0)) add("error", "Cars", `"${c.name}" is set to be replaced but has no replacement cycle.`);
  }
  for (const k of inputs.kids || []) if (!(k.birthYear > 1900)) add("error", "Kids", `${k.name || "A kid"} needs a birth year.`);
  for (const ev of inputs.events || []) if (monthIndex(ev.date) == null) add("error", "Events", `"${ev.name}" needs a month.`);
  if (num(inputs.assumptions?.inflation) > 0.2) add("warn", "Assumptions", "Inflation above 20% a year looks like a typo.");
  return out;
}

/* ------------------------------------------------------------------- the engine -- */

const DRAW_ORDER_CASH = ["checking", "savings", "emergency", "house"];

/**
 * Run the model. opts:
 *   overrides  { returnDelta, inflation, salaryGrowth, housePriceMult } (sliders)
 *   flowMonth  "YYYY-MM": record that month's flows for monthFlows()
 *   returns    (yearOffset) => { brokerage, retirement, hsa, college } random returns
 *   lean       skip month records (Monte Carlo)
 */
export function simulate(rawInputs, opts = {}) {
  const inputs = rawInputs;
  const ov = opts.overrides || {};
  const s = inputs.settings || {};
  const A = inputs.assumptions || {};
  const T = inputs.tax || defaultTax();
  const infl = ov.inflation != null ? ov.inflation : num(A.inflation);
  const salaryGrowth = ov.salaryGrowth != null ? ov.salaryGrowth : num(A.salaryGrowth);
  const returnDelta = num(ov.returnDelta);
  const housePriceMult = ov.housePriceMult != null ? ov.housePriceMult : 1;
  const start = monthIndex(s.start) ?? monthIndex(`${new Date().getFullYear()}-01`);
  const flowIdx = monthIndex(opts.flowMonth);
  const startYear = Math.floor(start / 12);
  const people = (inputs.people || []).filter((p) => p.birthYear > 1900);
  const pById = new Map(people.map((p) => [p.id, p]));
  const birthIdx = (p) => p.birthYear * 12 + (num(p.birthMonth, 1) - 1);
  const endAge = num(s.endAge, 95);
  const end = people.length ? Math.max(...people.map((p) => birthIdx(p) + endAge * 12)) : start + 60 * 12;
  const months = Math.max(1, end - start);
  const ageAt = (p, i) => (i - birthIdx(p)) / 12;
  const retireIdx = (p) => birthIdx(p) + Math.round(num(p.retireAge, 65) * 12);
  const allRetiredIdx = people.length ? Math.max(...people.map(retireIdx)) : end;
  const wedding = monthIndex(s.weddingMonth);
  const marriedIn = (year) => wedding != null && year >= Math.floor(wedding / 12);
  const F = (i) => (1 + infl) ** ((i - start) / 12); // price level vs today
  const yF = (year) => (1 + infl) ** (year - startYear);
  const taxIndex = (year) => (1 + num(A.bracketIndexing)) ** Math.max(0, year - num(T.year, startYear));
  const limitIndex = (year) => (1 + num(A.limitGrowth)) ** Math.max(0, year - num(T.year, startYear));

  /* accounts */
  const accounts = (inputs.accounts || []).filter((a) => ACCOUNT_TYPES[a.type]).map((a) => ({ ...a, bal: num(a.balance), info: ACCOUNT_TYPES[a.type], ytd: 0 }));
  const acct = new Map(accounts.map((a) => [a.id, a]));
  const surplusAcct = acct.get(s.surplusAccount) || accounts.find((a) => a.type === "checking") || accounts[0] || null;
  const meanReturn = (a) => {
    const base = a.ret != null && a.ret !== "" ? num(a.ret) : num(A.returns?.[a.info.ret]);
    return a.info.cash ? base : base + returnDelta;
  };

  /* flags, milestones */
  const flags = [];
  const flagged = new Set();
  const flag = (i, level, message, key = message) => {
    if (flagged.has(key)) return;
    flagged.add(key);
    flags.push({ month: ymOf(i), year: Math.floor(i / 12), level, message });
  };
  const milestones = [];
  const mile = (i, kind, label) => milestones.push({ month: ymOf(i), year: Math.floor(i / 12), kind, label });
  if (wedding != null && wedding >= start && wedding < end) mile(wedding, "wedding", "Wedding");
  for (const p of people) {
    if (retireIdx(p) >= start && retireIdx(p) < end) mile(retireIdx(p), "retire", `${p.name} retires`);
    const ssIdx = birthIdx(p) + Math.round(num(p.ssClaimAge, 67) * 12);
    if (num(p.ssMonthly) > 0 && ssIdx >= start && ssIdx < end) mile(ssIdx, "ss", `${p.name} starts Social Security`);
  }

  /* kids */
  const kids = (inputs.kids || []).filter((k) => k.birthYear > 1900).map((k) => ({ ...k, born: k.birthYear * 12 + num(k.birthMonth, 6) - 1 }));
  const KC = inputs.kidCosts || {};
  for (const k of kids) if (k.born >= start && k.born < end) mile(k.born, "kid", `${k.name || "Baby"} born`);
  // Parental leave becomes a pay gap on that person's salary.
  const leaveGaps = [];
  for (const k of kids) for (const l of k.leave || []) {
    const len = Math.max(1, Math.round((num(l.weeks) * 7) / 30.44));
    leaveGaps.push({ owner: l.person, from: k.born, to: k.born + len - 1, pctPaid: num(l.pctPaid) });
  }

  /* income: a pure function of the month, planned a year at a time for limits */
  const incomes = inputs.incomes || [];
  function streamAnnual(inc, i) {
    const st = monthIndex(inc.start);
    const year = Math.floor(i / 12);
    const firstYear = st != null ? Math.floor(st / 12) : startYear;
    const g = inc.growth != null && inc.growth !== "" ? num(inc.growth) : salaryGrowth;
    let annual = num(inc.annual) * (1 + g) ** Math.max(0, year - Math.max(firstYear, startYear));
    for (const j of (inc.jumps || []).slice().sort((a, b) => (monthIndex(a.date) ?? 0) - (monthIndex(b.date) ?? 0))) {
      const at = monthIndex(j.date);
      if (at == null || at > i) continue;
      if (opt(j.newAnnual) != null) annual = num(j.newAnnual) * (1 + g) ** Math.max(0, year - Math.floor(at / 12));
      else annual *= 1 + num(j.pct);
    }
    return annual;
  }
  function paidShare(inc, i) {
    let share = 1;
    for (const gap of [...(inc.gaps || []).map((g) => ({ from: monthIndex(g.start), to: monthIndex(g.end), pctPaid: num(g.pctPaid) })), ...(inc.kind === "salary" ? leaveGaps.filter((g) => g.owner === inc.owner) : [])]) {
      if (gap.from != null && i >= gap.from && (gap.to == null || i <= gap.to)) share = Math.min(share, gap.pctPaid);
    }
    return share;
  }
  const plans = new Map();
  function planYear(year) {
    if (plans.has(year)) return plans.get(year);
    const L = T.limits;
    const li = limitIndex(year);
    const used401 = new Map();
    const usedHsa = new Map();
    const out = [];
    for (let mo = 0; mo < 12; mo++) {
      const i = year * 12 + mo;
      const rec = { i, pay: [], ss: 0, ssBy: {}, wagesBy: {}, ficaBy: {}, pretax401: 0, roth401: 0, hsaEmp: 0, employer: 0, contribs: [], gross: 0, byKind: { salary: 0, bonus: 0, side: 0 }, byPerson: {} };
      const mine = (pid, kind, v) => {
        rec.byPerson[`${pid}.${kind}`] = (rec.byPerson[`${pid}.${kind}`] || 0) + v;
      };
      for (const inc of incomes) {
        const p = pById.get(inc.owner);
        if (!p) continue;
        const st = monthIndex(inc.start);
        const en = monthIndex(inc.end);
        if (st != null && i < st) continue;
        if (en != null && i > en) continue;
        if (i >= retireIdx(p)) continue;
        const annual = streamAnnual(inc, i) * paidShare(inc, i);
        const pay = inc.kind === "bonus" ? (mo + 1 === num(inc.payMonth, 12) ? annual : 0) : annual / 12;
        if (!(pay > 0)) continue;
        rec.gross += pay;
        rec.byKind[inc.kind in rec.byKind ? inc.kind : "salary"] += pay;
        mine(p.id, inc.kind in rec.byKind ? inc.kind : "salary", pay);
        rec.wagesBy[p.id] = (rec.wagesBy[p.id] || 0) + pay;
        rec.ficaBy[p.id] = (rec.ficaBy[p.id] || 0) + pay;
        // Employee retirement contribution, within the yearly limit (plus catch-up at 50).
        const ra = acct.get(inc.retireAccount);
        if (inc.kind !== "side" && ra && num(inc.retirePct) > 0) {
          const limit = (L.k401 + (ageAt(p, i) >= 50 ? L.k401Catchup : 0)) * li;
          const used = used401.get(p.id) || 0;
          const c = Math.max(0, Math.min(pay * num(inc.retirePct), limit - used));
          used401.set(p.id, used + c);
          if (c > 0) {
            rec.contribs.push({ acct: ra.id, amount: c, source: "employee" });
            if (ra.type === "roth401k") rec.roth401 += c;
            else {
              rec.pretax401 += c;
              rec.wagesBy[p.id] -= c;
            }
          }
          const matchTo = acct.get(inc.matchAccount) || ra;
          // Two kinds of employer money: a match on what you put in (rate × the first
          // "up to" % of pay), or a set % of pay once you put in at least a threshold.
          const m = inc.matchType === "threshold"
            ? (num(inc.retirePct) + 1e-9 >= num(inc.matchThreshold) ? pay * num(inc.employerPct) : 0)
            : pay * Math.min(num(inc.retirePct), num(inc.matchUpTo)) * num(inc.matchPct);
          if (m > 0) {
            rec.contribs.push({ acct: matchTo.id, amount: m, source: "employer" });
            rec.employer += m;
            mine(p.id, "employer", m);
          }
        }
        // HSA through payroll: pre-tax for income tax and FICA.
        const ha = acct.get(inc.hsaAccount);
        if (ha && (num(inc.hsaEmployee) || num(inc.hsaEmployer))) {
          const limit = (marriedIn(year) || kids.some((k) => k.born <= i) ? L.hsaFamily : L.hsaSelf) * li;
          const used = usedHsa.get(p.id) || 0;
          const er = Math.max(0, Math.min(num(inc.hsaEmployer) / 12 * (pay > 0 ? 1 : 0), limit - used));
          const ee = Math.max(0, Math.min(num(inc.hsaEmployee) / 12, limit - used - er));
          usedHsa.set(p.id, used + er + ee);
          if (er) {
            rec.contribs.push({ acct: ha.id, amount: er, source: "employer" });
            rec.employer += er;
            mine(p.id, "employer", er);
          }
          if (ee) {
            rec.contribs.push({ acct: ha.id, amount: ee, source: "employee" });
            rec.hsaEmp += ee;
            rec.wagesBy[p.id] -= ee;
            rec.ficaBy[p.id] -= ee;
          }
        }
      }
      for (const p of people) {
        const claim = birthIdx(p) + Math.round(num(p.ssClaimAge, 67) * 12);
        if (num(p.ssMonthly) > 0 && i >= claim) {
          const amt = num(p.ssMonthly) * (1 + infl) ** ((i - start) / 12);
          rec.ss += amt;
          rec.ssBy[p.id] = amt;
          mine(p.id, "ss", amt);
        }
      }
      out.push(rec);
    }
    plans.set(year, out);
    return out;
  }

  /* kids' costs for a month: { cost, childcare, health, birth, college, under17, under13, dependents } */
  function kidMonth(i) {
    const r = { cost: 0, childcare: 0, health: 0, birth: 0, college: 0, under17: 0, dependents: 0, count: 0 };
    for (const k of kids) {
      if (i < k.born) continue;
      const age = (i - k.born) / 12;
      r.count++;
      if (age < 17) r.under17++;
      if (age < 19) r.dependents++;
      if (i === k.born) r.birth += num(KC.birthCost) * F(i);
      if (age < 18) {
        r.health += num(KC.healthAddMonthly) * F(i);
        for (const b of KC.bands || []) if (age >= num(b.fromAge) && age < num(b.toAge) + 1) {
          const c = (num(b.annual) / 12) * F(i);
          r.cost += c;
          if (age < num(KC.childcareUnder, 13)) r.childcare += c;
        }
      }
      if (age >= 18 && age < 22 && (i - k.born) % 12 === 2) r.college += (num(KC.collegeGoal) / 4) * F(i);
    }
    return r;
  }

  /* debts */
  const debts = (inputs.debts || []).map((d) => ({ ...d, bal: num(d.balance), interest: 0, made: num(d.paymentsMade), startIdx: monthIndex(d.start), done: false, payment: num(d.minPayment) || amortizedPayment(num(d.balance), num(d.rate), num(d.termMonths)) }));

  /* house */
  const H = inputs.house || { enabled: false };
  const house = { owned: false, value: 0, loan: 0, loanRate: num(H.rate), payment: 0, boughtAt: null, sold: false, purchases: 0 };
  const housePrice = (i, base = H.price) => num(base) * housePriceMult * (1 + num(A.homeAppreciation)) ** ((i - start) / 12);
  function buyHouse(i, price, downPct, fromCash) {
    const down = price * downPct;
    const closing = price * num(H.closingPct);
    house.owned = true;
    house.value = price;
    house.loan = price - down;
    house.payment = amortizedPayment(house.loan, num(H.rate), num(H.termYears, 30) * 12);
    house.boughtAt = i;
    house.purchases++;
    mile(i, "house", house.purchases > 1 ? "Buy the next house" : "Buy the house");
    return fromCash(down + closing);
  }

  /* cars */
  const cars = (inputs.cars || []).map((c) => {
    const p0 = monthIndex(c.purchase) ?? start;
    const car = { ...c, base: num(c.price), rateBase: num(c.loanRate), boughtAt: p0, owned: false, price: num(c.price), loan: 0, loanPay: 0, loanRate: num(c.loanRate) };
    if (p0 < start) {
      // Already owned: the price is what was paid; any loan is the one there now.
      car.owned = true;
      car.loan = num(c.existingLoanBalance);
      car.loanRate = num(c.existingLoanRate);
      car.loanPay = num(c.existingLoanPayment) || amortizedPayment(car.loan, car.loanRate, 48);
    }
    return car;
  });
  const carValue = (car, i) => {
    const age = Math.max(0, (i - car.boughtAt) / 12);
    return car.price * (1 - num(car.depFirstYear)) ** Math.min(age, 1) * (1 - num(car.depYearly)) ** Math.max(0, age - 1);
  };
  const exciseFactor = (age) => Math.max(0.1, 0.87 ** Math.floor(age));

  /* retirement spending modes */
  const R = inputs.retirement || { mode: "budget" };
  let rateSpend = null;

  /* records */
  const monthsOut = [];
  const years = [];
  let yr = null;
  const emptyYear = (year) => ({
    year, months: 0, married: marriedIn(year), ages: people.map((p) => Math.floor(year - p.birthYear)),
    income: { salary: 0, bonus: 0, side: 0, ss: 0, employer: 0, windfall: 0 },
    incomeBy: {},
    paidFrom: {},
    pretax: { retirement: 0, hsa: 0, cafeteria: 0 },
    taxes: { federal: 0, fica: 0, state: 0, county: 0, total: 0 },
    housing: { rent: 0, utilities: 0, mortgage: 0, propertyTax: 0, insurance: 0, hoa: 0, upkeep: 0, pmi: 0, bigItems: 0, closing: 0 },
    cars: { purchase: 0, loan: 0, gas: 0, insurance: 0, registration: 0, excise: 0, maintenance: 0 },
    kids: { care: 0, health: 0, birth: 0, college: 0 },
    pets: 0, health: { premium: 0, outOfPocket: 0 },
    categories: {}, events: 0,
    debt: { payment: 0, extra: 0, interest: 0, forgiven: 0 },
    savings: {}, surplus: 0, shortfall: 0, unfunded: 0, withdrawals: {}, discretionary: 0,
  });
  const add = (obj, key, v) => {
    obj[key] = (obj[key] || 0) + v;
  };

  /* drawing money: cash first, then investments in the retirement order */
  const order = [...DRAW_ORDER_CASH.map((t) => ({ type: t })), ...(R.order || ["brokerage", "traditional", "roth", "hsa"]).filter((g) => g !== "cash").map((g) => ({ group: g }))];
  let yearExtra = { ordinary: 0, ltcg: 0, penalty: 0, withheld: 0 };
  let marg = 0.3;
  function draw(i, need, why, opts2 = {}) {
    // Returns what was covered: the leftover account first, then cash, then investments.
    // Withdrawals from traditional accounts are grossed up for tax at this year's
    // marginal rate (settled in December).
    let left = need;
    if (surplusAcct && surplusAcct.bal > 0) {
      const take = Math.min(surplusAcct.bal, left);
      surplusAcct.bal -= take;
      left -= take;
      add(yr.withdrawals, surplusAcct.id, take);
    }
    for (const o of order) {
      if (left <= 0.005) break;
      for (const a of accounts) {
        if (left <= 0.005) break;
        if (o.type ? a.type !== o.type : a.info.group !== o.group || a.info.cash) continue;
        if (opts2.skip?.has(a.id) || a.bal <= 0) continue;
        const owner = pById.get(a.owner);
        const early = owner && ageAt(owner, i) < 59.5 && ["traditional", "roth"].includes(a.info.group);
        let rate = 0;
        if (a.info.group === "traditional") rate = Math.min(0.6, marg + (early ? num(T.earlyPenalty) : 0));
        else if (a.info.group === "brokerage") rate = num(A.brokerageGainShare) * num(T.ltcgRate);
        else if (a.info.group === "roth" && early) rate = num(T.earlyPenalty) * 0.5;
        const gross = Math.min(a.bal, left / (1 - rate));
        a.bal -= gross;
        const net = gross * (1 - rate);
        left -= net;
        add(yr.withdrawals, a.id, gross);
        if (a.info.group === "traditional") yearExtra.ordinary += gross;
        if (a.info.group === "brokerage") yearExtra.ltcg += gross * num(A.brokerageGainShare);
        if (early) yearExtra.penalty += gross * num(T.earlyPenalty) * (a.info.group === "roth" ? 0.5 : 1);
        yearExtra.withheld += gross - net;
        if (!a.info.cash || a.type === "emergency" || a.type === "house") flag(i, a.info.cash ? "warn" : "info", `${why}: drew from ${a.name} in ${ymOf(i)}.`, `draw-${a.id}-${why}`);
      }
    }
    return need - Math.max(0, left);
  }

  let baseTax = null;
  let ytdShareTax = 0;
  let houseYear = null;
  let debtFreeAt = null;
  let fiYear = null;
  let runsOut = null;
  let rentNow = num(inputs.budget?.rent?.monthly);
  const rentInc = num(inputs.budget?.rent?.increase);
  const emergencyTargetMonths = num(s.emergencyMonths, 6);
  let lastRequired = 0;
  const goals = goalOrder(inputs, kids);
  const curTarget = {};
  const reached = {};
  const startPlan = { beforeGoals: 0, leftover: 0, goals: [], payroll: [] };
  /** Pay `v` from a set-aside or savings fund as far as it goes; returns what it covered. */
  function fromFund(id, v, group) {
    const a = id ? acct.get(id) : null;
    if (!a || !(v > 0) || a.bal <= 0) return 0;
    const take = Math.min(a.bal, v);
    a.bal -= take;
    add(yr.withdrawals, a.id, take);
    // What the fund paid for, so the one-month chart can draw it straight there.
    add(yr.paidFrom, `${a.id}|${group}`, take);
    return take;
  }
  /** A loan payment from its savings account (d.fundAccount), flagged once if it runs dry. */
  function loanFund(d, amount, i) {
    if (!d.fundAccount || !acct.get(d.fundAccount)) return 0;
    const got = fromFund(d.fundAccount, amount, "debt");
    if (got < amount - 0.5) flag(i, "warn", `${acct.get(d.fundAccount).name} ran short for ${d.name || "a loan"} in ${ymOf(i)}; pay covered the rest from then on.`, `loanfund-${d.id}`);
    return got;
  }
  /** An account's target balance in month i (future dollars), or null for none. */
  function targetFor(a, i, emergencyTarget) {
    if (a.type === "house" && H.enabled && a.id === H.fundAccount) return house.owned ? null : housePrice(i) * (num(H.downPct) + num(H.closingPct));
    if (a.type === "emergency") return emergencyTarget;
    if (opt(a.target) != null && num(a.target) > 0) return num(a.target) * F(i);
    if (a.type === "college529") {
      const n = kids.filter((k) => k.account === a.id && i < k.born + 18 * 12).length;
      return n ? n * num(KC.collegeGoal) * F(i) : null;
    }
    return null;
  }
  let netWorthStart = null;
  let thisYearSurplus = 0;
  let thisYearMonths = 0;

  for (let i = start; i < end; i++) {
    const year = Math.floor(i / 12);
    const mo = i % 12;
    if (!yr || yr.year !== year) {
      yr = emptyYear(year);
      years.push(yr);
      yearExtra = { ordinary: 0, ltcg: 0, penalty: 0, withheld: 0 };
      // This year's tax on its planned income, spread over its paychecks.
      const plan = planYear(year);
      baseTax = taxForYear(year, plan, { ordinary: 0, ltcg: 0, penalty: 0 });
      marg = baseTax.marginal;
      ytdShareTax = 0;
      for (const a of accounts) a.ytd = 0;
      // Retirement spending by withdrawal rate: set once, at the start of retirement.
      if (R.mode === "rate" && rateSpend == null && i >= allRetiredIdx) {
        const invested = accounts.filter((a) => !a.info.cash && a.info.group !== "college").reduce((t, a) => t + a.bal, 0);
        rateSpend = { annual: invested * num(R.rate, 0.04), at: i };
      }
    }
    yr.months++;
    // Each month's own flows (for the one-month chart) are the change in the year's totals.
    // Only for the month asked for (opts.flowMonth): every month would triple the run time.
    const snap = !opts.lean && i === flowIdx ? flatFlows(yr) : null;
    const rec = planYear(year)[mo];
    const f = F(i);
    const retired = i >= allRetiredIdx;
    const returnsNow = opts.returns ? opts.returns(year - startYear) : null;

    /* 1. growth */
    for (const a of accounts) {
      if (a.bal <= 0) continue;
      const r = returnsNow && !a.info.cash && returnsNow[a.info.ret] != null ? returnsNow[a.info.ret] : meanReturn(a);
      a.bal *= (1 + r) ** (1 / 12);
    }
    if (house.owned) house.value *= (1 + num(A.homeAppreciation)) ** (1 / 12);

    /* 2. pay, payroll deductions and tax withholding */
    const k = kidMonth(i);
    const fsaUse = num(T.dependentCare?.useFsa ? T.dependentCare.fsaLimit : 0) > 0 ? Math.min(k.childcare, (num(T.dependentCare.fsaLimit) / 12)) : 0;
    const healthPremium = num(inputs.budget?.health?.premiumMonthly) * (1 + num(inputs.budget?.health?.inflation)) ** ((i - start) / 12) + k.health;
    const cafeteria = (inputs.budget?.health?.pretax && rec.gross > 0 ? healthPremium : 0) + (rec.gross > 0 ? fsaUse : 0);
    yr.income.salary += rec.byKind.salary;
    yr.income.bonus += rec.byKind.bonus;
    yr.income.side += rec.byKind.side;
    yr.income.ss += rec.ss;
    yr.income.employer += rec.employer;
    for (const [k, v] of Object.entries(rec.byPerson)) add(yr.incomeBy, k, v);
    yr.pretax.retirement += rec.pretax401;
    yr.pretax.hsa += rec.hsaEmp;
    yr.pretax.cafeteria += cafeteria;
    const plan = planYear(year);
    const yearGross = plan.reduce((t, r) => t + r.gross + r.ss, 0);
    const share = yearGross > 0 ? (rec.gross + rec.ss) / yearGross : 0;
    const withheld = baseTax.total * share;
    ytdShareTax += withheld;
    for (const c of rec.contribs) {
      const a = acct.get(c.acct);
      a.bal += c.amount;
      if (c.source === "employee" || a.info.limit === "hsa") a.ytd += c.amount;
      add(yr.savings, a.id, c.amount);
    }
    let cash = rec.gross + rec.ss - rec.pretax401 - rec.roth401 - rec.hsaEmp - cafeteria - withheld;
    yr.taxes.total += withheld;
    for (const key of ["federal", "fica", "state", "county"]) yr.taxes[key] += baseTax[key] * share;
    if (rec.roth401) add(yr.pretax, "roth", rec.roth401);

    /* 3. required spending */
    let required = 0;
    const spend = (group, key, v) => {
      if (!(v > 0)) return;
      required += v;
      if (group) add(yr[group], key, v);
    };
    // House: buy (fixed date or when the fund is ready), sell, carry costs.
    if (H.enabled && !house.owned && !house.sold) {
      const price = housePrice(i);
      const needed = price * (num(H.downPct) + num(H.closingPct));
      const fund = acct.get(H.fundAccount);
      const due = H.mode === "year" ? i === num(H.year) * 12 + num(H.month, 6) - 1 : fund && fund.bal >= needed;
      if (due) {
        yr.housing.closing += price * num(H.closingPct);
        buyHouse(i, price, num(H.downPct), (need) => {
          let left = need;
          if (fund) {
            const take = Math.min(fund.bal, left);
            fund.bal -= take;
            left -= take;
          }
          if (left > 0.5) {
            flag(i, "warn", `The down payment fund was ${money(left)} short when buying the house in ${ymOf(i)}; the rest came from savings.`);
            const got = draw(i, left, "House purchase");
            if (got < left - 0.5) {
              yr.unfunded += left - got;
              surplusAcct && (surplusAcct.bal -= left - got);
            }
          }
          return need;
        });
        houseYear = houseYear ?? year;
        if (fund && H.mode === "auto" && !reached[fund.id]) reached[fund.id] = ymOf(i);
        // What's left in the fund goes to the leftover account.
        if (fund && surplusAcct && fund !== surplusAcct && fund.bal > 0) {
          surplusAcct.bal += fund.bal;
          fund.bal = 0;
        }
      }
    }
    if (H.enabled && house.owned && H.sell?.enabled && i === num(H.sell.year) * 12 + 5) {
      const proceeds = house.value * (1 - num(H.sell.costPct)) - house.loan;
      house.owned = false;
      house.loan = 0;
      house.value = 0;
      mile(i, "house", "Sell the house");
      let cashIn = proceeds;
      if (H.sell.rebuy) {
        const price = housePrice(i, H.sell.newPrice);
        cashIn -= price * (num(H.sell.newDownPct) + num(H.closingPct));
        yr.housing.closing += price * num(H.closingPct);
        buyHouse(i, price, num(H.sell.newDownPct), (n) => n);
      } else {
        house.sold = true;
        rentNow = num(inputs.budget?.rent?.monthly) * F(i);
      }
      if (cashIn >= 0) surplusAcct && (surplusAcct.bal += cashIn);
      else {
        const got = draw(i, -cashIn, "Next house");
        if (got < -cashIn - 0.5) yr.unfunded += -cashIn - got;
      }
    }
    if (house.owned) {
      const interest = (house.loan * num(house.loanRate)) / 12;
      const pay = Math.min(house.payment, house.loan + interest);
      house.loan = Math.max(0, house.loan + interest - pay);
      spend("housing", "mortgage", pay);
      if (house.loan / house.value > 0.8) spend("housing", "pmi", (house.loan * num(H.pmiRate)) / 12);
      spend("housing", "propertyTax", (house.value * num(H.propertyTaxRate)) / 12);
      spend("housing", "insurance", (num(H.insuranceYearly) * f) / 12);
      spend("housing", "hoa", num(H.hoaMonthly) * f);
      spend("housing", "upkeep", (house.value * num(H.upkeepPct)) / 12);
      for (const b of H.bigItems || []) if (num(b.year) * 12 + 5 === i) spend("housing", "bigItems", num(b.cost) * f);
      spend("housing", "utilities", num(inputs.budget?.utilities?.own) * f);
    } else {
      if (mo === 0 && i !== start) rentNow *= 1 + rentInc;
      spend("housing", "rent", rentNow);
      spend("housing", "utilities", num(inputs.budget?.utilities?.rent) * f);
    }
    // Health
    if (!(inputs.budget?.health?.pretax && rec.gross > 0)) spend("health", "premium", healthPremium);
    else add(yr.health, "premium", healthPremium);
    spend("health", "outOfPocket", (num(inputs.budget?.health?.oopYearly) / 12) * (1 + num(inputs.budget?.health?.inflation)) ** ((i - start) / 12));
    // Kids (childcare paid through the FSA is already out of pay)
    spend("kids", "care", k.cost - (rec.gross > 0 ? fsaUse : 0));
    if (rec.gross > 0 && fsaUse) add(yr.kids, "care", fsaUse);
    spend("kids", "birth", k.birth);
    if (k.college > 0) {
      let left = k.college;
      for (const a of accounts) if (a.type === "college529" && left > 0 && a.bal > 0) {
        const take = Math.min(a.bal, left);
        a.bal -= take;
        left -= take;
        add(yr.withdrawals, a.id, take);
      }
      add(yr.kids, "college", k.college);
      required += left;
    }
    // Pets (from their set-aside fund first, when they have one)
    for (const p of inputs.pets || []) {
      const st = monthIndex(p.start) ?? start;
      if (i < st || (opt(p.endYear) != null && year > num(p.endYear))) continue;
      const v = (num(p.annual) / 12) * f + (i === st ? num(p.oneTime) * f : 0);
      required += v - fromFund(p.fundAccount, v, "pets");
      yr.pets += v;
    }
    // Budget categories (replaced in retirement when a target or rate is set)
    let lifestyle = 0;
    for (const c of inputs.budget?.categories || []) {
      const st = monthIndex(c.start);
      const en = monthIndex(c.end);
      if ((st != null && i < st) || (en != null && i > en)) continue;
      const g = c.inflation != null && c.inflation !== "" ? num(c.inflation) : infl;
      const scale = (1 + g) ** ((i - start) / 12);
      const v = c.freq === "yearly" ? (mo === ((st ?? 0) % 12) ? num(c.amount) * scale : 0) : num(c.amount) * scale;
      if (retired && R.mode !== "budget") {
        lifestyle += v;
        continue;
      }
      lifestyle += v - fromFund(c.fundAccount, v, "categories");
      add(yr.categories, c.name || "Other", v);
    }
    if (retired && R.mode === "target") {
      lifestyle = num(R.targetMonthly) * f;
      add(yr.categories, "Retirement spending", lifestyle);
    } else if (retired && R.mode === "rate" && rateSpend) {
      lifestyle = (rateSpend.annual / 12) * (1 + infl) ** ((i - rateSpend.at) / 12);
      add(yr.categories, "Retirement spending", lifestyle);
    }
    required += lifestyle;
    yr.discretionary += lifestyle;
    // One-time events
    for (const ev of inputs.events || []) {
      if (monthIndex(ev.date) !== i) continue;
      const v = num(ev.amount) * (ev.grows ? f : 1);
      if (ev.kind === "windfall") {
        cash += v;
        yr.income.windfall += v;
      } else {
        required += v;
        yr.events += v;
      }
      mile(i, "event", ev.name || "Event");
    }
    // Cars: buy and replace, loans, running costs, value
    for (const car of cars) {
      const firstBuy = !car.owned && i === car.boughtAt;
      const replaceDue = car.owned && car.replace && num(car.cycleYears) > 0 && i - car.boughtAt >= num(car.cycleYears) * 12 && (opt(car.until) == null || year <= num(car.until));
      if (firstBuy || replaceDue) {
        // The trade-in pays off the old loan first, then goes toward the new car.
        const tradeIn = replaceDue ? carValue(car, i) : 0;
        const owed = car.base * f + (replaceDue ? car.loan : 0) - tradeIn;
        car.price = car.base * f;
        car.boughtAt = i;
        car.owned = true;
        const financing = num(car.loanMonths) > 0;
        const cashPart = financing ? Math.min(Math.max(0, owed), car.price * num(car.downPct)) : Math.max(0, owed);
        const financed = financing ? Math.max(0, owed - cashPart) : 0;
        if (owed < 0) cash += -owed;
        car.loan = financed;
        car.loanRate = car.rateBase;
        car.loanPay = amortizedPayment(financed, car.loanRate, num(car.loanMonths));
        spend("cars", "purchase", cashPart);
        mile(i, "car", `${firstBuy ? "Buy" : "Replace"} ${car.name || "car"}`);
      }
      if (!car.owned) continue;
      if (car.loan > 0) {
        const interest = (car.loan * car.loanRate) / 12;
        const pay = Math.min(car.loanPay || car.loan + interest, car.loan + interest);
        car.loan = Math.max(0, car.loan + interest - pay);
        spend("cars", "loan", pay);
        add(yr.debt, "interest", interest);
      }
      const age = (i - car.boughtAt) / 12;
      spend("cars", "gas", (num(car.milesPerYear) / 12 / Math.max(1, num(car.mpg, 25))) * num(car.gasPrice) * (1 + num(car.gasInflation)) ** ((i - start) / 12));
      spend("cars", "insurance", (num(car.insuranceYearly) / 12) * f);
      spend("cars", "registration", (num(car.registrationYearly) / 12) * f);
      // Indiana's excise falls with the car's age; it scales with the price paid.
      spend("cars", "excise", (num(car.exciseFirstYear) / 12) * exciseFactor(age) * (car.base > 0 ? car.price / car.base : 1));
      spend("cars", "maintenance", (num(car.maintBase) / 12) * (1 + num(car.maintGrowth)) ** age * f + num(car.upkeepMonthly) * f);
    }
    // Debts: minimum payments (IDR: a share of income over the poverty line)
    const famSize = (marriedIn(year) ? 2 : 1) + k.count;
    const lastAgi = years.length > 1 ? years[years.length - 2].agi || 0 : baseTax.agi;
    for (const d of debts) {
      if (d.done || (d.startIdx != null && i < d.startIdx)) continue;
      if (d.bal <= 0.005) continue;
      const interest = (d.bal * num(d.rate)) / 12;
      d.bal += interest;
      d.interest += interest;
      add(yr.debt, "interest", interest);
      let pay = d.payment;
      if (d.plan === "idr") {
        const pov = (num(T.poverty.base) + num(T.poverty.perPerson) * (famSize - 1)) * yF(year);
        pay = Math.max(0, ((lastAgi - num(d.idrPovertyMult, 1.5) * pov) * num(d.idrPct, 0.1)) / 12);
        if (num(d.minPayment) > 0) pay = Math.min(pay, num(d.minPayment));
      }
      pay = Math.min(pay, d.bal);
      d.bal -= pay;
      // Paid from savings (d.fundAccount) first, when chosen; pay covers the rest.
      const fromSavings = loanFund(d, pay, i);
      required += pay - fromSavings;
      add(yr.debt, "payment", pay);
      d.made++;
      if (d.forgive && d.made >= num(d.forgiveAfterMonths) && d.bal > 0.005) {
        add(yr.debt, "forgiven", d.bal);
        if (d.forgiveTaxable) yearExtra.ordinary += d.bal;
        mile(i, "debt", `${d.name || "Loan"} forgiven`);
        d.bal = 0;
      }
      if (d.bal <= 0.005 && !d.done) {
        d.done = true;
        d.paidAt = i;
        if (!yr.debt.forgiven || !d.forgive) mile(i, "debt", `${d.name || "Loan"} paid off`);
      }
    }
    lastRequired = required;

    /* 4. the waterfall: cash covers required spending, then goals in order, then surplus */
    cash -= required;
    if (cash < -0.005) {
      const need = -cash;
      const got = draw(i, need, retired ? "Retirement spending" : "Shortfall");
      yr.shortfall += got;
      if (got < need - 0.5) {
        yr.unfunded += need - got;
        if (surplusAcct) surplusAcct.bal -= need - got;
        runsOut = runsOut ?? year;
        flag(i, "error", `The money runs out in ${ymOf(i)}: ${money(need - got)} of spending isn't covered, so ${surplusAcct?.name || "checking"} goes below zero.`, `out-${year}`);
      }
      cash = 0;
    }
    const surplusBeforeGoals = cash;
    // Goals: each account's monthly contribution and each debt's extra payment, in the
    // order set on the page, while cash lasts. Limits, the emergency target and the
    // house target stop a goal once met.
    const emergencyTarget = emergencyTargetMonths * required;
    // Each account's target this month (the first month it's reached is noted below).
    for (const a of accounts) curTarget[a.id] = targetFor(a, i, emergencyTarget);
    for (const g of goals) {
      if (g.kind === "debt") {
        const d = debts.find((x) => x.id === g.id);
        if (!d || d.done || d.bal <= 0 || !(num(d.extra) > 0) || (d.startIdx != null && i < d.startIdx)) continue;
        // Extra payments come from the loan's savings account first, then what's left of pay.
        const want = Math.min(num(d.extra), d.bal);
        const fromSavings = loanFund(d, want, i);
        const fromPay = Math.max(0, Math.min(cash, want - fromSavings));
        const pay = fromSavings + fromPay;
        if (!(pay > 0)) continue;
        d.bal -= pay;
        cash -= fromPay;
        add(yr.debt, "extra", pay);
        if (d.bal <= 0.005) {
          d.done = true;
          d.paidAt = i;
          mile(i, "debt", `${d.name || "Loan"} paid off`);
        }
        continue;
      }
      if (cash <= 0.005) continue;
      const a = acct.get(g.id);
      if (!a) continue;
      let want = g.kind === "kid529" ? num(g.monthly) : num(a.monthly);
      if (g.kind === "kid529" && g.until != null && i >= g.until) continue;
      if (!(want > 0)) continue;
      if (a.type === "house" && (house.owned || !H.enabled)) continue;
      // Contributions stop at the target (house: auto-buy target; emergency: months of
      // spending; any account: its own target, in today's dollars).
      const t = curTarget[a.id];
      if (t != null && t > 0 && a.bal >= t && !(a.type === "house" && H.mode === "year")) continue;
      const lim = annualLimit(a, i);
      if (lim != null) want = Math.min(want, Math.max(0, lim - a.ytd));
      const c = Math.min(cash, want);
      if (!(c > 0)) continue;
      a.bal += c;
      a.ytd += c;
      cash -= c;
      add(yr.savings, a.id, c);
      if (i === start) startPlan.goals.push({ key: g.key, id: a.id, label: g.label, amount: c, wanted: g.kind === "kid529" ? num(g.monthly) : num(a.monthly) });
      if (a.info.group === "traditional" && a.type === "tradIRA") yearExtra.ordinary -= c; // deductible IRA
    }
    if (cash > 0 && surplusAcct) {
      surplusAcct.bal += cash;
      add(yr.savings, surplusAcct.id, cash);
      yr.surplus += cash;
    }
    for (const a of accounts) {
      const t = curTarget[a.id];
      if (t != null && t > 0 && a.bal >= t - 0.5 && !reached[a.id]) reached[a.id] = ymOf(i);
    }
    if (i === start) {
      startPlan.beforeGoals = surplusBeforeGoals;
      startPlan.leftover = Math.max(0, cash);
      startPlan.payroll = rec.contribs.map((c) => ({ id: c.acct, amount: c.amount, source: c.source }));
    }

    /* 5. December: settle the year's tax on what actually happened */
    if (mo === 11 || i === end - 1) {
      const actual = taxForYear(year, planYear(year), yearExtra);
      const settle = actual.total - baseTax.total - yearExtra.withheld;
      yr.agi = actual.agi;
      if (!retired && yr.shortfall > yr.surplus + 1) flag(i, "warn", `${year}: spending was ${money(yr.shortfall - yr.surplus)} more than income; savings covered it.`, `short-${year}`);
      for (const key of ["federal", "state", "county"]) yr.taxes[key] += actual[key] - baseTax[key];
      yr.taxes.total += actual.total - baseTax.total;
      if (settle > 0.5) {
        const got = draw(i, settle, "Year-end taxes", { skip: new Set() });
        if (got < settle - 0.5) {
          yr.unfunded += settle - got;
          if (surplusAcct) surplusAcct.bal -= settle - got;
        }
      } else if (settle < -0.5 && surplusAcct) surplusAcct.bal -= settle;
    }

    /* 6. net worth and milestones */
    const homeEquity = house.owned ? house.value - house.loan : 0;
    const carVal = cars.filter((c) => c.owned).reduce((t, c) => t + carValue(c, i), 0);
    const carLoans = cars.reduce((t, c) => t + c.loan, 0);
    const debtBal = debts.reduce((t, d) => t + Math.max(0, d.bal), 0);
    const byGroup = { cash: 0, brokerage: 0, traditional: 0, roth: 0, hsa: 0, college: 0 };
    for (const a of accounts) byGroup[a.info.group] += a.bal;
    const assets = Object.values(byGroup).reduce((t, v) => t + v, 0) + (house.owned ? house.value : 0) + carVal;
    const liabilities = (house.owned ? house.loan : 0) + carLoans + debtBal;
    const netWorth = assets - liabilities;
    if (netWorthStart == null) netWorthStart = netWorth;
    if (debtFreeAt == null && debtBal <= 0.005 && debts.some((d) => num(d.balance) > 0)) debtFreeAt = i;
    if (year === startYear) {
      thisYearSurplus += surplusBeforeGoals;
      thisYearMonths++;
    }
    if (mo === 11 || i === end - 1) {
      yr.balances = Object.fromEntries(accounts.map((a) => [a.id, a.bal]));
      yr.byGroup = { ...byGroup, home: homeEquity, homeValue: house.owned ? house.value : 0, mortgage: house.owned ? house.loan : 0, cars: carVal, carLoans, debts: debtBal };
      yr.netWorth = netWorth;
      yr.deflator = F(i);
      yr.debtBalances = Object.fromEntries(debts.map((d) => [d.id, Math.max(0, d.bal)]));
      yr.targets = { ...curTarget };
      yr.required = required;
      // Financial independence: invested assets at the FI rate cover this year's spending.
      const invested = byGroup.brokerage + byGroup.traditional + byGroup.roth + byGroup.hsa + Math.max(0, byGroup.cash);
      const yearSpend = yr.discretionary + Object.values(yr.housing).reduce((t, v) => t + v, 0) + Object.values(yr.cars).reduce((t, v) => t + v, 0) + yr.health.outOfPocket + yr.pets + Object.values(yr.kids).reduce((t, v) => t + v, 0);
      yr.spending = yearSpend;
      if (fiYear == null && yr.months === 12 && invested * num(s.fiRate, 0.04) >= yearSpend) {
        fiYear = year;
        mile(i, "fi", "Financially independent");
      }
    }
    if (!opts.lean) {
      let flows = null;
      if (snap) {
        flows = {};
        for (const [k, v] of Object.entries(flatFlows(yr))) {
          const d = v - (snap[k] || 0);
          if (Math.abs(d) > 0.005) flows[k] = d;
        }
      }
      monthsOut.push({ i, month: ymOf(i), year, netWorth, cash: byGroup.cash, required, deflator: F(i), flows });
    }
  }
  if (debtFreeAt != null) mile(debtFreeAt, "debt", "Debt free (not counting the mortgage)");
  if (runsOut != null) mile(runsOut * 12, "out", "Money runs out");

  /* summary */
  const real = (v, year) => v / ((years.find((y) => y.year === year)?.deflator) || 1);
  const retYear = Math.floor(allRetiredIdx / 12);
  const retRow = years.find((y) => y.year === retYear) || years[years.length - 1];
  const first = years[0];
  const startAccounts = (inputs.accounts || []).filter((a) => ACCOUNT_TYPES[a.type]);
  const cashStart = startAccounts.filter((a) => ["checking", "savings", "emergency"].includes(a.type)).reduce((t, a) => t + num(a.balance), 0);
  const firstMonthSpending = monthsOut[0]?.required || lastRequired || 1;
  const savedFirst = first ? Object.values(first.savings).reduce((t, v) => t + v, 0) + first.debt.extra : 0;
  const grossFirst = first ? first.income.salary + first.income.bonus + first.income.side + first.income.employer : 0;
  const summary = {
    netWorthToday: netWorthStart ?? 0,
    netWorthAtRetirement: retRow ? real(retRow.netWorth, retRow.year) : null,
    retirementYear: retYear,
    monthlySurplus: thisYearMonths ? thisYearSurplus / thisYearMonths : 0,
    savingsRate: grossFirst > 0 ? savedFirst / grossFirst : 0,
    emergencyMonths: cashStart / Math.max(1, firstMonthSpending),
    houseYear,
    debtFreeYear: debtFreeAt != null ? Math.floor(debtFreeAt / 12) : null,
    fiYear,
    lasts: runsOut == null,
    runsOutYear: runsOut,
    endYear: Math.floor((end - 1) / 12),
    totalInterest: debts.reduce((t, d) => t + d.interest, 0),
    reached,
    startPlan,
    debts: debts.map((d) => ({ id: d.id, name: d.name, interest: d.interest, paidOff: d.paidAt != null ? ymOf(d.paidAt) : null, forgiven: d.forgive && d.paidAt != null })),
  };
  milestones.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  const seen = new Set();
  const uniqueMilestones = milestones.filter((m) => {
    const key = `${m.month}|${m.label.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { start: ymOf(start), end: ymOf(end - 1), years, months: monthsOut, summary, milestones: uniqueMilestones, flags, people: people.map((p) => ({ id: p.id, name: p.name })), surplusAccount: surplusAcct?.id || null, accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, group: a.info.group })) };

  function annualLimit(a, i) {
    const L = T.limits;
    const li = limitIndex(Math.floor(i / 12));
    const owner = pById.get(a.owner);
    const fifty = owner && ageAt(owner, i) >= 50;
    if (a.limit != null && a.limit !== "") return num(a.limit) * li;
    if (a.info.limit === "ira") return (L.ira + (fifty ? L.iraCatchup : 0)) * li;
    if (a.info.limit === "k401") return (L.k401 + (fifty ? L.k401Catchup : 0)) * li;
    if (a.info.limit === "hsa") return (marriedIn(Math.floor(i / 12)) ? L.hsaFamily : L.hsaSelf) * li;
    return null;
  }

  function taxForYear(year, plan, extra) {
    const married = marriedIn(year);
    const index = taxIndex(year);
    const kidsAt = kidMonth(year * 12 + 11);
    const childcare = plan.reduce((t, r) => t + kidMonth(r.i).childcare, 0);
    const fsa = T.dependentCare?.useFsa ? Math.min(childcare, num(T.dependentCare.fsaLimit)) : 0;
    const sum = (key) => plan.reduce((t, r) => {
      const by = r[key];
      return t + Object.values(by).reduce((x, v) => x + v, 0);
    }, 0);
    const premium = inputs.budget?.health?.pretax ? plan.reduce((t, r) => t + (r.gross > 0 ? num(inputs.budget.health.premiumMonthly) * (1 + num(inputs.budget.health.inflation)) ** ((r.i - start) / 12) + kidMonth(r.i).health : 0), 0) : 0;
    const cafeteria = premium + fsa;
    if (married || people.length < 2) {
      const ficaWages = people.map((p) => Math.max(0, plan.reduce((t, r) => t + (r.ficaBy[p.id] || 0), 0) - cafeteria / Math.max(1, people.length)));
      return yearTax(T, { married, year, index, wages: Math.max(0, sum("wagesBy") - cafeteria), ficaWages, ss: sum("ssBy"), ordinary: extra.ordinary, ltcg: extra.ltcg, penalty: extra.penalty, people: married ? 2 : 1, kidsUnder17: kidsAt.under17, dependents: kidsAt.dependents, childcare, fsa });
    }
    // Before the wedding: each files single; shared items split evenly.
    const out = { federal: 0, fica: 0, state: 0, county: 0, total: 0, agi: 0, marginal: 0 };
    people.forEach((p, n) => {
      const wages = plan.reduce((t, r) => t + (r.wagesBy[p.id] || 0), 0) - cafeteria / people.length;
      const fica = plan.reduce((t, r) => t + (r.ficaBy[p.id] || 0), 0) - cafeteria / people.length;
      const r = yearTax(T, { married: false, year, index, wages: Math.max(0, wages), ficaWages: [Math.max(0, fica)], ss: plan.reduce((t, x) => t + (x.ssBy[p.id] || 0), 0), ordinary: extra.ordinary / people.length, ltcg: extra.ltcg / people.length, penalty: extra.penalty / people.length, people: 1, kidsUnder17: n === 0 ? kidsAt.under17 : 0, dependents: n === 0 ? kidsAt.dependents : 0, childcare: n === 0 ? childcare : 0, fsa: n === 0 ? fsa : 0 });
      for (const key of ["federal", "fica", "state", "county", "total", "agi"]) out[key] += r[key];
      out.marginal = Math.max(out.marginal, r.marginal);
    });
    return out;
  }
}

/* ----------------------------------------------------- one month's flows -- */

const FLOW_GROUPS = ["income", "incomeBy", "paidFrom", "taxes", "housing", "cars", "kids", "health", "categories", "debt", "savings", "withdrawals"];
function flatFlows(y) {
  const o = { pets: y.pets, events: y.events, surplus: y.surplus };
  for (const g of FLOW_GROUPS) for (const [k, v] of Object.entries(y[g] || {})) o[`${g}.${k}`] = v;
  return o;
}

const FLOW_LABELS = {
  salary: "Salary", bonus: "Bonus", side: "Side income", ss: "Social Security", employer: "Employer money", windfall: "Windfalls",
  federal: "Federal", fica: "FICA", state: "Indiana", county: "County",
  rent: "Rent", utilities: "Utilities", mortgage: "Mortgage", propertyTax: "Property tax", insurance: "Insurance", hoa: "HOA", upkeep: "Upkeep", pmi: "PMI", bigItems: "Big repairs", closing: "Closing costs",
  purchase: "Car purchase", loan: "Car loan", gas: "Gas", registration: "Registration", excise: "Excise tax", maintenance: "Maintenance",
  care: "Care and activities", birth: "Birth", college: "College",
  premium: "Health premiums", outOfPocket: "Out-of-pocket",
  payment: "Required payments", extra: "Extra payments",
};
export const FLOW_GROUP_LABELS = { taxes: "Taxes", housing: "Housing", cars: "Cars", kids: "Kids", health: "Health", categories: "Spending", pets: "Pets", events: "One-time events", debt: "Loan payments", retirement: "Retirement and HSA", savings: "Savings", leftover: "Leftover", adjust: "Held for later" };
export const FLOW_ORDER = ["taxes", "housing", "cars", "kids", "health", "categories", "pets", "events", "debt", "retirement", "savings", "leftover", "adjust"];
const RETIREMENT_GROUPS = new Set(["traditional", "roth", "hsa"]);

/**
 * Where one month's money came from and went, for a Sankey chart: `inflows` (pay,
 * Social Security, employer money, money drawn from savings...) add up to `total`, and so
 * do the `groups` (taxes, housing, ... retirement, savings, leftover), each with its line
 * items. Anything that only settles later (tax held back on a withdrawal, a refund,
 * closing costs paid straight from the house fund) shows as "Held for later" or "From
 * savings, other", so the two sides always match.
 *   real      divide by that month's inflation
 *   byPerson  income by person ("Patrick: Salary"); spending stays shared
 *   hide      group keys to leave out. The money in shrinks to match: employer money
 *             first when retirement is hidden (it only goes there), then every other
 *             source in proportion. `hidden` lists what was left out.
 * An inflow with `direct` (a fund paying a loan, the pets or a category) goes straight
 * to that group instead of through "money in".
 */
export function monthFlows(result, ym, { real = false, byPerson = false, hide = [] } = {}) {
  const m = result.months.find((x) => x.month === ym);
  if (!m?.flows) return null;
  const d = real ? m.deflator || 1 : 1;
  const accts = new Map((result.accounts || []).map((a) => [a.id, a]));
  const who = Object.fromEntries((result.people || []).map((p) => [p.id, p.name]));
  const hidden = new Set(hide);
  const inflows = [];
  const groups = new Map();
  const refunds = [];
  const outItem = (group, label, v) => {
    if (!(Math.abs(v) > 0.005)) return;
    if (v < 0) return refunds.push({ label: `${label} (back)`, value: -v / d });
    if (!groups.has(group)) groups.set(group, { key: group, label: FLOW_GROUP_LABELS[group] || group, items: [] });
    groups.get(group).items.push({ label, value: v / d });
  };
  const split = byPerson && Object.keys(m.flows).some((k) => k.startsWith("incomeBy."));
  // Fund payments for a particular thing (a loan, the pets, a category) go straight
  // there: { acct, group, value }. They come out of that account's withdrawal.
  const earmarks = [];
  const earmarked = {};
  for (const [k, v] of Object.entries(m.flows)) {
    if (!k.startsWith("paidFrom.") || !(v > 0.005)) continue;
    const [acctId, group] = k.slice("paidFrom.".length).split("|");
    earmarks.push({ acct: acctId, group, value: v / d });
    earmarked[acctId] = (earmarked[acctId] || 0) + v / d;
  }
  const leftover = Math.max(0, m.flows.surplus || 0);
  for (const [k, v] of Object.entries(m.flows)) {
    const dot = k.indexOf(".");
    const g = dot < 0 ? k : k.slice(0, dot);
    const key = dot < 0 ? k : k.slice(dot + 1);
    if (g === "income") {
      if (v > 0.005 && (!split || key === "windfall")) inflows.push({ label: FLOW_LABELS[key] || key, value: v / d, employer: key === "employer" });
    } else if (g === "incomeBy") {
      const [pid, kind] = key.split(".");
      if (split && v > 0.005) inflows.push({ label: `${who[pid] || pid}: ${FLOW_LABELS[kind] || kind}`, value: v / d, employer: kind === "employer", person: pid });
    } else if (g === "withdrawals") {
      const rest = v / d - (earmarked[key] || 0);
      if (rest > 0.005) inflows.push({ label: `From ${accts.get(key)?.name || key}`, value: rest, drawn: true });
    } else if (g === "paidFrom") {
      // Added below, as direct inflows.
    } else if (g === "taxes") {
      if (key !== "total") outItem("taxes", FLOW_LABELS[key] || key, v);
    } else if (g === "debt") {
      if (key === "payment" || key === "extra") outItem("debt", FLOW_LABELS[key], v);
    } else if (g === "savings") {
      const a = accts.get(key);
      // The leftover account's share that's this month's leftover gets its own group.
      const v2 = key === result.surplusAccount ? v - leftover : v;
      outItem(a && RETIREMENT_GROUPS.has(a.group) ? "retirement" : "savings", a?.name || key, v2);
    } else if (g === "categories") outItem("categories", key, v);
    else if (g === "pets" || g === "events") outItem(g, FLOW_GROUP_LABELS[g], v);
    else if (g === "surplus") {
      if (leftover > 0.005) outItem("leftover", `To ${accts.get(result.surplusAccount)?.name || "checking"}`, leftover);
    } else outItem(g, FLOW_LABELS[key] || key, v);
  }
  for (const r of refunds) inflows.push(r);
  for (const e of earmarks) inflows.push({ label: `From ${accts.get(e.acct)?.name || e.acct}`, value: e.value, drawn: true, direct: e.group });
  let groupList = [...groups.values()].map((g) => ({ ...g, value: g.items.reduce((t, x) => t + x.value, 0) }));
  const tin = inflows.reduce((t, x) => t + x.value, 0);
  const tout = groupList.reduce((t, x) => t + x.value, 0);
  if (tin - tout > 0.5) groupList.push({ key: "adjust", label: FLOW_GROUP_LABELS.adjust, value: tin - tout, items: [{ label: "Tax held back, refunds and other timing", value: tin - tout }] });
  // Closing costs in a purchase month come straight from the house fund.
  else if (tout - tin > 0.5) inflows.push({ label: result.milestones.some((x) => x.month === ym && x.kind === "house") ? "From the house fund" : "From savings, other", value: tout - tin, drawn: true });
  const fullTotal = Math.max(tin, tout);

  // Leaving groups out: the money in shrinks by the same amount.
  const left = groupList.filter((g) => hidden.has(g.key));
  groupList = groupList.filter((g) => !hidden.has(g.key));
  let cut = left.reduce((t, g) => t + g.value, 0);
  // A fund's payment for a group that's left out goes with it.
  let ins = inflows.filter((x) => !(x.direct && hidden.has(x.direct)));
  cut -= inflows.filter((x) => x.direct && hidden.has(x.direct)).reduce((t, x) => t + x.value, 0);
  if (cut > 0.005) {
    if (hidden.has("retirement")) {
      const ret = left.find((g) => g.key === "retirement")?.value || 0;
      let fromEmployer = Math.min(ret, ins.filter((x) => x.employer).reduce((t, x) => t + x.value, 0));
      cut -= fromEmployer;
      ins = ins.map((x) => {
        if (!x.employer || fromEmployer <= 0) return x;
        const take = Math.min(x.value, fromEmployer);
        fromEmployer -= take;
        return { ...x, value: x.value - take };
      });
    }
    const rest = ins.filter((x) => !x.direct).reduce((t, x) => t + x.value, 0);
    const keep = rest > 0 ? Math.max(0, (rest - cut) / rest) : 0;
    ins = ins.map((x) => (x.direct ? x : { ...x, value: x.value * keep })).filter((x) => x.value > 0.005);
  }
  groupList.sort((a, b) => FLOW_ORDER.indexOf(a.key) - FLOW_ORDER.indexOf(b.key));
  for (const g of groupList) g.items.sort((a, b) => b.value - a.value);
  ins.sort((a, b) => (a.drawn === b.drawn ? (a.person || "").localeCompare(b.person || "") || b.value - a.value : a.drawn ? 1 : -1));
  const total = groupList.reduce((t, g) => t + g.value, 0);
  return { month: ym, inflows: ins, groups: groupList, total: hidden.size ? total : fullTotal, fullTotal, hidden: left.map((g) => ({ key: g.key, label: g.label, value: g.value })) };
}

/** The goal order: settings.priority first, then accounts with a monthly amount, debts with extra, and kids' 529s. */
export function goalOrder(inputs, kids = null) {
  const all = [];
  for (const a of inputs.accounts || []) if (num(a.monthly) > 0 && a.id !== inputs.settings?.surplusAccount) all.push({ key: a.id, kind: "account", id: a.id, label: a.name });
  for (const d of inputs.debts || []) if (num(d.extra) > 0) all.push({ key: d.id, kind: "debt", id: d.id, label: `Extra on ${d.name}` });
  for (const k of kids || (inputs.kids || []).map((x) => ({ ...x, born: x.birthYear * 12 + num(x.birthMonth, 6) - 1 }))) {
    if (num(k.college529Monthly) > 0 && k.account) all.push({ key: `kid529-${k.id}`, kind: "kid529", id: k.account, monthly: k.college529Monthly, until: k.born != null ? k.born + 18 * 12 : null, label: `529 for ${k.name || "kid"}` });
  }
  const pr = inputs.settings?.priority || [];
  return all.sort((a, b) => {
    const ia = pr.indexOf(a.key);
    const ib = pr.indexOf(b.key);
    return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib);
  });
}

function money(n) {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/* ----------------------------------------------------------------- Monte Carlo -- */

/** A seeded random number generator (mulberry32), so runs repeat. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `runs` simulations with each year's investment return drawn from a normal
 * distribution (mean = the assumption, spread = assumptions.returnSd). All investment
 * accounts move together in a year. Returns percentiles of net worth in today's dollars
 * and the share of runs where the money lasts.
 */
export function monteCarlo(inputs, { runs = 300, seed = 1, overrides = {} } = {}) {
  const rand = rng(seed);
  const normal = () => {
    const u = Math.max(1e-12, rand());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  const A = inputs.assumptions || {};
  const sd = num(A.returnSd, 0.15);
  const delta = num(overrides.returnDelta);
  const series = [];
  let lasted = 0;
  let yearsList = null;
  for (let n = 0; n < runs; n++) {
    const draws = [];
    const result = simulate(inputs, {
      overrides,
      lean: true,
      returns: (y) => {
        if (!draws[y]) {
          const z = normal();
          draws[y] = Object.fromEntries(["brokerage", "retirement", "hsa", "college"].map((k) => [k, num(A.returns?.[k]) + delta + sd * z]));
        }
        return draws[y];
      },
    });
    if (result.summary.lasts) lasted++;
    yearsList = yearsList || result.years.map((y) => y.year);
    series.push(result.years.map((y) => y.netWorth / (y.deflator || 1)));
  }
  const pct = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  };
  const bands = yearsList.map((year, idx) => {
    const col = series.map((r) => r[idx]);
    return { year, p10: pct(col, 0.1), p50: pct(col, 0.5), p90: pct(col, 0.9) };
  });
  return { runs, success: lasted / runs, bands };
}

/* ------------------------------------------------------------------------- CSV -- */

/** Flatten the yearly results into rows for a CSV download. `real` divides by the deflator. */
export function yearRows(result, real = true, names = {}) {
  const rows = [];
  for (const y of result.years) {
    const d = real ? y.deflator || 1 : 1;
    const v = (n) => Math.round((n || 0) / d);
    const row = { Year: y.year, Married: y.married ? "yes" : "no" };
    for (const [k, n] of Object.entries(y.income)) row[`Income: ${k}`] = v(n);
    for (const [k, n] of Object.entries(y.pretax)) row[`Pre-tax: ${k}`] = v(n);
    for (const [k, n] of Object.entries(y.taxes)) row[`Taxes: ${k}`] = v(n);
    for (const [k, n] of Object.entries(y.housing)) row[`Housing: ${k}`] = v(n);
    for (const [k, n] of Object.entries(y.cars)) row[`Cars: ${k}`] = v(n);
    for (const [k, n] of Object.entries(y.kids)) row[`Kids: ${k}`] = v(n);
    row["Pets"] = v(y.pets);
    for (const [k, n] of Object.entries(y.health)) row[`Health: ${k}`] = v(n);
    for (const [k, n] of Object.entries(y.categories)) row[`Spending: ${k}`] = v(n);
    row["One-time events"] = v(y.events);
    for (const [k, n] of Object.entries(y.debt)) row[`Debt: ${k}`] = v(n);
    for (const [k, n] of Object.entries(y.savings)) row[`Saved to: ${names[k] || k}`] = v(n);
    for (const [k, n] of Object.entries(y.withdrawals)) row[`Drawn from: ${names[k] || k}`] = v(n);
    row["Leftover"] = v(y.surplus);
    row["Uncovered spending"] = v(y.unfunded);
    for (const [k, n] of Object.entries(y.balances || {})) row[`Balance: ${names[k] || k}`] = v(n);
    for (const [k, n] of Object.entries(y.byGroup || {})) row[`Total: ${k}`] = v(n);
    row["Net worth"] = v(y.netWorth);
    rows.push(row);
  }
  return rows;
}

export function toCsv(rows) {
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const cell = (x) => {
    const t = x == null ? "" : String(x);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [cols.map(cell).join(","), ...rows.map((r) => cols.map((c) => cell(r[c] ?? 0)).join(","))].join("\n");
}

export { round2 };
