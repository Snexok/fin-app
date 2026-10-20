// v23: журнал обращений и ошибок, источник трафика, флаг команды/тестов, агрегаты дашборда (миграция 007).
import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("next/headers", async () => (await import("./http-helpers")).nextHeadersMock);
import { getDb } from "../lib/db";
import { pseudonym, setAnalyticsConsent, track } from "../lib/analytics";
import { apiRoute, CALL_TYPES, channelOfRequest, forgetLogMeta, logServiceError, normalizeCode, recordCall, redact, safeMessage, setCallType, setCallUser, timed, withCall } from "../lib/service-log";
import { errorJson, handleError, json } from "../lib/api";
import { ApiError } from "../lib/util";
import { cleanTag, recordFirstTouch, referrerHost, startPayloadAttribution, webAttribution } from "../lib/traffic-source";
import { checkInviteCode, markInternalIfListed, setInternal, syncInternalFromEnv } from "../lib/internal-users";
import { dashboard } from "../lib/analytics-metrics";
import { opsSummary } from "../lib/service-metrics";
import { botCallType, createBot } from "../lib/bot";
import { runReminders, type Sender } from "../lib/reminders";
import { signInitData, verifyInitData } from "../lib/telegram-webapp";
import { telegramUserId } from "../lib/auth";
import { POST as chatPOST } from "../app/api/chat/route";
import { POST as sessionPOST } from "../app/api/v1/session/route";
import { POST as tgLoginPOST } from "../app/api/v1/session/telegram/route";
import { NOW, tgUser, webUser } from "./helpers";
import { call, jar, lastSet, newSession, req } from "./http-helpers";

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await (await getDb()).query<T>(sql, p)).rows;
const callsOf = (subject: string) => q<{ call_type: string; result: string; code: string | null; http_status: number | null; latency_ms: number | null; channel: string; internal: boolean }>("SELECT * FROM service_calls WHERE subject=$1 ORDER BY id", [subject]);
const errorsOf = (subject: string) => q<{ route: string; code: string; http_status: number | null; message: string | null; channel: string }>("SELECT * FROM service_errors WHERE subject=$1 ORDER BY id", [subject]);
afterEach(() => { vi.unstubAllEnvs(); forgetLogMeta(); });

describe("service-log: codes and messages carry no PII", () => {
  it("normalizes codes to stable strings", () => {
    expect(normalizeCode("RATE_LIMITED")).toBe("RATE_LIMITED");
    expect(normalizeCode("TypeError")).toBe("TYPE_ERROR");
    expect(normalizeCode("23505")).toBe("23505");
    expect(normalizeCode(403)).toBe("E403");
    expect(normalizeCode("купить айфон")).toBe("UNKNOWN");
    expect(normalizeCode(undefined)).toBe("UNKNOWN");
  });
  it("redacts numbers, e-mails, urls and tokens; foreign exception text is never stored", () => {
    const m = redact("user ivan@mail.ru paid 15 000 rub, token=abc123 https://x.y/z?q=1 bot 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(m).not.toMatch(/ivan|15 000|abc123|x\.y|AAAA/);
    expect(redact("x".repeat(500)).length).toBeLessThanOrEqual(200);
    // Текст исключения PG может содержать ввод пользователя: берём только имя и код.
    const pg = Object.assign(new Error('duplicate key value "наушники 15000"'), { code: "23505" });
    expect(safeMessage(pg)).toBe("Error · code 23505");
    expect(safeMessage(new ApiError("RATE_LIMITED", 429, "Слишком много запросов"))).toBe("Слишком много запросов");
  });
  it("call types are a closed list of dotted lowercase names", () => {
    for (const t of CALL_TYPES) expect(t).toMatch(/^[a-z]+(\.[a-z]+)?$/);
  });
});

describe("service-log: recordCall / logServiceError", () => {
  it("writes the analytics pseudonym, never the user id; opt-out writes NULL and unlinks earlier rows", async () => {
    const s = await webUser();
    const subj = pseudonym(s.userId, 0);
    expect(await recordCall({ type: "chat.question", channel: "web", userId: s.userId, result: "ok", latencyMs: 812.4, httpStatus: 200 })).toBe(true);
    expect(await logServiceError({ channel: "web", route: "/api/chat", userId: s.userId, code: "INTERNAL", httpStatus: 500, error: new TypeError("secret 4111 1111 1111 1111") })).toBe(true);
    expect(await callsOf(subj)).toMatchObject([{ call_type: "chat.question", result: "ok", latency_ms: 812, http_status: 200, channel: "web", internal: false }]);
    const [e] = await errorsOf(subj);
    expect(e).toMatchObject({ route: "/api/chat", code: "INTERNAL", http_status: 500, message: "TypeError" });
    const all = JSON.stringify(await q("SELECT * FROM service_calls UNION ALL SELECT id, occurred_at, subject, channel, route, 'x', code, http_status, 0, internal, demo FROM service_errors"));
    expect(all).not.toContain(s.userId);

    await setAnalyticsConsent(s.userId, false);
    expect(await callsOf(subj)).toHaveLength(0); // строки остались, но без псевдонима
    expect((await q("SELECT count(*)::int n FROM service_calls WHERE subject IS NULL AND call_type='chat.question'"))[0]).toMatchObject({ n: 1 });
    await recordCall({ type: "chat.question", channel: "web", userId: s.userId, result: "ok" });
    expect((await q("SELECT subject FROM service_calls ORDER BY id DESC LIMIT 1"))[0]).toEqual({ subject: null });
  });
  it("never throws: bad input or failing insert returns false", async () => {
    expect(await recordCall({ type: "no.such" as never, channel: "web", result: "ok" })).toBe(false);
    expect(await recordCall({ type: "stt", channel: "fax" as never, result: "ok" })).toBe(false);
    expect(await recordCall({ type: "stt", channel: "web", result: "ok", latencyMs: Number.NaN, userId: "not-a-uuid" })).toBe(false);
    await expect(logServiceError({ channel: "web", userId: "not-a-uuid", code: "X" })).resolves.toBe(false);
    vi.stubEnv("SERVICE_LOGS_ENABLED", "0");
    expect(await recordCall({ type: "stt", channel: "web", result: "ok" })).toBe(false);
  });
  it("the same exception is logged once even if caught again higher up", async () => {
    const e = new Error("boom");
    expect(await logServiceError({ channel: "cron", route: "a", error: e })).toBe(true);
    expect(await logServiceError({ channel: "cron", route: "b", error: e })).toBe(false);
  });
});

describe("service-log: apiRoute / withCall", () => {
  it("records type, status, code and latency; 4xx/5xx go to service_errors; expected 401 does not", async () => {
    const s = await webUser();
    const subj = pseudonym(s.userId, 0);
    const ok = apiRoute("plan.view", async () => { setCallUser(s.userId); return json({ ok: true }); });
    const limited = apiRoute("chat.message", async () => { setCallUser(s.userId); return handleError(new ApiError("RATE_LIMITED", 429, "Слишком много запросов")); });
    const crash = apiRoute("sim.purchase", async () => { setCallUser(s.userId); return handleError(Object.assign(new Error("relation users: Иван"), { code: "42P01" })); });
    const refine = apiRoute("chat.message", async () => { setCallUser(s.userId); setCallType("chat.question"); return json({}); });
    const thrower = apiRoute("stt", async () => { setCallUser(s.userId); throw new RangeError("x"); });
    for (const h of [ok, limited, crash, refine]) await h(req("/api/x"));
    await expect(thrower(req("/api/stt"))).rejects.toThrow(RangeError);
    const c = await callsOf(subj);
    expect(c.map((x) => [x.call_type, x.result, x.code, x.http_status])).toEqual([
      ["plan.view", "ok", null, 200], ["chat.message", "error", "RATE_LIMITED", 429], ["sim.purchase", "error", "INTERNAL", 500], ["chat.question", "ok", null, 200], ["stt", "error", "RANGE_ERROR", null]]);
    expect(c.every((x) => x.latency_ms != null && x.latency_ms >= 0)).toBe(true);
    const e = await errorsOf(subj);
    expect(e.map((x) => [x.route, x.code, x.http_status, x.message])).toEqual([
      ["/api/x", "RATE_LIMITED", 429, "Слишком много запросов"], ["/api/x", "INTERNAL", 500, "Error · code 42P01"], ["/api/stt", "RANGE_ERROR", null, "RangeError"]]);

    await newSession();
    const r = await call(chatPOST, req("/api/chat", { method: "POST", body: {} }));
    expect(r.status).toBe(400);
    jar.clear();
    const before = (await q<{ n: number }>("SELECT count(*)::int n FROM service_errors"))[0].n;
    expect((await call(chatPOST, req("/api/chat", { method: "POST", body: { message: "привет" } }))).status).toBe(401);
    expect((await q<{ n: number }>("SELECT count(*)::int n FROM service_errors"))[0].n).toBe(before);
    expect((await q("SELECT code FROM service_calls ORDER BY id DESC LIMIT 1"))[0]).toEqual({ code: "UNAUTHORIZED" });
  });
  it("chat question through the real route is logged as chat.question; nested LLM call is timed", async () => {
    const s = await webUser();
    jar.clear(); jar.set("mozhno_sid", { value: s.token });
    const r = await call(chatPOST, req("/api/chat", { method: "POST", body: { message: "Можно купить наушники за 15 000?" } }));
    expect(r.status).toBe(200);
    expect((await callsOf(pseudonym(s.userId, 0))).map((x) => x.call_type)).toContain("chat.question");
    await withCall({ type: "chat.message", channel: "telegram", userId: s.userId }, async () => { await timed("llm.intent", async () => 1); await expect(timed("llm.intent", async () => { throw Object.assign(new Error(), { code: "LLM_TIMEOUT" }); })).rejects.toThrow(); });
    const llm = (await callsOf(pseudonym(s.userId, 0))).filter((x) => x.call_type === "llm.intent");
    expect(llm.map((x) => [x.result, x.code, x.channel])).toEqual([["ok", null, "telegram"], ["error", "LLM_TIMEOUT", "telegram"]]);
  });
  it("errorJson tags the response code without changing the body; mini app cookie labels the channel", async () => {
    const res = errorJson("X_CODE", "msg", 409);
    expect((await res.json()).error.code).toBe("X_CODE");
    expect(channelOfRequest(req("/", { headers: { cookie: "a=1; mozhno_ch=miniapp" } }))).toBe("miniapp");
    expect(channelOfRequest(req("/", { headers: { cookie: "mozhno_ch=miniappx" } }))).toBe("web");
    expect(channelOfRequest(req("/"))).toBe("web");
  });
});

describe("service-log: bot and reminders", () => {
  it("classifies bot updates; handlers refine the type", () => {
    expect(botCallType({ message: { text: "/start src_vk" } } as never)).toBe("bot.start");
    expect(botCallType({ message: { text: "/status" } } as never)).toBe("bot.command");
    expect(botCallType({ message: { text: "кофе 300" } } as never)).toBe("bot.message");
    expect(botCallType({ message: { voice: {} } } as never)).toBe("bot.voice");
    expect(botCallType({ callbackQuery: { data: "pc:x:1" } } as never)).toBe("proposal.confirm");
    expect(botCallType({ callbackQuery: { data: "rm:paid:x" } } as never)).toBe("reminder.click");
    expect(botCallType({ callbackQuery: { data: "o:0123abcd:1" } } as never)).toBe("onboarding.turn");
  });
  it("bot /start with a src_ payload stores the first touch and logs the call", async () => {
    const bot = createBot("123456:TEST", { botInfo: { id: 123456, is_bot: true, first_name: "M", username: "mozhno_test_bot" } as never });
    bot.api.config.use(async (_p, method, payload) => ({ ok: true, result: method === "sendMessage" ? { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: (payload as { text: string }).text } : true }) as never);
    const id = 9_100_001;
    const up = (n: number, text: string) => bot.handleUpdate({ update_id: n, message: { message_id: n, date: 0, chat: { id, type: "private", first_name: "U" }, from: { id, is_bot: false, first_name: "U" }, text, entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] : undefined } } as never);
    await up(1, "/start src_sber500__demo_day__disrupt_2026");
    await up(2, "/start src_other");
    const userId = (await telegramUserId(id, false))!;
    expect(await q("SELECT channel, source, medium, campaign FROM user_sources WHERE user_id=$1", [userId])).toEqual([{ channel: "telegram", source: "sber500", medium: "demo_day", campaign: "disrupt_2026" }]);
    expect((await callsOf(pseudonym(userId, 0))).map((x) => [x.call_type, x.channel, x.result])).toEqual([["bot.start", "telegram", "ok"], ["bot.start", "telegram", "ok"]]);
  });
  it("reminder send failures are logged with Telegram codes, successes as reminder.send ok", async () => {
    const u = await tgUser();
    const AT = new Date("2026-10-19T08:00:00Z");
    const blocked: Sender = { send: async (chatId) => { if (chatId === String(u.tgId)) throw Object.assign(new Error("Forbidden: bot was blocked"), { error_code: 403 }); } };
    await runReminders(blocked, AT);
    const subj = pseudonym(u.userId, 0);
    expect((await callsOf(subj)).map((x) => [x.call_type, x.result, x.code, x.channel])).toEqual([["reminder.send", "error", "TG_403", "cron"]]);
    expect((await errorsOf(subj)).map((x) => [x.route, x.code, x.http_status])).toEqual([["reminder.send", "TG_403", 403]]);
    expect((await errorsOf(subj))[0].message).not.toMatch(/blocked/);
  });
});

describe("traffic source", () => {
  it("normalizes tags and keeps only the referrer domain", () => {
    expect(cleanTag("  Sber500 Demo/Day!  ")).toBe("sber500_demoday");
    expect(cleanTag("")).toBeNull();
    expect(referrerHost("https://www.google.com/search?q=долги+15000")).toBe("google.com");
    expect(referrerHost("https://mozhno-mvp.vercel.app/x", ["mozhno-mvp.vercel.app"])).toBeNull();
    expect(referrerHost("javascript:alert(1)")).toBeNull();
    expect(webAttribution({ utm_source: "VK", utm_medium: "post", utm_campaign: "Oct" })).toEqual({ source: "vk", medium: "post", campaign: "oct", referrerHost: null });
    expect(webAttribution({ referrer: "https://t.me/s/channel" })).toEqual({ source: "telegram", medium: "referral", campaign: null, referrerHost: "t.me" });
    expect(webAttribution({})).toMatchObject({ source: "direct" });
    expect(startPayloadAttribution("link_abc")).toBeNull();
    expect(startPayloadAttribution("")).toMatchObject({ source: "direct" });
    expect(startPayloadAttribution("vc")).toMatchObject({ source: "vc", medium: null });
    expect(startPayloadAttribution("src_tg__post__oct")).toEqual({ source: "tg", medium: "post", campaign: "oct", referrerHost: null });
    expect(startPayloadAttribution("bad payload!")).toMatchObject({ source: "other" });
  });
  it("first touch is written once; opt-out users are skipped", async () => {
    const s = await webUser();
    expect(await recordFirstTouch(s.userId, "web", { source: "vk", medium: null, campaign: null, referrerHost: null })).toBe(true);
    expect(await recordFirstTouch(s.userId, "telegram", { source: "tg", medium: null, campaign: null, referrerHost: null })).toBe(false);
    expect(await q("SELECT source, channel FROM user_sources WHERE user_id=$1", [s.userId])).toEqual([{ source: "vk", channel: "web" }]);
    const o = await webUser();
    await setAnalyticsConsent(o.userId, false);
    expect(await recordFirstTouch(o.userId, "web", { source: "vk", medium: null, campaign: null, referrerHost: null })).toBe(false);
    await setAnalyticsConsent(s.userId, false);
    expect(await q("SELECT 1 FROM user_sources WHERE user_id=$1", [s.userId])).toHaveLength(0);
  });
  it("POST /api/v1/session stores UTM + referrer domain; ?team=<code> marks the user internal", async () => {
    vi.stubEnv("INTERNAL_INVITE_CODE", "team-code-1234567");
    jar.clear();
    const r = await call(sessionPOST, req("/api/v1/session", { method: "POST", body: { attribution: { utm_source: "sber500", utm_medium: "demo", referrer: "https://www.vk.com/feed?w=1" } } }));
    expect(r.status).toBe(201);
    const mine = (await q<{ user_id: string }>("SELECT s.user_id FROM user_sources s JOIN sessions x ON x.user_id = s.user_id WHERE s.source='sber500'"))[0];
    expect(mine).toBeTruthy();
    expect(await q("SELECT source, medium, referrer_host, channel FROM user_sources WHERE user_id=$1", [mine.user_id])).toEqual([{ source: "sber500", medium: "demo", referrer_host: "vk.com", channel: "web" }]);
    expect(checkInviteCode("nope")).toBe(false);
    expect((await call(sessionPOST, req("/api/v1/session", { method: "POST", body: { team: "team-code-1234567" } }))).body).toEqual({ created: false });
    expect(await q("SELECT is_internal FROM users WHERE id=$1", [mine.user_id])).toEqual([{ is_internal: true }]);
  });
  it("Mini App start_param becomes the miniapp first touch and the channel cookie is set", async () => {
    const token = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    vi.stubEnv("TELEGRAM_BOT_TOKEN", token);
    const now = Math.floor(Date.now() / 1000);
    const initData = signInitData({ auth_date: String(now), start_param: "src_tg_ads__cpc", user: JSON.stringify({ id: 7_800_001, first_name: "A" }) }, token);
    expect(verifyInitData(initData, token)?.startParam).toBe("src_tg_ads__cpc");
    jar.clear();
    expect((await call(tgLoginPOST, req("/api/v1/session/telegram", { method: "POST", body: { initData } }))).status).toBe(200);
    const userId = (await telegramUserId(7_800_001, false))!;
    expect(await q("SELECT channel, source, medium FROM user_sources WHERE user_id=$1", [userId])).toEqual([{ channel: "miniapp", source: "tg_ads", medium: "cpc" }]);
    expect(lastSet.get("mozhno_ch")?.value).toBe("miniapp");
    // Сам вход ещё без cookie — помечен как web; следующие запросы Mini App придут с mozhno_ch=miniapp.
    expect((await q<{ channel: string }>("SELECT channel FROM service_calls WHERE call_type='session.telegram' ORDER BY id DESC LIMIT 1"))[0].channel).toBe("web");
  });
});

describe("team / test accounts", () => {
  it("setInternal backfills events and logs; dashboard and ops summary exclude them unless asked", async () => {
    const db = await getDb();
    await db.query("DELETE FROM analytics_events"); await db.query("DELETE FROM service_calls"); await db.query("DELETE FROM service_errors");
    const day = new Date(NOW.getTime() - 2 * 86_400_000);
    const real = await webUser(), team = await webUser();
    for (const u of [real, team]) {
      await track(u.userId, "user_active", {}, { channel: "web", key: "d", now: day });
      await withCall({ type: "chat.question", channel: "web", userId: u.userId }, async () => {});
    }
    // service_calls пишутся с текущим временем: сдвигаем в тот же день, что и события.
    await db.query("UPDATE service_calls SET occurred_at=$1", [day]);
    await logServiceError({ channel: "web", route: "/api/chat", userId: team.userId, code: "INTERNAL", httpStatus: 500 });
    await db.query("UPDATE service_errors SET occurred_at=$1", [day]);
    expect(await setInternal(team.userId)).toBe(true);
    expect(await setInternal(team.userId)).toBe(false);
    expect(await q("SELECT internal FROM analytics_events WHERE subject=$1", [pseudonym(team.userId, 0)])).toEqual([{ internal: true }]);
    expect((await dashboard(NOW, 7)).cur.active).toBe(1);
    expect((await dashboard(NOW, 7, null, undefined, { includeInternal: true })).cur.active).toBe(2);
    await track(team.userId, "user_active", {}, { channel: "telegram", key: "d2", now: day });
    expect((await q<{ internal: boolean }>("SELECT internal FROM analytics_events WHERE channel='telegram'"))[0].internal).toBe(true);
    const from = new Date(NOW.getTime() - 7 * 86_400_000), to = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()));
    const o = await opsSummary(from, to);
    expect(o.calls).toMatchObject({ total: 1, core: 1, errors: 0, dauDays: 1, corePerDau: 1 });
    expect(o.errors.total).toBe(0);
    expect(o.users.real).toBe(1);
    const all = await opsSummary(from, to, null, undefined, { includeInternal: true });
    expect(all.calls.total).toBe(2);
    expect(all.errors.codes).toMatchObject([{ code: "INTERNAL", n: 1, status: 500 }]);
    expect(all.users.real).toBe(2);
  });
  it("env allowlists mark users by Telegram ID or user id", async () => {
    const a = await tgUser(), b = await webUser();
    vi.stubEnv("INTERNAL_TELEGRAM_IDS", `1, ${a.tgId}`);
    vi.stubEnv("INTERNAL_USER_IDS", b.userId);
    expect(await markInternalIfListed(a.userId, 999)).toBe(false);
    expect(await markInternalIfListed(a.userId, a.tgId)).toBe(true);
    expect(await syncInternalFromEnv()).toBeGreaterThanOrEqual(1);
    expect(await q("SELECT is_internal FROM users WHERE id = ANY($1::uuid[]) ORDER BY is_internal", [[a.userId, b.userId]])).toEqual([{ is_internal: true }, { is_internal: true }]);
  });
});
