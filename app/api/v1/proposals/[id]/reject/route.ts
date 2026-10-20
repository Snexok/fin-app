import { assertSameOrigin, handleError, json } from "../../../../../../lib/api";
import { requireUserId } from "../../../../../../lib/session";
import { rejectProposal } from "../../../../../../lib/proposals";
import { enforce, LIMITS } from "../../../../../../lib/rate-limit";
import { apiRoute } from "../../../../../../lib/service-log";
export const dynamic = "force-dynamic";
async function postHandler(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const userId = await requireUserId();
    await enforce([LIMITS.writePerUser(userId)]);
    return json({ proposal: await rejectProposal(userId, (await ctx.params).id) });
  } catch (e) { return handleError(e); }
}
export const POST = apiRoute("proposal.reject", postHandler);
