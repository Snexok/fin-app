// Тарифы и квоты из env (Монетизация.md §1.2, §2). Читается при каждом вызове (тесты и cron меняют env на лету), без кэша.
// Этап 1 Sber500: PLANS_MODE=beta (по умолчанию) — у всех одинаковый «Бета-Плюс», денег не берём, цена показывается как «после беты».

export const PLAN_CODES = ["beta_plus", "free", "plus"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];
export type PlansMode = "beta" | "live";
/** Цены, которые можно предложить в вопросе «сколько честно платить» (перечисление — для allowlist аналитики). */
export const PRICE_POINTS = [149, 199, 249, 299, 349, 399, 449, 499, 599, 699] as const;

export interface PlanLimits {
  /** AI-ответов в день (по Москве); 0 — без дневного лимита. */
  perDay: number;
  /** AI-ответов на 30-дневное окно; 0 — без лимита окна. */
  perWindow: number;
  /** Секунды голоса на окно и в день; 0 — без лимита. */
  voiceWindowSec: number;
  voiceDaySec: number;
}

export interface PlansConfig {
  mode: PlansMode;
  /** Дата окончания беты (YYYY-MM-DD, МСК) — только для показа и для старта наград «после беты». */
  betaEndsAt: string | null;
  windowDays: number;
  limits: Record<PlanCode, PlanLimits>;
  price: { plusRub: number; periodDays: number; options: number[]; experiment: boolean };
  /** Сколько секунд резерв токена считается живым (вызов модели не дольше LLM_TOTAL_TIMEOUT_MS). */
  reservationTtlSec: number;
  /** «Мало осталось»: показать мягкую строку в ответе, когда осталось не больше стольких AI-ответов. */
  lowThreshold: number;
}

const env = (k: string) => { const v = process.env[k]; return v == null || v.trim() === "" ? undefined : v.trim(); };
function int(k: string, def: number, min = 0, max = 1_000_000): number {
  const v = env(k);
  if (v == null) return def;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) && n >= min ? Math.min(max, Math.floor(n)) : def;
}
const minutes = (k: string, def: number) => Math.round(Number(int(k, def, 0, 100_000)) * 60);

export function plansConfig(): PlansConfig {
  const mode: PlansMode = env("PLANS_MODE")?.toLowerCase() === "live" ? "live" : "beta";
  const plusVoice = { voiceWindowSec: minutes("PLUS_VOICE_MIN_PER_30D", 30), voiceDaySec: minutes("PLUS_VOICE_MIN_PER_DAY", 3) };
  const plusRub = int("PLUS_PRICE_RUB", 399, 0, 10_000);
  const raw = (env("PLUS_PRICE_OPTIONS") ?? "299,399,499").split(/[\s,;]+/).map(Number);
  const options = [...new Set(raw.filter((n) => (PRICE_POINTS as readonly number[]).includes(n)))].sort((a, b) => a - b).slice(0, 4);
  const be = env("BETA_ENDS_AT");
  return {
    mode,
    betaEndsAt: be && /^\d{4}-\d{2}-\d{2}$/.test(be) ? be : null,
    windowDays: int("PLANS_WINDOW_DAYS", 30, 1, 366),
    limits: {
      // Бета: 15 AI-ответов в день без месячного лимита, голос как в Плюсе.
      beta_plus: { perDay: int("BETA_AI_ANSWERS_PER_DAY", 15), perWindow: int("BETA_AI_ANSWERS_PER_30D", 0), ...plusVoice },
      free: { perDay: int("FREE_AI_ANSWERS_PER_DAY", 10), perWindow: int("FREE_AI_ANSWERS_PER_30D", 60), voiceWindowSec: minutes("FREE_VOICE_MIN_PER_30D", 2), voiceDaySec: minutes("FREE_VOICE_MIN_PER_DAY", 0) },
      plus: { perDay: int("PLUS_AI_ANSWERS_PER_DAY", 30), perWindow: int("PLUS_AI_ANSWERS_PER_30D", 300), ...plusVoice },
    },
    price: { plusRub, periodDays: int("PLUS_PERIOD_DAYS", 30, 1, 366), options: options.length ? options : [299, 399, 499], experiment: /^(1|true|on|yes)$/i.test(env("PLUS_PRICE_EXPERIMENT") ?? "") },
    reservationTtlSec: int("PLANS_RESERVATION_TTL_SEC", 120, 10, 3600),
    lowThreshold: int("PLANS_LOW_THRESHOLD", 3, 0, 100),
  };
}

export const PLAN_LABEL: Record<PlanCode, string> = { beta_plus: "Бета-Плюс", free: "Free", plus: "Плюс" };
