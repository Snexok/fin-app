import { webhookCallback } from "grammy";
import { createBot } from "../../../lib/bot";
import { claimInboxEvent, markInboxProcessed } from "../../../lib/inbox";
import { telegramBotToken } from "../../../lib/telegram-token";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
let handler: ((req: Request) => Promise<Response>) | null = null;

export async function POST(req: Request) {
  const token = telegramBotToken();
  if (!token) return new Response("not configured", { status: 503 });
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret && process.env.NODE_ENV === "production") return new Response("webhook secret required", { status: 503 });
  if (secret && req.headers.get("x-telegram-bot-api-secret-token") !== secret) return new Response("forbidden", { status: 403 });

  const raw = await req.text();
  let update: { update_id?: number };
  try { update = JSON.parse(raw); } catch { return new Response("bad request", { status: 400 }); }
  if (typeof update.update_id !== "number") return new Response("bad request", { status: 400 });

  // Дедупликация повторов Telegram по (botId, update_id). Полный inbox+jobs — шаг 9.
  const source = `telegram:${token.split(":")[0]}`;
  const eventId = String(update.update_id);
  if (!(await claimInboxEvent(source, eventId, { update_id: update.update_id }))) return new Response("ok (duplicate)", { status: 200 });

  // Долгая обработка (STT/LLM) не должна вызывать повтор: таймаут длиннее, при таймауте отвечаем 200.
  handler ??= webhookCallback(createBot(), "std/http", { secretToken: secret || undefined, timeoutMilliseconds: 55_000, onTimeout: "return" });
  try {
    const res = await handler(new Request(req.url, { method: "POST", headers: req.headers, body: raw }));
    await markInboxProcessed(source, eventId);
    return res;
  } catch (e) {
    // Захват НЕ снимаем: частично выполненный апдейт нельзя безопасно повторить без jobs/outbox (шаг 9).
    // Лучше потерять апдейт (пользователь повторит сообщение), чем дважды продвинуть онбординг.
    console.error("telegram webhook error", (e as Error)?.message);
    return new Response("ok", { status: 200 });
  }
}
