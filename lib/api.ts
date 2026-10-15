// Общие помощники HTTP-слоя: no-store, bigint -> строки, единый формат ошибок, проверка Origin.
import { NextResponse } from "next/server";
import { ApiError, toJsonSafe, uuid } from "./util";
import { MoneyError } from "./engine/money";
import { DateError } from "./engine/dates";
import { DbUnavailableError } from "./db";

const NO_STORE = { "Cache-Control": "no-store" };

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(toJsonSafe(data), { status, headers: { ...NO_STORE, ...headers } });
}

export function errorJson(code: string, message: string, status: number, extra: Record<string, unknown> = {}) {
  return json({ error: { code, message, requestId: uuid(), ...extra } }, status);
}

export function handleError(e: unknown) {
  if (e instanceof ApiError) return errorJson(e.code, e.message, e.status, e.details ? { details: e.details } : {});
  if (e instanceof MoneyError || e instanceof DateError) return errorJson((e as MoneyError).code, e.message, 422);
  if (e instanceof RangeError) return errorJson("INVALID_INPUT", e.message, 422);
  if (e instanceof DbUnavailableError) return errorJson("DB_UNAVAILABLE", "Хранилище временно недоступно. Попробуйте чуть позже.", 503);
  console.error("api error", (e as Error)?.name, (e as Error)?.message);
  return errorJson("INTERNAL", "Что-то пошло не так. Попробуйте ещё раз.", 500);
}

/** CSRF: для изменяющих запросов Origin (если браузер его прислал) должен совпадать с хостом. */
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  if (site && !["same-origin", "none"].includes(site)) throw new ApiError("FORBIDDEN_ORIGIN", 403, "Запрос с другого сайта отклонён");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  let oh: string;
  try { oh = new URL(origin).host; } catch { throw new ApiError("FORBIDDEN_ORIGIN", 403, "Некорректный Origin"); }
  if (!host || oh !== host) throw new ApiError("FORBIDDEN_ORIGIN", 403, "Запрос с другого сайта отклонён");
}

export async function readJson(req: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > maxBytes) throw new ApiError("PAYLOAD_TOO_LARGE", 413, "Слишком большой запрос");
  try { const v = JSON.parse(text || "{}"); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch { /* ниже */ }
  throw new ApiError("BAD_JSON", 400, "Нужен JSON-объект");
}
