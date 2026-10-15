import { handleError, json } from "../../../../../lib/api";
import { requireUserId } from "../../../../../lib/session";
import { getProposal } from "../../../../../lib/proposals";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try { return json({ proposal: await getProposal(await requireUserId(), (await ctx.params).id) }); } catch (e) { return handleError(e); }
}
