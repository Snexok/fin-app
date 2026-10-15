import { cookies } from "next/headers";
import { assertSameOrigin, handleError, json } from "../../../../../../lib/api";
import { LINK_COOKIE, requireUserId } from "../../../../../../lib/session";
import { confirmLink } from "../../../../../../lib/auth";
export const dynamic = "force-dynamic";
// Шаг 3: подтверждение в исходном браузере (нужен cookie с секретом). Сессия остаётся прежней.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const id = (await ctx.params).id;
    const c = await cookies();
    const [cid, secret] = (c.get(LINK_COOKIE)?.value ?? "").split(".");
    const r = await confirmLink(await requireUserId(), id, cid === id ? secret : undefined);
    c.delete(LINK_COOKIE);
    return json(r);
  } catch (e) { return handleError(e); }
}
