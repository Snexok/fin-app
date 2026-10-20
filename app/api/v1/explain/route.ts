import { assertSameOrigin, errorJson, handleError, json, readJson } from "../../../../lib/api";
import { requireUserId } from "../../../../lib/session";
import { enforce, LIMITS } from "../../../../lib/rate-limit";
import { explainDecision } from "../../../../lib/explain";
import { isUuid } from "../../../../lib/util";
import { apiRoute } from "../../../../lib/service-log";
export const dynamic = "force-dynamic";
// «Почему так?» к ответу «Можно?»: { decisionId }. AI-ответ (тратит 1 из квоты) или шаблон с теми же числами движка.
async function postHandler(req: Request) {
  try {
    assertSameOrigin(req);
    const id = await requireUserId();
    const { decisionId } = await readJson(req, 2 * 1024);
    if (!isUuid(decisionId)) return errorJson("INVALID_INPUT", "Нужен decisionId", 400);
    await enforce([LIMITS.chatPerUser(id), LIMITS.chatPerUserDay(id)]);
    const r = await explainDecision(id, decisionId, { channel: "web" });
    if (!r) return errorJson("NOT_FOUND", "Этот расчёт недоступен. Спросите «Можно?» ещё раз.", 404);
    return json(r);
  } catch (e) { return handleError(e); }
}
export const POST = apiRoute("chat.explain", postHandler);
