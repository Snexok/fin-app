import { after } from "next/server";
import { handleTelegramWebhook } from "../../../lib/telegram-webhook";
import { logServiceError } from "../../../lib/service-log";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Детали: lib/telegram-webhook.ts (секрет, лимит тела, inbox по update_id, обработка после ответа).
export async function POST(req: Request) {
  try {
    return await handleTelegramWebhook(req, { schedule: (task) => after(() => task().catch((e) => console.error("telegram task failed", { name: (e as Error)?.name }))) });
  } catch (e) {
    // Апдейт не удалось даже сохранить (например, БД недоступна): 500, чтобы Telegram повторил доставку.
    console.error("telegram webhook error", { name: (e as Error)?.name, code: (e as { code?: string })?.code });
    await logServiceError({ channel: "telegram", route: "/api/telegram", httpStatus: 500, error: e });
    return new Response("temporarily unavailable", { status: 500 });
  }
}
