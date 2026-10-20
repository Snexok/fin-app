// Доступ к внутреннему дашборду аналитики. Секрет ANALYTICS_ADMIN_SECRET вводится один раз в форму (POST, не в URL)
// и обменивается на подписанную HttpOnly-cookie (SameSite=Strict, path=/internal, 12 часов). Без секрета — 404.
import { createHmac } from "node:crypto";
import { safeEqual } from "./util";

export const ADMIN_COOKIE = "mozhno_admin";
export const ADMIN_TTL_SEC = 12 * 3600;

export function adminSecret(): string | null {
  const s = process.env.ANALYTICS_ADMIN_SECRET;
  return s && s.length >= 16 ? s : null;
}
const sign = (secret: string, exp: number) => createHmac("sha256", secret).update(`admin:v1:${exp}`).digest("base64url");

export function issueAdminToken(now = Date.now()): string | null {
  const secret = adminSecret();
  if (!secret) return null;
  const exp = Math.floor(now / 1000) + ADMIN_TTL_SEC;
  return `${exp}.${sign(secret, exp)}`;
}

export function verifyAdminToken(token: string | undefined | null, now = Date.now()): boolean {
  const secret = adminSecret();
  if (!secret || !token) return false;
  const [e, sig] = token.split(".");
  const exp = Number(e);
  if (!Number.isInteger(exp) || exp * 1000 <= now || !sig) return false;
  return safeEqual(sig, sign(secret, exp));
}

export function checkAdminSecret(given: unknown): boolean {
  const secret = adminSecret();
  return !!secret && typeof given === "string" && given.length <= 256 && safeEqual(given, secret);
}

export const adminCookieOptions = () => ({ httpOnly: true, sameSite: "strict" as const, secure: process.env.NODE_ENV === "production", path: "/internal", maxAge: ADMIN_TTL_SEC });
