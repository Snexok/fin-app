// Веб-сессия: случайный токен в HttpOnly-cookie, в БД только sha256-хеш (lib/auth.ts).
// GET-запросы никогда не создают аккаунт: сессия создаётся явно (POST /api/v1/session или вход через Telegram Mini App).
import { cookies } from "next/headers";
import { SESSION_TTL_DAYS, touchSession, userIdForSessionToken, type IssuedSession } from "./auth";
import { ApiError } from "./util";

export const SESSION_COOKIE = "mozhno_sid";
export const LINK_COOKIE = "mozhno_link";

/**
 * В production cookie SameSite=None; Secure: Mini App открывается в iframe web.telegram.org, где Lax-cookie не отправляется.
 * CSRF закрыт строгой проверкой Origin (lib/api.ts assertSameOrigin) на всех изменяющих запросах.
 */
export const cookieBase = () => {
  const prod = process.env.NODE_ENV === "production";
  return { httpOnly: true, sameSite: prod ? ("none" as const) : ("lax" as const), secure: prod, path: "/" };
};

export async function setSessionCookie(s: Pick<IssuedSession, "token">) {
  (await cookies()).set(SESSION_COOKIE, s.token, { ...cookieBase(), maxAge: SESSION_TTL_DAYS * 86_400 });
}

/** Текущий пользователь или null (без создания). Сессия скользящая: продлевается при активности. */
export async function currentUserId(): Promise<string | null> {
  const c = await cookies();
  const token = c.get(SESSION_COOKIE)?.value;
  const id = await userIdForSessionToken(token);
  if (id && token && (await touchSession(token))) await setSessionCookie({ token });
  return id;
}

export async function requireUserId(): Promise<string> {
  const id = await currentUserId();
  if (!id) throw new ApiError("UNAUTHORIZED", 401, "Сессия не найдена. Обновите страницу.");
  return id;
}
