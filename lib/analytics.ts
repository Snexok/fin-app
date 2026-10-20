// Первичная продуктовая аналитика: события только из allowlist, свойства — только перечисления.
// Приватность по построению: track() физически не принимает текст/суммы — любое значение вне enum отклоняется.
// Ошибки аналитики никогда не ломают пользовательский сценарий: track() не бросает исключений.
import { createHmac, randomUUID } from "node:crypto";
import { getDb, type Queryable } from "./db";
import { PLAN_CODES, PRICE_POINTS } from "./plans/config";

export const ONBOARDING_STEPS = ["balance", "income", "planningDays", "payments", "reserve", "essentialDaily", "goal"] as const;
export const VERDICTS = ["fits_plan", "reduces_daily_margin", "touches_protected_money", "cash_gap", "insufficient_data"] as const;
export const CHANNELS = ["web", "telegram", "miniapp", "system"] as const;
export const SCREENS = ["home", "plan", "payments", "history", "assistant", "add", "reminders", "onboarding"] as const;
/** Дубль lib/reminders REMINDER_KINDS (без импорта — избегаем цикла модулей); равенство проверяет тест. */
export const REMINDER_KINDS = ["payment_due", "payday", "onboarding", "log_nudge", "weekly", "morning"] as const;
export const DURATION_BUCKETS = ["lt1m", "1_3m", "3_10m", "10_60m", "1_24h", "gt24h"] as const;
export type Channel = (typeof CHANNELS)[number];
export type Verdict = (typeof VERDICTS)[number];

const INPUT = ["text", "choice", "voice"] as const;
const KIND = ["income", "expense"] as const;
const BOOL = ["true", "false"] as const;
/** Как поделились приглашением и откуда (экран после ответа «Можно?», меню, карточка результата, бот). */
export const INVITE_METHODS = ["copy", "native", "telegram", "image", "bot"] as const;
export const INVITE_SURFACES = ["answer", "menu", "card", "bot"] as const;

/** Откуда открыли экран «Плюс»: счётчик AI-ответов, меню/профиль, состояние «закончились», под ответом, бот (/plus). */
export const PLUS_SURFACES = ["counter", "menu", "exhausted", "answer", "bot"] as const;
const PRICE_TAGS = PRICE_POINTS.map(String) as `${(typeof PRICE_POINTS)[number]}`[];

/**
 * Схема событий: имя → допустимые свойства → допустимые значения.
 * Свойство вне схемы или значение вне перечисления — событие отклоняется целиком (не «чистится»).
 */
export const EVENTS = {
  session_started: {},
  user_active: {},
  screen_viewed: { screen: SCREENS },
  onboarding_started: { mode: ["initial", "edit", "update"] },
  onboarding_step_shown: { step: ONBOARDING_STEPS },
  onboarding_step_answered: { step: ONBOARDING_STEPS, answer_kind: ["value", "none"], input: INPUT },
  onboarding_step_skipped: { step: ONBOARDING_STEPS, input: INPUT },
  onboarding_step_unknown: { step: ONBOARDING_STEPS, input: INPUT },
  onboarding_corrected: { step: ONBOARDING_STEPS, input: INPUT },
  onboarding_not_understood: { step: [...ONBOARDING_STEPS, "summary"], input: INPUT },
  onboarding_preview_shown: { preliminary: BOOL },
  onboarding_completed: { mode: ["initial", "edit"], duration: DURATION_BUCKETS },
  purchase_asked: {},
  purchase_result: { verdict: VERDICTS, engine: ["llm", "fallback", "api"] },
  proposal_created: { kind: KIND, origin: ["chat", "reminder"] },
  proposal_confirmed: { kind: KIND },
  proposal_rejected: { kind: KIND },
  expense_logged: { origin: ["chat", "manual"] },
  reminder_sent: { kind: REMINDER_KINDS },
  reminder_clicked: { kind: REMINDER_KINDS, action: ["paid", "inc", "later", "log", "ob", "less", "off"] },
  reminder_disabled: { scope: ["all", "kind"], kind: REMINDER_KINDS, reason: ["user", "bot_blocked"] },
  // Реферальная программа (lib/referrals.ts): код и пригласивший в события не попадают.
  invite_shared: { method: INVITE_METHODS, surface: INVITE_SURFACES },
  invite_opened: { result: ["attributed", "held", "invalid", "self", "internal", "existing", "already"] },
  referral_attributed: { via: ["web", "bot", "miniapp"], held: BOOL },
  referral_activated: {},
  referral_reward_pending: {},
  // Тарифы и AI-ответы (lib/plans): экран «Плюс», заявка без оплаты, исчерпание и списание квоты. Цена — из перечисления.
  plus_viewed: { surface: PLUS_SURFACES },
  plus_interest: { price: [...PRICE_TAGS, "none"], repeat: BOOL },
  tokens_exhausted: { plan: PLAN_CODES, scope: ["day", "window"] },
  ai_answer_consumed: { purpose: ["explain", "compare", "goal_chat", "weekly_review"], plan: PLAN_CODES },
} as const satisfies Record<string, Record<string, readonly string[]>>;

export type EventName = keyof typeof EVENTS;
type PropsOf<N extends EventName> = keyof (typeof EVENTS)[N] extends never ? Record<string, never>
  : { [K in keyof (typeof EVENTS)[N]]?: (typeof EVENTS)[N][K] extends readonly (infer V)[] ? V : never };

/** События, которые может прислать клиент (только показы/активность; финансовые успехи — только с сервера). */
export const CLIENT_EVENTS = ["session_started", "screen_viewed", "onboarding_preview_shown", "plus_viewed"] as const satisfies readonly EventName[];

export function validateEvent(name: string, props: unknown): { ok: true; props: Record<string, string> } | { ok: false; error: string } {
  if (!Object.prototype.hasOwnProperty.call(EVENTS, name)) return { ok: false, error: "UNKNOWN_EVENT" };
  const schema = EVENTS[name as EventName] as Record<string, readonly string[]>;
  if (props == null) return { ok: true, props: {} };
  if (typeof props !== "object" || Array.isArray(props)) return { ok: false, error: "BAD_PROPS" };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    if (v === undefined) continue;
    const allowed = Object.prototype.hasOwnProperty.call(schema, k) ? schema[k] : null;
    if (!allowed) return { ok: false, error: `PROP_NOT_ALLOWED:${k}` };
    const s = typeof v === "boolean" ? String(v) : v;
    if (typeof s !== "string" || !allowed.includes(s)) return { ok: false, error: `VALUE_NOT_ALLOWED:${k}` };
    out[k] = s;
  }
  return { ok: true, props: out };
}

// ---------- Псевдонимы ----------

const DEV_SECRET = "mozhno-dev-analytics-secret-not-for-production";
/** Секрет HMAC. В production без ANALYTICS_SECRET аналитика выключена (не пишем с известным ключом). */
export function analyticsSecret(): string | null {
  const s = process.env.ANALYTICS_SECRET;
  if (s && s.length >= 16) return s;
  return process.env.NODE_ENV === "production" ? null : DEV_SECRET;
}
export function analyticsEnabled(): boolean {
  return process.env.ANALYTICS_ENABLED !== "0" && analyticsSecret() != null;
}
const hmac = (secret: string, s: string, len = 32) => createHmac("sha256", secret).update(s).digest("hex").slice(0, len);
export const pseudonym = (userId: string, epoch: number, secret = analyticsSecret() ?? DEV_SECRET) => hmac(secret, `subject:${userId}:${epoch}`);
export const attemptToken = (userId: string, startedAt: string, secret = analyticsSecret() ?? DEV_SECRET) => hmac(secret, `attempt:${userId}:${startedAt}`, 24);

export function durationBucket(ms: number): (typeof DURATION_BUCKETS)[number] {
  const m = ms / 60_000;
  return m < 1 ? "lt1m" : m < 3 ? "1_3m" : m < 10 ? "3_10m" : m < 60 ? "10_60m" : m < 1440 ? "1_24h" : "gt24h";
}
const minute = (d: Date) => new Date(Math.floor(d.getTime() / 60_000) * 60_000);

export interface TrackOpts {
  channel: Channel;
  /** Естественный ключ для дедупликации (id предложения, callback и т.п.). Без него — каждое событие уникально. */
  key?: string | null;
  attempt?: string | null;
  source?: "server" | "client";
  now?: Date;
  q?: Queryable;
}

/** Записать событие. Возвращает true, если строка добавлена (false: выключено, отказ, дубль, ошибка схемы). */
export async function track<N extends EventName>(userId: string, name: N, props: PropsOf<N>, opts: TrackOpts): Promise<boolean> {
  try {
    if (!analyticsEnabled()) return false;
    const v = validateEvent(name, props);
    if (!v.ok) { if (process.env.NODE_ENV !== "production") console.warn(`[analytics] rejected ${name}: ${v.error}`); return false; }
    if (!(CHANNELS as readonly string[]).includes(opts.channel)) return false;
    const db = opts.q ?? (await getDb());
    const u = await db.query<{ analytics_enabled: boolean; analytics_epoch: number; is_internal: boolean }>("SELECT analytics_enabled, analytics_epoch, is_internal FROM users WHERE id=$1", [userId]);
    const row = u.rows[0];
    if (!row || !row.analytics_enabled) return false; // opt-out действует во всех каналах
    const secret = analyticsSecret()!;
    const subject = pseudonym(userId, Number(row.analytics_epoch), secret);
    const dedup = hmac(secret, `dedup:${name}:${subject}:${opts.key ?? randomUUID()}`, 40);
    const r = await db.query(
      `INSERT INTO analytics_events(dedup_key, name, subject, attempt, channel, source, occurred_at, props, internal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
      [dedup, name, subject, opts.attempt ?? null, opts.channel, opts.source ?? "server", minute(opts.now ?? new Date()), JSON.stringify(v.props), !!row.is_internal]);
    return r.rows.length > 0;
  } catch (e) {
    if (process.env.NODE_ENV !== "production") console.warn("[analytics] track failed", (e as Error).message);
    return false;
  }
}

/** Активность: начало сессии (окно 30 минут) и «активен сегодня» (UTC-день) по каналу. */
export async function trackActivity(userId: string, channel: Channel, now = new Date()) {
  const slot = Math.floor(now.getTime() / (30 * 60_000));
  await track(userId, "session_started", {}, { channel, key: `${channel}:${slot}`, now });
  await track(userId, "user_active", {}, { channel, key: `${channel}:${now.toISOString().slice(0, 10)}`, now });
}

// ---------- Отказ от статистики ----------

export async function getAnalyticsConsent(userId: string): Promise<boolean> {
  const db = await getDb();
  const r = await db.query<{ analytics_enabled: boolean }>("SELECT analytics_enabled FROM users WHERE id=$1", [userId]);
  return r.rows[0]?.analytics_enabled ?? true;
}

/**
 * Отказ: удаляем все события текущего псевдонима и увеличиваем эпоху — повторное включение
 * создаёт новый, не связанный с прошлым псевдоним.
 */
export async function setAnalyticsConsent(userId: string, enabled: boolean): Promise<boolean> {
  const db = await getDb();
  const r = await db.query<{ analytics_enabled: boolean; analytics_epoch: number }>("SELECT analytics_enabled, analytics_epoch FROM users WHERE id=$1", [userId]);
  const row = r.rows[0];
  if (!row) return enabled;
  if (!enabled && row.analytics_enabled) {
    const subject = pseudonym(userId, Number(row.analytics_epoch));
    await db.query("DELETE FROM analytics_events WHERE subject=$1", [subject]);
    await unlinkLogs(db, [subject], userId);
    await db.query("UPDATE users SET analytics_enabled=false, analytics_epoch=analytics_epoch+1 WHERE id=$1", [userId]);
  } else if (enabled && !row.analytics_enabled) {
    await db.query("UPDATE users SET analytics_enabled=true WHERE id=$1", [userId]);
  }
  return enabled;
}

/** Удаление аккаунта: события удаляются по всем эпохам (до текущей включительно). */
export async function forgetAnalytics(userId: string, q?: Queryable) {
  const db = q ?? (await getDb());
  const r = await db.query<{ analytics_epoch: number }>("SELECT analytics_epoch FROM users WHERE id=$1", [userId]);
  const epoch = Number(r.rows[0]?.analytics_epoch ?? 0);
  const subjects = Array.from({ length: epoch + 1 }, (_, i) => pseudonym(userId, i));
  await db.query("DELETE FROM analytics_events WHERE subject = ANY($1::text[])", [subjects]);
  await unlinkLogs(db, subjects, userId);
}

/**
 * Служебные журналы (service_calls / service_errors / ai_usage) остаются для подсчёта нагрузки и ошибок, но теряют псевдоним;
 * источник первого касания удаляется. Кэш псевдонимов журнала сбрасывается (lib/service-log.ts, TTL 60 с в других инстансах).
 */
async function unlinkLogs(db: Queryable, subjects: string[], userId: string) {
  await db.query("UPDATE service_calls SET subject=NULL WHERE subject = ANY($1::text[])", [subjects]);
  await db.query("UPDATE service_errors SET subject=NULL WHERE subject = ANY($1::text[])", [subjects]);
  await db.query("UPDATE ai_usage SET subject=NULL WHERE subject = ANY($1::text[])", [subjects]);
  // Дневные счётчики бюджета пользователя по id: при отказе от статистики не нужны (лимит дня начнётся заново).
  await db.query("DELETE FROM budget_buckets WHERE scope_type='user' AND scope_id=$1", [userId]);
  await db.query("DELETE FROM user_sources WHERE user_id=$1", [userId]);
  (globalThis as { __mozhnoForgetLogMeta?: (id: string) => void }).__mozhnoForgetLogMeta?.(userId);
}
