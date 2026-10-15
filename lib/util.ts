import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";

export const uuid = () => randomUUID();
export const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const big = (v: unknown): bigint => (v == null ? 0n : BigInt(String(v)));

/** Сравнение секретов за постоянное время (по sha256, чтобы не раскрывать длину). */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest(), y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Строгая проверка UUID на границе: в SQL не уходит произвольный ввод (и не попадает в логи ошибок PG). */
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** JSON с bigint -> десятичная строка (все суммы в API передаются строками копеек). */
export function toJsonSafe<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

/** Канонический JSON (отсортированные ключи) для хешей запросов и предложений. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, function (_k, x) {
    if (typeof x === "bigint") return x.toString();
    if (x && typeof x === "object" && !Array.isArray(x)) return Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]));
    return x;
  });
}

export class ApiError extends Error {
  constructor(public code: string, public status: number, message: string, public details?: unknown) { super(message); }
}
