import { cookies } from "next/headers";
import { assertSameOrigin, handleError, json } from "../../../../../../lib/api";
import { cookieBase, LINK_COOKIE, requireUserId, SESSION_COOKIE, setSessionCookie } from "../../../../../../lib/session";
import { confirmLink, rotateSession } from "../../../../../../lib/auth";
export const dynamic = "force-dynamic";
// Шаг 3: подтверждение в исходном браузере (нужен cookie с секретом). После привязки сессия ротируется.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const id = (await ctx.params).id;
    const c = await cookies();
    const [cid, secret] = (c.get(LINK_COOKIE)?.value ?? "").split(".");
    const r = await confirmLink(await requireUserId(), id, cid === id ? secret : undefined);
    c.set(LINK_COOKIE, "", { ...cookieBase(), maxAge: 0 });
    const rotated = await rotateSession(c.get(SESSION_COOKIE)?.value);
    if (rotated) await setSessionCookie(rotated);
    return json(r);
  } catch (e) { return handleError(e); }
}
