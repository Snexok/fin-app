import { NextResponse } from "next/server";
import { assertSameOrigin } from "../../../../lib/api";
import { ADMIN_COOKIE, adminCookieOptions } from "../../../../lib/admin";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try { assertSameOrigin(req); } catch { return new NextResponse("Forbidden", { status: 403 }); }
  const res = NextResponse.redirect(new URL("/internal/analytics", req.url), 303);
  res.cookies.set(ADMIN_COOKIE, "", { ...adminCookieOptions(), maxAge: 0 });
  return res;
}
