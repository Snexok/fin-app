import { handleError, json } from "../../../../lib/api";
import { requireUserId } from "../../../../lib/session";
import { getPlan } from "../../../../lib/plans";
import { apiRoute } from "../../../../lib/service-log";
export const dynamic = "force-dynamic";
// Тариф и AI-ответы: план (beta_plus | free | plus), сколько осталось, когда обновятся, будущие цены, режим беты.
// Этап 1: денег не берём — цены показываются как «после беты», без автопродления.
async function getHandler() {
  try {
    const id = await requireUserId();
    return json(await getPlan(id));
  } catch (e) { return handleError(e); }
}
export const GET = apiRoute("plan.status", getHandler);
