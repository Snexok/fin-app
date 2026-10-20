// Агрегаты служебных журналов для дашборда: обращения и ошибки (service_calls / service_errors),
// источники первого касания (user_sources) и число реальных пользователей. Только агрегаты, без псевдонимов.
// Команда и тестовые аккаунты исключены по умолчанию (internal / users.is_internal), как и в остальном дашборде.
import { getDb, type Queryable } from "./db";
import { MIN_COHORT, rate, scopedDb, type ChannelFilter } from "./analytics-metrics";

/** Ядро продукта для «обращений на DAU»: служебные вызовы (вход, батчи аналитики, настройки) не считаются. */
export const CORE_CALL_TYPES = ["chat.question", "chat.message", "sim.purchase", "onboarding.turn", "stt", "entry.create", "proposal.confirm", "proposal.reject", "plan.save", "reminder.send"] as const;

export interface OpsSummary {
  from: string; to: string; includeInternal: boolean;
  calls: { total: number; core: number; errors: number; errorRate: number | null; dauDays: number; corePerDau: number | null; p50: number | null; p95: number | null };
  types: { type: string; n: number; errors: number; errorRate: number | null; p95: number | null }[];
  errors: { total: number; s5xx: number; s4xx: number; other: number; codes: { code: string; route: string; status: number | null; n: number; last: string }[]; byChannel: { channel: string; n: number }[]; daily: { day: string; calls: number; errors: number }[] };
  sources: { total: number; rows: { source: string; medium: string | null; n: number; share: number | null; small: boolean }[]; byChannel: { channel: string; n: number }[] };
  users: { real: number; internal: number; newReal: number };
}

const num = (v: unknown) => (v == null ? 0 : Number(v));
const DAY = 86_400_000;

/** Сводка за [from, to). Канал: web/telegram/miniapp или null (все, включая cron). */
export async function opsSummary(from: Date, to: Date, channel: ChannelFilter = null, q?: Queryable, opts: { includeInternal?: boolean } = {}): Promise<OpsSummary> {
  const raw = q ?? (await getDb());
  const inc = !!opts.includeInternal;
  const ev = scopedDb(raw, inc);
  const P = [from, to, channel];
  const T = "occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz AND ($3::text IS NULL OR channel = $3::text)" + (inc ? "" : " AND NOT internal");
  const core = `call_type IN (${CORE_CALL_TYPES.map((x) => `'${x}'`).join(",")})`;

  const c = (await raw.query<Record<string, string | null>>(
    `SELECT count(*) total, count(*) FILTER (WHERE ${core}) core, count(*) FILTER (WHERE result='error') errors,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ${core}) p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ${core}) p95
       FROM service_calls WHERE ${T}`, P)).rows[0] ?? {};
  const dau = (await ev.query<{ n: string }>(
    `SELECT count(*) n FROM (SELECT DISTINCT subject, (occurred_at AT TIME ZONE 'UTC')::date FROM analytics_events
      WHERE name='user_active' AND occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz AND ($3::text IS NULL OR channel = $3::text)) t`, P)).rows[0];
  const types = (await raw.query<{ t: string; n: string; e: string; p95: number | null }>(
    `SELECT call_type t, count(*) n, count(*) FILTER (WHERE result='error') e, percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) p95
       FROM service_calls WHERE ${T} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, P)).rows;

  const e = (await raw.query<Record<string, string>>(
    `SELECT count(*) total, count(*) FILTER (WHERE http_status >= 500) s5, count(*) FILTER (WHERE http_status BETWEEN 400 AND 499) s4
       FROM service_errors WHERE ${T}`, P)).rows[0] ?? {};
  const codes = (await raw.query<{ code: string; route: string; status: number | null; n: string; last: Date }>(
    `SELECT code, mode() WITHIN GROUP (ORDER BY route) route, max(http_status) status, count(*) n, max(occurred_at) last
       FROM service_errors WHERE ${T} GROUP BY code ORDER BY 4 DESC, 1 LIMIT 5`, P)).rows;
  const byCh = (await raw.query<{ channel: string; n: string }>(`SELECT channel, count(*) n FROM service_errors WHERE ${T} GROUP BY 1 ORDER BY 2 DESC`, P)).rows;
  const dCalls = (await raw.query<{ d: string; n: string; e: string }>(
    `SELECT ((occurred_at AT TIME ZONE 'UTC')::date)::text d, count(*) n, count(*) FILTER (WHERE result='error') e FROM service_calls WHERE ${T} GROUP BY 1`, P)).rows;
  const dErr = (await raw.query<{ d: string; n: string }>(
    `SELECT ((occurred_at AT TIME ZONE 'UTC')::date)::text d, count(*) n FROM service_errors WHERE ${T} GROUP BY 1`, P)).rows;
  const daily: OpsSummary["errors"]["daily"] = [];
  for (let t = from.getTime(); t < to.getTime(); t += DAY) {
    const day = new Date(t).toISOString().slice(0, 10);
    daily.push({ day, calls: num(dCalls.find((x) => x.d === day)?.n), errors: num(dErr.find((x) => x.d === day)?.n) });
  }

  const S = "s.first_seen_at >= $1::timestamptz AND s.first_seen_at < $2::timestamptz AND ($3::text IS NULL OR s.channel = $3::text)" + (inc ? "" : " AND NOT u.is_internal");
  const src = (await raw.query<{ source: string; medium: string | null; n: string }>(
    `SELECT s.source, s.medium, count(*) n FROM user_sources s JOIN users u ON u.id = s.user_id WHERE ${S} GROUP BY 1, 2 ORDER BY 3 DESC, 1 LIMIT 7`, P)).rows;
  const srcTotal = num((await raw.query<{ n: string }>(`SELECT count(*) n FROM user_sources s JOIN users u ON u.id = s.user_id WHERE ${S}`, P)).rows[0]?.n);
  const srcCh = (await raw.query<{ channel: string; n: string }>(`SELECT s.channel, count(*) n FROM user_sources s JOIN users u ON u.id = s.user_id WHERE ${S} GROUP BY 1 ORDER BY 2 DESC`, P)).rows;

  const real = (await ev.query<{ n: string; nw: string }>(
    `SELECT count(DISTINCT subject) n FROM analytics_events WHERE name='user_active' AND occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz AND ($3::text IS NULL OR channel = $3::text)`, P)).rows[0];
  const internal = (await raw.query<{ n: string }>("SELECT count(*) n FROM users WHERE is_internal AND deleted_at IS NULL")).rows[0];
  // Новые аккаунты: по всем каналам — users.created_at; с фильтром канала — по каналу первого касания.
  const newReal = (await raw.query<{ n: string }>(channel
    ? `SELECT count(*) n FROM user_sources s JOIN users u ON u.id = s.user_id WHERE u.created_at >= $1::timestamptz AND u.created_at < $2::timestamptz AND s.channel = $3::text AND u.deleted_at IS NULL${inc ? "" : " AND NOT u.is_internal"}`
    : `SELECT count(*) n FROM users u WHERE u.created_at >= $1::timestamptz AND u.created_at < $2::timestamptz AND u.deleted_at IS NULL${inc ? "" : " AND NOT u.is_internal"}`,
    channel ? [from, to, channel] : [from, to])).rows[0];

  const total = num(c.total), errors = num(c.errors), dauDays = num(dau?.n);
  return {
    from: from.toISOString(), to: to.toISOString(), includeInternal: inc,
    calls: { total, core: num(c.core), errors, errorRate: rate(errors, total), dauDays, corePerDau: rate(num(c.core), dauDays), p50: c.p50 == null ? null : Math.round(Number(c.p50)), p95: c.p95 == null ? null : Math.round(Number(c.p95)) },
    types: types.map((x) => ({ type: x.t, n: num(x.n), errors: num(x.e), errorRate: rate(num(x.e), num(x.n)), p95: x.p95 == null ? null : Math.round(Number(x.p95)) })),
    errors: {
      total: num(e.total), s5xx: num(e.s5), s4xx: num(e.s4), other: num(e.total) - num(e.s5) - num(e.s4),
      codes: codes.map((x) => ({ code: x.code, route: x.route, status: x.status == null ? null : Number(x.status), n: num(x.n), last: new Date(x.last).toISOString() })),
      byChannel: byCh.map((x) => ({ channel: x.channel, n: num(x.n) })), daily,
    },
    sources: {
      total: srcTotal,
      rows: src.map((x) => ({ source: x.source, medium: x.medium, n: num(x.n), share: rate(num(x.n), srcTotal), small: num(x.n) < MIN_COHORT })),
      byChannel: srcCh.map((x) => ({ channel: x.channel, n: num(x.n) })),
    },
    users: { real: num(real?.n), internal: num(internal?.n), newReal: num(newReal?.n) },
  };
}
