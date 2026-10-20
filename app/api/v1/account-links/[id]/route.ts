import { handleError, json } from "../../../../../lib/api";
import { requireUserId } from "../../../../../lib/session";
import { linkStatus } from "../../../../../lib/auth";
import { apiRoute } from "../../../../../lib/service-log";
export const dynamic = "force-dynamic";
// Опрос статуса: pending -> approved (код отправлен боту) -> consumed.
async function getHandler(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try { return json(await linkStatus(await requireUserId(), (await ctx.params).id)); } catch (e) { return handleError(e); }
}
export const GET = apiRoute("account.link", getHandler);
