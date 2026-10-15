import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";

export const uuid = () => randomUUID();
export const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const big = (v: unknown): bigint => (v == null ? 0n : BigInt(String(v)));

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

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
