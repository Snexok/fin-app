import { errorJson, handleError, json } from "../../../../../lib/api";
import { requireUserId } from "../../../../../lib/session";
import { getForecast } from "../../../../../lib/finance-service";
import { apiRoute } from "../../../../../lib/service-log";
export const dynamic = "force-dynamic";
async function getHandler() {
  try {
    const v = await getForecast(await requireUserId());
    if (!v) return errorJson("NO_PLAN", "Сначала нужен план: остаток, доход и платежи", 404);
    return json({ meta: v.meta, forecast: v.forecast, balanceMinor: v.book.balanceMinor });
  } catch (e) { return handleError(e); }
}
export const GET = apiRoute("plan.view", getHandler);
