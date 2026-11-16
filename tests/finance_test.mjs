/**
 * The finance tool's engine (public/admin/personal/engine.js), checked against numbers
 * worked out by hand. Each test shows its arithmetic. Run with `npm test`.
 */
import assert from "node:assert/strict";
import { amortizedPayment, bracketTax, defaultInputs, defaultModel, defaultTax, monteCarlo, monthFlows, normalizeInputs, simulate, toCsv, validate, yearRows, yearTax } from "../public/admin/personal/engine.js";

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

/* ------------------------------------------------------ one month's flows -- */

// Asked for: pick any month and see a Sankey chart of income and expenses. Whatever comes
// in has to equal whatever goes out, in every kind of month.
test("one month's flows: money in equals money out, with the right pieces", () => {
  const inp = bare();
  inp.incomes = [salary(60000)];
  inp.budget.rent.monthly = 1500;
  inp.budget.categories = [{ id: "c", name: "Groceries", amount: 500, freq: "monthly", inflation: null, start: "", end: "", owner: "shared" }];
  inp.accounts.push({ id: "sav", name: "Savings", type: "savings", owner: "shared", balance: 0, monthly: 300 });
  const f = monthFlows(simulate(inp, { flowMonth: "2026-03" }), "2026-03");
  near(f.total, 5000, 0.01, "a month of a $60,000 salary");
  const g = Object.fromEntries(f.groups.map((x) => [x.key, x.value]));
  near(g.taxes, 12542.3 / 12, 0.05, "a twelfth of the year's tax");
  near(g.housing, 1500, 0.01);
  near(g.categories, 500, 0.01);
  near(g.savings, 300, 0.01, "the savings goal");
  near(g.leftover, 1654.81, 0.05, "and the leftover, on its own");
  // The default plan's busy months: the wedding (drawing from savings), a December
  // settling taxes, the house purchase and a retirement month.
  const def = defaultInputs(new Date(2026, 10, 1));
  const house = simulate(def).milestones.find((m) => m.kind === "house").month;
  for (const ym of ["2027-05", "2027-12", house, "2063-03"]) {
    const r = simulate(def, { flowMonth: ym });
    const x = monthFlows(r, ym, { real: true });
    const tin = x.inflows.reduce((t, y) => t + y.value, 0);
    const tout = x.groups.reduce((t, y) => t + y.value, 0);
    near(tin, tout, 0.5, `${ym} balances`);
    assert.ok(x.inflows.every((y) => y.value > 0) && x.groups.every((y) => y.value > 0), `${ym} has no negative pieces`);
  }
  assert.equal(monthFlows(simulate(def), "2027-05"), null, "only the month asked for is recorded");
});

// Asked for: tick boxes to leave out taxes, retirement, savings and the rest, and income
// split between the two of you. Patrick earns $60,000 with 5% into his 401(k) and a 4%
// match ($250 + $200 a month); Kit earns $40,000 with nothing withheld for retirement.
test("one month's flows by person, and with groups left out", () => {
  const inp = bare();
  inp.people.push({ id: "p2", name: "Kit", birthYear: 1995, birthMonth: 1, retireAge: 65, ssMonthly: 0, ssClaimAge: 67 });
  inp.accounts.push({ id: "k", name: "401k", type: "trad401k", owner: "p1", balance: 0, monthly: 0 });
  inp.incomes = [salary(60000, { retirePct: 0.05, retireAccount: "k", matchPct: 1, matchUpTo: 0.04 }), { ...salary(40000), id: "inc2", owner: "p2" }];
  const r = simulate(inp, { flowMonth: "2026-03" });
  const sum = (xs) => xs.reduce((t, x) => t + x.value, 0);
  const f = monthFlows(r, "2026-03", { byPerson: true });
  const ins = Object.fromEntries(f.inflows.map((x) => [x.label, x.value]));
  near(ins["Pat: Salary"], 5000, 0.01);
  near(ins["Pat: Employer money"], 200, 0.01);
  near(ins["Kit: Salary"], 40000 / 12, 0.01);
  near(f.groups.find((g) => g.key === "retirement").value, 450, 0.01, "his $250 and the employer's $200");
  near(f.groups.find((g) => g.key === "leftover").value, sum(f.inflows) - sum(f.groups.filter((g) => g.key !== "leftover")), 0.01);
  // Leaving out taxes and retirement: the employer's $200 goes first, then every source
  // shrinks in proportion, and the two sides still match.
  const cut = monthFlows(r, "2026-03", { byPerson: true, hide: ["taxes", "retirement"] });
  assert.ok(!cut.groups.some((g) => g.key === "taxes" || g.key === "retirement"));
  assert.ok(!cut.inflows.some((x) => /Employer/.test(x.label)), "employer money only goes to retirement");
  near(sum(cut.inflows), sum(cut.groups), 0.01);
  near(sum(cut.inflows), f.total - f.groups.filter((g) => g.key === "taxes" || g.key === "retirement").reduce((t, g) => t + g.value, 0), 0.01);
  assert.deepEqual(cut.hidden.map((x) => x.key), ["taxes", "retirement"]);
});

/* ------------------------------------------------------- savings goals -- */

// Asked for: self-insure the pets from a set-aside fund. Pet costs $1,200 a year ($100 a
// month); the fund gets $150 a month and starts empty. Costs come before contributions,
// so January's $100 comes out of pay, then the fund pays February to December: $1,100.
// The fund ends the year at 12 × 150 − 1,100 = $700.
test("a set-aside fund pays the pets' costs first, and pay covers what it can't", () => {
  const inp = bare();
  inp.incomes = [salary(60000)];
  inp.accounts.push({ id: "pet", name: "Pet fund", type: "sinking", owner: "shared", balance: 0, monthly: 150 });
  inp.pets = [{ id: "dog", name: "Rex", annual: 1200, oneTime: 0, start: "2026-01", endYear: null, fundAccount: "pet" }];
  const y = simulate(inp).years[0];
  near(y.pets, 1200, 0.01, "the full cost still shows as pet spending");
  near(y.withdrawals.pet, 1100, 0.01, "paid by the fund");
  near(y.balances.pet, 700, 0.01);
});

// Asked for: "I pay my student loans out of my savings." $300 a month from a $5,000
// savings account for a year leaves 5,000 − 3,600 = $1,400 there, and pay keeps the $300
// each month (the leftover grows by 12 × 300 = $3,600 compared with paying from pay).
// With only $1,000 saved, the account covers the first 3⅓ payments, then pay takes over.
test("a loan paid from a savings account, with pay covering what the account can't", () => {
  const make = (fund, balance) => {
    const inp = bare();
    inp.incomes = [salary(60000)];
    inp.accounts.push({ id: "sav", name: "Savings", type: "savings", owner: "shared", balance, monthly: 0 });
    inp.debts = [{ id: "sl", name: "Student loan", kind: "student", balance: 20000, rate: 0, minPayment: 300, extra: 0, plan: "standard", fundAccount: fund }];
    return simulate(inp);
  };
  const fromPay = make("", 5000).years[0];
  const r = make("sav", 5000);
  const y = r.years[0];
  near(y.debt.payment, 3600, 0.01, "the loan is paid either way");
  near(y.withdrawals.sav, 3600, 0.01);
  near(y.balances.sav, 1400, 0.01);
  near(y.surplus - fromPay.surplus, 3600, 0.5, "pay keeps the $300 a month");
  // On the one-month chart the $300 goes straight from Savings to the loan.
  const flowRun = (() => {
    const inp = bare();
    inp.incomes = [salary(60000)];
    inp.accounts.push({ id: "sav", name: "Savings", type: "savings", owner: "shared", balance: 5000, monthly: 0 });
    inp.debts = [{ id: "sl", name: "Student loan", kind: "student", balance: 20000, rate: 0, minPayment: 300, extra: 0, plan: "standard", fundAccount: "sav" }];
    return simulate(inp, { flowMonth: "2026-03" });
  })();
  const fl = monthFlows(flowRun, "2026-03");
  assert.deepEqual(fl.inflows.filter((x) => x.direct).map((x) => [x.label, x.direct, Math.round(x.value)]), [["From Savings", "debt", 300]]);
  assert.ok(!fl.inflows.some((x) => !x.direct && /Savings/.test(x.label)), "none of it goes through money in");
  assert.ok(!monthFlows(flowRun, "2026-03", { hide: ["debt"] }).inflows.some((x) => x.direct), "leaving out loans leaves out its fund payment too");
  const short = make("sav", 1000);
  near(short.years[0].withdrawals.sav, 1000, 0.01);
  assert.ok(short.flags.some((f) => /Savings ran short for Student loan in 2026-04/.test(f.message)), JSON.stringify(short.flags));
});

// A $500-a-month savings goal with a $2,000 target fills in four months and stops.
test("a target balance stops contributions once it's reached, and says when", () => {
  const inp = bare();
  inp.incomes = [salary(60000)];
  inp.accounts.push({ id: "sav", name: "Trip fund", type: "savings", owner: "shared", balance: 0, monthly: 500, target: 2000 });
  const r = simulate(inp);
  near(r.years[0].savings.sav, 2000, 0.01);
  assert.equal(r.summary.reached.sav, "2026-04", "April's $500 brings it to $2,000");
  assert.equal(r.years[0].targets.sav, 2000);
  assert.deepEqual(r.summary.startPlan.goals.map((g) => [g.id, g.amount]), [["sav", 500]]);
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
