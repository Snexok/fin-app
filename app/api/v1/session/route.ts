import { cookies, headers } from "next/headers";
import { allowedOrigins, assertSameOrigin, handleError, json, readJson } from "../../../../lib/api";
import { currentUserId, setSessionCookie } from "../../../../lib/session";
import { createAnonymousSession } from "../../../../lib/auth";
import { clientIp, enforce, LIMITS } from "../../../../lib/rate-limit";
import { apiRoute, CHANNEL_COOKIE, setCallUser } from "../../../../lib/service-log";
import { recordFirstTouch, webAttribution } from "../../../../lib/traffic-source";
import { checkInviteCode, markInternalIfListed, setInternal } from "../../../../lib/internal-users";
import { attributeReferral, normalizeRefCode, referralAttribution } from "../../../../lib/referrals";
export const dynamic = "force-dynamic";
// Явное создание анонимной веб-сессии (GET-запросы аккаунтов не создают). Идемпотентно для живой сессии.
async function postHandler(req: Request) {
  try {
    assertSameOrigin(req);
    // Тело (необязательно): { attribution: { utm_source, utm_medium, utm_campaign, referrer }, team }.
    const body = await readJson(req, 4 * 1024).catch(() => ({} as Record<string, unknown>));
    const existing = await currentUserId();
    if (existing) { await afterSession(req, existing, body, false); return json({ created: false }); }
    await enforce([LIMITS.sessionPerIp(clientIp(await headers()))]);
    const s = await createAnonymousSession();
    await setSessionCookie(s);
    setCallUser(s.userId);
    (await cookies()).delete(CHANNEL_COOKIE); // явная веб-сессия: не Mini App
    await afterSession(req, s.userId, body, true);
    return json({ created: true }, 201);
  } catch (e) { return handleError(e); }
}
export const POST = apiRoute("session.create", postHandler);

/**
 * Первое касание (UTM и домен реферера), пометка команды по коду ?team= и приглашение ?ref=<код>
 * (засчитывается только для аккаунта, созданного этим запросом). Ошибки не мешают входу.
 */
async function afterSession(req: Request, userId: string, body: Record<string, unknown>, created: boolean) {
  if (checkInviteCode(body.team)) await setInternal(userId, true).catch(() => false);
  else await markInternalIfListed(userId);
  const own = allowedOrigins(req).map((o) => { try { return new URL(o).hostname; } catch { return ""; } }).filter(Boolean);
  const a = body.attribution && typeof body.attribution === "object" ? (body.attribution as Record<string, unknown>) : null;
  const ref = normalizeRefCode(body.ref);
  await recordFirstTouch(userId, "web", ref ? referralAttribution(typeof a?.utm_campaign === "string" ? a.utm_campaign : null) : webAttribution(a, own));
  if (body.ref != null) await attributeReferral(userId, body.ref, "web", { isNew: created });
}
