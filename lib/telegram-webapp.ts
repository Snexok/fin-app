// Проверка initData Telegram Mini App (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
import { createHmac, timingSafeEqual } from "crypto";

export const INIT_DATA_MAX_AGE_SEC = 24 * 3600;

export interface VerifiedInitData { userId: number; authDate: number; /** startapp-параметр ссылки (источник трафика), если был. */ startParam: string | null }

export function verifyInitData(initData: string, botToken: string, now = new Date(), maxAgeSec = INIT_DATA_MAX_AGE_SEC): VerifiedInitData | null {
  if (typeof initData !== "string" || !initData || initData.length > 8192) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete("hash");
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return null;
  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate) || authDate <= 0) return null;
  const age = Math.floor(now.getTime() / 1000) - authDate;
  if (age > maxAgeSec || age < -300) return null;
  let user: { id?: unknown };
  try { user = JSON.parse(params.get("user") ?? "null") ?? {}; } catch { return null; }
  if (typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0) return null;
  const sp = params.get("start_param");
  return { userId: user.id, authDate, startParam: sp && /^[A-Za-z0-9_-]{1,64}$/.test(sp) ? sp : null };
}

/** Для тестов: подписать initData тем же алгоритмом. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const check = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}
