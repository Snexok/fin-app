// Метрики продуктовой аналитики для внутреннего дашборда. Только агрегаты, без строк пользователей.
// Соглашения (видны на дашборде в «что считается»):
//  • дни — UTC; период — последние N ПОЛНЫХ дней, сегодняшний неполный день не входит;
//  • сравнение — с предыдущим периодом той же длины;
//  • когорта — по первому активному дню; удержание считается только по «созревшим» пользователям;
//  • малые группы (< MIN_COHORT) скрываются.
import { getDb, type Queryable } from "./db";

export const MIN_COHORT = Number(process.env.ANALYTICS_MIN_COHORT ?? 5);
/** Минимальная выборка, при которой дашборд делает выводы (иначе «мало данных»). */
export const MIN_SAMPLE = 30;
export const PERIODS = [7, 30, 90] as const;
export const CHANNELS = ["web", "telegram", "miniapp"] as const;
export type ChannelFilter = (typeof CHANNELS)[number] | null;
export const FUNNEL_STEPS = ["balance", "income", "payments", "reserve", "essentialDaily", "goal"] as const;
export const VERDICTS = ["fits_plan", "reduces_daily_margin", "touches_protected_money", "cash_gap", "insufficient_data"] as const;
export const REMINDER_KINDS = ["payment_due", "payday", "onboarding", "log_nudge", "weekly", "morning"] as const;
export const FREQ_BUCKETS = ["0", "1", "2–3", "4–9", "10+"] as const;
export const TTV_BUCKETS = ["<1 мин", "1–3 мин", "3–10 мин", "10–60 мин", "1–24 ч", ">24 ч"] as const;
export const RET_DAYS = [1, 7, 14, 30] as const;

const DAY = 86_400_000;
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown) => (v == null ? 0 : Number(v));
export const rate = (a: number, b: number) => (b > 0 ? a / b : null);
const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

// Общий фильтр событий: период + канал. $1 from, $2 to, $3 channel|null.
const W = "occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz AND ($3::text IS NULL OR channel = $3::text)";

export interface FunnelStage { key: string; n: number; drop: number; dropRate: number | null; ofStart: number | null; unknownShare: number | null; skippedShare: number | null }
export interface Period {
  from: string; to: string;
  active: number; newUsers: number; wauEnd: number; activeUserWeeks: number;
  activation: { starters: number; matured: number; activated: number; rate: number | null; reached: number; p50Min: number | null; buckets: number[]; never: number };
  funnel: { attempts: number; stages: FunnelStage[]; completed: number; completion: number | null };
  asks: { total: number; askers: number; perActiveWeek: number | null; freq: number[]; repeatShare: number | null };
  verdicts: Record<string, number>;
  reminders: {
    kinds: { kind: string; sent: number; recipients: number; clicked: number; ctr: number | null; disabled: number; disableRate: number | null }[];
    sent: number; clicked: number; ctr: number | null; disabledAll: number; blocked: number; recipients: number;
    effect: { remindedDays: number; remindedActive: number; otherDays: number; otherActive: number; lift: number | null } | null;
  };
  retention: { d1: Ret; d7: Ret };
  value: { proposalsCreated: number; proposalsConfirmed: number; completion: number | null; corrections: number; notUnderstood: number };
}
export interface Ret { n: number; returned: number; rate: number | null }
export interface DayPoint { day: string; dau: number; wau: number; asks: number; newUsers: number; starters: number; activated: number; matured: number; remSent: number; remClicked: number; web: number; telegram: number; miniapp: number }
export interface CohortRow { week: string; size: number | null; cells: { day: number; matured: number; rate: number | null }[] }
export interface ChannelRow { channel: string; active: number; share: number | null; activation: number | null; starters: number; d7: number | null; d7n: number; asksPerActiveWeek: number | null }
export interface Dashboard {
  generatedAt: string; days: number; channel: ChannelFilter; demo: boolean; minCohort: number; minSample: number;
  /** Включены ли команда и тестовые аккаунты (по умолчанию нет). */
  includeInternal?: boolean;
  totals: { events: number; subjects: number };
  cur: Period; prev: Period;
  series: DayPoint[]; prevSeries: DayPoint[];
  cohorts: CohortRow[];
  verdictWeeks: { week: string; counts: Record<string, number>; total: number }[];
  channels: ChannelRow[];
}

const DAYIDX = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
const IDXDAY = (i: number) => new Date(i * DAY).toISOString().slice(0, 10);
const weekStart = (i: number) => i - ((new Date(i * DAY).getUTCDay() + 6) % 7);

/**
 * Индекс активности: одна выборка (пользователь, UTC-день, канал) по user_active, дальше — расчёты в памяти.
 * Для MVP-объёмов (десятки тысяч строк) это быстрее десятков коррелированных запросов; при росте — материализованная таблица дней.
 */
class Activity {
  days = new Map<string, Set<number>>(); // любой канал
  byDay = new Map<string, Map<number, Set<string>>>(); // канал|all → день → пользователи
  first = new Map<string, { d0: number; ch0: string; t0: number }>();
  firstIn = new Map<string, Map<string, number>>(); // канал → пользователь → первый день в канале
  constructor(rows: { subject: string; d: string; channel: string; t: Date | string }[]) {
    for (const r of rows) {
      const i = DAYIDX(r.d);
      (this.days.get(r.subject) ?? this.days.set(r.subject, new Set()).get(r.subject)!).add(i);
      for (const k of ["all", r.channel]) {
        const m = this.byDay.get(k) ?? this.byDay.set(k, new Map()).get(k)!;
        (m.get(i) ?? m.set(i, new Set()).get(i)!).add(r.subject);
        const f = this.firstIn.get(k) ?? this.firstIn.set(k, new Map()).get(k)!;
        if (!f.has(r.subject) || f.get(r.subject)! > i) f.set(r.subject, i);
      }
      // первый канал — по времени первого события, а не по алфавиту
      const t = new Date(r.t).getTime(), f = this.first.get(r.subject);
      if (!f || t < f.t0) this.first.set(r.subject, { d0: i, ch0: r.channel, t0: t });
    }
  }
  on(ch: ChannelFilter, i: number) { return this.byDay.get(ch ?? "all")?.get(i) ?? new Set<string>(); }
  union(ch: ChannelFilter, a: number, b: number) { const s = new Set<string>(); for (let i = a; i < b; i++) for (const x of this.on(ch, i)) s.add(x); return s; }
  userWeeks(ch: ChannelFilter, a: number, b: number) { const s = new Set<string>(); for (let i = a; i < b; i++) for (const x of this.on(ch, i)) s.add(`${x}:${weekStart(i)}`); return s.size; }
  newUsers(ch: ChannelFilter, a: number, b: number) { let n = 0; for (const i of this.firstIn.get(ch ?? "all")?.values() ?? []) if (i >= a && i < b) n++; return n; }
  /** Вернулся в окно [d0+lo, d0+hi]; учитываются те, у кого окно закрылось в [a, b). */
  retention(ch: ChannelFilter, lo: number, hi: number, a: number, b: number): Ret {
    let n = 0, r = 0;
    for (const [s, f] of this.first) {
      if (ch && f.ch0 !== ch) continue;
      if (f.d0 + hi < a || f.d0 + hi >= b) continue;
      n++;
      const ds = this.days.get(s)!;
      for (let i = f.d0 + lo; i <= f.d0 + hi; i++) if (ds.has(i)) { r++; break; }
    }
    return { n, returned: r, rate: n >= MIN_COHORT ? rate(r, n) : null };
  }
}

/**
 * Команда и тестовые аккаунты (users.is_internal → analytics_events.internal) по умолчанию исключены:
 * все запросы дашборда читают вид analytics_events_real вместо таблицы. includeInternal — показать всех.
 */
export function scopedDb(db: Queryable, includeInternal = false): Queryable {
  if (includeInternal) return db;
  return { query: <T,>(sql: string, params?: unknown[]) => db.query<T>(sql.replace(/\banalytics_events\b/g, "analytics_events_real"), params) };
}

interface Starter { subject: string; t0: number; tv: number | null; channel: string }

/** Дашборд за последние `days` полных UTC-дней и такой же предыдущий период. */
export async function dashboard(now = new Date(), days = 30, channel: ChannelFilter = null, q?: Queryable, opts: { includeInternal?: boolean } = {}): Promise<Dashboard> {
  const db = scopedDb(q ?? (await getDb()), opts.includeInternal);
  const to = startOfUtcDay(now);
  const from = addDays(to, -days);
  const pfrom = addDays(from, -days);
  const tot = (await db.query<{ events: string; subjects: string; demo: boolean }>(
    "SELECT count(*) events, count(DISTINCT subject) subjects, COALESCE(bool_or(demo), false) demo FROM analytics_events WHERE " + W, [from, to, channel])).rows[0];
  const act = new Activity((await db.query<{ subject: string; d: string; channel: string; t: Date }>(
    "SELECT subject, ((occurred_at AT TIME ZONE 'UTC')::date)::text d, channel, min(occurred_at) t FROM analytics_events WHERE name='user_active' AND occurred_at < $1::timestamptz GROUP BY 1, 2, 3", [to])).rows);
  // Первое начало знакомства пользователя и первая польза после него (прогноз или ответ «Можно?»).
  const starters: Starter[] = (await db.query<{ subject: string; t0: Date; tv: Date | null; channel: string }>(
    `WITH s AS (SELECT DISTINCT ON (subject) subject, occurred_at t0, channel FROM analytics_events
                 WHERE name='onboarding_started' AND props->>'mode'='initial' ORDER BY subject, occurred_at)
     SELECT s.subject, s.t0, s.channel, (SELECT min(e.occurred_at) FROM analytics_events e WHERE e.subject = s.subject AND e.occurred_at >= s.t0
               AND e.name IN ('onboarding_preview_shown','purchase_result')) tv
       FROM s WHERE s.t0 >= $1::timestamptz AND s.t0 < $2::timestamptz`, [addDays(pfrom, -7), to])).rows
    .map((r) => ({ subject: r.subject, t0: new Date(r.t0).getTime(), tv: r.tv == null ? null : new Date(r.tv).getTime(), channel: r.channel }));
  const sends = channel === null || channel === "telegram" ? await loadSends(db, addDays(pfrom, -7), to) : [];
  const ctx = { db, act, starters, sends, now };
  const cur = await period(ctx, from, to, channel), prev = await period(ctx, pfrom, from, channel);
  const all = await daily(ctx, addDays(pfrom, -6), to, channel);
  const series = all.filter((p) => p.day >= isoDay(from));
  const prevSeries = all.filter((p) => p.day >= isoDay(pfrom) && p.day < isoDay(from));
  const weeks = Math.min(13, Math.max(8, Math.ceil(days / 7)));
  // начало — с понедельника, чтобы первая когорта не была обрезанной неделей
  const c0 = DAYIDX(isoDay(addDays(to, -weeks * 7)));
  const cohorts = cohortsFrom(act, weekStart(c0) === c0 ? c0 : weekStart(c0) + 7, DAYIDX(isoDay(to)), channel, DAYIDX(isoDay(now)));
  const verdictWeeks = await verdictByWeek(db, from, to, channel);
  // Каналы: активные, активация, D7, вопросы на активного-неделю.
  const a = DAYIDX(isoDay(from)), b = DAYIDX(isoDay(to));
  const asksBy = await db.query<{ channel: string; n: string }>(`SELECT channel, count(*) n FROM analytics_events WHERE name='purchase_asked' AND ${W} GROUP BY 1`, [from, to, null]);
  const channels: ChannelRow[] = CHANNELS.filter((c) => !channel || channel === c).map((c) => {
    const act7 = activation(starters, from, to, c, now);
    const d7 = act.retention(c, 7, 13, a, b);
    return { channel: c, active: act.union(c, a, b).size, share: rate(act.union(c, a, b).size, cur.active), activation: act7.rate, starters: act7.matured, d7: d7.rate, d7n: d7.n,
      asksPerActiveWeek: rate(num(asksBy.rows.find((r) => r.channel === c)?.n), act.userWeeks(c, a, b)) };
  });
  return {
    generatedAt: now.toISOString(), days, channel, demo: !!tot?.demo, minCohort: MIN_COHORT, minSample: MIN_SAMPLE, includeInternal: !!opts.includeInternal,
    totals: { events: num(tot?.events), subjects: num(tot?.subjects) }, cur, prev, series, prevSeries, cohorts, verdictWeeks, channels,
  };
}

function activation(starters: Starter[], from: Date, to: Date, ch: ChannelFilter, now: Date) {
  const mature = now.getTime() - DAY;
  const xs = starters.filter((s) => s.t0 >= from.getTime() && s.t0 < to.getTime() && (!ch || s.channel === ch));
  const m = xs.filter((s) => s.t0 < mature);
  const activated = m.filter((s) => s.tv != null && s.tv - s.t0 <= DAY).length;
  const mins = xs.filter((s) => s.tv != null).map((s) => (s.tv! - s.t0) / 60_000).sort((x, y) => x - y);
  // гистограмма — только по «созревшим» (окно 24 ч закрыто), чтобы доли складывались в 100 %
  const mm = m.filter((s) => s.tv != null).map((s) => (s.tv! - s.t0) / 60_000);
  const edges = [1, 3, 10, 60, 1440, Infinity];
  const buckets = edges.map((e, i) => mm.filter((v) => v >= (i ? edges[i - 1] : -Infinity) && v < e).length);
  const p50 = mins.length ? (mins.length % 2 ? mins[(mins.length - 1) / 2] : (mins[mins.length / 2 - 1] + mins[mins.length / 2]) / 2) : null;
  return { starters: xs.length, matured: m.length, activated, rate: rate(activated, m.length), reached: mins.length, p50Min: p50, buckets, never: m.filter((s) => s.tv == null || s.tv - s.t0 > DAY).length }; // never — не получили пользу за 24 ч
}

interface Send { subject: string; kind: string; t: number; hit: boolean }
type Ctx = { db: Queryable; act: Activity; starters: Starter[]; sends: Send[]; now: Date };

/**
 * Отправки напоминаний и атрибуция кликов: клик (только целевое действие) засчитывается ПОСЛЕДНЕЙ отправке
 * того же вида до него, если прошло меньше 24 ч, — один клик не закрывает несколько отправок.
 */
async function loadSends(db: Queryable, from: Date, to: Date): Promise<Send[]> {
  const rows = (await db.query<{ subject: string; kind: string; t: Date; click: boolean }>(
    `SELECT subject, props->>'kind' kind, occurred_at t, name = 'reminder_clicked' click FROM analytics_events
      WHERE (name = 'reminder_sent' AND occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz)
         OR (name = 'reminder_clicked' AND props->>'action' IN (${TARGET_ACTIONS.map((x) => `'${x}'`).join(",")}) AND occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz + interval '1 day')
      ORDER BY occurred_at, click`, [from, to])).rows;
  const sends: Send[] = [];
  const last = new Map<string, Send>();
  for (const r of rows) {
    const key = `${r.subject}|${r.kind}`, t = new Date(r.t).getTime();
    if (!r.click) { const x = { subject: r.subject, kind: r.kind, t, hit: false }; sends.push(x); last.set(key, x); }
    else { const x = last.get(key); if (x && t - x.t < DAY) x.hit = true; }
  }
  return sends;
}

/** Целевые действия по кнопкам напоминания; «позже», «реже», «выключить» — не успех. */
export const TARGET_ACTIONS = ["paid", "inc", "log", "ob"] as const;


/** Этапы воронки по порядку: начало → шаги → первый прогноз → … → «Готово». */
export const FUNNEL_ORDER = ["started", "balance", "income", "preview", ...FUNNEL_STEPS.slice(2), "completed"] as const;
export type Outcome = "answered" | "unknown" | "skipped";
export interface AttemptEvent { name: string; step: string | null; input: string | null; t: number }
/** Проход знакомства: k — сколько этапов FUNNEL_ORDER пройдено подряд; события — только онбординговые, без значений. */
export interface FunnelAttempt { attempt: string; subject: string; channel: string; k: number; x: { reached: Set<string>; outcome: Map<string, Outcome>; input: Map<string, string> }; events: AttemptEvent[] }

/** Горизонт наблюдения прохода: события позже started + 7 дней не учитываются — у прошлого периода нет форы во времени. */
export const ATTEMPT_HORIZON_DAYS = 7;
/** Первичные проходы, начатые в [from, to) (канал — по событию начала), с последовательной глубиной. */
export async function loadFunnelAttempts(db: Queryable, from: Date, to: Date, ch: ChannelFilter): Promise<FunnelAttempt[]> {
  const f = await db.query<{ attempt: string; subject: string; channel: string; name: string; step: string | null; input: string | null; t: Date | string }>(
    `WITH att AS (SELECT attempt, min(channel) channel, min(occurred_at) t0 FROM analytics_events WHERE name='onboarding_started' AND props->>'mode'='initial' AND attempt IS NOT NULL AND ${W} GROUP BY 1)
     SELECT e.attempt, e.subject, att.channel, e.name, e.props->>'step' step, e.props->>'input' input, e.occurred_at t
       FROM analytics_events e JOIN att ON att.attempt = e.attempt
      WHERE e.name LIKE 'onboarding\\_%' AND e.occurred_at < att.t0 + interval '${ATTEMPT_HORIZON_DAYS} days'
      ORDER BY e.attempt, e.occurred_at, e.id`, [from, to, ch]);
  const RANK = { answered: 3, unknown: 2, skipped: 1 } as const; // один итог на шаг: ответ важнее «не знаю», «не знаю» — пропуска
  const by = new Map<string, FunnelAttempt>();
  for (const r of f.rows) {
    let a = by.get(r.attempt);
    if (!a) by.set(r.attempt, (a = { attempt: r.attempt, subject: r.subject, channel: r.channel, k: 0, x: { reached: new Set(), outcome: new Map(), input: new Map() }, events: [] }));
    a.events.push({ name: r.name, step: r.step, input: r.input, t: new Date(r.t).getTime() });
    const x = a.x;
    if (r.name === "onboarding_started") x.reached.add("started");
    else if (r.name === "onboarding_preview_shown") x.reached.add("preview");
    else if (r.name === "onboarding_completed") x.reached.add("completed");
    else if (r.step && (r.name === "onboarding_step_answered" || r.name === "onboarding_step_unknown" || r.name === "onboarding_step_skipped")) {
      x.reached.add(r.step);
      const o: Outcome = r.name === "onboarding_step_answered" ? "answered" : r.name === "onboarding_step_unknown" ? "unknown" : "skipped";
      const was = x.outcome.get(r.step);
      if (!was || RANK[o] > RANK[was]) { x.outcome.set(r.step, o); if (r.input) x.input.set(r.step, r.input); }
    }
  }
  for (const a of by.values()) { let k = 0; while (k < FUNNEL_ORDER.length && a.x.reached.has(FUNNEL_ORDER[k])) k++; a.k = k; }
  return [...by.values()];
}

async function period({ db, act, starters, sends, now }: Ctx, from: Date, to: Date, ch: ChannelFilter): Promise<Period> {
  const P = [from, to, ch];
  const a = DAYIDX(isoDay(from)), b = DAYIDX(isoDay(to));
  const mature = new Date(Math.min(now.getTime(), to.getTime() + DAY) - DAY);
  const names = await db.query<{ name: string; n: string; u: string }>(`SELECT name, count(*) n, count(DISTINCT subject) u FROM analytics_events WHERE ${W} GROUP BY name`, P);
  const N = (name: string) => num(names.rows.find((r) => r.name === name)?.n);
  const U = (name: string) => num(names.rows.find((r) => r.name === name)?.u);
  const activeSet = act.union(ch, a, b);
  const auw = act.userWeeks(ch, a, b);

  // Воронка по проходам: этап засчитан, только если ЭТОТ ЖЕ проход прошёл все предыдущие этапы (общая логика с drill-down).
  const depth = await loadFunnelAttempts(db, from, to, ch);
  const attempts = depth.filter((d) => d.k > 0).length;
  const stages: FunnelStage[] = [];
  let prevN = attempts;
  FUNNEL_ORDER.forEach((key, idx) => {
    const at = depth.filter((d) => d.k > idx);
    const n = at.length;
    const isStep = (FUNNEL_STEPS as readonly string[]).includes(key);
    stages.push({ key, n, drop: prevN - n, dropRate: key === "started" ? null : rate(prevN - n, prevN), ofStart: rate(n, attempts),
      unknownShare: isStep ? rate(at.filter((d) => d.x.outcome.get(key) === "unknown").length, n) : null,
      skippedShare: isStep ? rate(at.filter((d) => d.x.outcome.get(key) === "skipped").length, n) : null });
    prevN = n;
  });
  const completed = stages[stages.length - 1].n;

  // Частота «Можно?» среди активных.
  const per = await db.query<{ subject: string; c: string }>(`SELECT subject, count(*) c FROM analytics_events WHERE name='purchase_asked' AND ${W} GROUP BY 1`, P);
  const cnt = new Map(per.rows.map((r) => [r.subject, num(r.c)]));
  const freq = [0, 0, 0, 0, 0];
  for (const s of activeSet) { const k = cnt.get(s) ?? 0; freq[k === 0 ? 0 : k === 1 ? 1 : k <= 3 ? 2 : k <= 9 ? 3 : 4]++; }
  const activeAskers = freq.slice(1).reduce((s, x) => s + x, 0);

  const vr = await db.query<{ v: string; n: string }>(`SELECT props->>'verdict' v, count(*) n FROM analytics_events WHERE name='purchase_result' AND ${W} GROUP BY 1`, P);
  const verdicts = Object.fromEntries(VERDICTS.map((v) => [v, num(vr.rows.find((r) => r.v === v)?.n)]));

  // Напоминания (только Telegram).
  const tgOnly = ch === null || ch === "telegram";
  const ps = sends.filter((x) => x.t >= from.getTime() && x.t < to.getTime() && x.t < mature.getTime());
  const rm = { rows: REMINDER_KINDS.map((kind) => { const k = ps.filter((x) => x.kind === kind); return { kind, sent: String(k.length), recipients: String(new Set(k.map((x) => x.subject)).size), clicked: String(k.filter((x) => x.hit).length) }; }) };
  const rd = tgOnly ? await db.query<{ scope: string; kind: string | null; reason: string; n: string }>(
    "SELECT props->>'scope' scope, props->>'kind' kind, props->>'reason' reason, count(DISTINCT subject) n FROM analytics_events WHERE name='reminder_disabled' AND occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz GROUP BY 1, 2, 3", [from, to]) : { rows: [] };
  // Выключившие вид — уникальные получатели этого вида в периоде (доля не превышает 100 %).
  const rdk = tgOnly ? await db.query<{ kind: string; n: string }>(
    `SELECT d.props->>'kind' kind, count(DISTINCT d.subject) n FROM analytics_events d
      WHERE d.name='reminder_disabled' AND d.props->>'scope'='kind' AND d.occurred_at >= $1::timestamptz AND d.occurred_at < $2::timestamptz
        AND EXISTS (SELECT 1 FROM analytics_events s WHERE s.name='reminder_sent' AND s.subject=d.subject AND s.props->>'kind'=d.props->>'kind' AND s.occurred_at >= $1::timestamptz AND s.occurred_at < $2::timestamptz)
      GROUP BY 1`, [from, to]) : { rows: [] };
  const kinds = REMINDER_KINDS.map((kind) => {
    const r = rm.rows.find((x) => x.kind === kind);
    const sent = num(r?.sent), clicked = num(r?.clicked), recipients = num(r?.recipients);
    const disabled = num(rdk.rows.find((x) => x.kind === kind)?.n);
    return { kind, sent, recipients, clicked, ctr: rate(clicked, sent), disabled, disableRate: rate(disabled, recipients) };
  });
  const remSent = kinds.reduce((s, k) => s + k.sent, 0), remClicked = kinds.reduce((s, k) => s + k.clicked, 0);

  // Связь напоминаний с возвратом: доля активных дней у получателей в дни с напоминанием и без.
  // Не доказанный эффект: напоминания приходят в «особые» дни (платёж, доход) — смещение отбора.
  let effect: Period["reminders"]["effect"] = null;
  let recipients = 0;
  if (tgOnly) {
    // День с напоминанием засчитан «с визитом», только если после отправки в течение 24 ч была новая сессия
    // (визит до отправки не считается). Остальные дни — любая активность за UTC-день.
    const rs = await db.query<{ subject: string; d: string; hit: boolean }>(
      `WITH r AS (SELECT subject, ((occurred_at AT TIME ZONE 'UTC')::date)::text d, min(occurred_at) t FROM analytics_events
                   WHERE name='reminder_sent' AND occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz GROUP BY 1, 2)
       SELECT r.subject, r.d, EXISTS (SELECT 1 FROM analytics_events a WHERE a.name='session_started' AND a.subject=r.subject
                AND a.occurred_at >= r.t AND a.occurred_at < r.t + interval '24 hours') hit FROM r`, [from, to]);
    const sent = new Map<string, Map<number, boolean>>();
    for (const r of rs.rows) (sent.get(r.subject) ?? sent.set(r.subject, new Map()).get(r.subject)!).set(DAYIDX(r.d), r.hit);
    recipients = sent.size;
    let rD = 0, rA = 0, oD = 0, oA = 0;
    for (const [s, ds] of sent) {
      const f = act.first.get(s); const on = act.days.get(s);
      if (!f || !on) continue;
      for (let i = Math.max(f.d0 + 1, a); i < b; i++) { if (ds.has(i)) { rD++; if (ds.get(i)) rA++; } else { oD++; if (on.has(i)) oA++; } }
    }
    const x = rate(rA, rD), y = rate(oA, oD);
    effect = { remindedDays: rD, remindedActive: rA, otherDays: oD, otherActive: oA, lift: x != null && y != null ? x - y : null };
  }

  return {
    from: from.toISOString(), to: to.toISOString(),
    active: activeSet.size, newUsers: act.newUsers(ch, a, b), wauEnd: act.union(ch, b - 7, b).size, activeUserWeeks: auw,
    activation: activation(starters, from, to, ch, now),
    funnel: { attempts, stages, completed, completion: rate(completed, attempts) },
    asks: { total: N("purchase_asked"), askers: U("purchase_asked"), perActiveWeek: rate(N("purchase_asked"), auw), freq, repeatShare: rate(freq.slice(2).reduce((s, x) => s + x, 0), activeAskers) },
    verdicts,
    reminders: { kinds, sent: remSent, clicked: remClicked, ctr: rate(remClicked, remSent), recipients,
      disabledAll: rd.rows.filter((x) => x.scope === "all" && x.reason === "user").reduce((s, x) => s + num(x.n), 0),
      blocked: rd.rows.filter((x) => x.reason === "bot_blocked").reduce((s, x) => s + num(x.n), 0), effect },
    retention: { d1: act.retention(ch, 1, 1, a, b), d7: act.retention(ch, 7, 13, a, b) },
    value: { proposalsCreated: N("proposal_created"), proposalsConfirmed: N("proposal_confirmed"), completion: rate(N("proposal_confirmed"), N("proposal_created")),
      corrections: N("onboarding_corrected"), notUnderstood: N("onboarding_not_understood") },
  };
}

/** Дневные ряды за [from, to). */
async function daily({ db, act, starters, sends, now }: Ctx, from: Date, to: Date, ch: ChannelFilter): Promise<DayPoint[]> {
  const dayExpr = "((occurred_at AT TIME ZONE 'UTC')::date)::text";
  const asks = await db.query<{ d: string; n: string }>(`SELECT ${dayExpr} d, count(*) n FROM analytics_events WHERE name='purchase_asked' AND ${W} GROUP BY 1`, [from, to, ch]);
  const ripe = sends.filter((x) => x.t < now.getTime() - DAY);
  const remByDay = new Map<string, { n: number; c: number }>();
  for (const x of ripe) { const k = isoDay(new Date(x.t)); const v = remByDay.get(k) ?? remByDay.set(k, { n: 0, c: 0 }).get(k)!; v.n++; if (x.hit) v.c++; }
  const g = (rows: Record<string, string>[], day: string, k = "n") => num(rows.find((r) => r.d === day)?.[k]);
  const mature = now.getTime() - DAY;
  const out: DayPoint[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += DAY) {
    const day = isoDay(new Date(t)), i = DAYIDX(day);
    const st = starters.filter((s) => s.t0 >= t && s.t0 < t + DAY && (!ch || s.channel === ch));
    const m = st.filter((s) => s.t0 < mature);
    out.push({ day, dau: act.on(ch, i).size, wau: act.union(ch, i - 6, i + 1).size, asks: g(asks.rows, day), newUsers: act.newUsers(ch, i, i + 1),
      starters: st.length, matured: m.length, activated: m.filter((s) => s.tv != null && s.tv - s.t0 <= DAY).length,
      remSent: remByDay.get(day)?.n ?? 0, remClicked: remByDay.get(day)?.c ?? 0, web: act.on("web", i).size, telegram: act.on("telegram", i).size, miniapp: act.on("miniapp", i).size });
  }
  return out;
}

/** Тепловая карта удержания: недельные когорты первого активного дня; D1 = день 1, D7/D14/D30 = окно [N, N+6]. */
function cohortsFrom(act: Activity, a: number, b: number, ch: ChannelFilter, today: number): CohortRow[] {
  const groups = new Map<number, { s: string; d0: number }[]>();
  for (const [s, f] of act.first) {
    if (f.d0 < a || f.d0 >= b || (ch && f.ch0 !== ch)) continue;
    const w = weekStart(f.d0);
    (groups.get(w) ?? groups.set(w, []).get(w)!).push({ s, d0: f.d0 });
  }
  return [...groups.keys()].sort((x, y) => x - y).map((w) => {
    const us = groups.get(w)!;
    return {
      week: IDXDAY(w), size: us.length >= MIN_COHORT ? us.length : null,
      cells: RET_DAYS.map((day) => {
        const [lo, hi] = day === 1 ? [1, 1] : [day, day + 6];
        const m = us.filter((u) => u.d0 + hi < today);
        const r = m.filter((u) => { const ds = act.days.get(u.s)!; for (let i = u.d0 + lo; i <= u.d0 + hi; i++) if (ds.has(i)) return true; return false; }).length;
        return { day, matured: m.length, rate: m.length >= MIN_COHORT ? rate(r, m.length) : null };
      }),
    };
  });
}

async function verdictByWeek(db: Queryable, from: Date, to: Date, ch: ChannelFilter) {
  const r = await db.query<{ wk: string; v: string; n: string }>(
    `SELECT (date_trunc('week', occurred_at AT TIME ZONE 'UTC'))::date::text wk, props->>'verdict' v, count(*) n FROM analytics_events WHERE name='purchase_result' AND ${W} GROUP BY 1, 2 ORDER BY 1`, [from, to, ch]);
  const weeks = [...new Set(r.rows.map((x) => x.wk))];
  return weeks.map((week) => {
    const counts = Object.fromEntries(VERDICTS.map((v) => [v, num(r.rows.find((x) => x.wk === week && x.v === v)?.n)]));
    return { week, counts, total: Object.values(counts).reduce((s, x) => s + x, 0) };
  });
}
