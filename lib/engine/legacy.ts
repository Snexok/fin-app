// Совместимый слой: старый профиль в рублях (number) -> новый движок в копейках -> старая форма ответа.
// UI (app/page.tsx) читает эти поля; новые поля добавлены рядом, старые сохранены.
import { assertDate, isValidDate, type ISODate } from "./dates";
import { MoneyError, minorToRubles, rublesToMinor, MAX_MINOR, type Minor } from "./money";
import { forecast } from "./forecast";
import { simulatePurchase } from "./purchase";
import type { Assessment, Forecast, ForecastInput, Simulation } from "./types";

export interface Payment { name: string; amount: number; date: ISODate; overdue?: boolean }
export interface Goal { name: string; amount: number; date: ISODate; saved?: number; savedInBalance?: boolean }
export interface FinanceProfile {
  balance: number;
  nextIncome: { date: ISODate; amount: number };
  payments: Payment[];
  reserve: number;
  goal?: Goal | null;
  /** Новое необязательное поле: необходимые траты в день (еда, транспорт). */
  essentialDaily?: number | null;
}

export interface Snapshot {
  today: ISODate;
  daysToIncome: number;
  mandatoryBeforeIncome: number;
  upcomingPayments: Payment[];
  goalSetAside: number;
  goalDailyNeed: number;
  freeMoney: number;
  safeDaily: number;
  // --- новые поля (обратная совместимость сохранена) ---
  horizonEnd: ISODate;
  horizonKind: Forecast["horizonKind"];
  freeMoneyKnown: boolean;
  discretionaryDaily: number | null;
  cashGap: { date: ISODate; amount: number } | null;
  protectedShortfall: { date: ISODate; amount: number } | null;
  overdueIncome: boolean;
  limitations: string[];
}

export type Risk = "none" | "low" | "medium" | "high";
export type Verdict = "yes" | "careful" | "wait" | "no";

export interface ScenarioResult {
  key: "now" | "after_income";
  freeAfter: number;
  safeDailyAfter: number;
  periodDays: number;
  cashGap: boolean;
  /** Всегда 0: сдвиг цели больше не выдумывается (§4.7). См. goalImpact. */
  goalDelayDays: number;
  assessment: Assessment;
  horizonEnd: ISODate;
}

export interface PurchaseImpact {
  price: number;
  item: string;
  snapshot: Snapshot;
  freeAfter: number;
  safeDailyAfter: number;
  risk: Risk;
  cashGap: boolean;
  goalDelayDays: number;
  scenarios: { now: ScenarioResult; afterIncome: ScenarioResult | null };
  verdict: Verdict;
  assessment: Assessment;
  waitIsBetter: boolean;
}

export function validateProfile(p: FinanceProfile): string[] {
  const e: string[] = [];
  const money = (v: unknown, label: string, allowNeg = false) => {
    if (typeof v !== "number" || !Number.isFinite(v)) { e.push(`${label}: нужна сумма числом`); return; }
    if (!allowNeg && v < 0) e.push(`${label}: сумма не может быть отрицательной`);
    if (Math.abs(v) * 100 > Number(MAX_MINOR)) e.push(`${label}: слишком большая сумма`);
  };
  money(p?.balance, "Текущий остаток", true);
  if (!p?.nextIncome || !isValidDate(p.nextIncome.date)) e.push("Ближайший доход: нужна реальная дата");
  else money(p.nextIncome.amount, "Ближайший доход");
  money(p?.reserve, "Резерв");
  if (p?.essentialDaily != null) money(p.essentialDaily, "Траты в день");
  for (const pay of p?.payments ?? []) {
    if (!isValidDate(pay.date)) e.push(`Платёж "${pay.name}": нужна реальная дата`);
    if (!(typeof pay.amount === "number" && Number.isFinite(pay.amount) && pay.amount > 0)) e.push(`Платёж "${pay.name}": сумма должна быть больше нуля`);
  }
  if (p?.goal) {
    if (!isValidDate(p.goal.date)) e.push("Цель: нужна реальная дата");
    if (!(typeof p.goal.amount === "number" && Number.isFinite(p.goal.amount) && p.goal.amount > 0)) e.push("Цель: сумма должна быть больше нуля");
    if (p.goal.saved != null) money(p.goal.saved, "Цель: уже накоплено");
  }
  return e;
}

export function profileToInput(p: FinanceProfile, today: ISODate): ForecastInput {
  const errs = validateProfile(p);
  if (errs.length) throw new MoneyError(errs.join("; "));
  return {
    today,
    balanceMinor: rublesToMinor(p.balance),
    reserveMinor: rublesToMinor(p.reserve),
    essentialDailyMinor: p.essentialDaily == null ? null : rublesToMinor(p.essentialDaily),
    occurrences: [
      ...(p.nextIncome.amount > 0 ? [{ id: "income", direction: "income" as const, name: "Доход", remainingMinor: rublesToMinor(p.nextIncome.amount), dueOn: assertDate(p.nextIncome.date), certainty: "committed" as const }] : []),
      ...p.payments.map((x, i) => ({ id: `p${i}`, direction: "expense" as const, name: x.name, remainingMinor: rublesToMinor(x.amount), dueOn: assertDate(x.date), certainty: "committed" as const })),
    ],
    goal: p.goal ? { name: p.goal.name, targetMinor: rublesToMinor(p.goal.amount), savedMinor: rublesToMinor(p.goal.saved ?? 0), savedInBalance: !!p.goal.savedInBalance, targetDate: p.goal.date } : null,
  };
}

const R = minorToRubles;

export function forecastToSnapshot(f: Forecast): Snapshot {
  const free: Minor = f.freeMoneyMinor ?? f.dailyEnvelopeMinor;
  const cash = f.gaps.mandatory ?? f.gaps.essential;
  return {
    today: f.today,
    daysToIncome: f.days,
    mandatoryBeforeIncome: R(f.mandatoryMinor),
    upcomingPayments: f.payments.map((p) => ({ name: p.name, amount: R(p.amountMinor), date: p.dueOn, ...(p.overdue ? { overdue: true } : {}) })),
    goalSetAside: R(f.goal?.setAsideInHorizonMinor ?? 0n),
    goalDailyNeed: R(f.goal?.dailyNeedMinor ?? 0n),
    freeMoney: R(free),
    safeDaily: R(f.safeDailyMinor),
    horizonEnd: f.horizonEnd,
    horizonKind: f.horizonKind,
    freeMoneyKnown: f.freeMoneyMinor != null,
    discretionaryDaily: f.discretionaryDailyMinor == null ? null : R(f.discretionaryDailyMinor),
    cashGap: cash ? { date: cash.firstDate, amount: R(cash.amountMinor) } : null,
    protectedShortfall: f.gaps.protected ? { date: f.gaps.protected.firstDate, amount: R(f.gaps.protected.amountMinor) } : null,
    overdueIncome: f.overdueIncomes.length > 0,
    limitations: f.limitations,
  };
}

/** Свободные деньги до следующего дохода и безопасная сумма на день (совместимая форма). */
export function snapshot(p: FinanceProfile, today: ISODate): Snapshot {
  return forecastToSnapshot(forecast(profileToInput(p, today)));
}

const RISK: Record<Assessment, Risk> = { fits_plan: "none", reduces_daily_margin: "low", touches_protected_money: "medium", cash_gap: "high", insufficient_data: "medium" };

export function simulationToImpact(sim: Simulation, priceMinor: Minor): PurchaseImpact {
  const n = sim.now, a = sim.afterIncome;
  const sc = (s: NonNullable<typeof a>, key: ScenarioResult["key"]): ScenarioResult => ({
    key,
    freeAfter: R(s.freeAfterMinor ?? s.envelopeAfterMinor),
    safeDailyAfter: R(s.safeDailyAfterMinor),
    periodDays: s.forecast.days,
    cashGap: s.assessment === "cash_gap",
    goalDelayDays: 0,
    assessment: s.assessment,
    horizonEnd: s.forecast.horizonEnd,
  });
  const verdict: Verdict = n.assessment === "fits_plan" ? "yes" : n.assessment === "reduces_daily_margin" ? "careful" : sim.waitIsBetter ? "wait" : "no";
  const now = sc(n, "now");
  return {
    price: R(priceMinor), item: sim.item, snapshot: forecastToSnapshot(sim.baseline),
    freeAfter: now.freeAfter, safeDailyAfter: now.safeDailyAfter,
    risk: RISK[n.assessment], cashGap: now.cashGap, goalDelayDays: 0,
    scenarios: { now, afterIncome: a ? sc(a, "after_income") : null },
    verdict, assessment: n.assessment, waitIsBetter: sim.waitIsBetter,
  };
}

/** Влияние покупки (совместимая форма). Цена в рублях; Infinity/NaN/0/отрицательные отклоняются. */
export function purchaseImpact(p: FinanceProfile, price: number, today: ISODate, item = "покупка"): PurchaseImpact {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) throw new MoneyError("Цена должна быть положительным конечным числом");
  const priceMinor = rublesToMinor(price);
  return simulationToImpact(simulatePurchase(profileToInput(p, today), { item, priceMinor }), priceMinor);
}
