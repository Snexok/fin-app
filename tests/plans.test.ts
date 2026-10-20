// v26: тарифы и AI-ответы (миграция 010) — план (beta/live), окна по Москве, атомарный расход, шаблон при исчерпании,
// заявка «Хочу Плюс» без оплаты, награды за друзей за флагом, голос, бот /plus. Настоящий прокси LLM не вызывается.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
vi.mock("next/headers", async () => (await import("./http-helpers")).nextHeadersMock);
import { getDb } from "../lib/db";
import { pseudonym, validateEvent, CLIENT_EVENTS } from "../lib/analytics";
import { forgetLogMeta } from "../lib/service-log";
import { llmCall } from "../lib/llm";
import {
  consumeToken, getPlan, grantPlusDays, installPlanHooks, maturePendingRewards, mergePlans, planContext, plansConfig, recordVoice,
  releaseStaleTokens, releaseToken, reserveToken, shownPrice, upsertInterest, voiceLeft, windowStart, moscowDay,
} from "../lib/plans";
import { resetLabel } from "../lib/plans/time";
import { plusText, tokensLine } from "../lib/plans/copy";
import { ESSENTIAL_HINT, allowedNumbers, evidenceOf, explainDecision, templateExplanation, tokenNote, validateExplanation } from "../lib/explain";
import { answer, isWhyQuestion, purchaseText } from "../lib/coach";
import { readFileSync } from "node:fs";
import { simulatePurchase } from "../lib/engine";
import { createBot } from "../lib/bot";
import { telegramUserId } from "../lib/auth";
import { savePlan } from "../lib/finance-service";
import { GET as planGET } from "../app/api/v1/plan/route";
import { POST as interestPOST } from "../app/api/v1/plan/interest/route";
import { POST as explainPOST } from "../app/api/v1/explain/route";
import { startFakeLlm, type FakeLlm } from "./fake-llm";
import { NOW, PLAN, webUser } from "./helpers";
import { call, jar, newSession, req } from "./http-helpers";

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await (await getDb()).query<T>(sql, p)).rows;
const events = async (userId: string, name: string) => q<{ props: Record<string, string>; channel: string }>("SELECT props, channel FROM analytics_events WHERE subject=$1 AND name=$2", [pseudonym(userId, 0), name]);
const rid = () => crypto.randomUUID();

let fake: FakeLlm;
/** Фейковая модель: объясняет числами из Evidence (как и требует промпт); bad=true — подсовывает чужое число. */
let bad = false;
let explainer: FakeLlm["handler"];
beforeAll(async () => {
  fake = await startFakeLlm(explainer = ({ body }) => {
    const msgs = body.messages as { role: string; content: string }[];
    const ev = JSON.parse(msgs.at(-1)!.content.replace(/^Evidence: /, ""));
    const n = bad ? 123457 : ev.safe_daily_after_rub;
    return { content: `После покупки останется около ${n.toLocaleString("ru-RU")} ₽ в день, обязательные платежи уже учтены. Решение за вами.` };
  });
});
afterAll(async () => { await fake.close(); });
beforeEach(() => { bad = false; fake.handler = explainer; installPlanHooks(); });
afterEach(() => { vi.unstubAllEnvs(); forgetLogMeta(); });
const withLlm = () => { vi.stubEnv("LLM_API_KEY", "accelerator-test-key"); vi.stubEnv("LLM_BASE_URL", fake.url); vi.stubEnv("LLM_TIMEOUT_MS", "2000"); vi.stubEnv("LLM_USER_DAILY_SOFT_CAP_RUB", "0"); };

describe("plans: config and resolution (beta vs live)", () => {
  it("defaults: beta mode, Бета-Плюс 15/day without a 30-day cap, Free 60/30d max 10/day, Plus 300/30d max 30/day, 399 ₽ after beta", async () => {
    const c = plansConfig();
    expect(c.mode).toBe("beta");
    expect(c.limits.beta_plus).toMatchObject({ perDay: 15, perWindow: 0, voiceWindowSec: 1800, voiceDaySec: 180 }); // голос беты — как в Плюсе
    expect(c.limits.free).toMatchObject({ perDay: 10, perWindow: 60, voiceWindowSec: 120 });
    expect(c.limits.plus).toMatchObject({ perDay: 30, perWindow: 300, voiceWindowSec: 1800 });
    expect(c.price).toMatchObject({ plusRub: 399, periodDays: 30, options: [299, 399, 499], experiment: false });
    const s = await webUser();
    const p = await getPlan(s.userId, NOW);
    expect(p).toMatchObject({ mode: "beta", plan: "beta_plus", label: "Бета-Плюс", source: "beta", prices: { free: 0, plusRub: 399, autoRenew: false, afterBeta: true } });
    expect(p.tokens).toMatchObject({ left: 15, limit: 15, scope: "day", exhausted: false, window: null });
  });
  it("env overrides every number; bad values fall back to defaults; price options are limited to the allowlisted points", () => {
    vi.stubEnv("PLANS_MODE", "LIVE"); vi.stubEnv("FREE_AI_ANSWERS_PER_DAY", "4"); vi.stubEnv("PLUS_AI_ANSWERS_PER_30D", "abc");
    vi.stubEnv("PLUS_PRICE_RUB", "349"); vi.stubEnv("PLUS_PRICE_OPTIONS", "299, 349, 1000, 499"); vi.stubEnv("BETA_ENDS_AT", "2026-11-01");
    const c = plansConfig();
    expect(c).toMatchObject({ mode: "live", betaEndsAt: "2026-11-01", price: { plusRub: 349, options: [299, 349, 499] } });
    expect(c.limits.free.perDay).toBe(4);
    expect(c.limits.plus.perWindow).toBe(300);
  });
  it("live: Free without an entitlement, Plus while a referral/manual period is active, back to Free after it ends", async () => {
    vi.stubEnv("PLANS_MODE", "live");
    const s = await webUser();
    expect((await getPlan(s.userId, NOW)).tokens).toMatchObject({ plan: "free", left: 10, scope: "day", window: { limit: 60, left: 60 } });
    const g = (await grantPlusDays({ userId: s.userId, days: 7, source: "manual", idempotencyKey: `t:${s.userId}`, now: NOW }))!;
    expect(g.endsAt.getTime() - g.startsAt.getTime()).toBe(7 * 86_400_000);
    expect(await grantPlusDays({ userId: s.userId, days: 7, source: "manual", idempotencyKey: `t:${s.userId}`, now: NOW })).toBeNull(); // идемпотентно
    const p = await getPlan(s.userId, new Date(NOW.getTime() + 3_600_000));
    expect(p).toMatchObject({ plan: "plus", source: "manual", label: "Плюс" });
    expect(p.tokens).toMatchObject({ left: 30, scope: "day", window: { limit: 300 } });
    expect((await getPlan(s.userId, new Date(NOW.getTime() + 8 * 86_400_000))).plan).toBe("free");
    // Второй период складывается после первого, а не поверх.
    const g2 = (await grantPlusDays({ userId: s.userId, days: 7, source: "manual", now: NOW }))!;
    expect(g2.startsAt.toISOString()).toBe(g.endsAt.toISOString());
  });
  it("experiment arm (PLUS_PRICE_EXPERIMENT=1) is stable per user and drawn from the options", () => {
    vi.stubEnv("PLUS_PRICE_EXPERIMENT", "1");
    const a = shownPrice("11111111-1111-4111-8111-111111111111"), b = shownPrice("11111111-1111-4111-8111-111111111111");
    expect(a).toEqual(b);
    expect([299, 399, 499]).toContain(a.price);
    expect(a.variant).toBe(`p${a.price}`);
    vi.stubEnv("PLUS_PRICE_EXPERIMENT", "0");
    expect(shownPrice("x")).toEqual({ price: 399, variant: "base" });
  });
});

describe("plans: windows in Europe/Moscow", () => {
  it("30-day windows from the anchor; reset labels in Moscow time", () => {
    expect(windowStart("2026-10-01", "2026-10-01")).toBe("2026-10-01");
    expect(windowStart("2026-10-01", "2026-10-30")).toBe("2026-10-01");
    expect(windowStart("2026-10-01", "2026-10-31")).toBe("2026-10-31");
    expect(windowStart("2026-10-01", "2026-12-15")).toBe("2026-11-30");
    expect(windowStart("2026-10-18", "2026-10-15")).toBe("2026-09-18");
    expect(moscowDay(new Date("2026-10-15T20:59:59Z"))).toBe("2026-10-15");
    expect(moscowDay(new Date("2026-10-15T21:00:00Z"))).toBe("2026-10-16"); // полночь МСК = 21:00 UTC
    expect(resetLabel(new Date("2026-10-15T21:00:00Z"), new Date("2026-10-15T12:00:00Z"))).toBe("завтра в 00:00");
    expect(resetLabel(new Date("2026-11-19T21:00:00Z"), new Date("2026-10-15T12:00:00Z"))).toBe("20 ноября");
  });
  it("the daily counter resets at Moscow midnight, not UTC midnight", async () => {
    vi.stubEnv("BETA_AI_ANSWERS_PER_DAY", "2");
    const s = await webUser();
    const late = new Date("2026-10-15T20:58:00Z"), after = new Date("2026-10-15T21:02:00Z");
    for (let i = 0; i < 2; i++) { const r = rid(); expect((await reserveToken({ userId: s.userId, purpose: "explain", requestId: r, now: late })).ok).toBe(true); await consumeToken(r, late); }
    expect(await reserveToken({ userId: s.userId, purpose: "explain", requestId: rid(), now: late })).toEqual({ ok: false, scope: "day" });
    const p = await getPlan(s.userId, late);
    expect(p.tokens).toMatchObject({ exhausted: true, left: 0, resetLabel: "завтра в 00:00" });
    expect(p.tokens.resetAt).toBe("2026-10-15T21:00:00.000Z");
    expect((await reserveToken({ userId: s.userId, purpose: "explain", requestId: rid(), now: after })).ok).toBe(true); // 00:02 МСК — новый день
  });
  it("live Free: the 30-day window is binding once the day is fine; reset is the window end", async () => {
    vi.stubEnv("PLANS_MODE", "live"); vi.stubEnv("FREE_AI_ANSWERS_PER_30D", "3"); vi.stubEnv("FREE_AI_ANSWERS_PER_DAY", "10");
    const s = await webUser();
    const ctx = await planContext(s.userId, NOW);
    for (let i = 0; i < 3; i++) { const r = rid(); await reserveToken({ userId: s.userId, purpose: "compare", requestId: r, now: NOW }); await consumeToken(r, NOW); }
    const later = new Date(NOW.getTime() + 2 * 86_400_000);
    expect(await reserveToken({ userId: s.userId, purpose: "explain", requestId: rid(), now: later })).toEqual({ ok: false, scope: "window" });
    const t = (await getPlan(s.userId, later)).tokens;
    expect(t).toMatchObject({ scope: "window", exhausted: true, window: { start: windowStart(ctx.anchorDay, moscowDay(later)), used: 3 } });
    expect(t.resetAt).toBe(new Date(`${t.window!.end}T00:00:00+03:00`).toISOString());
    expect(tokensLine(t)).toContain("на 30 дней закончились");
  });
});

describe("plans: atomic consume", () => {
  it("parallel reservations never exceed the daily quota; settle and release keep counters exact", async () => {
    vi.stubEnv("BETA_AI_ANSWERS_PER_DAY", "5");
    const s = await webUser();
    const ids = Array.from({ length: 12 }, rid);
    const rs = await Promise.all(ids.map((r) => reserveToken({ userId: s.userId, purpose: "explain", requestId: r, now: NOW })));
    expect(rs.filter((r) => r.ok)).toHaveLength(5);
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && r.scope === "day")).toBe(true);
    const ok = ids.filter((_, i) => rs[i].ok);
    await Promise.all(ok.slice(0, 3).map((r) => consumeToken(r, NOW)));
    await Promise.all(ok.slice(3).map((r) => releaseToken(r, NOW)));
    expect(await consumeToken(ok[0], NOW)).toBe(false); // повтор не списывает второй раз
    const b = await q<{ used: number; reserved: number }>("SELECT used, reserved FROM ai_token_buckets WHERE user_id=$1 AND period_kind='day'", [s.userId]);
    expect(b[0]).toMatchObject({ used: 3, reserved: 0 });
    expect((await getPlan(s.userId, NOW)).tokens.left).toBe(2);
    expect((await events(s.userId, "ai_answer_consumed")).length).toBe(3);
    expect((await events(s.userId, "tokens_exhausted")).length).toBe(1); // одно событие на день, не на каждый отказ
  });
  it("intent parsing and voice never reserve; stale reservations are released by maintenance", async () => {
    vi.stubEnv("BETA_AI_ANSWERS_PER_DAY", "1");
    const s = await webUser();
    expect(await reserveToken({ userId: s.userId, purpose: "intent_parse", requestId: rid(), now: NOW })).toEqual({ ok: true });
    expect(await reserveToken({ userId: s.userId, purpose: "voice_transcribe", requestId: rid(), now: NOW })).toEqual({ ok: true });
    const r = rid();
    expect((await reserveToken({ userId: s.userId, purpose: "explain", requestId: r, now: NOW })).ok).toBe(true);
    expect((await reserveToken({ userId: s.userId, purpose: "explain", requestId: rid(), now: NOW })).ok).toBe(false);
    expect(await releaseStaleTokens(new Date(NOW.getTime() + 10 * 60_000))).toBeGreaterThanOrEqual(1);
    expect((await getPlan(s.userId, NOW)).tokens.left).toBe(1);
    // Очень долгий вызов: резерв истёк, но ответ пришёл — списывается без двойного учёта.
    expect(await consumeToken(r, NOW)).toBe(true);
    expect((await q<{ used: number; reserved: number }>("SELECT used, reserved FROM ai_token_buckets WHERE user_id=$1 AND period_kind='day'", [s.userId]))[0]).toMatchObject({ used: 1, reserved: 0 });
  });
  it("through llmCall: only a successful explain consumes; 5xx, invalid output and intent parsing do not", async () => {
    withLlm();
    const s = await webUser();
    const ask = () => llmCall({ purpose: "explain", userId: s.userId, messages: [{ role: "user", content: 'Evidence: {"safe_daily_after_rub": 1500}' }], now: NOW });
    expect((await ask()).ok).toBe(true);
    fake.handler = () => ({ status: 500 });
    expect((await ask()).ok).toBe(false);
    fake.handler = () => ({ content: "" });
    expect((await ask()).ok).toBe(false);
    fake.handler = () => ({ content: '{"intent":"other"}' });
    await llmCall({ purpose: "intent_parse", userId: s.userId, messages: [{ role: "user", content: "x" }], now: NOW });
    const led = await q<{ status: string; purpose: string }>("SELECT status, purpose FROM ai_token_ledger WHERE user_id=$1 ORDER BY created_at", [s.userId]);
    expect(led.map((x) => x.status).sort()).toEqual(["consumed", "released", "released"]);
    expect((await getPlan(s.userId, NOW)).tokens.left).toBe(14);
  });
});

describe("explain: evidence check and graceful fallback", () => {
  const sim = () => simulatePurchase({ today: "2026-10-15", balanceMinor: 6_000_000n, reserveMinor: 1_000_000n, essentialDailyMinor: null, planningDays: null,
    occurrences: [{ id: "a", direction: "expense", name: "Аренда", remainingMinor: 3_000_000n, dueOn: "2026-10-20", certainty: "confirmed" }, { id: "b", direction: "income", name: "Зарплата", remainingMinor: 8_000_000n, dueOn: "2026-10-25", certainty: "confirmed" }], goal: null } as never,
  { item: "наушники", priceMinor: 1_500_000n });
  it("numbers outside the Evidence reject the model text; the template uses the engine numbers", () => {
    const s = sim(), ev = evidenceOf(s);
    expect(ev).toMatchObject({ price_rub: 15000, item: "наушники" });
    const set = allowedNumbers(ev);
    expect(set.has(ev.safe_daily_after_rub)).toBe(true);
    expect(validateExplanation(`Останется около ${ev.safe_daily_after_rub} ₽ в день до ${+ev.until.slice(8)} октября.`, ev)).not.toBeNull();
    expect(validateExplanation("Останется около 99 999 ₽ в день — спокойно.", ev)).toBeNull();
    expect(validateExplanation("Гарантирую, что хватит на всё и даже больше.", ev)).toBeNull();
    const t = templateExplanation(s);
    expect(t).toContain("15\u00a0000\u00a0₽");
    expect(t).toMatch(/^Почему так/);
    expect(isWhyQuestion("а почему?")).toBe(true);
    expect(isWhyQuestion("Почему так")).toBe(true);
    expect(isWhyQuestion("почему кофе дорогой за 300")).toBe(false);
  });
  it("AI answer consumes one token; out of tokens → template with the same numbers, a gentle note, and the core keeps working", async () => {
    withLlm(); vi.stubEnv("BETA_AI_ANSWERS_PER_DAY", "1");
    const s = await webUser();
    const a = await answer(s.userId, "Можно купить наушники за 15000?", { now: NOW });
    expect(a.decisionId).toBeTruthy();
    const ai = (await explainDecision(s.userId, a.decisionId!, { now: NOW }))!;
    expect(ai).toMatchObject({ mode: "ai", reason: null });
    expect(ai.tokens).toMatchObject({ left: 0, exhausted: true });
    const tpl = (await explainDecision(s.userId, a.decisionId!, { now: NOW }))!;
    expect(tpl).toMatchObject({ mode: "template", reason: "quota" });
    expect(tpl.reply).toContain("15\u00a0000\u00a0₽");
    expect(tpl.note).toMatch(/закончились.*завтра в 00:00 по Москве/);
    // «Можно?», «сколько можно сегодня», запись траты — без ограничений
    for (let i = 0; i < 3; i++) expect((await answer(s.userId, "Можно купить кофе за 300?", { now: NOW })).impact?.verdict).toBeTruthy();
    expect((await answer(s.userId, "Сколько можно тратить в день?", { now: NOW })).reply).toMatch(/в день/);
    expect((await answer(s.userId, "Потратил 500 на кофе", { now: NOW })).proposal).toBeTruthy();
    // «а почему?» текстом — тот же путь, шаблон
    const why = await answer(s.userId, "а почему?", { now: NOW });
    expect(why.explain).toMatchObject({ mode: "template", reason: "quota" });
    expect(why.reply).toMatch(/^Почему так/);
    expect((await events(s.userId, "tokens_exhausted"))[0].props).toEqual({ plan: "beta_plus", scope: "day" });
  });
  it("invalid model output and LLM off never consume and never show the 'ran out' note", async () => {
    withLlm();
    const s = await webUser();
    const a = await answer(s.userId, "Можно купить наушники за 15000?", { now: NOW });
    bad = true;
    const r = (await explainDecision(s.userId, a.decisionId!, { now: NOW }))!;
    expect(r).toMatchObject({ mode: "template", reason: "invalid", note: null });
    vi.stubEnv("LLM_ENABLED", "0");
    expect((await explainDecision(s.userId, a.decisionId!, { now: NOW }))!).toMatchObject({ mode: "template", reason: "disabled", note: null });
    expect((await getPlan(s.userId, NOW)).tokens.left).toBe(15);
    expect(tokenNote({ ...(await getPlan(s.userId, NOW)).tokens, left: 2, low: true })).toBe("✦ Осталось 2 AI-ответа на сегодня.");
  });
});

describe("plus interest (no payment)", () => {
  it("upsert: one row per user, the repeat updates the price choice and keeps created_at; invalid price is refused", async () => {
    const s = await webUser();
    const t1 = new Date(NOW.getTime() + 1000), t2 = new Date(NOW.getTime() + 60_000);
    const a = await upsertInterest(s.userId, { price: 399, channel: "web", now: t1 });
    expect(a).toMatchObject({ priceChoice: 399, offeredPrice: 399, variant: "base", repeat: false });
    const b = await upsertInterest(s.userId, { price: null, channel: "telegram", now: t2 });
    expect(b).toMatchObject({ priceChoice: null, repeat: true, createdAt: a.createdAt });
    expect((await q("SELECT * FROM plus_interest WHERE user_id=$1", [s.userId]))).toHaveLength(1);
    await expect(upsertInterest(s.userId, { price: 1, channel: "web" })).rejects.toThrow(/вариант/);
    expect((await events(s.userId, "plus_interest")).map((e) => e.props)).toEqual([{ price: "399", repeat: "false" }, { price: "none", repeat: "true" }]);
    expect((await getPlan(s.userId, NOW)).interest).toMatchObject({ priceChoice: null });
  });
  it("API: GET /api/v1/plan, POST /api/v1/plan/interest (same-origin, charged:false), POST /api/v1/explain", async () => {
    await newSession();
    const p = await call(planGET, req("/api/v1/plan"));
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ mode: "beta", plan: "beta_plus", tokens: { left: 15 }, prices: { plusRub: 399, options: [299, 399, 499] } });
    expect((await call(interestPOST, req("/api/v1/plan/interest", { method: "POST", body: { price: 499 }, origin: "http://evil.test" }))).status).toBe(403);
    expect((await call(interestPOST, req("/api/v1/plan/interest", { method: "POST", body: { price: 450 } }))).status).toBe(400);
    const r = await call(interestPOST, req("/api/v1/plan/interest", { method: "POST", body: { price: 499, channel: "miniapp" } }));
    expect(r).toMatchObject({ status: 200, body: { ok: true, charged: false, interest: { priceChoice: 499 } } });
    expect((await q<{ channel: string }>("SELECT channel FROM plus_interest ORDER BY updated_at DESC LIMIT 1"))[0].channel).toBe("web"); // без Telegram — web
    expect((await call(explainPOST, req("/api/v1/explain", { method: "POST", body: { decisionId: "x" } }))).status).toBe(400);
    expect((await call(explainPOST, req("/api/v1/explain", { method: "POST", body: { decisionId: rid() } }))).status).toBe(404);
    expect(jar.size).toBeGreaterThan(0);
  });
  it("plus_viewed is a client event with an enum surface", () => {
    expect(CLIENT_EVENTS).toContain("plus_viewed");
    expect(validateEvent("plus_viewed", { surface: "counter" }).ok).toBe(true);
    expect(validateEvent("plus_viewed", { surface: "home" }).ok).toBe(false);
    expect(validateEvent("plus_interest", { price: "399", repeat: "false" }).ok).toBe(true);
    expect(validateEvent("plus_interest", { price: "123" }).ok).toBe(false);
  });
});

describe("referral reward → +7 days Plus (behind REFERRAL_REWARDS_ENABLED)", () => {
  async function pendingReward(eligibleAt: Date) {
    const a = await webUser(), b = await webUser();
    const ref = (await q<{ id: string }>("INSERT INTO referrals(referrer_user_id, referee_user_id, code, channel, status, activated_at) VALUES ($1,$2,'abcdefgh','web','activated',$3) RETURNING id", [a.userId, b.userId, NOW]))[0];
    const w = (await q<{ id: string }>("INSERT INTO referral_rewards(referral_id, user_id, amount, period, status, eligible_at) VALUES ($1,$2,7,'2026-10','pending',$3) RETURNING id", [ref.id, a.userId, eligibleAt]))[0];
    await q("UPDATE referrals SET reward_status='pending', reward_id=$2 WHERE id=$1", [ref.id, w.id]);
    return { referrer: a.userId, rewardId: w.id };
  }
  it("flag off (default): nothing is granted", async () => {
    const { referrer } = await pendingReward(new Date(NOW.getTime() - 1000));
    expect(await maturePendingRewards(NOW)).toEqual({ enabled: false, granted: 0, skipped: 0 });
    expect(await q("SELECT 1 FROM entitlements WHERE user_id=$1", [referrer])).toHaveLength(0);
  });
  it("flag on: matured rewards become a Plus period once (idempotent); not-yet-eligible wait; flags report entitlement_source, ever_paid=false", async () => {
    vi.stubEnv("REFERRAL_REWARDS_ENABLED", "1"); vi.stubEnv("PLANS_MODE", "live");
    const due = await pendingReward(new Date(NOW.getTime() - 1000));
    const later = await pendingReward(new Date(NOW.getTime() + 3_600_000));
    const r1 = await maturePendingRewards(NOW);
    expect(r1.enabled).toBe(true);
    expect(r1.granted).toBeGreaterThanOrEqual(1);
    expect((await maturePendingRewards(NOW)).granted).toBe(0); // повтор cron ничего не добавляет
    const e = await q<{ source: string; starts_at: Date; ends_at: Date; referral_reward_id: string }>("SELECT * FROM entitlements WHERE user_id=$1", [due.referrer]);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ source: "referral", referral_reward_id: due.rewardId });
    expect(new Date(e[0].ends_at).getTime() - new Date(e[0].starts_at).getTime()).toBe(7 * 86_400_000);
    expect((await q<{ status: string }>("SELECT status FROM referral_rewards WHERE id=$1", [due.rewardId]))[0].status).toBe("granted");
    expect(await q("SELECT 1 FROM entitlements WHERE user_id=$1", [later.referrer])).toHaveLength(0);
    expect((await getPlan(due.referrer, new Date(NOW.getTime() + 60_000))).plan).toBe("plus");
    const f = (await q<{ ever_paid: boolean; entitlement_source: string | null }>("SELECT * FROM user_plan_flags WHERE user_id=$1", [due.referrer]))[0];
    expect(f).toMatchObject({ ever_paid: false, entitlement_source: "referral" });
  });
  it("in beta with BETA_ENDS_AT, a reward starts after the beta (not burnt inside the common beta)", async () => {
    vi.stubEnv("BETA_ENDS_AT", "2026-11-01");
    const s = await webUser();
    const g = (await grantPlusDays({ userId: s.userId, days: 7, source: "referral", now: NOW }))!;
    expect(g.startsAt.toISOString()).toBe("2026-11-01T21:00:00.000Z"); // 2 ноября 00:00 МСК
    const p = await getPlan(s.userId, NOW);
    expect(p).toMatchObject({ plan: "beta_plus", plusUntil: "2026-11-08T21:00:00.000Z" });
    expect(plusText(p)).toContain("После беты у вас будет Плюс до 9 ноября");
  });
});

describe("voice minutes and /link merge", () => {
  it("live Free: 2 voice minutes per 30 days; beta uses Plus voice", async () => {
    const s = await webUser();
    expect(await voiceLeft(s.userId, NOW)).toBe(180); // бета: до 3 мин в день
    vi.stubEnv("PLANS_MODE", "live");
    expect(await voiceLeft(s.userId, NOW)).toBe(120);
    await recordVoice(s.userId, 125, NOW);
    expect(await voiceLeft(s.userId, NOW)).toBe(0);
  });
  it("mergePlans moves Plus periods, counters and the interest to the surviving account", async () => {
    const a = await webUser(), b = await webUser();
    const r = rid();
    await reserveToken({ userId: a.userId, purpose: "explain", requestId: r, now: NOW }); await consumeToken(r, NOW);
    await upsertInterest(a.userId, { price: 299, channel: "web", now: NOW });
    await grantPlusDays({ userId: a.userId, days: 7, source: "manual", now: NOW });
    const db = await getDb();
    await db.tx((t) => mergePlans(t, a.userId, b.userId));
    expect((await getPlan(b.userId, NOW)).tokens.left).toBe(14);
    expect((await getPlan(b.userId, NOW)).interest?.priceChoice).toBe(299);
    expect(await q("SELECT 1 FROM entitlements WHERE user_id=$1", [b.userId])).toHaveLength(1);
    expect(await q("SELECT 1 FROM plus_interest WHERE user_id=$1", [a.userId])).toHaveLength(0);
  });
});

describe("bot: /plus and the interest buttons", () => {
  const calls: { method: string; payload: Record<string, any> }[] = [];
  const bot = createBot("123456:TEST", { botInfo: { id: 123456, is_bot: true, first_name: "Можно", username: "mozhno_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never });
  bot.api.config.use(async (_p, method, payload) => { calls.push({ method, payload: payload as Record<string, unknown> }); return { ok: true, result: method === "sendMessage" ? { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: "" } : true } as never; });
  let u = 1;
  const msg = (id: number, text: string) => bot.handleUpdate({ update_id: u++, message: { message_id: u, date: 0, chat: { id, type: "private", first_name: "U" }, from: { id, is_bot: false, first_name: "U" }, text, ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] } : {}) } } as never);
  const tap = (id: number, data: string, reply_markup?: unknown) => bot.handleUpdate({ update_id: u++, callback_query: { id: String(u), from: { id, is_bot: false, first_name: "U" }, chat_instance: "x", data, message: { message_id: 1, date: 0, chat: { id, type: "private", first_name: "U" }, text: "...", ...(reply_markup ? { reply_markup } : {}) } } } as never);
  const last = () => [...calls].reverse().find((c) => c.method === "sendMessage" || c.method === "editMessageText")!.payload;
  it("/plus explains free vs Plus, beta and price; «Хочу Плюс» → price choice → kind confirmation, nothing charged", async () => {
    const id = 77001;
    const userId = (await telegramUserId(id))!;
    await savePlan(userId, PLAN, "telegram", NOW);
    await msg(id, "/plus");
    const t = last();
    expect(t.text).toContain("Сейчас бета: всё бесплатно");
    expect(t.text).toContain("399\u00a0₽ за 30 дней, без автопродления");
    expect(t.text).toContain("AI-ответы: осталось 15 из 15 на сегодня");
    expect(t.reply_markup.inline_keyboard[0][0]).toMatchObject({ text: "Хочу Плюс", callback_data: "pl:want" });
    await tap(id, "pl:want");
    expect(last().reply_markup.inline_keyboard.flat().map((b: { callback_data: string }) => b.callback_data)).toEqual(["pl:p:299", "pl:p:399", "pl:p:499", "pl:p:0"]);
    await tap(id, "pl:p:399");
    expect(last().text).toMatch(/Спасибо, записали[\s\S]*399\u00a0₽[\s\S]*Ничего не списываем/);
    expect((await q<{ price_choice: number; channel: string }>("SELECT price_choice, channel FROM plus_interest WHERE user_id=$1", [userId]))[0]).toMatchObject({ price_choice: 399, channel: "telegram" });
    // Ответ «Можно?» — кнопка «Почему так? ✦»; нажатие — объяснение (шаблон: LLM в тестах выключена)
    await msg(id, "Можно купить кофе за 300?");
    const kb = last().reply_markup.inline_keyboard.flat() as { text: string; callback_data: string }[];
    const why = kb.find((b) => b.text === "Почему так? ✦")!;
    expect(why.callback_data).toMatch(/^ex:[0-9a-f-]{36}$/);
    expect(kb.filter((b) => /Почему/.test(b.text))).toHaveLength(1); // одна кнопка объяснения
    calls.length = 0;
    await tap(id, why.callback_data, { inline_keyboard: [kb] });
    const edit = calls.find((c) => c.method === "editMessageReplyMarkup")!.payload;
    expect(edit.reply_markup.inline_keyboard.flat().map((b: { callback_data: string }) => b.callback_data)).toEqual([expect.stringMatching(/^bp:/), expect.stringMatching(/^iv:/)]); // «Купил — записать» и «Поделиться» остались
    const ex = last();
    expect(ex.text).toMatch(/^Почему так/); // LLM в тестах выключена → шаблон
    expect(JSON.stringify(ex.reply_markup ?? {})).not.toContain("ex:"); // в объяснении нет повторной кнопки
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1); // одно объяснение, без дубля
  });
});

describe("dashboard: «Плюс и токены»", () => {
  it("views, interest, conversion, price distribution masked <5, AI answers per DAU, share exhausted; internal excluded", async () => {
    const { plusSummary } = await import("../lib/plans/metrics");
    const from = new Date("2026-09-01T00:00:00Z"), to = new Date("2026-09-08T00:00:00Z");
    let k = 0;
    const put = (subject: string, name: string, props: Record<string, string>, internal = false, day = 2) =>
      q("INSERT INTO analytics_events(dedup_key,name,subject,channel,source,occurred_at,props,internal) VALUES ($1,$2,$3,'web','server',$4,$5,$6)",
        [`t-plus-${++k}`, name, subject, new Date(`2026-09-0${day}T10:00:00Z`), JSON.stringify(props), internal]);
    for (let i = 0; i < 10; i++) {
      const s = `subj${i}`;
      await put(s, "user_active", {});
      await put(s, "ai_answer_consumed", { purpose: "explain", plan: "beta_plus" });
      if (i < 8) await put(s, "plus_viewed", { surface: i < 4 ? "counter" : "menu" });
      if (i < 6) await put(s, "plus_interest", { price: i < 5 ? "399" : "499", repeat: "false" });
      if (i < 2) await put(s, "tokens_exhausted", { plan: "beta_plus", scope: "day" });
    }
    await put("subj0", "plus_interest", { price: "399", repeat: "true" }, false, 3);
    await put("team", "user_active", {}, true); await put("team", "plus_viewed", { surface: "counter" }, true); await put("team", "plus_interest", { price: "299", repeat: "false" }, true);
    const p = await plusSummary(from, to);
    expect(p).toMatchObject({ views: 8, viewers: 8, interested: 6, repeats: 1, consumed: 10, dauDays: 10, activeUsers: 10, exhaustedUsers: 2, perDau: 1 });
    expect(p.conversion).toBeCloseTo(0.75);
    expect(p.exhaustedShare).toBeCloseTo(0.2);
    expect(p.prices).toEqual([{ price: "399", users: 5 }, { price: "499", users: null }]);
    expect(p.surfaces).toEqual([{ surface: "counter", views: 4 }, { surface: "menu", views: 4 }]);
    const all = await plusSummary(from, to, null, undefined, { includeInternal: true });
    expect(all).toMatchObject({ viewers: 9, interested: 7 });
  });
});

describe("v27: one explanation entry point, nothing lost", () => {
  it("web verdict card has no old collapsible «Почему?»; the fallback lines are shown only without «Почему так? ✦»", () => {
    const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
    expect(page).not.toMatch(/<details className="vc-why"/);
    expect(page).not.toMatch(/<summary>Почему\?<\/summary>/);
    // v31: «Почему так? ✦» — только вместе с демо-строкой действий (shouldShowVerdictActions); при умном сценарии строки расчёта видны сразу
    expect(page).toMatch(/explainable=\{shouldShowVerdictActions\(m\) && !!m\.decisionId\}/);
    expect(page).toMatch(/\{shouldShowVerdictActions\(m\) && \(\(\) => \{/);
    expect(page).toMatch(/!explainable && details\.length > 0/);
  });
  it("the template explanation keeps every fact the old collapsible showed (wait/careful scenario, unknown daily needs)", () => {
    for (const price of [15_000, 40_000, 5_000]) {
      const s = simulatePurchase({ today: "2026-10-15", balanceMinor: 6_000_000n, reserveMinor: 1_000_000n, essentialDailyMinor: null, planningDays: null,
        occurrences: [{ id: "a", direction: "expense", name: "Аренда", remainingMinor: 3_000_000n, dueOn: "2026-10-20", certainty: "confirmed" }, { id: "b", direction: "income", name: "Зарплата", remainingMinor: 8_000_000n, dueOn: "2026-10-25", certainty: "confirmed" }], goal: null } as never,
      { item: "наушники", priceMinor: BigInt(price) * 100n });
      const t = templateExplanation(s), old = purchaseText(s).split("\n").slice(1);
      const amounts = (x: string) => [...x.matchAll(/\d{1,3}(?:[\s\u00a0]\d{3})+|\d+/g)].map((m) => m[0].replace(/\s|\u00a0/g, ""));
      const have = new Set(amounts(t));
      for (const line of old) for (const n of amounts(line)) expect(have, `${price}: «${line}» → ${n}`).toContain(n);
      expect(t).toContain("Решение за вами");
      expect(old).toContain(ESSENTIAL_HINT); // essentials unknown here → the hint must survive into the explanation
      expect(t).toContain(ESSENTIAL_HINT);
    }
  });
});
