import { headers } from "next/headers";
import { assertSameOrigin, handleError, json } from "../../../../lib/api";
import { currentUserId, setSessionCookie } from "../../../../lib/session";
import { createAnonymousSession } from "../../../../lib/auth";
import { clientIp, enforce, LIMITS } from "../../../../lib/rate-limit";
export const dynamic = "force-dynamic";
// Явное создание анонимной веб-сессии (GET-запросы аккаунтов не создают). Идемпотентно для живой сессии.
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const existing = await currentUserId();
    if (existing) return json({ created: false });
    await enforce([LIMITS.sessionPerIp(clientIp(await headers()))]);
    const s = await createAnonymousSession();
    await setSessionCookie(s);
    return json({ created: true }, 201);
  } catch (e) { return handleError(e); }
}
