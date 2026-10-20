// Единственная точка вызова LLM (OpenAI-совместимый Chat Completions). Все вызовы модели в продукте идут через llmCall.
// Что делает обёртка:
//  • выключатель LLM_ENABLED=0 и отсутствие ключа → сразу типизированный отказ, без сети;
//  • цепочка моделей primary → fallbacks: переход на следующую при 5xx, 429, сетевой ошибке и таймауте попытки;
//    4xx (кроме 429) и невалидный ответ — без перехода (это ошибка запроса, а не доступности модели);
//  • бюджет: перед каждой попыткой атомарный резерв максимальной стоимости (оценка входа + max_tokens) у всего бюджета,
//    дня проекта (жёсткий потолок) и дня пользователя (мягкий лимит); после — сверка с фактом из usage (или оценкой);
//  • журнал: строка ai_usage на каждую попытку (и на отказ бюджета) + одна строка service_calls на операцию;
//    журналирование никогда не бросает и не ломает ответ;
//  • результат всегда типизирован (ok | отказ с причиной): вызывающий код при отказе идёт по шаблону/regex
//    с теми же числами движка. Сама обёртка не бросает.
// Модель никогда не считает деньги: она только классифицирует, извлекает фрагменты текста или формулирует объяснение готовых чисел.
import { randomUUID } from "node:crypto";
import { getDb } from "../db";
import { currentCall, logMetaOf, logServiceError, recordCall, type CallType, type LogChannel, LOG_CHANNELS } from "../service-log";
import { AI_ANSWER_PURPOSES, budgetDay, DEFAULT_MAX_TOKENS, llmConfig, type LlmConfig, type LlmPurpose } from "./config";
import { reserveBudget, settleBudget, type BudgetScope } from "./budget";
import { estimateTokens, priceOf, tokenCostMicro } from "./prices";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

export interface LlmCallOptions<T> {
  purpose: LlmPurpose;
  messages: ChatMessage[];
  /** Потолок выходных токенов этого вызова (не больше LLM_MAX_OUTPUT_TOKENS). */
  maxTokens?: number;
  temperature?: number;
  /** Попросить JSON-объект (response_format json_object, если не выключено LLM_JSON_MODE=0). */
  json?: boolean;
  /** Разбор/проверка ответа. null — ответ невалиден (LLM_BAD_OUTPUT), вызывающий уходит в fallback. */
  parse?: (text: string) => T | null;
  /** Пользователь и канал; по умолчанию — из контекста текущего обращения (service-log). */
  userId?: string | null;
  channel?: LogChannel;
  /** Явная цепочка моделей (иначе из env). */
  models?: string[];
  /** Таймаут одной попытки, мс (иначе LLM_TIMEOUT_MS). */
  timeoutMs?: number;
  now?: Date;
}

export type LlmFailure = "disabled" | "not_configured" | "quota" | "budget" | "timeout" | "error" | "bad_output";
export interface LlmOk<T> {
  ok: true; value: T; text: string; model: string; provider: string; fallback: boolean;
  promptTokens: number; completionTokens: number; usageEstimated: boolean; costMicro: number; latencyMs: number; requestId: string; attempts: number;
}
export interface LlmFail { ok: false; reason: LlmFailure; code: string; budgetScope?: BudgetScope; requestId: string | null; attempts: number; latencyMs: number }
export type LlmResult<T> = LlmOk<T> | LlmFail;

/** Квоты AI-ответов и права (шаг 2 плана, lib/plans): без хуков всё разрешено и ничего не списывается. */
export interface LlmHooks {
  /** До вызова: можно ли этому пользователю этот вызов (квота «AI-ответов», тариф). false → отказ reason=quota.
   *  requestId — тот же, что в ai_usage: по нему lib/plans резервирует токен, onAnswer списывает, onRelease возвращает. */
  allow?(c: { userId: string | null; purpose: LlmPurpose; requestId: string; now: Date }): boolean | Promise<boolean>;
  /** После УСПЕШНОГО пользовательского AI-ответа (AI_ANSWER_PURPOSES). Разбор намерения, голос, ошибки и отказы сюда не попадают. */
  onAnswer?(c: { userId: string | null; purpose: LlmPurpose; requestId: string; model: string; now: Date }): void | Promise<void>;
  /** allow пропустил вызов, но AI-ответа не получилось (сбой, невалидный ответ, бюджет): резерв квоты вернуть. */
  onRelease?(c: { userId: string | null; purpose: LlmPurpose; requestId: string; now: Date }): void | Promise<void>;
}
let hooks: LlmHooks = {};
export function setLlmHooks(h: LlmHooks) { hooks = h ?? {}; }

export const CALL_TYPE_OF: Record<LlmPurpose, CallType> = {
  intent_parse: "llm.intent", explain: "llm.explain", compare: "llm.compare", goal_chat: "llm.goal",
  weekly_review: "llm.review", voice_transcribe: "llm.stt", onboarding: "llm.onboarding",
};

export type UsageStatus = "ok" | "error" | "fallback" | "budget_denied" | "timeout";
export interface UsageRow {
  requestId: string; attempt: number; purpose: LlmPurpose; provider: string; model: string;
  promptTokens: number; completionTokens: number; audioMs?: number | null; usageEstimated: boolean;
  reservedMicro: number; costMicro: number; priceVersion: string; latencyMs: number | null;
  status: UsageStatus; errorCode: string | null; fallbackFrom: string | null; aiAnswer: boolean; budgetDay: string;
}

const warn = (what: string, e: unknown) => { if (process.env.NODE_ENV !== "production") console.warn(`[llm] ${what} failed`, (e as Error)?.message); };

/** Записать попытки в ai_usage одной вставкой. Никогда не бросает. */
export async function writeUsage(rows: UsageRow[], who: { userId: string | null; channel: LogChannel }): Promise<boolean> {
  if (!rows.length) return true;
  try {
    const m = await logMetaOf(who.userId);
    const channel = (LOG_CHANNELS as readonly string[]).includes(who.channel) ? who.channel : "system";
    const cols = 21;
    const vals: unknown[] = [];
    const tuples = rows.map((r, i) => {
      vals.push(r.budgetDay, r.requestId, r.attempt, m.subject, channel, r.purpose, r.provider.slice(0, 40), r.model.slice(0, 80),
        Math.max(0, Math.round(r.promptTokens)), Math.max(0, Math.round(r.completionTokens)), r.audioMs ?? null, r.usageEstimated,
        Math.max(0, Math.ceil(r.reservedMicro)), Math.max(0, Math.ceil(r.costMicro)), r.priceVersion.slice(0, 40),
        r.latencyMs == null ? null : Math.max(0, Math.round(r.latencyMs)), r.status, r.errorCode, r.fallbackFrom?.slice(0, 80) ?? null, r.aiAnswer, m.internal);
      return `(${Array.from({ length: cols }, (_, k) => `$${i * cols + k + 1}`).join(",")})`;
    });
    const db = await getDb();
    await db.query(
      `INSERT INTO ai_usage(budget_day, request_id, attempt, subject, channel, purpose, provider, model, prompt_tokens, completion_tokens, audio_ms,
         usage_estimated, reserved_microrub, cost_microrub, price_version, latency_ms, status, error_code, fallback_from, ai_answer, internal)
       VALUES ${tuples.join(",")}`, vals);
    return true;
  } catch (e) { warn("writeUsage", e); return false; }
}

/** Итог операции в service_calls (+ service_errors для сбоя модели). Никогда не бросает. */
export async function recordOperation(o: { purpose: LlmPurpose; userId: string | null; channel: LogChannel; ok: boolean; code: string | null; failed: boolean; latencyMs: number }) {
  try {
    await recordCall({ type: CALL_TYPE_OF[o.purpose], channel: o.channel, userId: o.userId, result: o.failed ? "error" : "ok", code: o.ok ? null : o.code, latencyMs: o.latencyMs });
    if (o.failed && o.code) await logServiceError({ channel: o.channel, route: CALL_TYPE_OF[o.purpose], userId: o.userId, code: o.code });
  } catch (e) { warn("recordOperation", e); }
}

/** Первый JSON-объект в тексте (модели иногда оборачивают его в ```json). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try { const v = JSON.parse(text.slice(s, e + 1)); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; }
  catch { return null; }
}

/** Ограничение длины входа: обрезается последнее сообщение пользователя (системный промпт не трогаем). */
function clampMessages(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  const total = messages.reduce((s, m) => s + m.content.length, 0);
  if (total <= maxChars) return messages;
  const out = messages.map((m) => ({ ...m }));
  let over = total - maxChars;
  for (let i = out.length - 1; i >= 0 && over > 0; i--) {
    if (out[i].role === "system") continue;
    const cut = Math.min(over, out[i].content.length);
    out[i].content = out[i].content.slice(0, out[i].content.length - cut);
    over -= cut;
  }
  return out;
}

type Attempt =
  | { kind: "ok"; text: string; usage: { prompt: number; completion: number } | null }
  | { kind: "http"; status: number }
  | { kind: "timeout" }
  | { kind: "network" };

async function attemptChat(cfg: LlmConfig, model: string, messages: ChatMessage[], maxTokens: number, o: { json?: boolean; temperature?: number }, timeoutMs: number): Promise<Attempt> {
  try {
    const body: Record<string, unknown> = { model, messages, max_tokens: maxTokens, temperature: o.temperature ?? 0, stream: false };
    if (o.json && cfg.jsonMode) body.response_format = { type: "json_object" };
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return { kind: "http", status: res.status }; } // тело провайдера не читаем и не храним
    const j = await res.json() as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    const content = j?.choices?.[0]?.message?.content;
    const pt = Number(j?.usage?.prompt_tokens), ct = Number(j?.usage?.completion_tokens);
    const usage = Number.isFinite(pt) && Number.isFinite(ct) && pt >= 0 && ct >= 0 ? { prompt: pt, completion: ct } : null;
    return { kind: "ok", text: typeof content === "string" ? content : "", usage };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    return name === "TimeoutError" || name === "AbortError" ? { kind: "timeout" } : { kind: "network" };
  }
}

const retryable = (a: Attempt) => a.kind === "timeout" || a.kind === "network" || (a.kind === "http" && (a.status >= 500 || a.status === 429));
const codeOf = (a: Attempt) => (a.kind === "timeout" ? "LLM_TIMEOUT" : a.kind === "network" ? "LLM_NETWORK" : a.kind === "http" ? `LLM_HTTP_${a.status}` : "LLM_BAD_OUTPUT");

/** Контекст вызова: пользователь и канал (явные или из текущего обращения). */
export function callWho(o: { userId?: string | null; channel?: LogChannel }) {
  const ctx = currentCall();
  return { userId: o.userId !== undefined ? o.userId : ctx?.userId ?? null, channel: o.channel ?? ctx?.channel ?? "system" as LogChannel };
}

export async function llmCall<T = string>(o: LlmCallOptions<T>): Promise<LlmResult<T>> {
  const t0 = Date.now();
  const fail = (reason: LlmFailure, code: string, extra: Partial<LlmFail> = {}): LlmFail => ({ ok: false, reason, code, requestId: null, attempts: 0, latencyMs: Date.now() - t0, ...extra });
  let cfg: LlmConfig;
  try { cfg = llmConfig(); } catch { return fail("error", "LLM_CONFIG"); }
  if (cfg.killed) return fail("disabled", "LLM_DISABLED");
  if (!cfg.configured) return fail("not_configured", "LLM_NOT_CONFIGURED");
  const who = callWho(o);
  const requestId = randomUUID();
  let allowedByHook = false;
  if (hooks.allow) {
    let allowed = true;
    try { allowed = await hooks.allow({ userId: who.userId, purpose: o.purpose, requestId, now: o.now ?? new Date() }); } catch { allowed = true; }
    if (!allowed) return fail("quota", "LLM_QUOTA");
    allowedByHook = true;
  }

  const messages = clampMessages(o.messages, cfg.maxInputChars);
  const maxTokens = Math.max(1, Math.min(cfg.maxOutputTokens, Math.floor(o.maxTokens ?? DEFAULT_MAX_TOKENS[o.purpose] ?? 300)));
  const base = o.models?.length ? o.models : o.purpose === "intent_parse" && cfg.intentModel ? [cfg.intentModel, cfg.primary, ...cfg.fallbacks] : [cfg.primary, ...cfg.fallbacks];
  const chain = [...new Set(base.map((m) => m.trim()).filter(Boolean))].slice(0, 5);
  const promptText = messages.map((m) => m.content).join("\n");
  const estPromptUpper = estimateTokens(promptText, true) + 8 * messages.length + 8;
  const estPrompt = estimateTokens(promptText) + 4 * messages.length;
  const now = o.now ?? new Date();
  const day = budgetDay(now);
  const deadline = t0 + cfg.totalTimeoutMs;
  const aiAnswerPurpose = AI_ANSWER_PURPOSES.includes(o.purpose);
  const rows: UsageRow[] = [];
  let result: LlmResult<T> | null = null;
  let lastFail: { code: string; reason: LlmFailure } | null = null;
  let prevFailed: string | null = null;

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const remaining = deadline - Date.now();
    if (remaining < 100) { lastFail = { code: "LLM_TIMEOUT", reason: "timeout" }; break; }
    const price = priceOf(model);
    const reserveMicro = tokenCostMicro(model, estPromptUpper, maxTokens);
    const row = { requestId, attempt: i + 1, purpose: o.purpose, provider: cfg.provider, model, priceVersion: price.version, budgetDay: day, audioMs: null } as const;
    const res = await reserveBudget({ userId: who.userId, micro: reserveMicro, cfg, now });
    if (!res.ok) {
      const code = `LLM_BUDGET_${res.scope.toUpperCase()}`;
      rows.push({ ...row, promptTokens: 0, completionTokens: 0, usageEstimated: false, reservedMicro: 0, costMicro: 0, latencyMs: 0, status: "budget_denied", errorCode: code, fallbackFrom: prevFailed, aiAnswer: false });
      result = fail("budget", code, { budgetScope: res.scope, requestId, attempts: i + 1 });
      break; // резервные модели дороже основной: если не влезла основная, не влезут и они
    }
    const ta = Date.now();
    const a = await attemptChat(cfg, model, messages, maxTokens, o, Math.min(o.timeoutMs ?? cfg.timeoutMs, remaining));
    const latencyMs = Date.now() - ta;
    if (a.kind === "ok") {
      const usageEstimated = !a.usage;
      const pt = a.usage?.prompt ?? estPrompt, ct = a.usage?.completion ?? estimateTokens(a.text);
      const costMicro = tokenCostMicro(model, pt, ct);
      await settleBudget(res.reservation, costMicro);
      let value: T | null = null;
      try { value = a.text.trim() ? (o.parse ? o.parse(a.text) : (a.text as unknown as T)) : null; } catch { value = null; }
      const common = { ...row, promptTokens: pt, completionTokens: ct, usageEstimated, reservedMicro: reserveMicro, costMicro, latencyMs, fallbackFrom: prevFailed };
      if (value == null) {
        rows.push({ ...common, status: "error", errorCode: "LLM_BAD_OUTPUT", aiAnswer: false });
        result = fail("bad_output", "LLM_BAD_OUTPUT", { requestId, attempts: i + 1 });
        break;
      }
      rows.push({ ...common, status: i === 0 ? "ok" : "fallback", errorCode: null, aiAnswer: aiAnswerPurpose });
      result = { ok: true, value, text: a.text, model, provider: cfg.provider, fallback: i > 0, promptTokens: pt, completionTokens: ct, usageEstimated, costMicro, latencyMs: Date.now() - t0, requestId, attempts: i + 1 };
      break;
    }
    // Таймаут: провайдер мог уже начать считать — списываем оценку входа (консервативно). 5xx/429/сеть — без списания.
    const costMicro = a.kind === "timeout" ? tokenCostMicro(model, estPrompt, 0) : 0;
    await settleBudget(res.reservation, costMicro);
    const code = codeOf(a);
    rows.push({ ...row, promptTokens: a.kind === "timeout" ? estPrompt : 0, completionTokens: 0, usageEstimated: a.kind === "timeout", reservedMicro: reserveMicro, costMicro, latencyMs,
      status: a.kind === "timeout" ? "timeout" : "error", errorCode: code, fallbackFrom: prevFailed, aiAnswer: false });
    lastFail = { code, reason: a.kind === "timeout" ? "timeout" : "error" };
    if (!retryable(a)) break;
    prevFailed = model;
  }
  if (!result) result = fail(lastFail?.reason ?? "error", lastFail?.code ?? "LLM_NO_MODEL", { requestId, attempts: rows.length });
  else result = { ...result, latencyMs: Date.now() - t0 };

  await writeUsage(rows, who);
  await recordOperation({ purpose: o.purpose, userId: who.userId, channel: who.channel, ok: result.ok, code: result.ok ? null : result.code,
    failed: !result.ok && result.reason !== "budget", latencyMs: Date.now() - t0 });
  if (result.ok && aiAnswerPurpose && hooks.onAnswer) {
    try { await hooks.onAnswer({ userId: who.userId, purpose: o.purpose, requestId, model: result.model, now: o.now ?? new Date() }); } catch (e) { warn("onAnswer", e); }
  } else if (allowedByHook && hooks.onRelease && !(result.ok && aiAnswerPurpose)) {
    try { await hooks.onRelease({ userId: who.userId, purpose: o.purpose, requestId, now: o.now ?? new Date() }); } catch (e) { warn("onRelease", e); }
  }
  return result;
}

/** LLM включена (есть ключ и не выключена LLM_ENABLED=0). */
export function llmEnabled(): boolean { try { return llmConfig().enabled; } catch { return false; } }
