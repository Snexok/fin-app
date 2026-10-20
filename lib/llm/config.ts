// Конфигурация LLM-слоя из env. Читается при каждом вызове (тесты и cron меняют env на лету), без кэша.
// Совместимость: старые LLM_MODEL / OPENAI_API_KEY продолжают работать (см. README, «Переменные окружения»).

export const LLM_PURPOSES = ["intent_parse", "explain", "compare", "goal_chat", "weekly_review", "voice_transcribe", "onboarding"] as const;
export type LlmPurpose = (typeof LLM_PURPOSES)[number];

/** Пользовательские AI-ответы: только они в будущем тратят квоту «AI-ответов» (Монетизация.md §2). */
export const AI_ANSWER_PURPOSES: readonly LlmPurpose[] = ["explain", "compare", "goal_chat", "weekly_review"];

/** Потолок выходных токенов по назначению (можно уменьшить в вызове, но не превысить LLM_MAX_OUTPUT_TOKENS). */
export const DEFAULT_MAX_TOKENS: Record<LlmPurpose, number> = {
  intent_parse: 120, explain: 300, compare: 350, goal_chat: 350, weekly_review: 600, voice_transcribe: 0, onboarding: 200,
};

export const ACCELERATOR_MODELS = { primary: "gigachat3.5-432b-a28b", fallbacks: ["qwen3.5-397b-a17b", "deepseek-v4-pro"] };
const LEGACY_OPENAI_MODEL = "gpt-4o-mini";
const OPENAI_BASE = "https://api.openai.com/v1";

const env = (k: string) => { const v = process.env[k]; return v == null || v.trim() === "" ? undefined : v.trim(); };
const list = (v: string | undefined) => (v ?? "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
function num(k: string, def: number, min = 0): number {
  const v = env(k);
  if (v == null) return def;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) && n >= min ? n : def;
}
export const rubToMicro = (rub: number) => Math.round(rub * 1_000_000);

export interface LlmConfig {
  /** Ключ задан и не выключено LLM_ENABLED=0. */
  enabled: boolean;
  configured: boolean;
  killed: boolean;
  baseUrl: string;
  apiKey: string | undefined;
  provider: string;
  primary: string;
  fallbacks: string[];
  /** Модель для разбора намерения (малая модель, если задана), иначе основная цепочка. */
  intentModel: string | undefined;
  timeoutMs: number;
  totalTimeoutMs: number;
  maxOutputTokens: number;
  maxInputChars: number;
  jsonMode: boolean;
  dailyCapMicro: number;
  userSoftCapMicro: number;
  totalBudgetMicro: number;
  totalBudgetMaxMicro: number;
  budgetStart: string;
}

export function providerOf(baseUrl: string): string {
  const forced = env("LLM_PROVIDER");
  if (forced) return forced.replace(/[^\w.-]/g, "_").slice(0, 40);
  try {
    const h = new URL(baseUrl).hostname;
    if (h.endsWith("multitool.works")) return "sber500-proxy";
    if (h === "api.openai.com") return "openai";
    if (h === "127.0.0.1" || h === "localhost") return "local";
    return h.slice(0, 40);
  } catch { return "unknown"; }
}

export function llmConfig(): LlmConfig {
  const apiKey = env("LLM_API_KEY") ?? env("OPENAI_API_KEY");
  const explicitBase = env("LLM_BASE_URL");
  const baseUrl = (explicitBase ?? OPENAI_BASE).replace(/\/+$/, "");
  // Без своего шлюза (чистый OpenAI-ключ) — прежняя модель по умолчанию; со шлюзом — модели акселератора.
  const legacy = !explicitBase;
  const primary = env("LLM_MODEL_PRIMARY") ?? env("LLM_MODEL") ?? (legacy ? LEGACY_OPENAI_MODEL : ACCELERATOR_MODELS.primary);
  const fbEnv = process.env.LLM_MODEL_FALLBACKS;
  const fallbacks = (fbEnv != null ? list(fbEnv) : legacy ? [] : ACCELERATOR_MODELS.fallbacks).filter((m) => m !== primary);
  const killed = env("LLM_ENABLED") === "0" || env("LLM_ENABLED") === "false";
  const totalBudget = num("LLM_TOTAL_BUDGET_RUB", 50_000);
  return {
    configured: !!apiKey, killed, enabled: !!apiKey && !killed,
    baseUrl, apiKey, provider: providerOf(baseUrl), primary, fallbacks,
    intentModel: env("LLM_MODEL_INTENT"),
    timeoutMs: num("LLM_TIMEOUT_MS", 8000, 100),
    totalTimeoutMs: num("LLM_TOTAL_TIMEOUT_MS", 15_000, 100),
    maxOutputTokens: Math.floor(num("LLM_MAX_OUTPUT_TOKENS", 800, 1)),
    maxInputChars: Math.floor(num("LLM_MAX_INPUT_CHARS", 6000, 100)),
    jsonMode: env("LLM_JSON_MODE") !== "0",
    dailyCapMicro: rubToMicro(num("LLM_DAILY_BUDGET_RUB", 2850)),
    userSoftCapMicro: rubToMicro(num("LLM_USER_DAILY_SOFT_CAP_RUB", 3)),
    totalBudgetMicro: rubToMicro(totalBudget),
    totalBudgetMaxMicro: rubToMicro(Math.max(totalBudget, num("LLM_TOTAL_BUDGET_MAX_RUB", 75_000))),
    budgetStart: /^\d{4}-\d{2}-\d{2}$/.test(env("LLM_BUDGET_START") ?? "") ? env("LLM_BUDGET_START")! : "2000-01-01",
  };
}

export interface SttConfig { enabled: boolean; baseUrl: string; apiKey: string | undefined; model: string; provider: string; timeoutMs: number }

/**
 * Распознавание речи. Совместимо с прежним поведением: STT_API_KEY / OPENAI_API_KEY → STT_BASE_URL или OpenAI.
 * Если задан только ключ шлюза (LLM_API_KEY), голос идёт в тот же шлюз (LLM_BASE_URL), если у него есть /audio/transcriptions.
 */
export function sttConfig(): SttConfig {
  const own = env("STT_API_KEY") ?? env("OPENAI_API_KEY");
  const apiKey = own ?? env("LLM_API_KEY");
  const baseUrl = (env("STT_BASE_URL") ?? (own ? OPENAI_BASE : env("LLM_BASE_URL") ?? OPENAI_BASE)).replace(/\/+$/, "");
  const killed = env("LLM_ENABLED") === "0" || env("LLM_ENABLED") === "false" || env("STT_ENABLED") === "0";
  return { enabled: !!apiKey && !killed, apiKey, baseUrl, model: env("STT_MODEL") ?? "whisper-1", provider: providerOf(baseUrl), timeoutMs: num("STT_TIMEOUT_MS", 30_000, 100) };
}

/** День бюджета: календарная дата в Europe/Moscow (UTC+3 без перехода на летнее время). */
export function budgetDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
