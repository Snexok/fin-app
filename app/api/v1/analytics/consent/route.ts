import { assertSameOrigin, handleError, json, readJson } from "../../../../../lib/api";
import { requireUserId } from "../../../../../lib/session";
import { enforce, LIMITS } from "../../../../../lib/rate-limit";
import { getAnalyticsConsent, setAnalyticsConsent } from "../../../../../lib/analytics";
import { ApiError } from "../../../../../lib/util";
import { apiRoute } from "../../../../../lib/service-log";
export const dynamic = "force-dynamic";

async function getHandler() {
  try { return json({ enabled: await getAnalyticsConsent(await requireUserId()) }); } catch (e) { return handleError(e); }
}

/** Отказ/согласие на анонимную статистику. Отказ удаляет накопленные события и меняет псевдоним. */
async function putHandler(req: Request) {
  try {
    assertSameOrigin(req);
    const userId = await requireUserId();
    await enforce([LIMITS.writePerUser(userId)]);
    const body = await readJson(req, 1024);
    if (typeof body.enabled !== "boolean") throw new ApiError("INVALID_INPUT", 400, "Нужно enabled: true/false");
    return json({ enabled: await setAnalyticsConsent(userId, body.enabled) });
  } catch (e) { return handleError(e); }
}
export const GET = apiRoute("analytics.consent", getHandler);
export const PUT = apiRoute("analytics.consent", putHandler);
