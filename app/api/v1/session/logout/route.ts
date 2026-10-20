import { cookies } from "next/headers";
import { assertSameOrigin, handleError, json } from "../../../../../lib/api";
import { cookieBase, LINK_COOKIE, SESSION_COOKIE } from "../../../../../lib/session";
import { revokeSession } from "../../../../../lib/auth";
import { apiRoute } from "../../../../../lib/service-log";
export const dynamic = "force-dynamic";
// Выход: сессия отзывается в БД, cookie удаляются.
async function postHandler(req: Request) {
  try {
    assertSameOrigin(req);
    const c = await cookies();
    const token = c.get(SESSION_COOKIE)?.value;
    if (token) await revokeSession(token);
    c.set(SESSION_COOKIE, "", { ...cookieBase(), maxAge: 0 });
    c.set(LINK_COOKIE, "", { ...cookieBase(), maxAge: 0 });
    return json({ ok: true });
  } catch (e) { return handleError(e); }
}
export const POST = apiRoute("session.logout", postHandler);
