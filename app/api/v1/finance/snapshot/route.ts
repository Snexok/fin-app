import { errorJson, handleError, json } from "../../../../../lib/api";
import { webUserId } from "../../../../../lib/session";
import { getForecast } from "../../../../../lib/finance-service";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const v = await getForecast(await webUserId());
    if (!v) return errorJson("NO_PLAN", "Сначала нужен план: остаток, доход и платежи", 404);
    return json({ meta: v.meta, forecast: v.forecast, balanceMinor: v.book.balanceMinor });
  } catch (e) { return handleError(e); }
}
