// v24: реферальная программа — коды и ссылки, правила атрибуции, активация, награды за флагом, дашборд (миграция 008).
import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("next/headers", async () => (await import("./http-helpers")).nextHeadersMock);
import { getDb } from "../lib/db";
import { createAnonymousSession, telegramUserId } from "../lib/auth";
import { pseudonym, validateEvent } from "../lib/analytics";
import { startPayloadAttribution } from "../lib/traffic-source";
import { setInternal } from "../lib/internal-users";
import { answer } from "../lib/coach";
import { savePlan } from "../lib/finance-service";
import {
  activateReferral, attributeReferral, considerReward, generateRefCode, getOrCreateRefCode, inviteLinks, isRefCode, mergeReferrals,
  normalizeRefCode, parseRefPayload, REF_ALPHABET, referralConfig, referralMe, referralSummary,
} from "../lib/referrals";
import { createBot, inviteText, shareResultText } from "../lib/bot";
import { signInitData } from "../lib/telegram-webapp";
import { POST as sessionPOST } from "../app/api/v1/session/route";
import { POST as tgLoginPOST } from "../app/api/v1/session/telegram/route";
import { GET as meGET } from "../app/api/v1/referrals/me/route";
import { POST as sharePOST } from "../app/api/v1/referrals/share/route";
import { PLAN, webUser } from "./helpers";
import { call, jar, req } from "./http-helpers";

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await (await getDb()).query<T>(sql, p)).rows;
const fresh = async () => (await createAnonymousSession()).userId; // новый веб-аккаунт без плана
const refOf = async (id: string) => (await q<{ status: string; channel: string; activated_at: Date | null; reward_status: string | null; risk_reasons: string[]; referrer_user_id: string; id: string }>("SELECT * FROM referrals WHERE referee_user_id=$1", [id]))[0];
const events = async (userId: string, name: string) => q<{ props: Record<string, string>; channel: string }>("SELECT props, channel FROM analytics_events WHERE subject=$1 AND name=$2", [pseudonym(userId, 0), name]);
afterEach(() => { vi.unstubAllEnvs(); });

describe("referral codes and links", () => {
  it("codes are random, fixed-length, from an unambiguous alphabet and unbiased", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) { const c = generateRefCode(); expect(c).toMatch(/^[2-9a-hjkmnp-z]{8}$/); expect(isRefCode(c)).toBe(true); seen.add(c); }
    expect(seen.size).toBe(200);
    expect(REF_ALPHABET).not.toMatch(/[01ilo]/);
    // байты ≥ 248 (256 − 256 % 31) отбрасываются, остальные — по модулю алфавита
    expect(generateRefCode(() => Buffer.from([255, 0, 1, 30, 31, 249, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 6)).toBe("23z245");
  });
  it("parses ref_ payloads within Telegram's charset and 64-char limit; other payloads are not referrals", () => {
    expect(parseRefPayload("ref_ab3cd5ef")).toEqual({ code: "ab3cd5ef", campaign: null });
    expect(parseRefPayload("REF_AB3CD5EF")).toEqual({ code: "ab3cd5ef", campaign: null });
    expect(parseRefPayload("ref_ab3cd5ef__spring_tg")).toEqual({ code: "ab3cd5ef", campaign: "spring_tg" });
    expect(parseRefPayload("ref-ab3cd5ef")?.code).toBe("ab3cd5ef");
    for (const bad of ["", "src_vk", "link_abcdefgh", "ref_ab", "ref_ab3cd5ef!", "ref_" + "a".repeat(17), "ref_ab3cd5ef__" + "x".repeat(60), "ref_ab3cd5ef extra"]) expect(parseRefPayload(bad)).toBeNull();
    expect(normalizeRefCode(" AB3CD5EF ")).toBe("ab3cd5ef");
    expect(normalizeRefCode("ab3cd5ef'; drop")).toBeNull();
  });
  it("a ref link also sets the first-touch source to referral; src_ links are unchanged", () => {
    expect(startPayloadAttribution("ref_ab3cd5ef")).toEqual({ source: "referral", medium: "invite", campaign: null, referrerHost: null });
    expect(startPayloadAttribution("ref_ab3cd5ef__vk_post")).toMatchObject({ source: "referral", medium: "invite", campaign: "vk_post" });
    expect(startPayloadAttribution("src_vk__post__oct")).toMatchObject({ source: "vk", medium: "post", campaign: "oct" });
  });
  it("link formats: bot ?start=ref_, Mini App ?startapp=ref_ (when configured), web ?ref=, Telegram share", () => {
    const l = inviteLinks("ab3cd5ef");
    expect(l.bot).toBe("https://t.me/mozhno_test_bot?start=ref_ab3cd5ef");
    expect(l.miniapp).toBeNull();
    expect(l.web).toBe("https://mozhno-mvp.vercel.app/?ref=ab3cd5ef");
    expect(l.telegramShare).toMatch(/^https:\/\/t\.me\/share\/url\?url=https%3A%2F%2Ft\.me%2Fmozhno_test_bot%3Fstart%3Dref_ab3cd5ef&text=/);
    vi.stubEnv("TELEGRAM_MINIAPP_SHORT_NAME", "app");
    vi.stubEnv("APP_ORIGIN", "https://example.test");
    expect(inviteLinks("ab3cd5ef")).toMatchObject({ miniapp: "https://t.me/mozhno_test_bot/app?startapp=ref_ab3cd5ef", web: "https://example.test/?ref=ab3cd5ef" });
    expect(`ref_${generateRefCode()}__${"c".repeat(40)}`.length).toBeLessThanOrEqual(64);
  });
  it("the personal code is created once and stays stable", async () => {
    const u = await fresh();
    const c = await getOrCreateRefCode(u);
    expect(await getOrCreateRefCode(u)).toBe(c);
    expect(await q("SELECT ref_code FROM users WHERE id=$1", [u])).toEqual([{ ref_code: c }]);
  });
  it("referral events are in the analytics allowlist and accept only enums", () => {
    expect(validateEvent("invite_shared", { method: "copy", surface: "answer" }).ok).toBe(true);
    expect(validateEvent("invite_shared", { method: "https://t.me/x", surface: "answer" }).ok).toBe(false);
    expect(validateEvent("invite_opened", { result: "self" }).ok).toBe(true);
    expect(validateEvent("referral_attributed", { via: "bot", held: "false" }).ok).toBe(true);
    expect(validateEvent("referral_activated", { code: "ab3cd5ef" }).ok).toBe(false);
  });
});

describe("attribution rules", () => {
  it("new user: attributed once, first touch wins; event without the code", async () => {
    const a = await fresh(), b = await fresh(), x = await fresh();
    const ca = await getOrCreateRefCode(a), cb = await getOrCreateRefCode(b);
    expect(await attributeReferral(x, ca, "web", { isNew: true })).toBe("attributed");
    expect(await attributeReferral(x, cb, "web", { isNew: true })).toBe("already");
    expect(await attributeReferral(x, ca, "web", { isNew: true })).toBe("already");
    expect(await refOf(x)).toMatchObject({ referrer_user_id: a, status: "attributed", channel: "web", activated_at: null });
    expect(await events(x, "referral_attributed")).toEqual([{ props: { via: "web", held: "false" }, channel: "web" }]);
    expect(JSON.stringify(await q("SELECT props FROM analytics_events WHERE subject=$1", [pseudonym(x, 0)]))).not.toContain(ca);
  });
  it("self-referral, unknown code, internal users and existing accounts are not attributed", async () => {
    const a = await fresh(); const ca = await getOrCreateRefCode(a);
    expect(await attributeReferral(a, ca, "web", { isNew: true })).toBe("self");
    expect(await attributeReferral(await fresh(), "zzzzzzzz", "web", { isNew: true })).toBe("invalid");
    expect(await attributeReferral(await fresh(), "../etc", "web", { isNew: true })).toBe("invalid");
    expect(await attributeReferral(await fresh(), ca, "web", { isNew: false })).toBe("existing"); // аккаунт был до перехода
    const withPlan = await webUser(PLAN);
    expect(await attributeReferral(withPlan.userId, ca, "web", { isNew: true })).toBe("existing"); // уже есть план
    const old = await fresh();
    await q("UPDATE users SET created_at = now() - interval '2 hours' WHERE id=$1", [old]);
    expect(await attributeReferral(old, ca, "web", { isNew: true })).toBe("existing");
    const team = await fresh(); await setInternal(team, true);
    expect(await attributeReferral(team, ca, "web", { isNew: true })).toBe("internal");
    const ti = await fresh(); await setInternal(ti, true); const ct = await getOrCreateRefCode(ti);
    expect(await attributeReferral(await fresh(), ct, "web", { isNew: true })).toBe("internal");
    expect(await q("SELECT count(*)::int n FROM referrals WHERE referrer_user_id = ANY($1::uuid[])", [[a, ti]])).toEqual([{ n: 0 }]);
  });
  it("velocity: over REFERRAL_DAILY_LIMIT attributions per code per day are held for review", async () => {
    vi.stubEnv("REFERRAL_DAILY_LIMIT", "3");
    const a = await fresh(); const ca = await getOrCreateRefCode(a);
    const out = [];
    for (let i = 0; i < 5; i++) out.push(await attributeReferral(await fresh(), ca, "bot", { isNew: true }));
    expect(out).toEqual(["attributed", "attributed", "attributed", "held", "held"]);
    expect(await q("SELECT status, risk_reasons FROM referrals WHERE referrer_user_id=$1 AND status='held'", [a])).toEqual([{ status: "held", risk_reasons: ["velocity"] }, { status: "held", risk_reasons: ["velocity"] }]);
  });
  it("account merge after /link: a self-invite between the two accounts disappears, invites move to the survivor", async () => {
    const a = await fresh(), b = await fresh(), friend = await fresh();
    const ca = await getOrCreateRefCode(a);
    expect(await attributeReferral(b, ca, "web", { isNew: true })).toBe("attributed");
    expect(await attributeReferral(friend, ca, "web", { isNew: true })).toBe("attributed");
    const db = await getDb();
    await db.tx(async (t) => { await mergeReferrals(t, a, b); await t.query("DELETE FROM users WHERE id=$1", [a]); });
    expect(await refOf(b)).toBeUndefined();
    expect((await refOf(friend)).referrer_user_id).toBe(b);
    expect(await q("SELECT ref_code FROM users WHERE id=$1", [b])).toEqual([{ ref_code: ca }]); // старая ссылка продолжает работать
  });
});

describe("activation and rewards", () => {
  it("first «Можно?» answer activates the referral once; rewards are off by default", async () => {
    expect(referralConfig().rewardsEnabled).toBe(false);
    const a = await fresh(); const x = await fresh();
    await attributeReferral(x, await getOrCreateRefCode(a), "web", { isNew: true });
    await savePlan(x, PLAN, "form");
    const r = await answer(x, "Можно купить наушники за 3000?", { channel: "web" });
    expect(r.impact).toBeTruthy();
    const ref = await refOf(x);
    expect(ref.status).toBe("activated");
    expect(ref.activated_at).toBeTruthy();
    expect(ref.reward_status).toBe("disabled");
    expect(await activateReferral(x, "web")).toBe(false); // повторно — ничего
    expect(await q("SELECT count(*)::int n FROM referral_rewards WHERE user_id=$1", [a])).toEqual([{ n: 0 }]);
    expect(await events(x, "referral_activated")).toHaveLength(1);
    expect((await referralMe(a)).active).toBe(1);
  });
  it("REFERRAL_REWARDS_ENABLED=1: +7 days pending for the referrer only after activation, max 4 per month, idempotent", async () => {
    vi.stubEnv("REFERRAL_REWARDS_ENABLED", "1");
    vi.stubEnv("REFERRAL_DAILY_LIMIT", "50");
    const a = await fresh(); const ca = await getOrCreateRefCode(a);
    const now = new Date("2026-10-18T10:00:00Z");
    const friends: string[] = [];
    for (let i = 0; i < 5; i++) { const f = await fresh(); friends.push(f); expect(await attributeReferral(f, ca, "miniapp", { isNew: true })).toBe("attributed"); }
    // без активации награды нет
    expect(await q("SELECT count(*)::int n FROM referral_rewards WHERE user_id=$1", [a])).toEqual([{ n: 0 }]);
    for (const f of friends) expect(await activateReferral(f, "miniapp", now)).toBe(true);
    const rw = await q<{ amount: number; period: string; status: string; eligible_at: Date }>("SELECT amount, period, status, eligible_at FROM referral_rewards WHERE user_id=$1 ORDER BY id", [a]);
    expect(rw).toHaveLength(4);
    expect(rw[0]).toMatchObject({ amount: 7, period: "2026-10", status: "pending" });
    expect(new Date(rw[0].eligible_at).getTime() - now.getTime()).toBe(48 * 3_600_000);
    expect((await refOf(friends[4])).reward_status).toBe("limit");
    expect(await considerReward((await refOf(friends[0])).id, now)).toBe("exists");
    expect(await q("SELECT referred, referral_reward_received FROM user_referral_flags WHERE user_id=$1", [a])).toEqual([{ referred: false, referral_reward_received: true }]);
    expect(await q("SELECT referred, referral_reward_received FROM user_referral_flags WHERE user_id=$1", [friends[0]])).toEqual([{ referred: true, referral_reward_received: false }]);
    // новый месяц — лимит заново
    const f6 = await fresh(); await attributeReferral(f6, ca, "web", { isNew: true });
    expect(await activateReferral(f6, "web", new Date("2026-11-02T10:00:00Z"))).toBe(true);
    expect((await refOf(f6)).reward_status).toBe("pending");
  });
  it("held (velocity) referrals and internal referrers get no reward even with the flag on", async () => {
    vi.stubEnv("REFERRAL_REWARDS_ENABLED", "1");
    vi.stubEnv("REFERRAL_DAILY_LIMIT", "1");
    const a = await fresh(); const ca = await getOrCreateRefCode(a);
    const f1 = await fresh(), f2 = await fresh();
    await attributeReferral(f1, ca, "web", { isNew: true });
    expect(await attributeReferral(f2, ca, "web", { isNew: true })).toBe("held");
    await activateReferral(f2, "web");
    expect(await refOf(f2)).toMatchObject({ status: "held", reward_status: "held" });
    await setInternal(a, true);
    await activateReferral(f1, "web");
    expect((await refOf(f1)).reward_status).toBe("none");
    expect(await q("SELECT count(*)::int n FROM referral_rewards WHERE user_id=$1", [a])).toEqual([{ n: 0 }]);
  });
});

describe("entry points", () => {
  it("web: ?ref= passed to POST /api/v1/session attributes a new session and sets source=referral; existing session is not attributed", async () => {
    const a = await fresh(); const ca = await getOrCreateRefCode(a);
    jar.clear();
    const r = await call(sessionPOST, req("/api/v1/session", { method: "POST", body: { attribution: { utm_campaign: "Oct" }, ref: ca.toUpperCase() } }));
    expect(r.status).toBe(201);
    const [x] = await q<{ referee_user_id: string }>("SELECT referee_user_id FROM referrals WHERE referrer_user_id=$1", [a]);
    expect(await q("SELECT source, medium, campaign, channel FROM user_sources WHERE user_id=$1", [x.referee_user_id])).toEqual([{ source: "referral", medium: "invite", campaign: "oct", channel: "web" }]);
    // та же сессия открывает чужую ссылку — без изменений
    const b = await fresh(); const cb = await getOrCreateRefCode(b);
    expect((await call(sessionPOST, req("/api/v1/session", { method: "POST", body: { ref: cb } }))).body).toEqual({ created: false });
    expect((await refOf(x.referee_user_id)).referrer_user_id).toBe(a);
    expect(await q("SELECT count(*)::int n FROM referrals WHERE referrer_user_id=$1", [b])).toEqual([{ n: 0 }]);
    // GET /api/v1/referrals/me у пригласившего: те же счётчики, ссылки
    jar.clear();
    const me = await call(meGET as never, req("/api/v1/referrals/me"));
    expect(me.status).toBe(401);
  });
  it("Mini App: startapp=ref_<code> attributes a Telegram account created by this login", async () => {
    const token = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    vi.stubEnv("TELEGRAM_BOT_TOKEN", token);
    const a = await fresh(); const ca = await getOrCreateRefCode(a);
    const login = async (id: number, sp: string) => {
      jar.clear();
      const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), start_param: sp, user: JSON.stringify({ id, first_name: "A" }) }, token);
      return call(tgLoginPOST, req("/api/v1/session/telegram", { method: "POST", body: { initData } }));
    };
    expect((await login(7_900_001, `ref_${ca}`)).status).toBe(200);
    const u = (await telegramUserId(7_900_001, false))!;
    expect(await refOf(u)).toMatchObject({ referrer_user_id: a, channel: "miniapp" });
    expect(await q("SELECT source, medium, channel FROM user_sources WHERE user_id=$1", [u])).toEqual([{ source: "referral", medium: "invite", channel: "miniapp" }]);
    // уже существующий Telegram-аккаунт: не засчитывается
    await telegramUserId(7_900_002);
    expect((await login(7_900_002, `ref_${ca}`)).status).toBe(200);
    expect(await refOf((await telegramUserId(7_900_002, false))!)).toBeUndefined();
  });
  it("bot: /start ref_<code> attributes a new Telegram user; /invite returns the personal link and counters", async () => {
    const calls: { method: string; payload: Record<string, any> }[] = [];
    const bot = createBot("123456:TEST", { botInfo: { id: 123456, is_bot: true, first_name: "Можно", username: "mozhno_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never });
    bot.api.config.use(async (_prev, method, payload) => { calls.push({ method, payload: payload as Record<string, any> }); return { ok: true, result: method === "sendMessage" ? { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: "" } : true } as never; });
    let uid = 9000;
    const msg = (id: number, text: string) => bot.handleUpdate({ update_id: uid++, message: { message_id: uid, date: 0, chat: { id, type: "private", first_name: "U" }, from: { id, is_bot: false, first_name: "U" }, text, ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] } : {}) } } as never);
    const inviterTg = 8_100_001, friendTg = 8_100_002;
    await msg(inviterTg, "/start");
    const inviter = (await telegramUserId(inviterTg, false))!;
    const code = await getOrCreateRefCode(inviter);
    await msg(friendTg, `/start ref_${code}`);
    const friend = (await telegramUserId(friendTg, false))!;
    expect(await refOf(friend)).toMatchObject({ referrer_user_id: inviter, channel: "bot", status: "attributed" });
    await msg(friendTg, `/start ref_${code}`); // повтор ссылки — ничего не меняется
    expect(await q("SELECT count(*)::int n FROM referrals WHERE referee_user_id=$1", [friend])).toEqual([{ n: 1 }]);
    await msg(inviterTg, `/start ref_${code}`); // своя ссылка
    expect(await refOf(inviter)).toBeUndefined();
    // друг проходит знакомство в боте → «начал пользоваться» (без вопроса «Можно?»)
    for (const t of ["60000", "25.06.2027 80000", "нет", "0", "не знаю", "нет"]) await msg(friendTg, t);
    const kb = [...calls].reverse().find((c) => c.method === "sendMessage" && c.payload.reply_markup)!;
    const done = (kb.payload.reply_markup.inline_keyboard as { text: string; callback_data: string }[][]).flat().find((x) => x.text === "Готово")!;
    await bot.handleUpdate({ update_id: uid++, callback_query: { id: String(uid), from: { id: friendTg, is_bot: false, first_name: "U" }, chat_instance: "x", data: done.callback_data, message: { message_id: 1, date: 0, chat: { id: friendTg, type: "private", first_name: "U" }, text: "..." } } } as never);
    expect(await refOf(friend)).toMatchObject({ status: "activated", reward_status: "disabled" });
    calls.length = 0;
    await msg(inviterTg, "/invite");
    const sent = calls.find((c) => c.method === "sendMessage")!;
    expect(sent.payload.text).toContain(`https://t.me/mozhno_test_bot?start=ref_${code}`);
    expect(sent.payload.text).toContain("Пришли по ссылке: 1 · начали пользоваться: 1");
    expect(sent.payload.reply_markup.inline_keyboard[0][0].url).toMatch(/^https:\/\/t\.me\/share\/url\?url=/);
    expect(inviteText(await referralMe(inviter))).toContain("Ваша личная ссылка");
    expect(shareResultText("yes")).toContain("Мне бот сказал: можно ✅");
    expect(shareResultText("yes")).not.toMatch(/\d/);
  });
  it("share route accepts only enum methods and surfaces", async () => {
    jar.clear();
    await call(sessionPOST, req("/api/v1/session", { method: "POST", body: {} }));
    expect((await call(sharePOST, req("/api/v1/referrals/share", { method: "POST", body: { method: "copy", surface: "answer" } }))).status).toBe(202);
    expect((await call(sharePOST, req("/api/v1/referrals/share", { method: "POST", body: { method: "sms", surface: "answer" } }))).status).toBe(400);
    expect((await call(sharePOST, req("/api/v1/referrals/share", { method: "POST", body: { method: "bot", surface: "bot" } }))).status).toBe(400);
    const me = await call(meGET as never, req("/api/v1/referrals/me"));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ invited: 0, active: 0, rewards: { enabled: false, days: 7, monthlyLimit: 4 } });
    expect(me.body.links.web).toBe(`https://mozhno-mvp.vercel.app/?ref=${me.body.code}`);
  });
});

describe("dashboard summary", () => {
  it("counts invites, signups, activation and K; internal excluded by default; small groups flagged", async () => {
    const from = new Date(Date.now() - 86_400_000), to = new Date(Date.now() + 60_000);
    const before = await referralSummary(from, to);
    const a = await fresh(); const ca = await getOrCreateRefCode(a);
    const f = await fresh(); await attributeReferral(f, ca, "web", { isNew: true }); await activateReferral(f, "web");
    const s = await referralSummary(from, to);
    expect(s.signups - before.signups).toBe(1);
    expect(s.activated - before.activated).toBe(1);
    const top = s.top.find((t) => t.subject === pseudonym(a, 0).slice(0, 8));
    expect(top).toMatchObject({ signups: 1, activated: 1, small: true });
    await setInternal(a, true);
    const s2 = await referralSummary(from, to);
    expect(s2.signups).toBe(s.signups - 1);
    expect((await referralSummary(from, to, { includeInternal: true })).signups).toBeGreaterThanOrEqual(s.signups);
    expect(JSON.stringify(s)).not.toContain(a);
  });
});
