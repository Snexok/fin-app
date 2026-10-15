/** Resolve Telegram bot token.
 * Supports TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_TOKEN_B64, or split parts
 * TELEGRAM_BOT_ID + TELEGRAM_BOT_KEY (and optional TELEGRAM_BOT_KEY2) when
 * connectors redact full tokens in transit.
 */
export function telegramBotToken(): string | undefined {
  const raw = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (raw && raw.includes(":")) return raw;

  const id = process.env.TELEGRAM_BOT_ID?.trim();
  const key = process.env.TELEGRAM_BOT_KEY?.trim();
  const key2 = process.env.TELEGRAM_BOT_KEY2?.trim() || "";
  if (id && key) {
    const joined = `${id}:${key}${key2}`;
    if (joined.includes(":")) return joined;
  }

  const b64 = process.env.TELEGRAM_BOT_TOKEN_B64?.trim();
  if (b64) {
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf8").trim();
      if (decoded.includes(":")) return decoded;
    } catch {
      /* ignore */
    }
  }
  return raw || undefined;
}
