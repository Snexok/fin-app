import { handleError, json } from "../../../../lib/api";
import { requireUserId } from "../../../../lib/session";
import { recentEntries } from "../../../../lib/finance-service";
import { apiRoute } from "../../../../lib/service-log";
export const dynamic = "force-dynamic";
async function getHandler() {
  try { return json({ entries: await recentEntries(await requireUserId(), 50) }); } catch (e) { return handleError(e); }
}
export const GET = apiRoute("plan.view", getHandler);
