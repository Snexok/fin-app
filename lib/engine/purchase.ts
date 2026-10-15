// Сценарии покупки (§4.8–4.9). Все варианты используют одни и те же входы и допущения.
import { addDays, assertDate, monthlyDates, weeklyDates, type ISODate } from "./dates";
import { assertPositiveAmount, type Minor } from "./money";
import { forecast, resolveHorizon, DEFAULT_PLANNING_DAYS } from "./forecast";
import { ENGINE_VERSION, type Assessment, type ExtraCharge, type Forecast, type ForecastInput, type GoalImpact, type PurchaseRequest, type Scenario, type Simulation } from "./types";

/** Продуктовое правило пилота (версионируется вместе с ENGINE_VERSION): "заметно" = запас на день падает больше чем вдвое. */
export const MARGIN_DROP_RATIO = 0.5;

/** Горизонт, который покрывает дату from и следующий доход после неё (или явный период планирования). */
export function horizonCovering(input: ForecastInput, from: ISODate, afterIncome = false): { end: ISODate; assumed: boolean } {
  const base = resolveHorizon(input).end;
  if (from < base || (from === base && !afterIncome)) return { end: base, assumed: false };
  const next = input.occurrences
    .filter((o) => o.direction === "income" && o.remainingMinor > 0n && o.certainty === "committed" && o.dueOn > from)
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0];
  if (next) return { end: next.dueOn, assumed: false };
  return { end: addDays(from, (input.planningDays ?? DEFAULT_PLANNING_DAYS) - 1), assumed: true };
}

function chargesFor(req: { priceMinor: Minor; date: ISODate; afterIncome?: boolean }, recurring: PurchaseRequest["recurring"], horizonEnd: ISODate, key: string): ExtraCharge[] {
  if (!recurring) return [{ key, amountMinor: req.priceMinor, date: req.date, afterIncome: req.afterIncome }];
  const dates = recurring.cadence === "monthly"
    ? monthlyDates(req.date, req.date, horizonEnd, recurring.everyN ?? 1)
    : weeklyDates(req.date, req.date, horizonEnd, recurring.everyN ?? 1);
  return dates.map((d, i) => ({ key: `${key}#${i}`, amountMinor: req.priceMinor, date: d, afterIncome: i === 0 ? req.afterIncome : false }));
}

export function assess(baseline: Forecast, after: Forecast): Assessment {
  if (after.gaps.mandatory || after.gaps.essential) return "cash_gap";
  if (after.gaps.protected) return "touches_protected_money";
  const before = baseline.discretionaryDailyMinor ?? baseline.safeDailyMinor;
  const now = after.discretionaryDailyMinor ?? after.safeDailyMinor;
  if (before > 0n && Number(now) < Number(before) * MARGIN_DROP_RATIO) return "reduces_daily_margin";
  return "fits_plan";
}

function goalImpact(input: ForecastInput, after: Forecast): GoalImpact | null {
  if (!input.goal) return null;
  const within = input.goal.targetDate <= after.horizonEnd;
  if (input.goal.targetDate < input.today && input.goal.targetMinor > input.goal.savedMinor) {
    return { protectedShortfallMinor: after.gaps.protected?.amountMinor ?? 0n, deadlineFeasible: false, projectedCompletionDate: null, delayDays: null, reason: "FUTURE_SAVING_CAPACITY_UNKNOWN" };
  }
  return {
    protectedShortfallMinor: after.gaps.protected?.amountMinor ?? 0n,
    deadlineFeasible: within ? !after.gaps.protected : null,
    projectedCompletionDate: null,
    delayDays: null,
    reason: within ? "FUTURE_SAVING_CAPACITY_UNKNOWN" : "HORIZON_EXCEEDED",
  };
}

export function scenario(input: ForecastInput, key: string, priceMinor: Minor, date: ISODate, opts: { afterIncome?: boolean; recurring?: PurchaseRequest["recurring"] } = {}): Scenario {
  assertPositiveAmount(priceMinor, "price");
  assertDate(date, "purchase.date");
  if (date < input.today) throw new RangeError("Дата покупки в прошлом");
  const h = horizonCovering(input, date, !!opts.afterIncome);
  const scoped: ForecastInput = { ...input, horizonEnd: h.end };
  const baseline = forecast(scoped);
  const after = forecast({ ...scoped, extraCharges: [...(input.extraCharges ?? []), ...chargesFor({ priceMinor, date, afterIncome: opts.afterIncome }, opts.recurring, h.end, key)] });
  if (h.assumed) {
    for (const f of [baseline, after]) {
      if (!f.limitations.includes("HORIZON_ASSUMED")) f.limitations.push("HORIZON_ASSUMED");
      f.assumptions.push(`Следующий доход после ${date} неизвестен: расчёт до ${h.end}, это не гарантия.`);
    }
  }
  if (opts.recurring) after.assumptions.push(`Повторяющийся платёж учтён до ${h.end}; платежи после этой даты не входят в расчёт.`);
  const firstGap = after.gaps.mandatory ?? after.gaps.essential ?? null;
  return {
    key, priceMinor, date, afterIncome: !!opts.afterIncome,
    assessment: assess(baseline, after),
    baseline, forecast: after,
    freeAfterMinor: after.freeMoneyMinor,
    envelopeAfterMinor: after.dailyEnvelopeMinor,
    safeDailyAfterMinor: after.safeDailyMinor,
    firstGapDate: firstGap?.firstDate ?? null,
    gapMinor: firstGap?.amountMinor ?? 0n,
    reserveShortfallMinor: after.gaps.protected?.amountMinor ?? 0n,
    goalImpact: goalImpact(input, after),
  };
}

const RANK: Record<Assessment, number> = { fits_plan: 0, reduces_daily_margin: 1, touches_protected_money: 2, cash_gap: 3, insufficient_data: 4 };

export function simulatePurchase(input: ForecastInput, req: PurchaseRequest): Simulation {
  const price = assertPositiveAmount(req.priceMinor, "price");
  const baseline = forecast(input);
  const date = req.date ?? input.today;
  const now = scenario(input, "now", price, date, { recurring: req.recurring });
  // "После дохода": покупка в день ближайшего committed-дохода, после его поступления.
  let afterIncome: Scenario | null = null;
  if (baseline.nextIncome && baseline.horizonKind === "until_income") {
    afterIncome = scenario(input, "after_income", price, baseline.nextIncome.dueOn, { afterIncome: true, recurring: req.recurring });
  }
  const alternatives = (req.alternatives ?? []).map((a) => scenario(input, a.key, a.priceMinor, a.date ?? input.today, { afterIncome: a.afterIncome }));
  const waitIsBetter = !!afterIncome && RANK[afterIncome.assessment] < RANK[now.assessment] && RANK[afterIncome.assessment] <= RANK.reduces_daily_margin;
  return { engineVersion: ENGINE_VERSION, item: req.item, baseline, now, afterIncome, alternatives, waitIsBetter };
}
