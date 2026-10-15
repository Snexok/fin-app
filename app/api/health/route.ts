import { json } from "../../../lib/api";
import { dbReady } from "../../../lib/db";
import { llmEnabled } from "../../../lib/ai/llm";
import { telegramBotToken } from "../../../lib/telegram-token";
export const dynamic = "force-dynamic";
// Публичный health без обращения к Telegram и без деталей интеграций. 503, если БД недоступна (readiness).
export async function GET() {
  const db = await dbReady();
  return json({
    ok: db.ok,
    storage: db.kind,
    db: db.ok ? "ready" : "unavailable",
    llm: llmEnabled(),
    telegramBot: telegramBotToken() ? "configured" : null,
    webhookSecret: !!process.env.TELEGRAM_WEBHOOK_SECRET,
  }, db.ok ? 200 : 503);
}
