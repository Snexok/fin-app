import { cookies, headers } from "next/headers";
import { assertSameOrigin, errorJson, handleError, json, readJson } from "../../../../../lib/api";
import { SESSION_COOKIE, setSessionCookie } from "../../../../../lib/session";
import { revokeSession, telegramSession } from "../../../../../lib/auth";
import { clientIp, enforce, LIMITS } from "../../../../../lib/rate-limit";
import { telegramBotToken } from "../../../../../lib/telegram-token";
import { verifyInitData } from "../../../../../lib/telegram-webapp";
export const dynamic = "force-dynamic";
// Вход из Telegram Mini App: initData проверяется HMAC от токена бота и по auth_date, затем выдаётся сессия Telegram-аккаунта.
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const token = telegramBotToken();
    if (!token) return errorJson("NOT_CONFIGURED", "Вход через Telegram сейчас недоступен", 503);
    await enforce([LIMITS.tgLoginPerIp(clientIp(await headers()))]);
    const { initData } = await readJson(req, 16 * 1024);
    const v = verifyInitData(typeof initData === "string" ? initData : "", token);
    if (!v) return errorJson("INVALID_INIT_DATA", "Не удалось подтвердить вход через Telegram. Откройте приложение из бота ещё раз.", 401);
    const old = (await cookies()).get(SESSION_COOKIE)?.value;
    const s = await telegramSession(v.userId);
    if (old) await revokeSession(old).catch(() => {});
    await setSessionCookie(s);
    return json({ ok: true });
  } catch (e) { return handleError(e); }
}
