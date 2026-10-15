import { cookies } from "next/headers";
import { assertSameOrigin, handleError, json } from "../../../../lib/api";
import { cookieBase, LINK_COOKIE, webUserId } from "../../../../lib/session";
import { LINK_TTL_MINUTES, startLink } from "../../../../lib/auth";
export const dynamic = "force-dynamic";
// Шаг 1 привязки: одноразовый код (10 минут). Секрет браузера — только в HttpOnly-cookie.
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const s = await startLink(await webUserId());
    (await cookies()).set(LINK_COOKIE, `${s.id}.${s.browserSecret}`, { ...cookieBase(), maxAge: LINK_TTL_MINUTES * 60 });
    return json({ id: s.id, code: s.code, command: `/link ${s.code}`, deepLink: s.deepLink, expiresAt: s.expiresAt.toISOString() }, 201);
  } catch (e) { return handleError(e); }
}
