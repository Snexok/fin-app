// Служебные журналы: обращения к ключевым компонентам (service_calls) и ошибки сервиса (service_errors).
// Правила:
//  • помощники НИКОГДА не бросают исключений и не ломают пользовательский сценарий (fire-and-forget safe);
//  • пользователь — только псевдоним (тот же HMAC, что в analytics_events); при отказе от статистики — NULL;
//  • код — стабильная строка ([A-Z0-9_:], до 64), тип обращения — из allowlist CALL_TYPES;
//  • сообщение — короткое и безопасное: для своих ApiError — наш шаблонный текст, для прочих — только имя/код
//    (тексты исключений PG и SDK могут содержать ввод пользователя), дополнительно вырезаются числа, e-mail и токены.
import { AsyncLocalStorage } from "node:async_hooks";
import { after } from "next/server";
import { getDb } from "./db";
import { analyticsEnabled, analyticsSecret, pseudonym } from "./analytics";
import { ApiError } from "./util";

export const LOG_CHANNELS = ["web", "telegram", "miniapp", "cron", "system"] as const;
export type LogChannel = (typeof LOG_CHANNELS)[number];

/** Типы обращений. Новые — только добавлением сюда (и в docs/METRICS-AND-LOGS.md). */
export const CALL_TYPES = [
  // ядро продукта
  "chat.question", // вопрос «Можно?» (расчёт движка из чата/бота)
  "chat.message", // прочее сообщение в чате (запись траты/дохода, уточнение, справка)
  "sim.purchase", // прямой расчёт покупки через API
  "onboarding.turn", // ход знакомства (текст или выбор варианта)
  "onboarding.open", // открытие/восстановление знакомства
  "plan.save", "plan.view", "entry.create",
  "proposal.read", "proposal.confirm", "proposal.reject",
  "stt", "llm.intent",
  // LLM-слой (lib/llm): одна строка на логическую операцию; попытки, токены и стоимость — в ai_usage
  "llm.explain", "llm.compare", "llm.goal", "llm.review", "llm.stt", "llm.onboarding",
  // аккаунт и служебное
  "session.create", "session.telegram", "session.logout", "me", "account.link",
  "reminders.settings", "reminder.click", "analytics.batch", "analytics.consent",
  "referral.me", "referral.share",
  // тарифы и AI-ответы (lib/plans): экран «Плюс», заявка без оплаты, объяснение «почему» (тратит AI-ответ, если ответила модель)
  "plan.status", "plus.interest", "chat.explain",
  // бот: тип уточняется обработчиком (chat.*, onboarding.turn, proposal.*), иначе остаётся общим
  "bot.start", "bot.command", "bot.message", "bot.voice", "bot.callback",
  // фоновые задачи
  "reminder.send", "cron.reminders", "cron.cleanup",
  "other",
] as const;
export type CallType = (typeof CALL_TYPES)[number];

export const isCallType = (v: unknown): v is CallType => typeof v === "string" && (CALL_TYPES as readonly string[]).includes(v);
const CODE_RE = /^[A-Z0-9_:]{1,64}$/;
/** Стабильный код: как есть, если уже в формате; иначе нормализуем (TypeError → TYPE_ERROR), иначе UNKNOWN. */
export function normalizeCode(v: unknown): string {
  if (typeof v === "number" && Number.isInteger(v)) return `E${v}`;
  if (typeof v !== "string" || !v) return "UNKNOWN";
  if (CODE_RE.test(v)) return v;
  const s = v.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9_:]+/g, "_").toUpperCase().replace(/^_+|_+$/g, "").slice(0, 64);
  return s && CODE_RE.test(s) ? s : "UNKNOWN";
}

/** Вырезает из текста то, что может оказаться персональными данными или секретом. */
export function redact(s: string): string {
  return s
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "<token>") // токен бота
    .replace(/(bearer|token|secret|key|password)[=: ]+\S+/gi, "$1=<redacted>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\d[\d\s.,]{3,}\d|\d{4,}/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Короткое безопасное описание ошибки для журнала. */
export function safeMessage(e: unknown): string | null {
  if (e == null) return null;
  if (e instanceof ApiError) return redact(e.message);
  if (typeof e === "string") return redact(e);
  const name = (e as Error)?.name;
  const code = (e as { code?: unknown })?.code ?? (e as { error_code?: unknown })?.error_code;
  // Имя класса исключения и код (PG SQLSTATE, Telegram error_code) — без текста сообщения.
  const parts = [typeof name === "string" ? redact(name).slice(0, 60) : null, code != null ? `code ${normalizeCode(String(code))}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
export function errorCodeOf(e: unknown): string {
  const c = (e as { code?: unknown })?.code ?? (e as { error_code?: unknown })?.error_code;
  if (c != null) return normalizeCode(c);
  return normalizeCode((e as Error)?.name ?? "ERROR");
}

// ---------- Пользователь → псевдоним (кэш, чтобы обращение стоило одну вставку) ----------

interface Meta { subject: string | null; internal: boolean; at: number }
const META_TTL_MS = 60_000;
const META_MAX = 5000;
const metaCache = new Map<string, Meta>();
export function forgetLogMeta(userId?: string) { if (userId) metaCache.delete(userId); else metaCache.clear(); }
// analytics.ts не импортирует этот модуль (иначе цикл): сброс кэша при отказе — через globalThis.
(globalThis as { __mozhnoForgetLogMeta?: (id: string) => void }).__mozhnoForgetLogMeta = (id) => forgetLogMeta(id);

async function metaOf(userId: string | null | undefined): Promise<Meta> {
  if (!userId) return { subject: null, internal: false, at: 0 };
  const now = Date.now();
  const c = metaCache.get(userId);
  if (c && now - c.at < META_TTL_MS) return c;
  const db = await getDb();
  const r = await db.query<{ analytics_enabled: boolean; analytics_epoch: number; is_internal: boolean }>(
    "SELECT analytics_enabled, analytics_epoch, is_internal FROM users WHERE id=$1", [userId]);
  const row = r.rows[0];
  const secret = analyticsSecret();
  const m: Meta = {
    subject: row && row.analytics_enabled && analyticsEnabled() && secret ? pseudonym(userId, Number(row.analytics_epoch), secret) : null,
    internal: !!row?.is_internal, at: now,
  };
  if (metaCache.size >= META_MAX) metaCache.delete(metaCache.keys().next().value!);
  metaCache.set(userId, m);
  return m;
}

/** Псевдоним и флаг команды для журналов LLM (ai_usage). Никогда не бросает: при ошибке — NULL. */
export async function logMetaOf(userId: string | null | undefined): Promise<{ subject: string | null; internal: boolean }> {
  try { const m = await metaOf(userId); return { subject: m.subject, internal: m.internal }; }
  catch { return { subject: null, internal: false }; }
}

export const logsEnabled = () => process.env.SERVICE_LOGS_ENABLED !== "0";
const warn = (what: string, e: unknown) => { if (process.env.NODE_ENV !== "production") console.warn(`[service-log] ${what} failed`, (e as Error)?.message); };

// ---------- Контекст обращения (AsyncLocalStorage) ----------

export interface CallCtx {
  type: CallType;
  channel: LogChannel;
  route: string;
  userId: string | null;
  start: number;
}
const als = new AsyncLocalStorage<CallCtx>();
export const currentCall = () => als.getStore() ?? null;
/** Уточнить пользователя текущего обращения (вызывается из requireUserId и бота). */
export function setCallUser(userId: string | null | undefined) { const c = als.getStore(); if (c && userId) c.userId = userId; }
/** Уточнить тип текущего обращения (например, сообщение бота оказалось вопросом «Можно?»). */
export function setCallType(type: CallType) { const c = als.getStore(); if (c) c.type = type; }

// Ошибки, уже записанные в service_errors: повторный перехват выше по стеку не создаёт дубль.
const logged = new WeakSet<object>();
const markLogged = (e: unknown) => { if (e && typeof e === "object") logged.add(e); };
export const wasLogged = (e: unknown) => !!e && typeof e === "object" && logged.has(e);

export interface CallRecord {
  type: CallType;
  channel: LogChannel;
  userId?: string | null;
  result: "ok" | "error";
  code?: string | null;
  httpStatus?: number | null;
  latencyMs?: number | null;
}

/** Записать обращение. Одна вставка; никогда не бросает. */
export async function recordCall(c: CallRecord): Promise<boolean> {
  try {
    if (!logsEnabled()) return false;
    if (!isCallType(c.type) || !(LOG_CHANNELS as readonly string[]).includes(c.channel)) return false;
    const m = await metaOf(c.userId);
    const db = await getDb();
    await db.query(
      `INSERT INTO service_calls(subject, channel, call_type, result, code, http_status, latency_ms, internal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [m.subject, c.channel, c.type, c.result === "error" ? "error" : "ok", c.code == null ? null : normalizeCode(c.code),
        c.httpStatus ?? null, c.latencyMs == null ? null : Math.max(0, Math.round(c.latencyMs)), m.internal]);
    return true;
  } catch (e) { warn("recordCall", e); return false; }
}

export interface ErrorRecord {
  channel?: LogChannel;
  route?: string;
  code?: string | null;
  httpStatus?: number | null;
  userId?: string | null;
  /** Исключение: из него берутся код и безопасное описание. */
  error?: unknown;
  /** Своё короткое сообщение (будет очищено redact). */
  message?: string | null;
}

/** Записать ошибку сервиса. Без контекста берёт канал, маршрут и пользователя из текущего обращения. Никогда не бросает. */
export async function logServiceError(r: ErrorRecord): Promise<boolean> {
  try {
    if (!logsEnabled()) return false;
    if (r.error !== undefined && wasLogged(r.error)) return false;
    markLogged(r.error);
    const ctx = als.getStore();
    const channel = r.channel ?? ctx?.channel ?? "system";
    if (!(LOG_CHANNELS as readonly string[]).includes(channel)) return false;
    const route = (r.route ?? ctx?.type ?? "other").replace(/[^\w./:-]/g, "_").slice(0, 80);
    const code = r.code != null ? normalizeCode(r.code) : r.error !== undefined ? errorCodeOf(r.error) : "UNKNOWN";
    const message = r.message != null ? redact(r.message) : safeMessage(r.error);
    const m = await metaOf(r.userId ?? ctx?.userId);
    const db = await getDb();
    await db.query(
      `INSERT INTO service_errors(subject, channel, route, code, http_status, message, internal) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [m.subject, channel, route, code, r.httpStatus ?? null, message || null, m.internal]);
    return true;
  } catch (e) { warn("logServiceError", e); return false; }
}

/** Ошибки, которые не пишем в service_errors (ожидаемые, массовые): только счётчик в service_calls. */
export const QUIET_CODES = new Set(["UNAUTHORIZED", "ONBOARDING_NOT_ACTIVE", "NOT_MODIFIED"]);

export interface Outcome { status?: number | null; code?: string | null; message?: string | null; error?: unknown }

/**
 * Выполнить обращение в контексте: тип, канал, задержка, итог. Исключение пробрасывается дальше (после записи).
 * outcome(r) — как понять итог по результату (например, HTTP-статус ответа).
 */
export async function withCall<T>(meta: { type: CallType; channel: LogChannel; route?: string; userId?: string | null },
  fn: () => Promise<T>, outcome?: (r: T) => Outcome | null, opts: { defer?: boolean } = {}): Promise<T> {
  const ctx: CallCtx = { type: meta.type, channel: meta.channel, route: meta.route ?? meta.type, userId: meta.userId ?? null, start: Date.now() };
  let res: T;
  try {
    res = await als.run(ctx, fn);
  } catch (e) {
    const ms = Date.now() - ctx.start;
    const code = errorCodeOf(e);
    const write = async () => { await recordCall({ type: ctx.type, channel: ctx.channel, userId: ctx.userId, result: "error", code, latencyMs: ms }); await als.run(ctx, () => logServiceError({ route: ctx.route, error: e })); };
    await schedule(write, opts.defer);
    throw e;
  }
  const ms = Date.now() - ctx.start;
  let o: Outcome | null = null;
  try { o = outcome ? outcome(res) : null; } catch { o = null; }
  const status = o?.status ?? null;
  const isErr = !!o && ((status != null && status >= 400) || (status == null && !!o.code));
  const write = async () => {
    await recordCall({ type: ctx.type, channel: ctx.channel, userId: ctx.userId, result: isErr ? "error" : "ok", code: isErr ? o?.code ?? `HTTP_${status}` : null, httpStatus: status, latencyMs: ms });
    if (isErr && !QUIET_CODES.has(o?.code ?? "")) await logServiceError({ channel: ctx.channel, route: ctx.route, userId: ctx.userId, code: o?.code ?? `HTTP_${status}`, httpStatus: status, message: o?.message ?? null, error: o?.error });
  };
  await schedule(write, opts.defer);
  return res;
}

/** После ответа (next/server after), если есть контекст запроса; иначе — сразу (тесты, бот в фоне, скрипты). */
async function schedule(task: () => Promise<void>, defer = false) {
  const safe = () => task().catch((e) => warn("write", e));
  if (defer) { try { after(safe); return; } catch { /* вне запроса — пишем сразу */ } }
  await safe();
}

// ---------- HTTP-обёртка маршрутов ----------

/** Итог ответа, зарегистрированный errorJson/handleError (без разбора тела). */
const responseInfo = new WeakMap<Response, Outcome>();
export function tagResponse(res: Response, info: Outcome) { responseInfo.set(res, info); return res; }

export const CHANNEL_COOKIE = "mozhno_ch";
/** Канал HTTP-запроса: Mini App помечается cookie при входе через initData; остальное — web. Только метка для журнала. */
export function channelOfRequest(req: Request | undefined): LogChannel {
  const c = req?.headers?.get("cookie") ?? "";
  return /(?:^|;\s*)mozhno_ch=miniapp(?:;|$)/.test(c) ? "miniapp" : "web";
}

/**
 * Обёртка обработчика маршрута Next: журнал обращения (тип, канал, статус, код, задержка) и ошибки 4xx/5xx.
 *   export const POST = apiRoute("chat.message", async (req) => { ... });
 */
export function apiRoute<A extends unknown[]>(type: CallType, handler: (req: Request, ...args: A) => Promise<Response>, opts: { channel?: LogChannel } = {}) {
  return async (req: Request, ...args: A): Promise<Response> => {
    let route = type as string;
    try { route = new URL(req.url).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id").slice(0, 80); } catch { /* тип вместо пути */ }
    return withCall({ type, channel: opts.channel ?? channelOfRequest(req), route }, () => handler(req, ...args),
      (res) => { const i = responseInfo.get(res); return { status: res.status, code: i?.code ?? (res.status >= 400 ? `HTTP_${res.status}` : null), message: i?.message ?? null, error: i?.error }; },
      { defer: true });
  };
}

/** Замер вложенного обращения (например, LLM внутри вопроса): тот же пользователь и канал, своя строка. Никогда не бросает сам. */
export async function timed<T>(type: CallType, fn: () => Promise<T>): Promise<T> {
  const ctx = als.getStore();
  const t0 = Date.now();
  try {
    const r = await fn();
    await recordCall({ type, channel: ctx?.channel ?? "system", userId: ctx?.userId, result: "ok", latencyMs: Date.now() - t0 });
    return r;
  } catch (e) {
    await recordCall({ type, channel: ctx?.channel ?? "system", userId: ctx?.userId, result: "error", code: errorCodeOf(e), latencyMs: Date.now() - t0 });
    throw e;
  }
}
