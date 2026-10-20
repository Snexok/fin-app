// Таблица цен моделей: копейки за 1 млн токенов, С НДС 22 %, без наценки прокси.
// Источник: docs/LLM-COST.md §2 (Cloud.ru Evolution Foundation Models, Приложение №7.EVO.11.2, версия 261015, с 15.10.2026).
// Переопределение без деплоя кода: LLM_PRICES (JSON), LLM_PRICE_MARKUP (коэффициент комиссии прокси), STT_PRICE_KOP_PER_SEC.
//
// Единица учёта — микрорубли (1 ₽ = 1 000 000 µ₽, 1 коп. = 10 000 µ₽): разбор намерения стоит ~1,5 коп.,
// округление до копеек его бы съело. Стоимость токена в µ₽ = (коп. за 1 млн) / 100.

export interface ModelPrice { inKop: number; outKop: number; note?: string }

export const PRICE_VERSION = "cloudru-261015";

/** Ключ — нормализованный id модели (нижний регистр, без префикса поставщика «ai-sage/…»). */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "gigachat3.5-432b-a28b": { inKop: 9_622, outKop: 28_860, note: "GigaChat 3.5 Ultra, строки 448-449" },
  "qwen3.5-397b-a17b": { inKop: 91_500, outKop: 108_580, note: "Qwen3.5-397B-A17B, внутренняя, строки 267-268 (дороже партнёрской)" },
  "deepseek-v4-pro": { inKop: 18_300, outKop: 73_200, note: "DeepSeek-V4-Pro, строки 251-252" },
  "gigachat3-10b-a1.8b": { inKop: 1_220, outKop: 1_220, note: "GigaChat3-10B-A1.8B, малая модель для разбора намерения, строки 259-260" },
  // Прежний режим без шлюза (чистый OpenAI-ключ): $0,15 / $0,60 за 1 млн по ~100 ₽/$ — оценка, не прайс Cloud.ru.
  "gpt-4o-mini": { inKop: 1_500, outKop: 6_000, note: "оценка, OpenAI" },
};

/** Неизвестная модель тарифицируется по самой дорогой известной: резерв не должен оказаться заниженным. */
export const UNKNOWN_MODEL_PRICE: ModelPrice = { inKop: 91_500, outKop: 108_580, note: "неизвестная модель: по самой дорогой" };

/** Whisper: 0,0061 ₽ за секунду аудио = 0,61 коп./с. */
export const STT_PRICE_KOP_PER_SEC = 0.61;

export const normalizeModel = (m: string) => m.trim().toLowerCase().replace(/^.*\//, "");

function overrides(): Record<string, ModelPrice> {
  const raw = process.env.LLM_PRICES;
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, ModelPrice> = {};
    for (const [k, v] of Object.entries(o)) {
      // Форматы: {"model": [in, out]} или {"model": {"in": .., "out": ..}} — копейки за 1 млн токенов с НДС.
      const pair = Array.isArray(v) ? v : v && typeof v === "object" ? [(v as { in?: unknown }).in, (v as { out?: unknown }).out] : null;
      const [i, x] = (pair ?? []).map(Number);
      if (Number.isFinite(i) && Number.isFinite(x) && i >= 0 && x >= 0) out[normalizeModel(k)] = { inKop: i, outKop: x, note: "LLM_PRICES" };
    }
    return out;
  } catch { return {}; }
}

const markup = () => { const m = Number(process.env.LLM_PRICE_MARKUP ?? 1); return Number.isFinite(m) && m > 0 ? m : 1; };

export function priceOf(model: string): ModelPrice & { version: string; known: boolean } {
  const key = normalizeModel(model);
  const o = overrides();
  const m = markup();
  const tag = (v: string) => (m !== 1 ? `${v}x${m}` : v);
  if (o[key]) return { ...o[key], version: tag("env"), known: true };
  const p = MODEL_PRICES[key];
  if (p) return { ...p, version: tag(PRICE_VERSION), known: true };
  if (o["*"]) return { ...o["*"], version: tag("env"), known: false };
  return { ...UNKNOWN_MODEL_PRICE, version: tag(PRICE_VERSION), known: false };
}

/** Стоимость в микрорублях, округление вверх (в пользу бюджета). Коэффициент прокси LLM_PRICE_MARKUP применяется ко всем ценам. */
export function tokenCostMicro(model: string, promptTokens: number, completionTokens: number): number {
  const p = priceOf(model);
  const raw = (Math.max(0, promptTokens) * p.inKop + Math.max(0, completionTokens) * p.outKop) / 100;
  return Math.ceil(raw * markup() - 1e-9);
}

export function sttCostMicro(seconds: number): number {
  const env = Number(process.env.STT_PRICE_KOP_PER_SEC);
  const kop = Number.isFinite(env) && env >= 0 && process.env.STT_PRICE_KOP_PER_SEC ? env : STT_PRICE_KOP_PER_SEC;
  return Math.ceil(Math.max(0, seconds) * kop * 10_000 * markup() - 1e-9);
}

/** Оценка токенов по длине текста. upper — верхняя граница для резерва (кириллица ~2 символа на токен в худшем случае). */
export function estimateTokens(text: string, upper = false): number {
  const n = text.length;
  return n === 0 ? 0 : Math.ceil(n / (upper ? 2 : 3));
}
