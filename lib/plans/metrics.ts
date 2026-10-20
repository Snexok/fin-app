// Агрегаты «Плюс и токены» для дашборда (/internal/analytics) и проверок. Только события из закрытого списка:
// plus_viewed, plus_interest, tokens_exhausted, ai_answer_consumed, user_active. Команда и тесты исключены (analytics_events_real),
// распределение цен: группы меньше MIN_COHORT скрыты («<5»). Денег и оплат нет: этап 1, только интерес.
import { getDb, type Queryable } from "../db";
import { MIN_COHORT, rate, scopedDb, type ChannelFilter } from "../analytics-metrics";
import { plansConfig } from "./config";

export interface PlusSummary {
  from: string; to: string; includeInternal: boolean; demo: boolean; minCohort: number;
  mode: "beta" | "live"; priceRub: number; options: number[];
  views: number; viewers: number; surfaces: { surface: string; views: number }[];
  interested: number; repeats: number; conversion: number | null;
  /** Последний выбор цены каждого заинтересованного; users=null — меньше minCohort (скрыто). */
  prices: { price: string; users: number | null }[];
  consumed: number; dauDays: number; activeUsers: number; perDau: number | null;
  exhaustedUsers: number; exhaustedShare: number | null; exhaustedUserDays: number;
  byPurpose: { purpose: string; n: number }[];
  daily: { day: string; consumed: number; dau: number; exhausted: number }[];
}
const num = (v: unknown) => (v == null ? 0 : Number(v));
const DAY = 86_400_000;

export async function plusSummary(from: Date, to: Date, channel: ChannelFilter = null, q?: Queryable, opts: { includeInternal?: boolean; minCohort?: number } = {}): Promise<PlusSummary> {
  const db = scopedDb(q ?? (await getDb()), !!opts.includeInternal);
  const min = opts.minCohort ?? MIN_COHORT;
  const cfg = plansConfig();
  const W = "occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz AND ($3::text IS NULL OR channel = $3::text)";
  const P = [from, to, channel];
  const head = (await db.query<Record<string, string | boolean | null>>(
    `SELECT count(*) FILTER (WHERE name='plus_viewed') views, count(DISTINCT subject) FILTER (WHERE name='plus_viewed') viewers,
            count(DISTINCT subject) FILTER (WHERE name='plus_interest') interested,
            count(*) FILTER (WHERE name='plus_interest' AND props->>'repeat'='true') repeats,
            count(*) FILTER (WHERE name='ai_answer_consumed') consumed,
            count(DISTINCT subject) FILTER (WHERE name='tokens_exhausted') exh_users,
            count(DISTINCT (subject, (occurred_at AT TIME ZONE 'UTC')::date)) FILTER (WHERE name='tokens_exhausted') exh_days,
            count(DISTINCT subject) FILTER (WHERE name='user_active') active,
            count(DISTINCT (subject, (occurred_at AT TIME ZONE 'UTC')::date)) FILTER (WHERE name='user_active') dau_days,
            COALESCE(bool_or(demo), false) demo
       FROM analytics_events WHERE ${W} AND name IN ('plus_viewed','plus_interest','ai_answer_consumed','tokens_exhausted','user_active')`, P)).rows[0] ?? {};
  const surfaces = (await db.query<{ s: string; n: string }>(
    `SELECT props->>'surface' s, count(*) n FROM analytics_events WHERE ${W} AND name='plus_viewed' GROUP BY 1 ORDER BY 2 DESC`, P)).rows;
  const pr = (await db.query<{ p: string; n: string }>(
    `SELECT p, count(*) n FROM (SELECT DISTINCT ON (subject) props->>'price' p FROM analytics_events WHERE ${W} AND name='plus_interest' ORDER BY subject, occurred_at DESC, id DESC) t GROUP BY 1`, P)).rows;
  const purposes = (await db.query<{ p: string; n: string }>(
    `SELECT props->>'purpose' p, count(*) n FROM analytics_events WHERE ${W} AND name='ai_answer_consumed' GROUP BY 1 ORDER BY 2 DESC`, P)).rows;
  const dRows = (await db.query<{ d: string; c: string; a: string; x: string }>(
    `SELECT ((occurred_at AT TIME ZONE 'UTC')::date)::text d, count(*) FILTER (WHERE name='ai_answer_consumed') c,
            count(DISTINCT subject) FILTER (WHERE name='user_active') a, count(DISTINCT subject) FILTER (WHERE name='tokens_exhausted') x
       FROM analytics_events WHERE ${W} AND name IN ('ai_answer_consumed','user_active','tokens_exhausted') GROUP BY 1`, P)).rows;
  const daily: PlusSummary["daily"] = [];
  for (let t = from.getTime(); t < to.getTime(); t += DAY) {
    const day = new Date(t).toISOString().slice(0, 10), r = dRows.find((x) => x.d === day);
    daily.push({ day, consumed: num(r?.c), dau: num(r?.a), exhausted: num(r?.x) });
  }
  const order = [...cfg.price.options.map(String), "none"];
  const prices = order.map((p) => pr.find((x) => x.p === p)).filter(Boolean).concat(pr.filter((x) => !order.includes(x.p)))
    .map((x) => ({ price: x!.p, users: num(x!.n) >= min ? num(x!.n) : null }));
  const viewers = num(head.viewers), interested = num(head.interested), dauDays = num(head.dau_days), active = num(head.active), consumed = num(head.consumed);
  return {
    from: from.toISOString(), to: to.toISOString(), includeInternal: !!opts.includeInternal, demo: !!head.demo, minCohort: min,
    mode: cfg.mode, priceRub: cfg.price.plusRub, options: cfg.price.options,
    views: num(head.views), viewers, surfaces: surfaces.map((x) => ({ surface: x.s, views: num(x.n) })),
    interested, repeats: num(head.repeats), conversion: viewers ? rate(interested, viewers) : null, prices,
    consumed, dauDays, activeUsers: active, perDau: dauDays ? consumed / dauDays : null,
    exhaustedUsers: num(head.exh_users), exhaustedShare: active ? rate(num(head.exh_users), active) : null, exhaustedUserDays: num(head.exh_days),
    byPurpose: purposes.map((x) => ({ purpose: x.p, n: num(x.n) })), daily,
  };
}
