// Общие помощники HTTP-слоя: no-store, bigint -> строки, единый формат ошибок, проверка Origin, лимиты тела.
import { NextResponse } from "next/server";
import { ApiError, toJsonSafe, uuid } from "./util";
import { MoneyError } from "./engine/money";
import { DateError } from "./engine/dates";
import { DbUnavailableError } from "./db";

const NO_STORE = { "Cache-Control": "no-store" };

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(toJsonSafe(data), { status, headers: { ...NO_STORE, ...headers } });
}

/** Единый формат ошибки: { error: { code, message, requestId, ...extra } }. */
export function errorJson(code: string, message: string, status: number, extra: Record<string, unknown> = {}) {
  return json({ error: { code, message, requestId: uuid(), ...extra } }, status);
}

export function handleError(e: unknown) {
  if (e instanceof ApiError) return errorJson(e.code, e.message, e.status, e.details ? { details: e.details } : {});
  if (e instanceof MoneyError || e instanceof DateError) return errorJson((e as MoneyError).code, e.message, 422);
  if (e instanceof RangeError) return errorJson("INVALID_INPUT", "Некорректные данные запроса", 422);
  if (e instanceof DbUnavailableError) return errorJson("DB_UNAVAILABLE", "Хранилище временно недоступно. Попробуйте чуть позже.", 503);
  const requestId = uuid();
  // В лог — только тип, код и requestId: сообщения ошибок (например, PG) могут содержать ввод пользователя.
  console.error("api error", { requestId, name: (e as Error)?.name, code: (e as { code?: string })?.code });
  return json({ error: { code: "INTERNAL", message: "Что-то пошло не так. Попробуйте ещё раз.", requestId } }, 500);
}

/** Разрешённые Origin: APP_ORIGIN (через запятую) или схема+Host самого запроса. X-Forwarded-Host не используется. */
export function allowedOrigins(req: Request): string[] {
  const env = (process.env.APP_ORIGIN ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  if (env.length) return env;
  const host = req.headers.get("host") ?? new URL(req.url).host; // Next строит req.url из Host
  if (!host) return [];
  const proto = process.env.NODE_ENV === "production" ? "https" : new URL(req.url).protocol.replace(":", "");
  return [`${proto}://${host}`];
}

/** CSRF: изменяющий запрос обязан прийти с разрешённого Origin. Без Origin — отказ. */
export function assertSameOrigin(req: Request) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") throw new ApiError("FORBIDDEN_ORIGIN", 403, "Запрос с другого сайта отклонён");
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") throw new ApiError("FORBIDDEN_ORIGIN", 403, "Запрос без Origin отклонён");
  if (!allowedOrigins(req).includes(origin.replace(/\/$/, ""))) throw new ApiError("FORBIDDEN_ORIGIN", 403, "Запрос с другого сайта отклонён");
}

const tooLarge = () => new ApiError("PAYLOAD_TOO_LARGE", 413, "Слишком большой запрос");

/** Читает тело потоком с лимитом в БАЙТАХ: 413 до полной буферизации (и при ложном Content-Length). */
export async function readBody(req: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const len = req.headers.get("content-length");
  if (len != null && (!/^\d+$/.test(len) || Number(len) > maxBytes)) throw tooLarge();
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => {}); throw tooLarge(); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

export async function readJson(req: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const bytes = await readBody(req, maxBytes);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new ApiError("BAD_JSON", 400, "Нужен JSON-объект"); }
  try { const v = JSON.parse(text || "{}"); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch { /* ниже */ }
  throw new ApiError("BAD_JSON", 400, "Нужен JSON-объект");
}
