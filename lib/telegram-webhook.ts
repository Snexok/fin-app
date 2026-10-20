// Вебхук Telegram: проверка секрета, лимит тела, durable inbox по update_id, быстрый ответ 200 и обработка после ответа.
import type { Update } from "grammy/types";
import { readBody } from "./api";
import { createBot } from "./bot";
import { leaseInboxEvent, markInboxProcessed, pendingInboxEvents, recordInboxEvent, releaseInboxEvent } from "./inbox";
import { telegramBotToken } from "./telegram-token";
import { ApiError, safeEqual } from "./util";
import { MoneyError } from "./engine/money";
import { DateError } from "./engine/dates";
import { logServiceError } from "./service-log";

export const MAX_UPDATE_BYTES = 256 * 1024;

type BotLike = { init(): Promise<void>; handleUpdate(u: Update): Promise<void> };
let cached: { token: string; bot: Promise<BotLike> } | null = null;

function botFor(token: string): Promise<BotLike> {
  if (cached?.token !== token) {
    const bot = createBot(token, { rethrow: true });
    cached = { token, bot: bot.init().then(() => bot) };
    cached.bot.catch(() => { cached = null; });
  }
  return cached.bot;
}

/** Обработка одного события из inbox под арендой. Ошибка снимает аренду: повтор Telegram или следующий вебхук обработают снова. */
export async function processInboxUpdate(source: string, eventId: string, getBot: () => Promise<BotLike>): Promise<"processed" | "skipped" | "failed"> {
  const update = await leaseInboxEvent(source, eventId);
  if (!update) return "skipped";
  try {
    await (await getBot()).handleUpdate(update as Update);
    await markInboxProcessed(source, eventId);
    return "processed";
  } catch (e) {
    const code = String((e as { code?: string })?.code ?? (e as Error)?.name ?? "ERROR");
    if (e instanceof ApiError || e instanceof MoneyError || e instanceof DateError) {
      // Детерминированная ошибка предметной области: повтор даст тот же результат (и дубли сообщений). Закрываем событие.
      console.error("telegram update rejected", { source, eventId, code });
      await logServiceError({ channel: "telegram", route: "bot.update", error: e, code });
      await markInboxProcessed(source, eventId, code).catch(() => {});
      return "failed";
    }
    console.error("telegram update failed", { source, eventId, name: (e as Error)?.name, code: (e as { code?: string })?.code });
    await logServiceError({ channel: "telegram", route: "bot.update", error: e }); // пропускается, если уже записано обработчиком бота
    await releaseInboxEvent(source, eventId, code).catch(() => {});
    return "failed";
  }
}

/** Повтор упавших апдейтов без нового вебхука (вызывается cron-ом /api/cron/cleanup). */
export async function retryPendingTelegram(limit = 20): Promise<number> {
  const token = telegramBotToken();
  if (!token) return 0;
  const source = `telegram:${token.split(":")[0]}`;
  let n = 0;
  for (const id of await pendingInboxEvents(source, limit)) if ((await processInboxUpdate(source, id, () => botFor(token))) === "processed") n++;
  return n;
}

export interface WebhookDeps {
  /** Запланировать работу после ответа (next/server after). В тестах — сбор промисов. */
  schedule: (task: () => Promise<unknown>) => void;
  getBot?: (token: string) => Promise<BotLike>;
}

export async function handleTelegramWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  const token = telegramBotToken();
  if (!token) return new Response("not configured", { status: 503 });
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret && process.env.NODE_ENV === "production") return new Response("webhook secret required", { status: 503 });
  if (secret && !safeEqual(req.headers.get("x-telegram-bot-api-secret-token") ?? "", secret)) return new Response("forbidden", { status: 403 });

  let raw: Uint8Array;
  try { raw = await readBody(req, MAX_UPDATE_BYTES); }
  catch (e) { if (e instanceof ApiError && e.status === 413) return new Response("payload too large", { status: 413 }); throw e; }
  let update: { update_id?: unknown };
  try { update = JSON.parse(new TextDecoder().decode(raw)); } catch { return new Response("bad request", { status: 400 }); }
  if (!update || typeof update.update_id !== "number" || !Number.isSafeInteger(update.update_id)) return new Response("bad request", { status: 400 });

  // Идемпотентность по (botId, update_id): апдейт сохраняется целиком ДО ответа, поэтому не теряется при сбое обработки.
  const source = `telegram:${token.split(":")[0]}`;
  const eventId = String(update.update_id);
  await recordInboxEvent(source, eventId, update);

  const getBot = () => (deps.getBot ?? botFor)(token);
  // Быстрый ответ: обработка (LLM/STT) идёт после ответа и не вызывает повторную доставку по таймауту.
  // Заодно добираем ранее упавшие события с истёкшей арендой (ограниченно по числу попыток).
  deps.schedule(async () => {
    await processInboxUpdate(source, eventId, getBot);
    for (const id of await pendingInboxEvents(source, 3)) if (id !== eventId) await processInboxUpdate(source, id, getBot);
  });
  return new Response("ok", { status: 200 });
}
