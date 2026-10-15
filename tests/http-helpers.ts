// Route-level тесты: обработчики Next вызываются напрямую с настоящим Request.
// next/headers подменяется простым cookie-jar (см. vi.mock в тестовых файлах).
export type CookieOpts = { httpOnly?: boolean; sameSite?: string; secure?: boolean; path?: string; maxAge?: number };
export const jar = new Map<string, { value: string; opts?: CookieOpts }>();
export let currentHeaders = new Headers();

export const nextHeadersMock = {
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)!.value } : undefined),
    set: (n: string, value: string, opts?: CookieOpts) => { if (opts?.maxAge === 0) jar.delete(n); else jar.set(n, { value, opts }); lastSet.set(n, { value, opts }); },
    delete: (n: string) => { jar.delete(n); },
  }),
  headers: async () => currentHeaders,
};
export const lastSet = new Map<string, { value: string; opts?: CookieOpts }>();

export const ORIGIN = "http://app.test";

export function req(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; origin?: string | null; raw?: BodyInit } = {}) {
  const h: Record<string, string> = { host: "app.test", ...(init.headers ?? {}) };
  if (init.origin !== null && (init.method ?? "GET") !== "GET") h.origin = init.origin ?? ORIGIN;
  const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  if (body !== undefined && !h["content-type"]) h["content-type"] = "application/json";
  const r = new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers: h, body, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);
  currentHeaders = r.headers;
  return r;
}

export async function call(handler: (r: Request, ctx?: never) => Promise<Response>, r: Request, params?: Record<string, string>) {
  currentHeaders = r.headers;
  const res = await handler(r, (params ? { params: Promise.resolve(params) } : undefined) as never);
  const text = await res.text();
  let body: any = null;  
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

/** Новый анонимный пользователь через POST /api/v1/session (cookie попадает в jar). */
export async function newSession() {
  jar.clear();
  const { POST } = await import("../app/api/v1/session/route");
  const r = await call(POST, req("/api/v1/session", { method: "POST" }));
  if (r.status !== 201) throw new Error("session " + r.status);
}
