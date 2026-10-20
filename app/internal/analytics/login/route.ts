import { NextResponse } from "next/server";
import { assertSameOrigin } from "../../../../lib/api";
import { ADMIN_COOKIE, adminCookieOptions, adminSecret, checkAdminSecret, issueAdminToken } from "../../../../lib/admin";
import { clientIp, hit } from "../../../../lib/rate-limit";
export const dynamic = "force-dynamic";

const back = (req: Request, q = "") => NextResponse.redirect(new URL(`/internal/analytics${q}`, req.url), 303);

/** Вход в дашборд: секрет из формы (POST) → подписанная cookie. 10 попыток за 15 минут с одного IP. */
export async function POST(req: Request) {
  if (!adminSecret()) return new NextResponse("Not found", { status: 404 });
  try { assertSameOrigin(req); } catch { return new NextResponse("Forbidden", { status: 403 }); }
  if (!(await hit(`admin:ip:${clientIp(req.headers)}`, 10, 900))) return back(req, "?e=limit");
  const form = await req.formData().catch(() => null);
  if (!checkAdminSecret(form?.get("secret"))) return back(req, "?e=1");
  const res = back(req);
  res.cookies.set(ADMIN_COOKIE, issueAdminToken()!, adminCookieOptions());
  res.headers.set("Cache-Control", "no-store");
  return res;
}
