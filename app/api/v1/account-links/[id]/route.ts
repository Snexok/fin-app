import { handleError, json } from "../../../../../lib/api";
import { requireUserId } from "../../../../../lib/session";
import { linkStatus } from "../../../../../lib/auth";
export const dynamic = "force-dynamic";
// Опрос статуса: pending -> approved (код отправлен боту) -> consumed.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try { return json(await linkStatus(await requireUserId(), (await ctx.params).id)); } catch (e) { return handleError(e); }
}
