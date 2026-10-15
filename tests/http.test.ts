// HTTP-границы: Origin, сессии и cookie, лимиты тела, формат ошибок, идемпотентность, лимиты частоты, initData.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { call, jar, lastSet, newSession, nextHeadersMock, req, ORIGIN } from "./http-helpers";
vi.mock("next/headers", () => nextHeadersMock);

import { POST as chatPOST } from "../app/api/chat/route";
import { GET as profileGET, POST as profilePOST } from "../app/api/profile/route";
import { GET as meGET } from "../app/api/v1/me/route";
import { GET as healthGET } from "../app/api/health/route";
import { POST as simPOST } from "../app/api/v1/finance/simulations/route";
import { POST as confirmPOST } from "../app/api/v1/proposals/[id]/confirm/route";
import { POST as proposalsPOST } from "../app/api/v1/proposals/route";
import { POST as logoutPOST } from "../app/api/v1/session/logout/route";
import { POST as tgLoginPOST } from "../app/api/v1/session/telegram/route";
import { POST as sttPOST } from "../app/api/stt/route";
import { cookieBase, SESSION_COOKIE } from "../lib/session";
import { getDb } from "../lib/db";
import { signInitData } from "../lib/telegram-webapp";
import { telegramUserId } from "../lib/auth";

const profileBody = (extra: Record<string, unknown> = {}) => ({ balance: 60000, reserve: 10000, nextIncome: { amount: 80000, date: "2026-11-25" }, payments: [{ name: "Аренда", amount: 30000, date: "2026-11-20" }], goal: null, ...extra });
const usersCount = async () => Number((await (await getDb()).query<{ n: string }>("SELECT count(*)::text AS n FROM users")).rows[0].n);

beforeEach(() => { jar.clear(); });

describe("Origin / CSRF (Medium #10)", () => {
  it("rejects mutating requests without Origin or from another site", async () => {
    await newSession();
    for (const origin of [null, "https://evil.example", "null"]) {
      const r = await call(chatPOST, req("/api/chat", { method: "POST", body: { message: "привет" }, origin }));
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("FORBIDDEN_ORIGIN");
    }
    const xs = await call(chatPOST, req("/api/chat", { method: "POST", body: { message: "привет" }, headers: { "sec-fetch-site": "cross-site" } }));
    expect(xs.status).toBe(403);
  });
  it("does not trust X-Forwarded-Host", async () => {
    await newSession();
    const r = await call(chatPOST, req("/api/chat", { method: "POST", body: { message: "привет" }, origin: "https://evil.example", headers: { "x-forwarded-host": "evil.example" } }));
    expect(r.status).toBe(403);
  });
});

describe("sessions and cookies (Medium #9, #12, #13)", () => {
  it("GET without a session is 401 and creates no user", async () => {
    const before = await usersCount();
    for (const h of [profileGET, meGET]) expect((await call(h as never, req("/api/profile"))).status).toBe(401);
    expect(await usersCount()).toBe(before);
  });
  it("session cookie: HttpOnly; in production SameSite=None; Secure", async () => {
    await newSession();
    expect(lastSet.get(SESSION_COOKIE)!.opts).toMatchObject({ httpOnly: true, path: "/" });
    vi.stubEnv("NODE_ENV", "production");
    expect(cookieBase()).toMatchObject({ sameSite: "none", secure: true, httpOnly: true });
    vi.unstubAllEnvs();
    expect(cookieBase().sameSite).toBe("lax");
  });
  it("logout revokes the session", async () => {
    await newSession();
    const token = jar.get(SESSION_COOKIE)!.value;
    expect((await call(profileGET as never, req("/api/profile"))).status).toBe(200);
    expect((await call(logoutPOST, req("/api/v1/session/logout", { method: "POST" }))).status).toBe(200);
    jar.set(SESSION_COOKIE, { value: token });
    expect((await call(profileGET as never, req("/api/profile"))).status).toBe(401);
  });
  it("Mini App: valid initData logs into the Telegram account; forged or stale is rejected", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const token = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const now = Math.floor(Date.now() / 1000);
    const good = signInitData({ auth_date: String(now), user: JSON.stringify({ id: 7700001, first_name: "A" }) }, token);
    const forged = good.replace("7700001", "7700002");
    const stale = signInitData({ auth_date: String(now - 3 * 86400), user: JSON.stringify({ id: 7700001 }) }, token);
    for (const initData of [forged, stale, "", "hash=00"]) {
      const r = await call(tgLoginPOST, req("/api/v1/session/telegram", { method: "POST", body: { initData } }));
      expect(r.status).toBe(401);
    }
    const ok = await call(tgLoginPOST, req("/api/v1/session/telegram", { method: "POST", body: { initData: good } }));
    expect(ok.status).toBe(200);
    const me = await call(meGET as never, req("/api/v1/me"));
    expect(me.body.id).toBe(await telegramUserId(7700001, false));
    expect(me.body.channels.telegram).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("body limits (High #5)", () => {
  it("413 for a streamed body over the byte limit without Content-Length", async () => {
    await newSession();
    const big = "я".repeat(40 * 1024); // 40k символов = 80 КБ в UTF-8 (> 64 КБ), но < 64k символов
    const stream = new ReadableStream({ start(c) { const b = new TextEncoder().encode(JSON.stringify({ message: big })); for (let i = 0; i < b.length; i += 8192) c.enqueue(b.slice(i, i + 8192)); c.close(); } });
    const r = await call(profilePOST, req("/api/profile", { method: "POST", raw: stream }));
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
  it("413 on a lying or oversized Content-Length before reading", async () => {
    await newSession();
    const r = await call(chatPOST, req("/api/chat", { method: "POST", body: { message: "x" }, headers: { "content-length": String(10 * 1024 * 1024) } }));
    expect(r.status).toBe(413);
  });
  it("STT: oversized upload is 413, non-audio bytes are 415", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test");
    await newSession();
    const fd = new FormData(); fd.append("audio", new Blob([new Uint8Array(64).fill(65)], { type: "audio/webm" }), "x.webm");
    const r = await call(sttPOST, new Request(`${ORIGIN}/api/stt`, { method: "POST", headers: { origin: ORIGIN }, body: fd }));
    expect(r.status).toBe(415);
    const big = new Request(`${ORIGIN}/api/stt`, { method: "POST", headers: { origin: ORIGIN, "content-length": String(20 * 1024 * 1024) }, body: "x" });
    expect((await call(sttPOST, big)).status).toBe(413);
    vi.unstubAllEnvs();
  });
});

describe("error format, health, idempotency (Medium #30, #27, #29)", () => {
  it("errors share one shape with requestId", async () => {
    await newSession();
    const r = await call(chatPOST, req("/api/chat", { method: "POST", body: { message: "" } }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: "INVALID_INPUT" });
    expect(r.body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const bad = await call(profilePOST, req("/api/profile", { method: "POST", body: profileBody({ balance: "abc" }) }));
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBeTruthy();
  });
  it("health exposes only ok", async () => {
    const r = await call(healthGET as never, req("/api/health"));
    expect(r.body).toEqual({ ok: true });
  });
  it("confirm requires Idempotency-Key", async () => {
    await newSession();
    await call(profilePOST, req("/api/profile", { method: "POST", body: profileBody() }));
    const p = await call(proposalsPOST, req("/api/v1/proposals", { method: "POST", body: { type: "create_entry", entry: { direction: "expense", amountMinor: "50000" } } }));
    expect(p.status).toBe(201);
    const id = p.body.proposal.id;
    const no = await call(confirmPOST as never, req(`/api/v1/proposals/${id}/confirm`, { method: "POST", body: { revision: 1 } }), { id });
    expect(no.status).toBe(400);
    expect(no.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const ok = await call(confirmPOST as never, req(`/api/v1/proposals/${id}/confirm`, { method: "POST", body: { revision: 1 }, headers: { "idempotency-key": "key-0001-abcd" } }), { id });
    expect(ok.status).toBe(200);
    const again = await call(confirmPOST as never, req(`/api/v1/proposals/${id}/confirm`, { method: "POST", body: { revision: 1 }, headers: { "idempotency-key": "key-0001-abcd" } }), { id });
    expect(again.body.replayed).toBe(true);
    const bogus = await call(confirmPOST as never, req(`/api/v1/proposals/not-a-uuid/confirm`, { method: "POST", body: { revision: 1 }, headers: { "idempotency-key": "key-0002-abcd" } }), { id: "not-a-uuid" });
    expect(bogus.status).toBe(404);
  });
});

describe("stale plan form (High #3) over HTTP", () => {
  it("409 when baseFinanceVersion is missing or stale; spend recorded meanwhile survives", async () => {
    await newSession();
    expect((await call(profilePOST, req("/api/profile", { method: "POST", body: profileBody() }))).status).toBe(200);
    const v1 = (await call(profileGET as never, req("/api/profile"))).body.meta.financeVersion as string;
    // Пока форма открыта, записывается трата (как из Telegram).
    const p = await call(proposalsPOST, req("/api/v1/proposals", { method: "POST", body: { type: "create_entry", entry: { direction: "expense", amountMinor: "100000" } } }));
    await call(confirmPOST as never, req(`/api/v1/proposals/${p.body.proposal.id}/confirm`, { method: "POST", body: { revision: 1 }, headers: { "idempotency-key": "stale-form-1" } }), { id: p.body.proposal.id });
    const missing = await call(profilePOST, req("/api/profile", { method: "POST", body: profileBody() }));
    expect(missing.status).toBe(409);
    const stale = await call(profilePOST, req("/api/profile", { method: "POST", body: profileBody({ baseFinanceVersion: v1 }) }));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("FINANCE_VERSION_CONFLICT");
    expect(stale.body.error.details.balanceMinor).toBe("5900000");
    const now = (await call(profileGET as never, req("/api/profile"))).body;
    expect(now.profile.balance).toBe(59000);
    const fresh = await call(profilePOST, req("/api/profile", { method: "POST", body: profileBody({ balance: 59000, baseFinanceVersion: now.meta.financeVersion }) }));
    expect(fresh.status).toBe(200);
  });
});

describe("simulation DoS (High #2) over HTTP", () => {
  it("far dates are rejected and the endpoint is rate limited", async () => {
    await newSession();
    await call(profilePOST, req("/api/profile", { method: "POST", body: profileBody() }));
    const far = await call(simPOST, req("/api/v1/finance/simulations", { method: "POST", body: { purchase: { priceMinor: "100000", date: "2200-01-01" } } }));
    expect(far.status).toBe(422);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await call(simPOST, req("/api/v1/finance/simulations", { method: "POST", body: { purchase: { priceMinor: "100000" } } }))).status;
    expect(last).toBe(429);
  });
});
