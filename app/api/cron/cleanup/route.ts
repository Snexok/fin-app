import { errorJson, json } from "../../../../lib/api";
import { syncInternalFromEnv } from "../../../../lib/internal-users";
import { runRetention } from "../../../../lib/retention";
import { retryPendingTelegram } from "../../../../lib/telegram-webhook";
import { safeEqual } from "../../../../lib/util";
import { maturePendingRewards } from "../../../../lib/plans/entitlements";
import { releaseStaleTokens } from "../../../../lib/plans";
import { apiRoute, safeMessage, tagResponse } from "../../../../lib/service-log";
export const dynamic = "force-dynamic";
// Vercel Cron: Authorization: Bearer $CRON_SECRET. Без CRON_SECRET эндпоинт выключен.
async function getHandler(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return errorJson("NOT_CONFIGURED", "Не настроено", 503);
  if (!safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) return errorJson("FORBIDDEN", "Нет доступа", 403);
  try {
    const retried = await retryPendingTelegram();
    const internalMarked = await syncInternalFromEnv(); // INTERNAL_TELEGRAM_IDS / INTERNAL_USER_IDS → users.is_internal
    // Награды за друзей: созревшие pending → +N дней Плюса (только при REFERRAL_REWARDS_ENABLED=1; по умолчанию ничего не делает).
    const referralRewards = await maturePendingRewards();
    const tokenReservationsReleased = await releaseStaleTokens(); // зависшие резервы AI-ответов (упавший вызов модели)
    return json({ ok: true, telegramRetried: retried, internalMarked, referralRewards, tokenReservationsReleased, deleted: await runRetention() });
  }
  catch (e) { console.error("retention error", (e as Error)?.name); return tagResponse(errorJson("INTERNAL", "Ошибка очистки", 500), { code: "INTERNAL", message: safeMessage(e), error: e }); }
}
export const GET = apiRoute("cron.cleanup", getHandler, { channel: "cron" });
