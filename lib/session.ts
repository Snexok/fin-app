// Веб-сессия: случайный токен в HttpOnly-cookie, в БД только sha256-хеш (lib/auth.ts).
import { cookies, headers } from "next/headers";
import { clientIp, enforce, LIMITS } from "./rate-limit";
import { createAnonymousSession, SESSION_TTL_DAYS, userIdForSessionToken } from "./auth";
import { ApiError } from "./util";

export const SESSION_COOKIE = "mozhno_sid";
export const LINK_COOKIE = "mozhno_link";

export const cookieBase = () => ({ httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/" });

/** Текущий пользователь или null (без создания). */
export async function currentUserId(): Promise<string | null> {
  const c = await cookies();
  return userIdForSessionToken(c.get(SESSION_COOKIE)?.value);
}

export async function requireUserId(): Promise<string> {
  const id = await currentUserId();
  if (!id) throw new ApiError("UNAUTHORIZED", 401, "Сессия не найдена. Обновите страницу.");
  return id;
}

/** Совместимость: пользователь веба; при отсутствии сессии создаётся анонимный аккаунт. */
export async function webUserId(): Promise<string> {
  const existing = await currentUserId();
  if (existing) return existing;
  const c = await cookies();
  await enforce([LIMITS.sessionPerIp(clientIp(await headers()))]);
  const s = await createAnonymousSession();
  c.set(SESSION_COOKIE, s.token, { ...cookieBase(), maxAge: SESSION_TTL_DAYS * 86_400 });
  return s.userId;
}
