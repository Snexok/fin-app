// Токен Telegram-бота: один секрет TELEGRAM_BOT_TOKEN с проверкой формата.
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,}$/;

export const isValidBotToken = (t: string | undefined | null): t is string => !!t && TOKEN_RE.test(t);

let warned = false;
const warnOnce = (msg: string) => { if (!warned) { warned = true; console.warn(msg); } };

/**
 * TEMPORARY, TO REMOVE: старый разделённый токен (TELEGRAM_BOT_ID + TELEGRAM_BOT_KEY[+KEY2] или TELEGRAM_BOT_TOKEN_B64).
 * Используется ТОЛЬКО если TELEGRAM_BOT_TOKEN не задан или невалиден, чтобы production не сломался до замены env.
 * Удалить вместе с переменными после того, как в Vercel задан полный TELEGRAM_BOT_TOKEN (см. docs/BACKEND.md).
 */
function legacySplitToken(): string | undefined {
  const id = process.env.TELEGRAM_BOT_ID?.trim();
  const key = process.env.TELEGRAM_BOT_KEY?.trim();
  if (id && key) {
    const joined = `${id}:${key}${process.env.TELEGRAM_BOT_KEY2?.trim() ?? ""}`;
    if (isValidBotToken(joined)) return joined;
  }
  const b64 = process.env.TELEGRAM_BOT_TOKEN_B64?.trim();
  if (b64 && /^[A-Za-z0-9+/=_-]+$/.test(b64)) {
    const decoded = Buffer.from(b64, "base64").toString("utf8").trim();
    if (isValidBotToken(decoded)) return decoded;
  }
  return undefined;
}

/** Валидный токен или undefined. Невалидный TELEGRAM_BOT_TOKEN никогда не возвращается. */
export function telegramBotToken(): string | undefined {
  const raw = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (isValidBotToken(raw)) return raw;
  const legacy = legacySplitToken();
  if (legacy) { warnOnce("TELEGRAM_BOT_TOKEN не задан: используется временный split-токен (TELEGRAM_BOT_ID/KEY). Замените на TELEGRAM_BOT_TOKEN."); return legacy; }
  if (raw) warnOnce("TELEGRAM_BOT_TOKEN имеет неверный формат (ожидается <id>:<secret>) и игнорируется.");
  return undefined;
}

/** Fail fast: без валидного токена бот не создаётся. */
export function requireTelegramBotToken(): string {
  const t = telegramBotToken();
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN не задан или имеет неверный формат (<id>:<secret>)");
  return t;
}
