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
  return Number(r.rows[0].count) <= limit;
}

export async function enforce(rules: { key: string; limit: number; windowSec: number }[], now = new Date()) {
  for (const r of rules) if (!(await hit(r.key, r.limit, r.windowSec, now))) throw new ApiError("RATE_LIMITED", 429, "Слишком много запросов подряд. Давайте сделаем паузу на минуту.");
}

export function clientIp(h: Headers): string {
  return (h.get("x-forwarded-for")?.split(",")[0] || h.get("x-real-ip") || "local").trim().slice(0, 64);
}

export const LIMITS = {
  chatPerUser: (u: string) => ({ key: `chat:u:${u}`, limit: 30, windowSec: 60 }),
  chatPerUserDay: (u: string) => ({ key: `chat:ud:${u}`, limit: 500, windowSec: 86_400 }),
  sttPerUser: (u: string) => ({ key: `stt:u:${u}`, limit: 10, windowSec: 60 }),
  sttPerIp: (ip: string) => ({ key: `stt:ip:${ip}`, limit: 60, windowSec: 3600 }),
  sessionPerIp: (ip: string) => ({ key: `session:ip:${ip}`, limit: 30, windowSec: 3600 }),
};
