// Прогноз по контрольным точкам (ARCHITECTURE.md §4.3–4.7). Чистая функция, без БД и часов.
import { addDays, assertDate, diffDays, type ISODate } from "./dates";
import { assertNonNegativeAmount, floorDiv, maxBig, minBig, type Minor } from "./money";
import { ENGINE_VERSION, type Forecast, type ForecastInput, type Gap, type Limitation, type OccurrenceInput } from "./types";

export const DEFAULT_PLANNING_DAYS = 30;

/** Непогашенная часть: planned - settled (с учётом сторно), не меньше нуля. */
export function remainingOf(plannedMinor: Minor, settlementsMinor: Minor[]): Minor {
  const settled = settlementsMinor.reduce((a, b) => a + b, 0n);
  return maxBig(0n, plannedMinor - settled);
}

/** Фактический остаток: opening + записи, влияющие на баланс. */
export function computeBalance(openingMinor: Minor, entries: { amountMinor: Minor; affectsBalance: boolean }[]): Minor {
  return entries.reduce((s, e) => (e.affectsBalance ? s + e.amountMinor : s), openingMinor);
}

function includedIncome(o: OccurrenceInput, scenario: ForecastInput["scenario"]) {
  return o.direction === "income" && o.remainingMinor > 0n &&
    (o.certainty === "committed" || (scenario === "expected" && o.certainty === "expected"));
}

/** Конец горизонта: день ближайшего включённого дохода (его траты идут до поступления), иначе явный период. */
export function resolveHorizon(input: ForecastInput): { end: ISODate; kind: Forecast["horizonKind"] } {
  if (input.horizonEnd) return { end: assertDate(input.horizonEnd, "horizonEnd"), kind: "explicit" };
  const next = input.occurrences
    .filter((o) => includedIncome(o, input.scenario) && o.dueOn >= input.today)
    .sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0))[0];
  if (next) return { end: next.dueOn, kind: "until_income" };
  const days = input.planningDays ?? DEFAULT_PLANNING_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new RangeError("planningDays вне диапазона 1..365");
  return { end: addDays(input.today, days - 1), kind: "planning_period" };
}

export function forecast(input: ForecastInput): Forecast {
  const today = assertDate(input.today, "today");
  if (typeof input.balanceMinor !== "bigint") throw new TypeError("balanceMinor must be bigint");
  const R = assertNonNegativeAmount(input.reserveMinor, "reserve");
  const essential = input.essentialDailyMinor == null ? null : assertNonNegativeAmount(input.essentialDailyMinor, "essentialDaily");
  for (const o of input.occurrences) { assertDate(o.dueOn, "dueOn"); assertNonNegativeAmount(o.remainingMinor, "occurrence"); }

  const { end, kind } = resolveHorizon(input);
  if (end < today) throw new RangeError("Горизонт раньше сегодняшнего дня");
  const limitations = new Set<Limitation>();
  const assumptions: string[] = [
    "Доход с неизвестным временем поступает в конце дня; платежи и траты этого дня идут раньше.",
  ];
  if (kind === "planning_period") { limitations.add("INCOME_UNKNOWN"); assumptions.push(`Ближайший доход неизвестен: выбран период планирования до ${end}.`); }

  // Доходы
  const incomes = input.occurrences.filter((o) => includedIncome(o, input.scenario));
  const overdueIncomes = incomes.filter((o) => o.dueOn < today);
  if (overdueIncomes.length) { limitations.add("INCOME_OVERDUE"); assumptions.push("Доход с прошедшей датой не подтверждён и не учитывается до уточнения."); }
  const futureIncomes = incomes.filter((o) => o.dueOn >= today && o.dueOn <= end);
  const nextIncomeOcc = incomes.filter((o) => o.dueOn >= today).sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0] ?? null;

  // Платежи (включая просроченные: они ложатся на сегодня)
  const expenses = input.occurrences.filter((o) => o.direction === "expense" && o.remainingMinor > 0n);
  const payments = expenses
    .map((o) => ({ id: o.id, name: o.name, amountMinor: o.remainingMinor, dueOn: o.dueOn, overdue: o.dueOn < today, inHorizon: o.dueOn <= end }))
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  const inHorizonPayments = payments.filter((p) => p.inHorizon);
  const effDate = (d: ISODate) => (d < today ? today : d);

  // Цель
  const g = input.goal;
  let L = 0n, S = 0n, N = 0, goalOverdue = false;
  if (g) {
    assertDate(g.targetDate, "goal.targetDate");
    L = maxBig(0n, g.targetMinor - g.savedMinor);
    S = g.protectedMinor != null ? maxBig(0n, g.protectedMinor) : g.savedInBalance ? maxBig(0n, g.savedMinor) : 0n;
    if (L > 0n && g.targetDate < today) { goalOverdue = true; limitations.add("GOAL_OVERDUE"); }
    else if (L > 0n) N = diffDays(today, g.targetDate) + 1;
  }
  // Просроченная цель: весь недостающий остаток L защищается сразу, пока пользователь не уточнит срок.
  const Q = (elapsed: number): Minor => (goalOverdue ? L : N === 0 ? 0n : floorDiv(L * BigInt(Math.min(elapsed, N)), BigInt(N)));

  const charges = input.extraCharges ?? [];
  for (const c of charges) { assertDate(c.date, "charge.date"); if (c.amountMinor <= 0n) throw new RangeError("charge must be > 0"); }

  // Обход точек
  let C = input.balanceMinor;
  let n = 0;
  const E = () => (essential ?? 0n) * BigInt(n);
  const m = {
    minC: null as Minor | null, minCE: null as Minor | null, minProt: null as Minor | null, minEnv: null as Minor | null, minFree: null as Minor | null,
    firstMand: null as ISODate | null, firstEss: null as ISODate | null, firstProt: null as ISODate | null,
    worstMand: null as ISODate | null, worstEss: null as ISODate | null, worstProt: null as ISODate | null,
    safeDaily: null as Minor | null, infeasible: false,
  };

  const check = (date: ISODate) => {
    const q = Q(n);
    const env = C - R - S - q;
    const prot = C - E() - R - S - q;
    if (m.minC == null || C < m.minC) m.worstMand = date;
    m.minC = m.minC == null ? C : minBig(m.minC, C);
    if (C < 0n && !m.firstMand) m.firstMand = date;
    if (essential != null) {
      const ce = C - E();
      if (m.minCE == null || ce < m.minCE) m.worstEss = date;
      m.minCE = m.minCE == null ? ce : minBig(m.minCE, ce);
      if (ce < 0n && !m.firstEss) m.firstEss = date;
      m.minFree = m.minFree == null ? prot : minBig(m.minFree, prot);
    }
    if (m.minProt == null || prot < m.minProt) m.worstProt = date;
    m.minProt = m.minProt == null ? prot : minBig(m.minProt, prot);
    if (prot < 0n && !m.firstProt) m.firstProt = date;
    m.minEnv = m.minEnv == null ? env : minBig(m.minEnv, env);
    if (n > 0) { const per = floorDiv(env, BigInt(n)); m.safeDaily = m.safeDaily == null ? per : minBig(m.safeDaily, per); }
    else if (env < 0n) m.infeasible = true;
  };

  check(today);
  for (let d = today; d <= end; d = addDays(d, 1)) {
    for (const p of inHorizonPayments) if (effDate(p.dueOn) === d) { C -= p.amountMinor; check(d); }
    for (const c of charges) if (!c.afterIncome && effDate(c.date) === d) { C -= c.amountMinor; check(d); }
    n += 1; check(d); // повседневные траты дня и дневной взнос на цель
    for (const i of futureIncomes) if (i.dueOn === d) { C += i.remainingMinor; check(d); }
    for (const c of charges) if (c.afterIncome && effDate(c.date) === d) { C -= c.amountMinor; check(d); }
  }

  const days = diffDays(today, end) + 1;
  const sd: Minor = m.infeasible ? 0n : maxBig(0n, m.safeDaily ?? 0n);
  if (m.infeasible) limitations.add("PLAN_INFEASIBLE");
  if (essential == null) limitations.add("ESSENTIAL_SPENDING_UNKNOWN");
  let discretionary: Minor | null = null;
  if (essential != null) {
    discretionary = maxBig(0n, sd - essential);
    if (sd < essential) limitations.add("ESSENTIAL_NOT_COVERED");
  }
  const gap = (min: Minor | null, first: ISODate | null, worst: ISODate | null): Gap | null => (min != null && min < 0n && first ? { firstDate: first, amountMinor: -min, worstDate: worst ?? first } : null);
  const freeMoney: Minor | null = m.minFree;

  return {
    engineVersion: ENGINE_VERSION,
    today, horizonEnd: end, horizonKind: kind, days,
    balanceMinor: input.balanceMinor,
    reserveMinor: R,
    protectedSavedMinor: S,
    mandatoryMinor: inHorizonPayments.reduce((s, p) => s + p.amountMinor, 0n),
    incomeInHorizonMinor: futureIncomes.reduce((s, i) => s + i.remainingMinor, 0n),
    nextIncome: nextIncomeOcc ? { id: nextIncomeOcc.id, name: nextIncomeOcc.name, amountMinor: nextIncomeOcc.remainingMinor, dueOn: nextIncomeOcc.dueOn } : null,
    overdueIncomes: overdueIncomes.map((o) => ({ id: o.id, name: o.name, amountMinor: o.remainingMinor, dueOn: o.dueOn })),
    payments,
    goal: g ? {
      name: g.name, remainingMinor: L, targetDate: g.targetDate, overdue: goalOverdue,
      setAsideInHorizonMinor: Q(days),
      dailyNeedMinor: N > 0 ? L / BigInt(N) : 0n,
    } : null,
    freeMoneyMinor: freeMoney,
    dailyEnvelopeMinor: m.minEnv ?? 0n,
    availableForPurchaseMinor: freeMoney == null ? null : maxBig(0n, freeMoney),
    planShortfallMinor: freeMoney == null ? null : maxBig(0n, -freeMoney),
    safeDailyMinor: sd,
    discretionaryDailyMinor: discretionary,
    gaps: { mandatory: gap(m.minC, m.firstMand, m.worstMand), essential: gap(m.minCE, m.firstEss, m.worstEss), protected: gap(m.minProt, m.firstProt, m.worstProt) },
    limitations: [...limitations],
    assumptions,
  };
}
