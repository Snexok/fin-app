import { assertSameOrigin, handleError, json, readJson } from "../../../../../../lib/api";
import { requireUserId } from "../../../../../../lib/session";
import { confirmProposal } from "../../../../../../lib/proposals";
import { getForecast } from "../../../../../../lib/finance-service";
import { forecastToSnapshot } from "../../../../../../lib/engine";
export const dynamic = "force-dynamic";
// Тело: { revision }. Заголовок Idempotency-Key — один на намерение, повторяется при retry.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const userId = await requireUserId();
    const body = await readJson(req);
    const out = await confirmProposal(userId, (await ctx.params).id, { revision: Number(body.revision), idempotencyKey: req.headers.get("idempotency-key") });
    const v = await getForecast(userId);
    return json({ ...out.body, replayed: out.replayed, forecast: v?.forecast ?? null, meta: v?.meta ?? null, snapshot: v ? forecastToSnapshot(v.forecast) : null }, out.status);
  } catch (e) { return handleError(e); }
}
