// Агрегаты стоимости LLM для дашборда (/internal/analytics, карточка «LLM и бюджет») и проверок.
// Источники: ai_usage (каждая попытка: модель, токены, стоимость, задержка, итог) и budget_buckets (счётчики потолка).
// Команда и тесты исключены по умолчанию (ai_usage.internal), как и во всём дашборде. Счётчики бюджета считают ВЕСЬ
// расход (деньги одни), поэтому «в счётчике потолка» показывается отдельно.
import { getDb, type Queryable } from "./db";
import { rate, scopedDb, type ChannelFilter } from "./analytics-metrics";
import { budgetDay, llmConfig } from "./llm/config";
import { budgetState } from "./llm/budget";

export interface LlmSummary {
  from: string; to: string; includeInternal: boolean; demo: boolean;
  setup: { enabled: boolean; configured: boolean; killed: boolean; provider: string; primary: string; fallbacks: string[] };
  today: { day: string; spentMicro: number; bucketSpentMicro: number; bucketReservedMicro: number; capMicro: number; share: number | null; userCapMicro: number };
  period: {
    spentMicro: number; operations: number; attempts: number; okOps: number; fallbackOps: number; fallbackRate: number | null;
    deniedOps: number; deniedUserDays: number; failedOps: number; timeouts: number; promptTokens: number; completionTokens: number;
    audioSec: number; p50: number | null; p95: number | null; dauDays: number; costPerDauMicro: number | null; aiAnswers: number;
  };
  total: { spentMicro: number; budgetMicro: number; budgetMaxMicro: number; budgetStart: string; share: number | null };
  models: { model: string; calls: number; ok: number; costMicro: number; share: number | null }[];
  purposes: { purpose: string; calls: number; costMicro: number }[];
  daily: { day: string; costMicro: number }[];
}

const num = (v: unknown) => (v == null ? 0 : Number(v));
const DAY = 86_400_000;

/** Сводка за полные дни дашборда [from, to) (дни бюджета по Москве) + «сегодня» по Москве + накопительно с начала бюджета.
 *  На DAU = расход за период / сумма DAU по дням (DAU — уникальные user_active за UTC-день, как во всём дашборде). */
export async function llmSummary(from: Date, to: Date, now = new Date(), channel: ChannelFilter = null, q?: Queryable, opts: { includeInternal?: boolean } = {}): Promise<LlmSummary> {
  const raw = q ?? (await getDb());
  const inc = !!opts.includeInternal;
  const cfg = llmConfig();
  const F = (i: number) => `($${i}::text IS NULL OR channel = $${i}::text)` + (inc ? "" : " AND NOT internal");
  // Период — дни бюджета по Москве [день(from), день(to)): у дашборда from/to — полночь UTC, это 03:00 МСК того же дня.
  const T = "budget_day >= $1::date AND budget_day < $2::date AND " + F(3);
  const P = [budgetDay(from), budgetDay(to), channel];

  const ops = (await raw.query<Record<string, string | null>>(
    `WITH o AS (
       SELECT request_id, bool_or(status IN ('ok', 'fallback')) okk, bool_or(status = 'fallback') fb, bool_or(status = 'budget_denied') den,
              bool_or(status = 'budget_denied' AND error_code = 'LLM_BUDGET_USER') den_user, max(subject) subject, max(budget_day) d,
              bool_or(ai_answer) ans
         FROM ai_usage WHERE ${T} GROUP BY request_id)
     SELECT count(*) ops, count(*) FILTER (WHERE okk) okk, count(*) FILTER (WHERE fb) fb, count(*) FILTER (WHERE den) den,
            count(*) FILTER (WHERE NOT okk AND NOT den) failed, count(*) FILTER (WHERE ans) ans,
            count(DISTINCT (subject, d)) FILTER (WHERE den_user) den_user_days FROM o`, P)).rows[0] ?? {};
  const att = (await raw.query<Record<string, string | null>>(
    `SELECT count(*) FILTER (WHERE status <> 'budget_denied') attempts, coalesce(sum(cost_microrub), 0) cost,
            coalesce(sum(prompt_tokens), 0) pt, coalesce(sum(completion_tokens), 0) ct, coalesce(sum(audio_ms), 0) audio,
            count(*) FILTER (WHERE status = 'timeout') timeouts,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status IN ('ok', 'fallback')) p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status IN ('ok', 'fallback')) p95,
            COALESCE(bool_or(demo), false) demo
       FROM ai_usage WHERE ${T}`, P)).rows[0] ?? {};
  const models = (await raw.query<{ model: string; n: string; ok: string; cost: string }>(
    `SELECT model, count(*) n, count(*) FILTER (WHERE status IN ('ok', 'fallback')) ok, coalesce(sum(cost_microrub), 0) cost
       FROM ai_usage WHERE ${T} AND status <> 'budget_denied' GROUP BY 1 ORDER BY 4 DESC, 2 DESC LIMIT 6`, P)).rows;
  const purposes = (await raw.query<{ purpose: string; n: string; cost: string }>(
    `SELECT purpose, count(DISTINCT request_id) n, coalesce(sum(cost_microrub), 0) cost FROM ai_usage WHERE ${T} GROUP BY 1 ORDER BY 3 DESC`, P)).rows;
  const dRows = (await raw.query<{ d: string; cost: string }>(
    `SELECT budget_day::text d, coalesce(sum(cost_microrub), 0) cost FROM ai_usage WHERE ${T} GROUP BY 1`, P)).rows;
  const daily: LlmSummary["daily"] = [];
  for (let t = from.getTime(); t < to.getTime(); t += DAY) {
    const day = budgetDay(new Date(t + 12 * 3_600_000));
    daily.push({ day, costMicro: num(dRows.find((x) => x.d === day)?.cost) });
  }
  const dau = (await scopedDb(raw, inc).query<{ n: string }>(
    `SELECT count(*) n FROM (SELECT DISTINCT subject, (occurred_at AT TIME ZONE 'UTC')::date FROM analytics_events
      WHERE name='user_active' AND occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz AND ($3::text IS NULL OR channel = $3::text)) t`, [from, to, channel])).rows[0];

  const today = budgetDay(now);
  const td = (await raw.query<{ cost: string }>(`SELECT coalesce(sum(cost_microrub), 0) cost FROM ai_usage WHERE budget_day = $1::date AND ${F(2)}`, [today, channel])).rows[0];
  // Весь бюджет акселератора — деньги проекта целиком: без фильтров канала и команды.
  const tot = (await raw.query<{ cost: string }>(`SELECT coalesce(sum(cost_microrub), 0) cost FROM ai_usage WHERE budget_day >= $1::date`, [cfg.budgetStart])).rows[0];
  const b = await budgetState(cfg, now, raw).catch(() => null);

  const spent = num(att.cost), dauDays = num(dau?.n), okOps = num(ops.okk);
  const totalSpent = Math.max(num(tot?.cost), b?.totalSpentMicro ?? 0);
  return {
    from: from.toISOString(), to: to.toISOString(), includeInternal: inc, demo: (att.demo as unknown) === true || att.demo === "t",
    setup: { enabled: cfg.enabled, configured: cfg.configured, killed: cfg.killed, provider: cfg.provider, primary: cfg.primary, fallbacks: cfg.fallbacks },
    today: { day: today, spentMicro: num(td?.cost), bucketSpentMicro: b?.spentMicro ?? 0, bucketReservedMicro: b?.reservedMicro ?? 0, capMicro: cfg.dailyCapMicro,
      share: rate(Math.max(num(td?.cost), b?.spentMicro ?? 0), cfg.dailyCapMicro), userCapMicro: cfg.userSoftCapMicro },
    period: {
      spentMicro: spent, operations: num(ops.ops), attempts: num(att.attempts), okOps, fallbackOps: num(ops.fb), fallbackRate: rate(num(ops.fb), okOps),
      deniedOps: num(ops.den), deniedUserDays: num(ops.den_user_days), failedOps: num(ops.failed), timeouts: num(att.timeouts),
      promptTokens: num(att.pt), completionTokens: num(att.ct), audioSec: Math.round(num(att.audio) / 1000),
      p50: att.p50 == null ? null : Math.round(Number(att.p50)), p95: att.p95 == null ? null : Math.round(Number(att.p95)),
      dauDays, costPerDauMicro: dauDays ? Math.round(spent / dauDays) : null, aiAnswers: num(ops.ans),
    },
    total: { spentMicro: totalSpent, budgetMicro: cfg.totalBudgetMicro, budgetMaxMicro: cfg.totalBudgetMaxMicro, budgetStart: cfg.budgetStart, share: rate(totalSpent, cfg.totalBudgetMicro) },
    models: models.map((m) => ({ model: m.model, calls: num(m.n), ok: num(m.ok), costMicro: num(m.cost), share: rate(num(m.n), num(att.attempts)) })),
    purposes: purposes.map((x) => ({ purpose: x.purpose, calls: num(x.n), costMicro: num(x.cost) })),
    daily,
  };
}

/** Рубли из микрорублей для подписи: до 10 ₽ — с копейками, до 0,01 ₽ — «<0,01». */
export function rubLabel(micro: number): string {
  const r = micro / 1_000_000;
  if (micro > 0 && r < 0.01) return "<0,01\u00a0₽";
  const s = r >= 100 ? Math.round(r).toLocaleString("ru-RU") : r.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${s}\u00a0₽`.replace(/\u202f/g, "\u00a0");
}
