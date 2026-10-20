import { handleError, json } from "../../../../../lib/api";
import { requireUserId } from "../../../../../lib/session";
import { getProposal } from "../../../../../lib/proposals";
import { apiRoute } from "../../../../../lib/service-log";
export const dynamic = "force-dynamic";
async function getHandler(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try { return json({ proposal: await getProposal(await requireUserId(), (await ctx.params).id) }); } catch (e) { return handleError(e); }
}
export const GET = apiRoute("proposal.read", getHandler);
