import { assertSameOrigin, errorJson, handleError, json, readJson } from "../../../../../lib/api";
import { requireUserId } from "../../../../../lib/session";
import { identitiesOf } from "../../../../../lib/auth";
import { enforce, LIMITS } from "../../../../../lib/rate-limit";
import { upsertInterest } from "../../../../../lib/plans";
import { InterestError } from "../../../../../lib/plans/interest";
import { apiRoute } from "../../../../../lib/service-log";
export const dynamic = "force-dynamic";
// «Хочу Плюс» без оплаты: { price: 299 | 399 | 499 | null }. Ничего не списывается, карта не нужна; повтор обновляет выбор.
async function postHandler(req: Request) {
  try {
    assertSameOrigin(req);
    const id = await requireUserId();
    await enforce([LIMITS.interestPerUser(id)]);
    const body = await readJson(req, 2 * 1024);
    const price = body.price == null || body.price === "" ? null : Number(body.price);
    if (price != null && !Number.isInteger(price)) return errorJson("INVALID_INPUT", "Выберите один из вариантов цены", 400);
    // «miniapp» — только у пользователя с привязанным Telegram (как в /api/v1/analytics).
    const channel = body.channel === "miniapp" && (await identitiesOf(id)).some((i) => i.provider === "telegram") ? "miniapp" : "web";
    try { return json({ ok: true, interest: await upsertInterest(id, { price, channel }), charged: false }); }
    catch (e) { if (e instanceof InterestError) return errorJson("INVALID_INPUT", e.message, 400); throw e; }
  } catch (e) { return handleError(e); }
}
export const POST = apiRoute("plus.interest", postHandler);
