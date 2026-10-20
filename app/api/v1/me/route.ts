import { handleError, json } from "../../../../lib/api";
import { requireUserId } from "../../../../lib/session";
import { identitiesOf } from "../../../../lib/auth";
import { getDb } from "../../../../lib/db";
import { userTimezone } from "../../../../lib/finance-service";
import { apiRoute } from "../../../../lib/service-log";
export const dynamic = "force-dynamic";
async function getHandler() {
  try {
    const id = await requireUserId();
    const ids = await identitiesOf(id);
    return json({ id, timezone: await userTimezone(await getDb(), id), channels: { telegram: ids.some((i) => i.provider === "telegram"), web: true } });
  } catch (e) { return handleError(e); }
}
export const GET = apiRoute("me", getHandler);
