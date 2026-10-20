import { assertSameOrigin, errorJson, handleError, json, readJson } from "../../../../../lib/api";
import { requireUserId } from "../../../../../lib/session";
import { enforce, LIMITS } from "../../../../../lib/rate-limit";
import { INVITE_METHODS, INVITE_SURFACES, track } from "../../../../../lib/analytics";
import { identitiesOf } from "../../../../../lib/auth";
import { apiRoute } from "../../../../../lib/service-log";
export const dynamic = "force-dynamic";
// Факт «поделился приглашением» (копирование, системное меню, Telegram, картинка). Только перечисления: ни ссылки, ни текста.
async function postHandler(req: Request) {
  try {
    assertSameOrigin(req);
    const userId = await requireUserId();
    await enforce([LIMITS.analyticsPerUser(userId)]);
    const body = await readJson(req, 1024);
    const method = (INVITE_METHODS as readonly string[]).includes(body.method as string) ? (body.method as (typeof INVITE_METHODS)[number]) : null;
    const surface = (INVITE_SURFACES as readonly string[]).includes(body.surface as string) ? (body.surface as (typeof INVITE_SURFACES)[number]) : null;
    if (!method || !surface || method === "bot" || surface === "bot") return errorJson("INVALID_INPUT", "Неизвестный способ", 400);
    const channel = body.channel === "miniapp" && (await identitiesOf(userId)).some((i) => i.provider === "telegram") ? "miniapp" : "web";
    await track(userId, "invite_shared", { method, surface }, { channel, source: "client" });
    return json({ ok: true }, 202);
  } catch (e) { return handleError(e); }
}
export const POST = apiRoute("referral.share", postHandler);
