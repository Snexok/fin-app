// Прикладной слой финансов: права (всегда WHERE user_id = владелец), транзакции, версии, события.
// Формул здесь нет — только сбор входов для lib/engine и запись подтверждённых изменений.
import { getDb, type Queryable } from "./db";
import {
  assertDate, assertDateWithin, assertNonNegativeAmount, GOAL_FUTURE_DAYS, MAX_MINOR, assertPositiveAmount, computeBalance, DEFAULT_TZ, ENGINE_VERSION, forecast, localDate,
  minorToRubles, remainingOf, rublesToMinor, simulatePurchase, simulationToImpact, forecastToSnapshot,
  type Certainty, type Forecast, type ForecastInput, type ISODate, type Minor, type PurchaseRequest, type Simulation,
} from "./engine";
import type { FinanceProfile } from "./engine/legacy";
import { ApiError, big, uuid } from "./util";

export interface OccurrenceRow { id: string; direction: "income" | "expense"; name: string; amountMinor: Minor; dueOn: ISODate; certainty: Certainty; settledMinor: Minor; remainingMinor: Minor }
export interface BookState {
  userId: string;
  timezone: string;
  financeVersion: bigint;
  openingMinor: Minor;
  balanceMinor: Minor;
  reserveMinor: Minor;
  essentialDailyMinor: Minor | null;
  planningDays: number;
  occurrences: OccurrenceRow[];
  goal: null | { id: string; name: string; targetMinor: Minor; targetDate: ISODate; allocatedMinor: Minor; savedOutsideMinor: Minor };
}

export async function userTimezone(q: Queryable, userId: string): Promise<string> {
  const r = await q.query<{ timezone: string }>("SELECT timezone FROM users WHERE id=$1", [userId]);
  return r.rows[0]?.timezone ?? DEFAULT_TZ;
}

/** Загружает бюджет владельца. lock=true блокирует строку books (SELECT ... FOR UPDATE). */
export async function loadBook(q: Queryable, userId: string, lock = false): Promise<BookState | null> {
  const b = await q.query<Record<string, unknown>>(
    `SELECT b.*, u.timezone FROM books b JOIN users u ON u.id=b.user_id WHERE b.user_id=$1 ${lock ? "FOR UPDATE OF b" : ""}`, [userId]);
  const row = b.rows[0];
  if (!row) return null;
  // Граница сравнивается в SQL: timestamptz не проходит через JS Date (потеря микросекунд).
  const entries = await q.query<{ amount_minor: string; affects_balance: boolean }>(
    "SELECT e.amount_minor::text, e.affects_balance FROM ledger_entries e JOIN books b ON b.user_id=e.user_id WHERE e.user_id=$1 AND e.created_at > b.opening_as_of", [userId]);
  const occ = await q.query<Record<string, string>>(
    `SELECT o.id, o.direction, o.name, o.amount_minor::text AS amount_minor, o.due_on::text AS due_on, o.certainty,
            COALESCE((SELECT SUM(CASE WHEN o.direction='expense' THEN -e.amount_minor ELSE e.amount_minor END)
                      FROM ledger_entries e WHERE e.user_id=o.user_id AND e.occurrence_id=o.id), 0)::text AS settled
       FROM occurrences o WHERE o.user_id=$1 AND o.cancelled_at IS NULL ORDER BY o.due_on, o.created_at`, [userId]);
  const goal = await q.query<Record<string, string>>(
    `SELECT g.id, g.name, g.target_minor::text AS target_minor, g.target_date::text AS target_date, g.saved_outside_minor::text AS saved_outside,
            COALESCE((SELECT SUM(delta_minor) FROM goal_allocations a WHERE a.user_id=g.user_id AND a.goal_id=g.id),0)::text AS allocated
       FROM goals g WHERE g.user_id=$1 AND g.status='active' ORDER BY g.priority, g.created_at LIMIT 1`, [userId]);
  const opening = big(row.opening_balance_minor);
  const g = goal.rows[0];
  return {
    userId,
    timezone: String(row.timezone ?? DEFAULT_TZ),
    financeVersion: big(row.finance_version),
    openingMinor: opening,
    balanceMinor: computeBalance(opening, entries.rows.map((e) => ({ amountMinor: big(e.amount_minor), affectsBalance: e.affects_balance }))),
    reserveMinor: big(row.reserve_minor),
    essentialDailyMinor: row.essential_daily_minor == null ? null : big(row.essential_daily_minor),
    planningDays: Number(row.planning_days),
    occurrences: occ.rows.map((o) => {
      const amount = big(o.amount_minor), settled = big(o.settled);
      return { id: o.id, direction: o.direction as "income" | "expense", name: o.name, amountMinor: amount, dueOn: o.due_on, certainty: o.certainty as Certainty, settledMinor: settled, remainingMinor: remainingOf(amount, [settled]) };
    }),
    goal: g ? { id: g.id, name: g.name, targetMinor: big(g.target_minor), targetDate: g.target_date, allocatedMinor: big(g.allocated), savedOutsideMinor: big(g.saved_outside) } : null,
  };
}

export function toForecastInput(b: BookState, today: ISODate): ForecastInput {
  return {
    today,
    balanceMinor: b.balanceMinor,
    reserveMinor: b.reserveMinor,
    essentialDailyMinor: b.essentialDailyMinor,
    planningDays: b.planningDays,
    occurrences: b.occurrences.map((o) => ({ id: o.id, direction: o.direction, name: o.name, remainingMinor: o.remainingMinor, dueOn: o.dueOn, certainty: o.certainty })),
    goal: b.goal ? {
      name: b.goal.name, targetMinor: b.goal.targetMinor, targetDate: b.goal.targetDate,
      savedMinor: b.goal.allocatedMinor + b.goal.savedOutsideMinor, savedInBalance: false, protectedMinor: b.goal.allocatedMinor,
    } : null,
  };
}

export interface CalculationMeta {
  financeVersion: string; engineVersion: string; asOfDate: ISODate; timezone: string; horizonEnd: ISODate; calculatedAt: string;
  completeness: "complete" | "partial" | "stale"; limitations: string[]; assumptions: string[]; sourceIds: string[];
}

export function metaOf(b: BookState, f: Forecast, now: Date): CalculationMeta {
  const partial = f.limitations.some((l) => l === "ESSENTIAL_SPENDING_UNKNOWN" || l === "INCOME_UNKNOWN" || l === "HORIZON_ASSUMED");
  return {
    financeVersion: b.financeVersion.toString(), engineVersion: ENGINE_VERSION, asOfDate: f.today, timezone: b.timezone, horizonEnd: f.horizonEnd,
    calculatedAt: now.toISOString(),
    completeness: f.limitations.includes("INCOME_OVERDUE") ? "stale" : partial ? "partial" : "complete",
    limitations: f.limitations, assumptions: f.assumptions, sourceIds: b.occurrences.map((o) => o.id),
  };
}

export interface ForecastView { book: BookState; forecast: Forecast; meta: CalculationMeta; today: ISODate }

/** Согласованный снимок бюджета: все чтения в одной транзакции REPEATABLE READ. */
export async function loadBookSnapshot(userId: string): Promise<BookState | null> {
  const db = await getDb();
  return db.tx(async (q) => {
    await q.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return loadBook(q, userId);
  });
}

export async function getForecast(userId: string, now = new Date(), q?: Queryable): Promise<ForecastView | null> {
  const book = q ? await loadBook(q, userId) : await loadBookSnapshot(userId);
  if (!book) return null;
  const today = localDate(now, book.timezone);
  const f = forecast(toForecastInput(book, today));
  return { book, forecast: f, meta: metaOf(book, f, now), today };
}

/** Увеличивает finance_version ровно один раз и пишет finance_event в той же транзакции. */
export async function bumpVersion(q: Queryable, userId: string, eventType: string, entityId: string | null, payload: unknown): Promise<bigint> {
  const r = await q.query<{ v: string }>("UPDATE books SET finance_version = finance_version + 1, updated_at = now() WHERE user_id=$1 RETURNING finance_version::text AS v", [userId]);
  const v = big(r.rows[0].v);
  await q.query("INSERT INTO finance_events(id, user_id, finance_version, event_type, entity_id, payload) VALUES ($1,$2,$3,$4,$5,$6)",
    [uuid(), userId, v, eventType, entityId, JSON.stringify(payload, (_k, x) => (typeof x === "bigint" ? x.toString() : x))]);
  return v;
}

// ---------- Онбординг / план ----------

export interface PlanInput {
  balanceMinor: Minor;
  reserveMinor: Minor;
  essentialDailyMinor: Minor | null;
  incomes: { name: string; amountMinor: Minor; dueOn: ISODate; certainty?: Certainty }[];
  payments: { name: string; amountMinor: Minor; dueOn: ISODate }[];
  /** savedMinor не задан — накопления по существующей цели сохраняются как есть (форма их не редактирует). */
  goal: null | { name: string; targetMinor: Minor; targetDate: ISODate; savedMinor?: Minor; savedInBalance?: boolean };
  /** Период планирования (дни), если доход нерегулярный или неизвестен. Не задан — не меняется (по умолчанию 30). */
  planningDays?: number;
}

const MAX_NAME = 120;
const cleanName = (s: unknown, fallback: string) => (typeof s === "string" && s.trim() ? s.trim().slice(0, MAX_NAME) : fallback);

export function validatePlan(p: PlanInput, today?: ISODate): PlanInput {
  if (typeof p.balanceMinor !== "bigint") throw new ApiError("INVALID_INPUT", 422, "Нужен текущий остаток");
  if (p.balanceMinor > MAX_MINOR || p.balanceMinor < -MAX_MINOR) throw new ApiError("INVALID_AMOUNT", 422, "Текущий остаток: слишком большая сумма");
  assertNonNegativeAmount(p.reserveMinor, "Резерв");
  if (p.essentialDailyMinor != null) assertNonNegativeAmount(p.essentialDailyMinor, "Траты в день");
  if (p.incomes.length + p.payments.length > 100) throw new ApiError("INVALID_INPUT", 422, "Слишком много записей");
  const d = (v: unknown, field: string, goal = false) => (today ? assertDateWithin(v, today, field, goal ? { futureDays: GOAL_FUTURE_DAYS } : {}) : assertDate(v, field));
  for (const i of p.incomes) { assertPositiveAmount(i.amountMinor, "Доход"); d(i.dueOn, "Дата дохода"); }
  for (const x of p.payments) { assertPositiveAmount(x.amountMinor, `Платёж ${x.name}`); d(x.dueOn, `Дата платежа ${x.name}`); }
  if (p.planningDays != null && !(Number.isInteger(p.planningDays) && p.planningDays >= 1 && p.planningDays <= 365)) throw new ApiError("INVALID_INPUT", 422, "Период планирования: от 1 до 365 дней");
  if (p.goal) { assertPositiveAmount(p.goal.targetMinor, "Цель"); d(p.goal.targetDate, "Дата цели", true); if (p.goal.savedMinor != null) assertNonNegativeAmount(p.goal.savedMinor, "Уже накоплено"); }
  return p;
}

export interface SavePlanOptions {
  /** finance_version, на которой пользователь открыл форму. Не совпала под блокировкой — 409, ничего не пишется. */
  baseFinanceVersion?: bigint | null;
  /** Для формы: при существующем бюджете baseFinanceVersion обязателен. */
  requireBase?: boolean;
}

/**
 * Применяет план целиком (явное действие пользователя в форме или после онбординга в боте).
 * Остаток становится новой точкой отсчёта; прежние плановые события отменяются, история операций сохраняется.
 * Устаревшая форма (версия изменилась, например трата из Telegram) не перезаписывает остаток: 409 FINANCE_VERSION_CONFLICT.
 * Активная цель обновляется на месте: накопления (аллокации и saved_outside) сохраняются, если план их явно не задаёт.
 */
export async function savePlan(userId: string, plan: PlanInput, source: "form" | "telegram" | "chat", now = new Date(), opts: SavePlanOptions = {}): Promise<bigint> {
  validatePlan(plan);
  const db = await getDb();
  return db.tx(async (q) => {
    // Блокируем строку пользователя: сериализует создание бюджета и привязку аккаунтов (confirmLink).
    const u = await q.query<{ timezone: string }>("SELECT timezone FROM users WHERE id=$1 FOR UPDATE", [userId]);
    if (!u.rows.length) throw new ApiError("NOT_FOUND", 404, "Аккаунт не найден");
    validatePlan(plan, localDate(now, u.rows[0].timezone ?? DEFAULT_TZ));
    const exists = await q.query<{ v: string }>("SELECT finance_version::text AS v FROM books WHERE user_id=$1 FOR UPDATE", [userId]);
    const current = exists.rows[0] ? big(exists.rows[0].v) : null;
    if (current != null && (opts.baseFinanceVersion != null || opts.requireBase) && opts.baseFinanceVersion !== current) {
      const book = await loadBook(q, userId);
      throw new ApiError("FINANCE_VERSION_CONFLICT", 409, "Пока вы заполняли план, данные изменились (например, записалась трата). Проверьте остаток и сохраните ещё раз.",
        { financeVersion: current.toString(), balanceMinor: book?.balanceMinor.toString() ?? null });
    }
    if (current == null) {
      await q.query("INSERT INTO books(user_id, opening_balance_minor, opening_as_of, reserve_minor, essential_daily_minor, last_reconciled_at) VALUES ($1,$2,clock_timestamp(),$3,$4,$5)",
        [userId, plan.balanceMinor, plan.reserveMinor, plan.essentialDailyMinor, now]);
    } else {
      await q.query("UPDATE books SET opening_balance_minor=$2, opening_as_of=clock_timestamp(), reserve_minor=$4, essential_daily_minor=$5, last_reconciled_at=$3 WHERE user_id=$1",
        [userId, plan.balanceMinor, now, plan.reserveMinor, plan.essentialDailyMinor]);
      await q.query("UPDATE occurrences SET cancelled_at=$2 WHERE user_id=$1 AND cancelled_at IS NULL", [userId, now]);
    }
    for (const i of plan.incomes)
      await q.query("INSERT INTO occurrences(id, user_id, direction, name, amount_minor, due_on, certainty) VALUES ($1,$2,'income',$3,$4,$5,$6)",
        [uuid(), userId, cleanName(i.name, "Доход"), i.amountMinor, i.dueOn, i.certainty ?? "committed"]);
    for (const x of plan.payments)
      await q.query("INSERT INTO occurrences(id, user_id, direction, name, amount_minor, due_on, certainty) VALUES ($1,$2,'expense',$3,$4,$5,'committed')",
        [uuid(), userId, cleanName(x.name, "Платёж"), x.amountMinor, x.dueOn]);
    if (plan.planningDays != null) await q.query("UPDATE books SET planning_days=$2 WHERE user_id=$1", [userId, plan.planningDays]);
    await saveGoal(q, userId, plan.goal);
    return bumpVersion(q, userId, "plan_saved", null, { source, incomes: plan.incomes.length, payments: plan.payments.length, goal: !!plan.goal });
  });
}

async function saveGoal(q: Queryable, userId: string, goal: PlanInput["goal"]) {
  const ex = await q.query<{ id: string; allocated: string }>(
    `SELECT g.id, COALESCE((SELECT SUM(delta_minor) FROM goal_allocations a WHERE a.user_id=g.user_id AND a.goal_id=g.id),0)::text AS allocated
       FROM goals g WHERE g.user_id=$1 AND g.status='active' ORDER BY g.priority, g.created_at LIMIT 1 FOR UPDATE OF g`, [userId]);
  const existing = ex.rows[0];
  if (!goal) {
    if (existing) await q.query("UPDATE goals SET status='cancelled' WHERE user_id=$1 AND status='active'", [userId]);
    return;
  }
  const name = cleanName(goal.name, "Цель");
  let gid: string;
  if (existing) {
    gid = existing.id;
    await q.query("UPDATE goals SET name=$3, target_minor=$4, target_date=$5 WHERE id=$1 AND user_id=$2", [gid, userId, name, goal.targetMinor, goal.targetDate]);
    // Прочие активные цели (наследие старой логики "отменить и создать") не трогаем, кроме дубликатов.
    await q.query("UPDATE goals SET status='cancelled' WHERE user_id=$1 AND status='active' AND id<>$2", [userId, gid]);
    if (goal.savedMinor == null) return; // накопления не редактировались — сохраняем как есть
  } else {
    gid = uuid();
    await q.query("INSERT INTO goals(id, user_id, name, target_minor, target_date, saved_outside_minor) VALUES ($1,$2,$3,$4,$5,0)", [gid, userId, name, goal.targetMinor, goal.targetDate]);
  }
  const saved = goal.savedMinor ?? 0n;
  const inBalance = goal.savedInBalance === true;
  await q.query("UPDATE goals SET saved_outside_minor=$3 WHERE id=$1 AND user_id=$2", [gid, userId, inBalance ? 0n : saved]);
  const delta = (inBalance ? saved : 0n) - (existing ? big(existing.allocated) : 0n);
  if (delta !== 0n) await q.query("INSERT INTO goal_allocations(id, user_id, goal_id, delta_minor, reason) VALUES ($1,$2,$3,$4,'plan')", [uuid(), userId, gid, delta]);
}

// ---------- Точечные правки (онбординг-чат, режим «Изменить») ----------
// Каждая операция: блокировка books, проверка версии, узкое изменение, ровно один bumpVersion. План целиком не перезаписывается.

export interface PatchOptions {
  now?: Date;
  /** finance_version, на которой задан вопрос. Не совпала под блокировкой — 409 FINANCE_VERSION_CONFLICT, ничего не пишется. */
  baseFinanceVersion?: bigint | null;
}

async function patchTx<T>(userId: string, eventType: string, payload: unknown, opts: PatchOptions, fn: (q: Queryable, today: ISODate, now: Date) => Promise<T>): Promise<{ result: T; financeVersion: bigint }> {
  const now = opts.now ?? new Date();
  const db = await getDb();
  return db.tx(async (q) => {
    const b = await q.query<{ timezone: string; v: string }>("SELECT u.timezone, b.finance_version::text AS v FROM books b JOIN users u ON u.id=b.user_id WHERE b.user_id=$1 FOR UPDATE OF b", [userId]);
    if (!b.rows.length) throw new ApiError("NO_PLAN", 409, "Сначала нужен план: остаток и доход");
    const current = big(b.rows[0].v);
    if (opts.baseFinanceVersion != null && opts.baseFinanceVersion !== current) {
      const book = await loadBook(q, userId);
      throw new ApiError("FINANCE_VERSION_CONFLICT", 409, "Пока мы говорили, данные изменились (например, записалась трата).",
        { financeVersion: current.toString(), balanceMinor: book?.balanceMinor.toString() ?? null });
    }
    const result = await fn(q, localDate(now, b.rows[0].timezone ?? DEFAULT_TZ), now);
    const financeVersion = await bumpVersion(q, userId, eventType, null, payload);
    return { result, financeVersion };
  });
}

/** Новый остаток «сейчас»: становится точкой отсчёта, прошлые операции сохраняются в истории. */
export async function setBalance(userId: string, balanceMinor: Minor, opts: PatchOptions = {}) {
  if (balanceMinor < 0n || balanceMinor > MAX_MINOR) throw new ApiError("INVALID_AMOUNT", 422, "Текущий остаток: некорректная сумма");
  return patchTx(userId, "balance_set", { source: "chat" }, opts, async (q, _today, now) => {
    await q.query("UPDATE books SET opening_balance_minor=$2, opening_as_of=clock_timestamp(), last_reconciled_at=$3 WHERE user_id=$1", [userId, balanceMinor, now]);
  });
}

/**
 * Ближайший доход: заменяет только указанные плановые доходы (replaceIds, без проводок), остальные не трогает.
 * income=null + planningDays — доход нерегулярный: считаем на период. Возвращает id нового дохода.
 */
export async function setNextIncome(userId: string, income: { amountMinor: Minor; dueOn: ISODate; name?: string } | null, planningDays: number | undefined, replaceIds: string[], opts: PatchOptions = {}) {
  if (planningDays != null && !(Number.isInteger(planningDays) && planningDays >= 1 && planningDays <= 365)) throw new ApiError("INVALID_INPUT", 422, "Период планирования: от 1 до 365 дней");
  return patchTx(userId, "income_set", { source: "chat", income: !!income, replaced: replaceIds.length }, opts, async (q, today, now) => {
    if (income) { assertPositiveAmount(income.amountMinor, "Доход"); assertDateWithin(income.dueOn, today, "Дата дохода"); }
    if (replaceIds.length) await q.query(`UPDATE occurrences o SET cancelled_at=$3 WHERE o.user_id=$1 AND o.id = ANY($2::uuid[]) AND o.direction='income' AND o.cancelled_at IS NULL
                     AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.user_id=o.user_id AND e.occurrence_id=o.id)`, [userId, replaceIds, now]);
    let id: string | null = null;
    if (income) {
      id = uuid();
      await q.query("INSERT INTO occurrences(id, user_id, direction, name, amount_minor, due_on, certainty) VALUES ($1,$2,'income',$3,$4,$5,'committed')",
        [id, userId, cleanName(income.name, "Доход"), income.amountMinor, income.dueOn]);
    }
    if (planningDays != null) await q.query("UPDATE books SET planning_days=$2 WHERE user_id=$1", [userId, planningDays]);
    return id;
  });
}

/**
 * Обязательные платежи этого диалога: replaceIds (ранее добавленные им же) заменяются новым списком. Возвращает id новых.
 * Если заменяемый платёж уже частично оплачен — 409: не дублируем остаток оплаченного платежа.
 */
export async function setPayments(userId: string, payments: { name: string; amountMinor: Minor; dueOn: ISODate }[], replaceIds: string[] = [], opts: PatchOptions = {}) {
  if (payments.length > 50) throw new ApiError("INVALID_INPUT", 422, "Слишком много платежей");
  return patchTx(userId, "payments_set", { source: "chat", count: payments.length, replaced: replaceIds.length }, opts, async (q, today, now) => {
    for (const p of payments) { assertPositiveAmount(p.amountMinor, `Платёж ${p.name}`); assertDateWithin(p.dueOn, today, `Дата платежа ${p.name}`); }
    if (replaceIds.length) {
      const settled = await q.query("SELECT 1 FROM ledger_entries e WHERE e.user_id=$1 AND e.occurrence_id = ANY($2::uuid[]) LIMIT 1", [userId, replaceIds]);
      if (settled.rows.length) throw new ApiError("FINANCE_VERSION_CONFLICT", 409, "Один из платежей уже оплачен — поправьте его на вкладке «Платежи».");
      await q.query("UPDATE occurrences SET cancelled_at=$3 WHERE user_id=$1 AND id = ANY($2::uuid[]) AND direction='expense' AND cancelled_at IS NULL", [userId, replaceIds, now]);
    }
    const ids: string[] = [];
    for (const p of payments) {
      const id = uuid(); ids.push(id);
      await q.query("INSERT INTO occurrences(id, user_id, direction, name, amount_minor, due_on, certainty) VALUES ($1,$2,'expense',$3,$4,$5,'committed')", [id, userId, cleanName(p.name, "Платёж"), p.amountMinor, p.dueOn]);
    }
    return ids;
  });
}

export async function setReserve(userId: string, reserveMinor: Minor, opts: PatchOptions = {}) {
  assertNonNegativeAmount(reserveMinor, "Резерв");
  return patchTx(userId, "reserve_set", { source: "chat" }, opts, async (q) => { await q.query("UPDATE books SET reserve_minor=$2 WHERE user_id=$1", [userId, reserveMinor]); });
}

/** null = «не знаю»: движок покажет ESSENTIAL_SPENDING_UNKNOWN, а не посчитает 0. */
export async function setEssentialDaily(userId: string, essentialDailyMinor: Minor | null, opts: PatchOptions = {}) {
  if (essentialDailyMinor != null) assertNonNegativeAmount(essentialDailyMinor, "Траты в день");
  return patchTx(userId, "essential_set", { source: "chat", known: essentialDailyMinor != null }, opts, async (q) => { await q.query("UPDATE books SET essential_daily_minor=$2 WHERE user_id=$1", [userId, essentialDailyMinor]); });
}

export async function setGoal(userId: string, goal: PlanInput["goal"], opts: PatchOptions = {}) {
  return patchTx(userId, "goal_set", { source: "chat", goal: !!goal }, opts, async (q, today) => {
    if (goal) { assertPositiveAmount(goal.targetMinor, "Цель"); assertDateWithin(goal.targetDate, today, "Дата цели", { futureDays: GOAL_FUTURE_DAYS }); }
    await saveGoal(q, userId, goal);
  });
}

// ---------- Совместимость с /api/profile (рубли) ----------

const toMinor = (v: unknown, field: string): Minor => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ApiError("INVALID_INPUT", 422, `${field}: нужна сумма числом`);
  return rublesToMinor(v);
};

/** Старое тело POST /api/profile (рубли) -> PlanInput. Новые поля: essentialDaily, goal.savedInBalance, *Minor-строки. */
export function legacyProfileToPlan(p: Record<string, any>): PlanInput { // eslint-disable-line @typescript-eslint/no-explicit-any
  const m = (minorKey: string, rubKey: string, src: Record<string, unknown>, field: string, optional = false): Minor | null => {
    const mv = src?.[minorKey];
    if (typeof mv === "string" && /^-?\d{1,15}$/.test(mv)) return BigInt(mv);
    const rv = src?.[rubKey];
    if (rv == null || rv === "") { if (optional) return null; throw new ApiError("INVALID_INPUT", 422, `${field}: нужна сумма`); }
    return toMinor(typeof rv === "string" ? Number(rv.replace(/\s/g, "").replace(",", ".")) : rv, field);
  };
  const ni = p.nextIncome ?? {};
  const incomes = [{ name: "Доход", amountMinor: m("amountMinor", "amount", ni, "Ближайший доход")!, dueOn: assertDate(ni.date, "Дата дохода") }];
  const payments = (Array.isArray(p.payments) ? p.payments : []).map((x: Record<string, unknown>, i: number) => ({
    name: cleanName(x?.name, "Платёж"), amountMinor: m("amountMinor", "amount", x, `Платёж ${i + 1}`)!, dueOn: assertDate(x?.date, `Дата платежа ${i + 1}`),
  }));
  const g = p.goal;
  return {
    balanceMinor: m("balanceMinor", "balance", p, "Текущий остаток")!,
    reserveMinor: m("reserveMinor", "reserve", p, "Резерв", true) ?? 0n,
    essentialDailyMinor: m("essentialDailyMinor", "essentialDaily", p, "Траты в день", true),
    incomes: incomes.filter((i) => { if (i.amountMinor < 0n) throw new ApiError("INVALID_INPUT", 422, "Доход не может быть отрицательным"); return i.amountMinor > 0n; }),
    payments,
    goal: g && (g.amount || g.amountMinor) ? {
      name: cleanName(g.name, "Цель"), targetMinor: m("amountMinor", "amount", g, "Цель")!, targetDate: assertDate(g.date, "Дата цели"),
      savedMinor: m("savedMinor", "saved", g, "Уже накоплено", true) ?? undefined, savedInBalance: g.savedInBalance === true,
    } : null,
  };
}

/** Профиль в старой форме (рубли) для UI: собирается из бюджета. */
export function legacyProfile(v: ForecastView): FinanceProfile {
  const b = v.book, f = v.forecast;
  const R = minorToRubles;
  const income = f.nextIncome ?? f.overdueIncomes[f.overdueIncomes.length - 1] ?? null;
  // Погашенный доход не возвращаем как предстоящий (иначе GET -> POST создаст его заново).
  const lastIncome = b.occurrences.filter((o) => o.direction === "income" && o.remainingMinor > 0n).slice(-1)[0];
  return {
    balance: R(b.balanceMinor),
    reserve: R(b.reserveMinor),
    essentialDaily: b.essentialDailyMinor == null ? null : R(b.essentialDailyMinor),
    nextIncome: income ? { date: income.dueOn, amount: R(income.amountMinor) } : lastIncome ? { date: lastIncome.dueOn, amount: R(lastIncome.remainingMinor) } : { date: f.horizonEnd, amount: 0 },
    payments: b.occurrences.filter((o) => o.direction === "expense" && o.remainingMinor > 0n).map((o) => ({ name: o.name, amount: R(o.remainingMinor), date: o.dueOn })),
    goal: b.goal ? { name: b.goal.name, amount: R(b.goal.targetMinor), date: b.goal.targetDate, saved: R(b.goal.allocatedMinor + b.goal.savedOutsideMinor), savedInBalance: b.goal.allocatedMinor > 0n } : null,
  };
}

// ---------- Проверка покупки (не меняет финансовую версию) ----------

export interface SimulationView { decisionId: string; simulation: Simulation; meta: CalculationMeta }

export async function simulate(userId: string, req: PurchaseRequest, question: string | null, now = new Date()): Promise<SimulationView> {
  const db = await getDb();
  const book = await loadBookSnapshot(userId);
  if (!book) throw new ApiError("NO_PLAN", 409, "Сначала нужен план: остаток, доход и платежи");
  const today = localDate(now, book.timezone);
  const sim = simulatePurchase(toForecastInput(book, today), req);
  const decisionId = uuid();
  const impact = simulationToImpact(sim, req.priceMinor);
  const result = { assessment: sim.now.assessment, verdict: impact.verdict, waitIsBetter: sim.waitIsBetter, freeAfter: impact.freeAfter, safeDailyAfter: impact.safeDailyAfter };
  // Исходный текст вопроса хранится только при явном согласии (users.history_enabled). Без него — только итог расчёта.
  const hist = await db.query<{ history_enabled: boolean }>("SELECT history_enabled FROM users WHERE id=$1", [userId]);
  const keepText = hist.rows[0]?.history_enabled === true;
  await db.query("INSERT INTO decisions(id, user_id, finance_version, engine_version, as_of_date, input, result) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
    decisionId, userId, book.financeVersion, ENGINE_VERSION, today,
    JSON.stringify({ question: keepText ? question?.slice(0, 500) ?? null : null, item: req.item, priceMinor: req.priceMinor.toString(), date: req.date ?? null }),
    JSON.stringify(result),
  ]);
  return { decisionId, simulation: sim, meta: metaOf(book, sim.baseline, now) };
}

export interface HistoryItem { at: string; question: string; item: string; price: number; verdict: string; freeAfter: number; safeDailyAfter: number; assessment?: string; financeVersion: string }

export async function listDecisions(userId: string, limit = 50): Promise<HistoryItem[]> {
  const db = await getDb();
  const r = await db.query<{ created_at: Date; input: any; result: any; finance_version: string }>( // eslint-disable-line @typescript-eslint/no-explicit-any
    "SELECT created_at, input, result, finance_version::text FROM decisions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2", [userId, limit]);
  return r.rows.map((d) => {
    const input = typeof d.input === "string" ? JSON.parse(d.input) : d.input;
    const result = typeof d.result === "string" ? JSON.parse(d.result) : d.result;
    return {
      at: new Date(d.created_at).toISOString(), question: input.question ?? "", item: input.item, price: Number(input.priceMinor) / 100,
      verdict: result.verdict, freeAfter: result.freeAfter, safeDailyAfter: result.safeDailyAfter, assessment: result.assessment, financeVersion: d.finance_version,
    };
  });
}

export async function recentEntries(userId: string, limit = 20) {
  const db = await getDb();
  const r = await db.query<Record<string, string>>(
    "SELECT id, kind, amount_minor::text AS amount_minor, name, source, occurrence_id, occurred_at, occurred_on::text AS occurred_on, reversal_of FROM ledger_entries WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2", [userId, limit]);
  return r.rows.map((e) => ({ id: e.id, kind: e.kind, amountMinor: e.amount_minor, name: e.name, source: e.source, occurrenceId: e.occurrence_id, occurredAt: new Date(e.occurred_at).toISOString(), occurredOn: e.occurred_on ?? null, reversalOf: e.reversal_of }));
}

export { forecastToSnapshot };
