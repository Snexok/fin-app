import { Api } from "grammy";
import { errorJson, json } from "../../../../lib/api";
import { runReminders } from "../../../../lib/reminders";
import { telegramBotToken } from "../../../../lib/telegram-token";
import { safeEqual } from "../../../../lib/util";
import { apiRoute, safeMessage, tagResponse } from "../../../../lib/service-log";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Мягкие напоминания. Vercel Hobby: cron раз в день (vercel.json, 07:00 UTC = 10:00 МСК).
// Почасовой внешний раннер (GitHub Actions / cron-job.org) может вызывать тот же URL каждый час: повторы не дублируют сообщения.
async function getHandler(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return errorJson("NOT_CONFIGURED", "Не настроено", 503);
  if (!safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) return errorJson("FORBIDDEN", "Нет доступа", 403);
  const token = telegramBotToken();
  if (!token) return errorJson("NOT_CONFIGURED", "Бот не настроен", 503);
  try {
    const api = new Api(token);
    // REMINDERS_RUNNER=hourly — когда настроен почасовой внешний вызов; по умолчанию daily (Vercel Hobby).
    const mode = process.env.REMINDERS_RUNNER === "hourly" ? "hourly" : "daily";
    const stats = await runReminders({ send: async (chatId, text, keyboard) => { await api.sendMessage(chatId, text, { reply_markup: keyboard }); } }, new Date(), { mode });
    return json({ ok: true, ...stats });
  } catch (e) { console.error("reminders error", (e as Error)?.name); return tagResponse(errorJson("INTERNAL", "Ошибка напоминаний", 500), { code: "INTERNAL", message: safeMessage(e), error: e }); }
}
export const GET = apiRoute("cron.reminders", getHandler, { channel: "cron" });
