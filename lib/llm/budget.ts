// Атомарные бюджеты LLM: резерв оценённой максимальной стоимости ДО вызова, сверка с фактом ПОСЛЕ, освобождение при сбое.
// Резерв — одна условная вставка/обновление на счётчик (INSERT … ON CONFLICT DO UPDATE … WHERE spent + reserved + x <= limit):
// Postgres блокирует строку счётчика, поэтому параллельные запросы видят резервы друг друга и не пробивают потолок.
// Три счётчика в одной транзакции (всегда в одном порядке — без взаимоблокировок): весь бюджет → день проекта → день пользователя.
// Отказ любого откатывает остальные. Ошибка БД при резерве = отказ (fail closed): ответ уйдёт шаблоном, деньги не потратятся.
import { getDb, type Queryable } from "../db";
import { budgetDay, type LlmConfig } from "./config";

export type BudgetScope = "total" | "project" | "user" | "unavailable";
export interface Reservation { day: string; totalStart: string; userId: string | null; micro: number; done: boolean }
export type ReserveResult = { ok: true; reservation: Reservation } | { ok: false; scope: BudgetScope };

const UPSERT = `
  INSERT INTO budget_buckets(scope_type, scope_id, period_kind, period_start, reserved_microrub)
  SELECT $1, $2, $3, $4::date, $5::bigint WHERE $5::bigint <= $6::bigint
  ON CONFLICT (scope_type, scope_id, period_kind, period_start) DO UPDATE
     SET reserved_microrub = budget_buckets.reserved_microrub + EXCLUDED.reserved_microrub, updated_at = now()
   WHERE budget_buckets.spent_microrub + budget_buckets.reserved_microrub + EXCLUDED.reserved_microrub <= $6::bigint
  RETURNING 1 AS ok`;

class Denied extends Error { constructor(public scope: BudgetScope) { super("BUDGET_DENIED"); } }

async function take(q: Queryable, scope: BudgetScope, args: [string, string, string, string], micro: number, limit: number) {
  const r = await q.query(UPSERT, [...args, micro, limit]);
  if (!r.rows.length) throw new Denied(scope);
}

/** Резерв micro µ₽ на день (по Москве) у проекта, всего бюджета и пользователя (если есть). */
export async function reserveBudget(o: { userId: string | null; micro: number; cfg: LlmConfig; now?: Date }): Promise<ReserveResult> {
  const day = budgetDay(o.now);
  const micro = Math.max(0, Math.ceil(o.micro));
  const { cfg } = o;
  try {
    const db = await getDb();
    await db.tx(async (q) => {
      await take(q, "total", ["project", "all", "total", cfg.budgetStart], micro, cfg.totalBudgetMicro);
      await take(q, "project", ["project", "all", "day", day], micro, cfg.dailyCapMicro);
      // Мягкий лимит пользователя: 0 — без лимита. Пользователь без id (cron, система) не ограничен.
      if (o.userId && cfg.userSoftCapMicro > 0) await take(q, "user", ["user", o.userId, "day", day], micro, cfg.userSoftCapMicro);
    });
    return { ok: true, reservation: { day, totalStart: cfg.budgetStart, userId: o.userId, micro, done: false } };
  } catch (e) {
    if (e instanceof Denied) return { ok: false, scope: e.scope };
    if (process.env.NODE_ENV !== "production") console.warn("[llm-budget] reserve failed", (e as Error)?.message);
    return { ok: false, scope: "unavailable" };
  }
}

/** Сверка: снять резерв, добавить факт. Повторный вызов ничего не делает. Никогда не бросает. */
export async function settleBudget(r: Reservation | null | undefined, actualMicro: number): Promise<boolean> {
  if (!r || r.done) return false;
  r.done = true;
  try {
    const db = await getDb();
    await db.query(
      `UPDATE budget_buckets SET reserved_microrub = GREATEST(0, reserved_microrub - $1::bigint), spent_microrub = spent_microrub + $2::bigint, updated_at = now()
        WHERE (scope_type = 'project' AND scope_id = 'all' AND ((period_kind = 'day' AND period_start = $3::date) OR (period_kind = 'total' AND period_start = $4::date)))
           OR (scope_type = 'user' AND scope_id = $5 AND period_kind = 'day' AND period_start = $3::date)`,
      [r.micro, Math.max(0, Math.ceil(actualMicro)), r.day, r.totalStart, r.userId ?? ""]);
    return true;
  } catch (e) {
    if (process.env.NODE_ENV !== "production") console.warn("[llm-budget] settle failed", (e as Error)?.message);
    return false;
  }
}

export const releaseBudget = (r: Reservation | null | undefined) => settleBudget(r, 0);

export interface BudgetState { day: string; spentMicro: number; reservedMicro: number; capMicro: number; totalSpentMicro: number; totalMicro: number; totalMaxMicro: number; budgetStart: string }

/** Текущее состояние счётчиков проекта (весь расход, включая команду и тесты: потолок считает деньги). */
export async function budgetState(cfg: LlmConfig, now = new Date(), q?: Queryable): Promise<BudgetState> {
  const db = q ?? (await getDb());
  const day = budgetDay(now);
  const r = await db.query<{ period_kind: string; spent_microrub: string; reserved_microrub: string }>(
    `SELECT period_kind, spent_microrub, reserved_microrub FROM budget_buckets
      WHERE scope_type = 'project' AND scope_id = 'all' AND ((period_kind = 'day' AND period_start = $1::date) OR (period_kind = 'total' AND period_start = $2::date))`,
    [day, cfg.budgetStart]);
  const d = r.rows.find((x) => x.period_kind === "day"), t = r.rows.find((x) => x.period_kind === "total");
  return {
    day, spentMicro: Number(d?.spent_microrub ?? 0), reservedMicro: Number(d?.reserved_microrub ?? 0), capMicro: cfg.dailyCapMicro,
    totalSpentMicro: Number(t?.spent_microrub ?? 0), totalMicro: cfg.totalBudgetMicro, totalMaxMicro: cfg.totalBudgetMaxMicro, budgetStart: cfg.budgetStart,
  };
}
