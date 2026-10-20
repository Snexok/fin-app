import { cookies, headers } from "next/headers";
import { assertSameOrigin, errorJson, handleError, json, readJson } from "../../../../../lib/api";
import { SESSION_COOKIE, setSessionCookie } from "../../../../../lib/session";
import { revokeSession, telegramSession, telegramUserId } from "../../../../../lib/auth";
import { clientIp, enforce, LIMITS } from "../../../../../lib/rate-limit";
import { telegramBotToken } from "../../../../../lib/telegram-token";
import { verifyInitData } from "../../../../../lib/telegram-webapp";
import { apiRoute, CHANNEL_COOKIE, setCallUser } from "../../../../../lib/service-log";
import { recordFirstTouch, startPayloadAttribution } from "../../../../../lib/traffic-source";
import { markInternalIfListed } from "../../../../../lib/internal-users";
import { attributeReferral, parseRefPayload } from "../../../../../lib/referrals";
import { cookieBase } from "../../../../../lib/session";
export const dynamic = "force-dynamic";
// Вход из Telegram Mini App: initData проверяется HMAC от токена бота и по auth_date, затем выдаётся сессия Telegram-аккаунта.
async function postHandler(req: Request) {
  try {
    assertSameOrigin(req);
    const token = telegramBotToken();
    if (!token) return errorJson("NOT_CONFIGURED", "Вход через Telegram сейчас недоступен", 503);
    await enforce([LIMITS.tgLoginPerIp(clientIp(await headers()))]);
    const { initData } = await readJson(req, 16 * 1024);
    const v = verifyInitData(typeof initData === "string" ? initData : "", token);
    if (!v) return errorJson("INVALID_INIT_DATA", "Не удалось подтвердить вход через Telegram. Откройте приложение из бота ещё раз.", 401);
    const old = (await cookies()).get(SESSION_COOKIE)?.value;
    // Приглашение (startapp=ref_<код>): засчитывается, только если Telegram-аккаунт появился этим входом.
    const ref = parseRefPayload(v.startParam ?? "");
    const existed = ref ? (await telegramUserId(v.userId, false)) != null : true;
    const s = await telegramSession(v.userId);
    if (old) await revokeSession(old).catch(() => {});
    await setSessionCookie(s);
    setCallUser(s.userId);
    // Метка канала для журнала обращений (не для доступа): запросы из Mini App пишутся как miniapp.
    (await cookies()).set(CHANNEL_COOKIE, "miniapp", { ...cookieBase(), maxAge: 30 * 86_400 });
    await markInternalIfListed(s.userId, v.userId);
    await recordFirstTouch(s.userId, "miniapp", startPayloadAttribution(v.startParam ?? ""));
    if (ref) await attributeReferral(s.userId, ref.code, "miniapp", { isNew: !existed });
    return json({ ok: true });
  } catch (e) { return handleError(e); }
}
export const POST = apiRoute("session.telegram", postHandler);
