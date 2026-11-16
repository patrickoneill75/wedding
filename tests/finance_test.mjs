/**
 * The finance tool's engine (public/admin/personal/engine.js), checked against numbers
 * worked out by hand. Each test shows its arithmetic. Run with `npm test`.
 */
import assert from "node:assert/strict";
import { amortizedPayment, bracketTax, defaultInputs, defaultModel, defaultTax, monteCarlo, normalizeInputs, simulate, toCsv, validate, yearRows, yearTax } from "../public/admin/personal/engine.js";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg || ""} expected ${expected} ± ${tol}, got ${actual}`);

/** A scenario with nothing in it but what a test adds: no inflation, no growth, no house, cars or debts. */
function bare(start = "2026-01") {
  const inp = defaultInputs(new Date(2026, 0, 1));
  inp.settings = { ...inp.settings, start, weddingMonth: "", priority: [], surplusAccount: "chk", endAge: 95 };
  inp.assumptions = { ...inp.assumptions, inflation: 0, salaryGrowth: 0, homeAppreciation: 0, bracketIndexing: 0, limitGrowth: 0, returns: { cash: 0, hysa: 0, brokerage: 0, retirement: 0, hsa: 0, college: 0 } };
  inp.people = [{ id: "p1", name: "Pat", birthYear: 1995, birthMonth: 1, retireAge: 65, ssMonthly: 0, ssClaimAge: 67 }];
  inp.incomes = [];
  inp.budget = { rent: { monthly: 0, increase: 0 }, utilities: { rent: 0, own: 0 }, health: { premiumMonthly: 0, pretax: false, oopYearly: 0, inflation: 0 }, categories: [] };
  inp.events = [];
  inp.pets = [];
  inp.accounts = [{ id: "chk", name: "Checking", type: "checking", owner: "shared", balance: 0, monthly: 0 }];
  inp.debts = [];
  inp.house = { ...inp.house, enabled: false, bigItems: [], sell: { enabled: false } };
  inp.cars = [];
  inp.kids = [];
  return inp;
}
const salary = (annual, extra = {}) => ({ id: "inc", owner: "p1", name: "Salary", kind: "salary", annual, start: "", end: "", growth: null, jumps: [], gaps: [], retirePct: 0, retireAccount: "", matchPct: 0, matchUpTo: 0, hsaEmployee: 0, hsaEmployer: 0, ...extra });

/* ------------------------------------------------------------------ loans -- */

// $10,000 at 6% for 12 months: r = 0.005, payment = 10000 × 0.005 / (1 − 1.005^−12)
// = 860.66. Twelve payments total 10,327.97, so interest is 327.97.
test("a loan's payment and total interest match the amortization formula", () => {
  near(amortizedPayment(10000, 0.06, 12), 860.66, 0.005);
  near(amortizedPayment(255000, 0.06, 360), 1528.85, 0.005, "a 30-year mortgage on $255,000 at 6%");
  near(amortizedPayment(1200, 0, 12), 100, 1e-9, "no interest: just divide");
  const inp = bare();
  inp.incomes = [salary(60000)];
  inp.debts = [{ id: "loan", name: "Loan", kind: "other", balance: 10000, rate: 0.06, minPayment: 0, termMonths: 12, extra: 0, plan: "standard" }];
  const r = simulate(inp);
  const d = r.summary.debts[0];
  near(d.interest, 327.97, 0.02, "total interest");
  assert.equal(d.paidOff, "2026-12", "the twelfth payment clears it");
  assert.equal(r.summary.debtFreeYear, 2026);
});

test("extra payments come out after required spending and shorten the loan", () => {
  const inp = bare();
  inp.incomes = [salary(60000)];
  inp.debts = [{ id: "loan", name: "Loan", kind: "student", balance: 10000, rate: 0.06, minPayment: 200, extra: 300, plan: "standard" }];
  const r = simulate(inp);
  // $500 a month at 6% on $10,000: n = −ln(1 − 0.005 × 10,000 / 500) / ln(1.005) = 21.1,
  // so 22 payments, January 2026 to October 2027.
  assert.equal(r.summary.debts[0].paidOff, "2027-10");
});

/* ------------------------------------------------------------------- taxes -- */

// 2026, single, $60,000 of wages and nothing else:
//   federal: taxable 60,000 − 16,100 = 43,900; 10% × 12,400 = 1,240; 12% × 31,500 = 3,780;
//            total 5,020
//   FICA:    7.65% × 60,000 = 4,590
//   Indiana: (60,000 − 1,000) × 2.95% = 1,740.50; Marion County: 59,000 × 2.02% = 1,191.80
test("a simple single filer's 2026 taxes, worked by hand", () => {
  const t = yearTax(defaultTax(), { married: false, year: 2026, wages: 60000, ficaWages: [60000], people: 1 });
  near(t.federal, 5020, 0.01, "federal");
  near(t.fica, 4590, 0.01, "FICA");
  near(t.state, 1740.5, 0.01, "Indiana");
  near(t.county, 1191.8, 0.01, "county");
  // Taxable $60,000 crosses into 22%: 1,240 + 12% × 38,000 + 22% × 9,600 = 7,912.
  near(bracketTax(60000, defaultTax().federal.single.brackets), 7912, 0.01);
});

// Married filing jointly in 2027, $120,000 of wages split evenly:
//   federal: 120,000 − 32,200 = 87,800; 2,480 + 12% × 63,000 = 10,040
//   FICA 9,180; Indiana at 2.9% from 2027: 118,000 × 2.9% = 3,422; county 2,383.60
test("married filing jointly, and Indiana's rate stepping down in 2027", () => {
  const t = yearTax(defaultTax(), { married: true, year: 2027, wages: 120000, ficaWages: [60000, 60000], people: 2 });
  near(t.federal, 10040, 0.01);
  near(t.fica, 9180, 0.01);
  near(t.state, 3422, 0.01);
  near(t.county, 2383.6, 0.01);
});

test("pre-tax 401(k) lowers income tax but not FICA; HSA through payroll lowers both", () => {
  const inp = bare();
  inp.accounts.push({ id: "k", name: "401k", type: "trad401k", owner: "p1", balance: 0, monthly: 0 }, { id: "h", name: "HSA", type: "hsa", owner: "p1", balance: 0, monthly: 0 });
  inp.incomes = [salary(60000, { retirePct: 0.1, retireAccount: "k", hsaEmployee: 2400, hsaAccount: "h" })];
  const y = simulate(inp).years[0];
  // Income-tax wages: 60,000 − 6,000 − 2,400 = 51,600 → taxable 35,500 → 1,240 + 12% × 23,100 = 4,012.
  near(y.taxes.federal, 4012, 0.5, "federal");
  // FICA wages: 60,000 − 2,400 = 57,600 × 7.65% = 4,406.40.
  near(y.taxes.fica, 4406.4, 0.5, "FICA");
  near(y.savings.k, 6000, 0.01);
  near(y.savings.h, 2400, 0.01);
});

// Social Security: married, $40,000 of benefits and $30,000 of other income.
// Provisional = 30,000 + 20,000 = 50,000, over the 44,000 line:
// taxable = min(85% × 40,000, 85% × 6,000 + min(20,000, 50% × 12,000)) = 5,100 + 6,000 = 11,100.
test("the taxable part of Social Security follows the IRS formula", () => {
  const t = yearTax(defaultTax(), { married: true, year: 2026, wages: 0, ss: 40000, ordinary: 30000, people: 2 });
  near(t.ssTaxable, 11100, 0.01);
});

test("child tax credit: $2,200 a child under 17, and it phases out over the line", () => {
  const base = { married: true, year: 2026, wages: 150000, ficaWages: [75000, 75000], people: 2 };
  const none = yearTax(defaultTax(), base);
  const two = yearTax(defaultTax(), { ...base, kidsUnder17: 2, dependents: 2 });
  near(none.federal - two.federal, 4400, 0.01);
  // $410,000: $10,000 over the $400,000 line → $500 less.
  const rich = yearTax(defaultTax(), { ...base, wages: 410000, kidsUnder17: 2, dependents: 2 });
  near(rich.ctc, 3900, 0.01);
});

test("single until the wedding year, then married filing jointly", () => {
  const inp = bare();
  inp.settings.weddingMonth = "2027-05";
  inp.people.push({ id: "p2", name: "Kit", birthYear: 1995, birthMonth: 1, retireAge: 65, ssMonthly: 0, ssClaimAge: 67 });
  inp.incomes = [salary(60000), { ...salary(60000), id: "inc2", owner: "p2" }];
  const [y2026, y2027] = simulate(inp).years;
  assert.equal(y2026.married, false);
  assert.equal(y2027.married, true);
  near(y2026.taxes.federal, 2 * 5020, 0.5, "two single returns of 5,020");
  // 2027 joint: 120,000 − 32,200 = 87,800 → 10,040 (no indexing in this test).
  near(y2027.taxes.federal, 10040, 0.5);
});

/* --------------------------------------------------------------- waterfall -- */

// Single, $60,000, 2026: take-home = 60,000 − 5,020 − 4,590 − 1,740.50 − 1,191.80
// = 47,457.70 a year, 3,954.81 a month. Rent 1,500 + groceries 500 = 2,000 required.
// Savings goal 300. Leftover = 3,954.81 − 2,000 − 300 = 1,654.81 a month, 19,857.70 a year.
test("the monthly waterfall: income, taxes, required spending, goals, then leftover", () => {
  const inp = bare();
  inp.incomes = [salary(60000)];
  inp.budget.rent.monthly = 1500;
  inp.budget.categories = [{ id: "c", name: "Groceries", amount: 500, freq: "monthly", inflation: null, start: "", end: "", owner: "shared" }];
  inp.accounts.push({ id: "sav", name: "Savings", type: "savings", owner: "shared", balance: 0, monthly: 300 });
  const y = simulate(inp).years[0];
  near(y.taxes.total, 12542.3, 0.5, "taxes");
  near(y.housing.rent, 18000, 0.01);
  near(y.savings.sav, 3600, 0.01);
  near(y.surplus, 19857.7, 0.5, "leftover");
});

test("a shortfall draws from cash, then flags the month the money runs out", () => {
  const inp = bare();
  inp.incomes = [salary(60000)];
  inp.budget.rent.monthly = 5000;
  inp.accounts[0].balance = 10000;
  const r = simulate(inp);
  // Short 5,000 − 3,954.81 = 1,045.19 a month: $10,000 lasts 9 full months, out in month 10.
  assert.equal(r.summary.lasts, false);
  assert.equal(r.summary.runsOutYear, 2026);
  const out = r.flags.find((f) => f.level === "error");
  assert.ok(out && out.month === "2026-10", JSON.stringify(r.flags));
});

/* -------------------------------------------------------------------- house -- */

// Fund $50,000 + $1,000 a month, price $300,000, 15% down + 3% closing = $54,000.
// Checked at the start of each month: Jan 50k, Feb 51k, Mar 52k, Apr 53k, May 54k → buys in May.
test("buying automatically once the down payment fund reaches the target", () => {
  const inp = bare("2027-01");
  inp.incomes = [salary(90000)];
  inp.accounts.push({ id: "fund", name: "House fund", type: "house", owner: "shared", balance: 50000, monthly: 1000 });
  inp.budget.rent.monthly = 1500;
  inp.house = { ...inp.house, enabled: true, price: 300000, downPct: 0.15, closingPct: 0.03, mode: "auto", fundAccount: "fund", rate: 0.06, termYears: 30, pmiRate: 0, propertyTaxRate: 0, insuranceYearly: 0, hoaMonthly: 0, upkeepPct: 0, bigItems: [], sell: { enabled: false } };
  const r = simulate(inp);
  assert.equal(r.summary.houseYear, 2027);
  assert.equal(r.milestones.find((m) => m.kind === "house").month, "2027-05");
  const [y2027, y2028] = r.years;
  near(y2027.housing.rent, 4 * 1500, 0.01, "rent stops at purchase");
  // Loan 255,000 at 6% over 30 years: 1,528.85 a month.
  near(y2028.housing.mortgage, 12 * 1528.85, 0.1);
  near(y2028.byGroup.homeValue, 300000, 0.01, "no appreciation in this test");
});

test("buying in a chosen year, and PMI until 20% equity", () => {
  const inp = bare("2027-01");
  inp.incomes = [salary(120000)];
  inp.accounts[0].balance = 100000;
  inp.house = { ...inp.house, enabled: true, price: 200000, downPct: 0.1, closingPct: 0, mode: "year", year: 2028, month: 3, fundAccount: "", rate: 0.06, termYears: 30, pmiRate: 0.006, propertyTaxRate: 0, insuranceYearly: 0, hoaMonthly: 0, upkeepPct: 0, bigItems: [], sell: { enabled: false } };
  const r = simulate(inp);
  assert.equal(r.milestones.find((m) => m.kind === "house").month, "2028-03");
  assert.ok(r.years[1].housing.pmi > 0, "90% loan-to-value pays PMI");
});

/* ---------------------------------------------------------- employer money -- */

// Asked for: "as long as I contribute 5% of my salary, my employer contributes 10% of my
// salary." $60,000 at 5%: you put in $3,000 and the employer $6,000. At 4%: $2,400 and
// nothing from the employer, with a warning.
test("employer puts in a set 10% of pay once you put in at least 5%", () => {
  const inp = bare();
  inp.accounts.push({ id: "k", name: "401k", type: "trad401k", owner: "p1", balance: 0, monthly: 0 });
  inp.incomes = [salary(60000, { retirePct: 0.05, retireAccount: "k", matchType: "threshold", matchThreshold: 0.05, employerPct: 0.1 })];
  let y = simulate(inp).years[0];
  near(y.income.employer, 6000, 0.01, "employer");
  near(y.savings.k, 9000, 0.01, "3,000 yours + 6,000 theirs");
  assert.deepEqual(validate(inp).filter((x) => /left on the table/.test(x.message)), []);
  inp.incomes[0].retirePct = 0.04;
  y = simulate(inp).years[0];
  near(y.income.employer, 0, 0.01, "under the threshold: nothing");
  near(y.savings.k, 2400, 0.01);
  assert.ok(validate(inp).some((x) => /under the 5% needed for the employer's 10%/.test(x.message)));
  // The usual kind still works: 100% of the first 4% on $60,000 is $2,400.
  inp.incomes[0] = salary(60000, { retirePct: 0.06, retireAccount: "k", matchType: "match", matchPct: 1, matchUpTo: 0.04 });
  near(simulate(inp).years[0].income.employer, 2400, 0.01);
});

/* ------------------------------------------------------- balance updates -- */

test("dated balances: old files gain an empty history, and a balance older than 90 days is flagged", () => {
  const inp = bare();
  delete inp.accounts[0].history;
  assert.deepEqual(normalizeInputs(inp).accounts[0].history, []);
  inp.accounts[0].balanceAsOf = "2026-06-01";
  const now = new Date(2026, 10, 16);
  assert.ok(validate(inp, now).some((x) => x.where === "Accounts" && /balance is from Jun 1, 2026/.test(x.message)));
  inp.accounts[0].balanceAsOf = "2026-10-01";
  assert.ok(!validate(inp, now).some((x) => /balance is from/.test(x.message)));
});

/* ------------------------------------------------------------- Monte Carlo -- */

test("Monte Carlo with no spread matches the plain run, and repeats with the same seed", () => {
  const inp = defaultInputs(new Date(2026, 10, 1));
  inp.assumptions.returnSd = 0;
  const plain = simulate(inp);
  const mc = monteCarlo(inp, { runs: 3, seed: 7 });
  const last = plain.years[plain.years.length - 1];
  near(mc.bands[mc.bands.length - 1].p50, last.netWorth / last.deflator, 1);
  inp.assumptions.returnSd = 0.15;
  assert.deepEqual(monteCarlo(inp, { runs: 5, seed: 3 }).bands[10], monteCarlo(inp, { runs: 5, seed: 3 }).bands[10]);
});

/* ---------------------------------------------------------- the rest of it -- */

test("validation catches a loan with no payment and a retirement age already passed", () => {
  const inp = bare();
  inp.people[0].birthYear = 1950;
  inp.debts = [{ id: "d", name: "Car loan", balance: 5000, rate: 0.05, minPayment: 0, extra: 0, plan: "standard" }];
  const issues = validate(inp, new Date(2026, 10, 1));
  assert.ok(issues.some((x) => x.level === "error" && /no payment/.test(x.message)));
  assert.ok(issues.some((x) => /already passed/.test(x.message)));
  assert.deepEqual(validate(defaultInputs(new Date(2026, 10, 1)), new Date(2026, 10, 1)).filter((x) => x.level === "error"), [], "the defaults are clean");
});

test("the default model runs to both of us at 95, and the CSV has every year", () => {
  const model = defaultModel(new Date(2026, 10, 1));
  const r = simulate(model.scenarios[0].inputs);
  assert.equal(r.end, "2089-12");
  const csv = toCsv(yearRows(r, true));
  assert.equal(csv.split("\n").length, r.years.length + 1);
  assert.ok(csv.startsWith("Year,Married,"));
  for (const y of r.years) assert.ok(Number.isFinite(y.netWorth), `${y.year} net worth is a number`);
});

test("sliders change the result without touching the inputs", () => {
  const inp = defaultInputs(new Date(2026, 10, 1));
  const before = JSON.stringify(inp);
  const a = simulate(inp).summary.netWorthAtRetirement;
  const b = simulate(inp, { overrides: { returnDelta: 0.02 } }).summary.netWorthAtRetirement;
  assert.ok(b > a);
  assert.equal(JSON.stringify(inp), before);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${error.stack.split("\n").slice(0, 4).join("\n     ")}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
