import { handleError, json } from "../../../../../lib/api";
import { requireUserId } from "../../../../../lib/session";
import { referralMe } from "../../../../../lib/referrals";
import { apiRoute } from "../../../../../lib/service-log";
export const dynamic = "force-dynamic";
// Личная ссылка приглашения и счётчики «приглашено / начали пользоваться». Код создаётся при первом запросе.
async function getHandler() {
  try {
    const id = await requireUserId();
    return json(await referralMe(id));
  } catch (e) { return handleError(e); }
}
export const GET = apiRoute("referral.me", getHandler);
