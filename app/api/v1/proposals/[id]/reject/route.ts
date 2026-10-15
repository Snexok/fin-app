import { assertSameOrigin, handleError, json } from "../../../../../../lib/api";
import { requireUserId } from "../../../../../../lib/session";
import { rejectProposal } from "../../../../../../lib/proposals";
export const dynamic = "force-dynamic";
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try { assertSameOrigin(req); return json({ proposal: await rejectProposal(await requireUserId(), (await ctx.params).id) }); } catch (e) { return handleError(e); }
}
