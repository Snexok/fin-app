import { handleError, json } from "../../../../lib/api";
import { webUserId } from "../../../../lib/session";
import { recentEntries } from "../../../../lib/finance-service";
export const dynamic = "force-dynamic";
export async function GET() {
  try { return json({ entries: await recentEntries(await webUserId(), 50) }); } catch (e) { return handleError(e); }
}
