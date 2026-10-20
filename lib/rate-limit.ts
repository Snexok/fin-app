// Лимиты в Postgres (общие для всех инстансов): фиксированное окно, атомарный UPSERT.
import { getDb } from "./db";
import { ApiError } from "./util";

export async function hit(key: string, limit: number, windowSec: number, now = new Date()): Promise<boolean> {
  const db = await getDb();
  const start = new Date(Math.floor(now.getTime() / (windowSec * 1000)) * windowSec * 1000);
  const r = await db.query<{ count: number }>(
    "INSERT INTO rate_limits(key, window_start, count) VALUES ($1,$2,1) ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1 RETURNING count",
    [key.slice(0, 200), start]);
  if (Math.random() < 0.01) await db.query("DELETE FROM rate_limits WHERE window_start < $1", [new Date(now.getTime() - 86_400_000)]).catch(() => {});
  if (Math.random() < 0.002) void import("./retention").then((m) => m.runRetention(now)).catch(() => {});
  return Number(r.rows[0].count) <= limit;
}

export async function enforce(rules: { key: string; limit: number; windowSec: number }[], now = new Date()) {
  for (const r of rules) if (!(await hit(r.key, r.limit, r.windowSec, now))) throw new ApiError("RATE_LIMITED", 429, "Слишком много запросов подряд. Давайте сделаем паузу на минуту.");
}

/**
 * IP клиента только из доверенного источника (TRUST_PROXY):
 * - "vercel" (по умолчанию на Vercel): x-vercel-forwarded-for / x-real-ip, которые платформа перезаписывает;
 * - число N: N-й адрес с конца X-Forwarded-For (N доверенных прокси перед приложением);
 * - "none" (по умолчанию вне Vercel): заголовкам не доверяем, все запросы в одном ведре "direct".
 * Первое значение X-Forwarded-For клиент может подделать, поэтому оно не используется.
 */
export function clientIp(h: Headers, trust = process.env.TRUST_PROXY ?? (process.env.VERCEL ? "vercel" : "none")): string {
  let ip: string | undefined;
  if (trust === "vercel") ip = h.get("x-vercel-forwarded-for")?.split(",")[0] || h.get("x-real-ip") || undefined;
  else if (/^\d+$/.test(trust)) {
    const hops = (h.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    ip = hops[hops.length - Number(trust)];
  }
  return (ip || "direct").trim().slice(0, 64);
}

export const LIMITS = {
  chatPerUser: (u: string) => ({ key: `chat:u:${u}`, limit: 30, windowSec: 60 }),
  chatPerUserDay: (u: string) => ({ key: `chat:ud:${u}`, limit: 500, windowSec: 86_400 }),
  sttPerUser: (u: string) => ({ key: `stt:u:${u}`, limit: 10, windowSec: 60 }),
  sttPerIp: (ip: string) => ({ key: `stt:ip:${ip}`, limit: 60, windowSec: 3600 }),
  sessionPerIp: (ip: string) => ({ key: `session:ip:${ip}`, limit: 30, windowSec: 3600 }),
  simPerUser: (u: string) => ({ key: `sim:u:${u}`, limit: 30, windowSec: 60 }),
  simPerUserDay: (u: string) => ({ key: `sim:ud:${u}`, limit: 500, windowSec: 86_400 }),
  writePerUser: (u: string) => ({ key: `write:u:${u}`, limit: 60, windowSec: 60 }),
  writePerUserDay: (u: string) => ({ key: `write:ud:${u}`, limit: 1000, windowSec: 86_400 }),
  planPerUser: (u: string) => ({ key: `plan:u:${u}`, limit: 20, windowSec: 3600 }),
  linkPerUser: (u: string) => ({ key: `link:u:${u}`, limit: 10, windowSec: 3600 }),
  analyticsPerUser: (u: string) => ({ key: `an:u:${u}`, limit: 60, windowSec: 60 }),
  analyticsPerUserDay: (u: string) => ({ key: `an:ud:${u}`, limit: 2000, windowSec: 86_400 }),
  tgLoginPerIp: (ip: string) => ({ key: `tglogin:ip:${ip}`, limit: 60, windowSec: 3600 }),
  interestPerUser: (u: string) => ({ key: `plus:u:${u}`, limit: 20, windowSec: 3600 }),
};
