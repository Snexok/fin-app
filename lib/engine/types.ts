import type { ISODate } from "./dates";
import type { Minor } from "./money";

export const ENGINE_VERSION = "2.0.0";

export type Direction = "income" | "expense";
export type Certainty = "committed" | "expected" | "speculative";

/** Плановое событие с уже посчитанной непогашенной частью (см. remainingOf). */
export interface OccurrenceInput {
  id: string;
  direction: Direction;
  name: string;
  remainingMinor: Minor;
  dueOn: ISODate;
  certainty: Certainty;
}

export interface GoalInput {
  name: string;
  targetMinor: Minor;
  /** Сколько уже накоплено. */
  savedMinor: Minor;
  /** true: накопленное лежит внутри остатка и защищается (S); false: хранится отдельно. */
  savedInBalance: boolean;
  /** Явно: какая часть накопленного лежит в остатке (S). Если задано, savedInBalance не используется. */
  protectedMinor?: Minor;
  targetDate: ISODate;
}

/** Гипотетическое списание сценария (покупка). afterIncome: в этот день после поступления дохода. */
export interface ExtraCharge { key: string; amountMinor: Minor; date: ISODate; afterIncome?: boolean }

export interface ForecastInput {
  today: ISODate;
  balanceMinor: Minor;
  reserveMinor: Minor;
  /** Необходимые повседневные траты в день; null = неизвестно. */
  essentialDailyMinor: Minor | null;
  occurrences: OccurrenceInput[];
  goal: GoalInput | null;
  /** Явный период планирования, если доход неизвестен. */
  planningDays?: number;
  /** Явный конец горизонта (включительно). */
  horizonEnd?: ISODate;
  /** "conservative" — только committed-доходы; "expected" — ещё и expected. */
  scenario?: "conservative" | "expected";
  extraCharges?: ExtraCharge[];
}

export type Limitation =
  | "ESSENTIAL_SPENDING_UNKNOWN"
  | "INCOME_UNKNOWN"
  | "INCOME_OVERDUE"
  | "GOAL_OVERDUE"
  | "PLAN_INFEASIBLE"
  | "ESSENTIAL_NOT_COVERED"
  | "HORIZON_ASSUMED";

/** firstDate — первая точка нехватки; amountMinor — максимальная нехватка в горизонте, достигается в worstDate. */
export interface Gap { firstDate: ISODate; amountMinor: Minor; worstDate: ISODate }

export interface ForecastPayment { id: string; name: string; amountMinor: Minor; dueOn: ISODate; overdue: boolean; inHorizon: boolean }

export interface Forecast {
  engineVersion: string;
  today: ISODate;
  horizonEnd: ISODate;
  horizonKind: "until_income" | "planning_period" | "explicit";
  /** Количество дневных лимитов в горизонте (включая сегодня и день дохода). */
  days: number;
  balanceMinor: Minor;
  reserveMinor: Minor;
  protectedSavedMinor: Minor;
  mandatoryMinor: Minor;
  incomeInHorizonMinor: Minor;
  nextIncome: { id: string; name: string; amountMinor: Minor; dueOn: ISODate } | null;
  overdueIncomes: { id: string; name: string; amountMinor: Minor; dueOn: ISODate }[];
  payments: ForecastPayment[];
  goal: null | {
    name: string;
    remainingMinor: Minor;
    targetDate: ISODate;
    overdue: boolean;
    /** Сколько по плану отложить к концу горизонта (Q на конец горизонта). */
    setAsideInHorizonMinor: Minor;
    /** Средний дневной взнос, округлён вниз (только для показа). */
    dailyNeedMinor: Minor;
  };
  /** min slack(k); null, если повседневный минимум неизвестен. */
  freeMoneyMinor: Minor | null;
  /** min [C - R - S - Q] — деньги до учёта повседневных расходов. */
  dailyEnvelopeMinor: Minor;
  availableForPurchaseMinor: Minor | null;
  planShortfallMinor: Minor | null;
  safeDailyMinor: Minor;
  discretionaryDailyMinor: Minor | null;
  gaps: { mandatory: Gap | null; essential: Gap | null; protected: Gap | null };
  limitations: Limitation[];
  assumptions: string[];
}

export type Assessment = "fits_plan" | "reduces_daily_margin" | "touches_protected_money" | "cash_gap" | "insufficient_data";

export interface GoalImpact {
  protectedShortfallMinor: Minor;
  deadlineFeasible: boolean | null;
  projectedCompletionDate: string | null;
  delayDays: number | null;
  reason?: "FUTURE_SAVING_CAPACITY_UNKNOWN" | "HORIZON_EXCEEDED";
}

export interface Scenario {
  key: string;
  priceMinor: Minor;
  date: ISODate;
  afterIncome: boolean;
  assessment: Assessment;
  baseline: Forecast;
  forecast: Forecast;
  freeAfterMinor: Minor | null;
  envelopeAfterMinor: Minor;
  safeDailyAfterMinor: Minor;
  firstGapDate: ISODate | null;
  gapMinor: Minor;
  reserveShortfallMinor: Minor;
  goalImpact: GoalImpact | null;
}

export interface PurchaseRequest {
  item: string;
  priceMinor: Minor;
  /** Дата покупки (по умолчанию сегодня). */
  date?: ISODate;
  recurring?: { cadence: "monthly" | "weekly"; everyN?: number };
  alternatives?: { key: string; priceMinor: Minor; date?: ISODate; afterIncome?: boolean }[];
}

export interface Simulation {
  engineVersion: string;
  item: string;
  baseline: Forecast;
  now: Scenario;
  /** Купить сразу после ближайшего дохода. null, если доход неизвестен. */
  afterIncome: Scenario | null;
  alternatives: Scenario[];
  /** "Подождать" предлагается только если afterIncome реально лучше. */
  waitIsBetter: boolean;
}
