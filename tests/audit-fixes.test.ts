// Тесты к исправлениям pre-audit (High и Medium).
import { describe, it, expect, vi } from "vitest";
import { forecast, MAX_HORIZON_DAYS, assertDateWithin } from "../lib/engine";
import { getForecast, savePlan, simulate } from "../lib/finance-service";
import { confirmProposal, createEntryProposal } from "../lib/proposals";
import { answer, onboardingStep, startOnboarding } from "../lib/coach";
import { getState } from "../lib/conversation";
import { parseDate, parsePaymentLines } from "../lib/parse";
import { createAnonymousSession, touchSession, userIdForSessionToken } from "../lib/auth";
import { pendingInboxEvents, recordInboxEvent } from "../lib/inbox";
import { readJson } from "../lib/api";
import { clientIp } from "../lib/rate-limit";
import { telegramBotToken } from "../lib/telegram-token";
import { handleTelegramWebhook } from "../lib/telegram-webhook";
import { runRetention } from "../lib/retention";
import { getDb } from "../lib/db";
import { NOW, PLAN, rub, webUser } from "./helpers";

describe("High #2: bounded horizon", () => {
  it("income in 2200 does not make a 63k-day loop: horizon is capped", () => {
    const t0 = Date.now();
    const f = forecast({ today: "2026-10-15", balanceMinor: rub(1000), reserveMinor: 0n, essentialDailyMinor: null,
      occurrences: [{ id: "i", direction: "income", name: "x", remainingMinor: rub(1), dueOn: "2200-01-01", certainty: "committed" }], goal: null });
    expect(f.days).toBe(MAX_HORIZON_DAYS);
    expect(f.limitations).toContain("HORIZON_CAPPED");
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it("plan dates outside the window are rejected", async () => {
    const { userId } = await webUser(null);
    await expect(savePlan(userId, { ...PLAN, incomes: [{ name: "x", amountMinor: rub(1), dueOn: "2200-01-01" }] }, "form", NOW)).rejects.toMatchObject({ code: "INVALID_DATE" });
    expect(() => assertDateWithin("2028-01-01", "2026-10-15", "d")).toThrow();
    expect(assertDateWithin("2027-06-01", "2026-10-15", "d")).toBe("2027-06-01");
  });
});

describe("High #3: stale plan does not roll back spends", () => {
  it("savePlan with an old baseFinanceVersion is 409 and keeps the expense", async () => {
    const { userId } = await webUser();
    const v0 = (await getForecast(userId, NOW))!.book.financeVersion;
    const p = await createEntryProposal(userId, { direction: "expense", amountMinor: rub(1000) }, NOW);
    await confirmProposal(userId, p.id, { revision: 1 }, NOW);
    await expect(savePlan(userId, PLAN, "form", NOW, { baseFinanceVersion: v0 })).rejects.toMatchObject({ code: "FINANCE_VERSION_CONFLICT", status: 409 });
    expect((await getForecast(userId, NOW))!.book.balanceMinor).toBe(rub(59000));
    const v1 = (await getForecast(userId, NOW))!.book.financeVersion;
    await savePlan(userId, { ...PLAN, balanceMinor: rub(59000) }, "form", NOW, { baseFinanceVersion: v1 });
  });
});

describe("High #4: editing the plan keeps goal savings", () => {
  it("allocations and saved-outside survive a plan edit without saved fields", async () => {
    const goal = { name: "Отпуск", targetMinor: rub(60000), targetDate: "2027-06-01", savedMinor: rub(15000), savedInBalance: true };
    const { userId } = await webUser({ ...PLAN, goal });
    const before = (await getForecast(userId, NOW))!.book.goal!;
    expect(before.allocatedMinor).toBe(rub(15000));
    await savePlan(userId, { ...PLAN, goal: { name: "Отпуск в Италии", targetMinor: rub(70000), targetDate: "2027-07-01" } }, "form", NOW);
    const after = (await getForecast(userId, NOW))!.book.goal!;
    expect(after).toMatchObject({ id: before.id, name: "Отпуск в Италии", targetMinor: rub(70000), allocatedMinor: rub(15000) });
    // явное изменение накоплений по-прежнему работает
    await savePlan(userId, { ...PLAN, goal: { ...goal, savedMinor: rub(5000), savedInBalance: false } }, "form", NOW);
    expect((await getForecast(userId, NOW))!.book.goal).toMatchObject({ allocatedMinor: 0n, savedOutsideMinor: rub(5000) });
  });
});

describe("High #5: body limit counts bytes", () => {
  it("multi-byte text over the byte limit is 413 even if its length in chars is under it", async () => {
    const body = JSON.stringify({ m: "я".repeat(600) }); // ~1200 байт, 600+ символов
    const r = new Request("http://x/", { method: "POST", body });
    await expect(readJson(r, 1000)).rejects.toMatchObject({ status: 413 });
    expect(await readJson(new Request("http://x/", { method: "POST", body: '{"a":1}' }), 1000)).toEqual({ a: 1 });
  });
});

describe("High #6: webhook idempotency by update_id", () => {
  const TOKEN = "123456789:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const mk = (body: string, secret = "s3cret") => new Request("http://x/api/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body });
  it("duplicates are processed once, failures are retried, bad secret/size rejected, response is immediate", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN); vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "s3cret");
    const handled: number[] = [];
    let failNext = true;
    const bot = { init: async () => {}, handleUpdate: async (u: { update_id: number }) => { if (u.update_id === 2 && failNext) { failNext = false; throw new Error("boom"); } handled.push(u.update_id); } };
    const tasks: Promise<unknown>[] = [];
    const deps = { schedule: (t: () => Promise<unknown>) => { tasks.push(t()); }, getBot: async () => bot };
    const flush = async () => { await Promise.all(tasks.splice(0)); };

    expect((await handleTelegramWebhook(mk('{"update_id":1}', "wrong"), deps)).status).toBe(403);
    expect((await handleTelegramWebhook(mk(JSON.stringify({ update_id: 1, pad: "x".repeat(300 * 1024) })), deps)).status).toBe(413);
    expect((await handleTelegramWebhook(mk('{"update_id":1,"message":{"text":"a"}}'), deps)).status).toBe(200);
    expect((await handleTelegramWebhook(mk('{"update_id":1,"message":{"text":"a"}}'), deps)).status).toBe(200);
    await flush();
    expect(handled).toEqual([1]);
    // сбой обработки: апдейт сохранён и обрабатывается при повторной доставке
    await handleTelegramWebhook(mk('{"update_id":2}'), deps); await flush();
    expect(handled).toEqual([1]);
    const row = (await (await getDb()).query<{ payload: unknown; processed_at: Date | null; attempts: number }>("SELECT payload, processed_at, attempts FROM inbox WHERE source_event_id='2'")).rows[0];
    expect(row.processed_at).toBeNull();
    expect(row.attempts).toBe(1);
    await handleTelegramWebhook(mk('{"update_id":2}'), deps); await flush();
    expect(handled).toEqual([1, 2]);
    vi.unstubAllEnvs();
  });
});

describe("Telegram token (#26)", () => {
  it("single TELEGRAM_BOT_TOKEN with format check; legacy split only as fallback", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456789:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC");
    vi.stubEnv("TELEGRAM_BOT_ID", "9999999"); vi.stubEnv("TELEGRAM_BOT_KEY", "D".repeat(35));
    expect(telegramBotToken()).toBe("123456789:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "garbage");
    expect(telegramBotToken()).toBe(`9999999:${"D".repeat(35)}`);
    vi.stubEnv("TELEGRAM_BOT_KEY", "short");
    expect(telegramBotToken()).toBeUndefined();
    vi.unstubAllEnvs();
  });
});

describe("Medium fixes", () => {
  it("#8: X-Forwarded-For first hop is not trusted", () => {
    const h = new Headers({ "x-forwarded-for": "6.6.6.6, 10.0.0.1", "x-vercel-forwarded-for": "1.2.3.4", "x-real-ip": "1.2.3.4" });
    expect(clientIp(h, "none")).toBe("direct");
    expect(clientIp(h, "vercel")).toBe("1.2.3.4");
    expect(clientIp(h, "1")).toBe("10.0.0.1");
  });
  it("#14/#15/#19: amounts with kopecks, thousands, ambiguity", async () => {
    const { userId } = await webUser();
    const r = await answer(userId, "Потратил 15.50 на кофе", { now: NOW });
    expect(r.proposal!.payload.amountMinor).toBe(1550n);
    expect(r.reply).toContain("15,50\u00a0₽");
    const t = await answer(userId, "Потратил 1.234 ₽ на такси", { now: NOW });
    expect(t.proposal!.payload.amountMinor).toBe(123400n);
    const amb = await answer(userId, "Потратил 100 и 500", { now: NOW });
    expect(amb.proposal).toBeUndefined();
    expect(amb.reply).toContain("несколько сумм");
    const prec = await answer(userId, "Потратил 1,234 на кофе", { now: NOW });
    expect(prec.proposal).toBeUndefined();
  });
  it("#16: entry dates prefer the past, future is refused, local noon is used", async () => {
    const { userId } = await webUser();
    const y = await answer(userId, "Потратил 300 на кофе вчера", { now: NOW });
    expect(y.proposal!.payload.date).toBe("2026-10-14");
    const past = await answer(userId, "Потратил 300 на кофе 5 октября", { now: NOW });
    expect(past.proposal!.payload.date).toBe("2026-10-05");
    const fut = await answer(userId, "Потратил 300 на кофе завтра", { now: NOW });
    expect(fut.proposal).toBeUndefined();
    await confirmProposal(userId, y.proposal!.id, { revision: 1 }, NOW);
    const e = (await (await getDb()).query<{ occurred_on: string; occurred_at: Date }>("SELECT occurred_on::text, occurred_at FROM ledger_entries WHERE proposal_id=$1", [y.proposal!.id])).rows[0];
    expect(e.occurred_on).toBe("2026-10-14");
    expect(new Date(e.occurred_at).toISOString()).toBe("2026-10-14T09:00:00.000Z"); // 12:00 МСК
  });
  it("#17: stale proposal is re-validated before getting a new revision", async () => {
    const { userId } = await webUser();
    const rent = (await getForecast(userId, NOW))!.book.occurrences.find((o) => o.name === "Аренда")!;
    const a = await createEntryProposal(userId, { direction: "expense", amountMinor: rub(30000), occurrenceId: rent.id }, NOW);
    const b = await createEntryProposal(userId, { direction: "expense", amountMinor: rub(30000), occurrenceId: rent.id }, NOW);
    expect((await confirmProposal(userId, a.id, { revision: 1 }, NOW)).status).toBe(200);
    const out = await confirmProposal(userId, b.id, { revision: 1 }, NOW);
    expect(out.status).toBe(409);
    expect((out.body.error as { code: string }).code).toBe("PROPOSAL_INVALIDATED");
  });
  it("#18: balance is clamped to MAX_MINOR", async () => {
    const { userId } = await webUser(null);
    await expect(savePlan(userId, { ...PLAN, balanceMinor: 10n ** 15n }, "form", NOW)).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
  });
  it("#20: occurrenceId that is not a UUID never reaches SQL", async () => {
    const { userId } = await webUser();
    await expect(createEntryProposal(userId, { direction: "expense", amountMinor: rub(1), occurrenceId: "'; DROP --" }, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("#21: question text is kept only with history_enabled; retention removes old rows", async () => {
    const { userId } = await webUser();
    await simulate(userId, { item: "наушники", priceMinor: rub(100) }, "секретный вопрос", NOW);
    const db = await getDb();
    const q = (await db.query<{ input: { question: string | null } | string }>("SELECT input FROM decisions WHERE user_id=$1", [userId])).rows[0].input;
    expect((typeof q === "string" ? JSON.parse(q) : q).question).toBeNull();
    await db.query("UPDATE decisions SET created_at = now() - interval '40 days' WHERE user_id=$1", [userId]);
    const del = await runRetention();
    expect(del.decisions).toBeGreaterThanOrEqual(1);
    expect((await db.query("SELECT 1 FROM decisions WHERE user_id=$1", [userId])).rows).toHaveLength(0);
  });
  it("#23: two concurrent onboarding answers advance the step only once", async () => {
    const { userId } = await webUser(null);
    await startOnboarding(userId, "telegram");
    const [a, b] = await Promise.all([onboardingStep(userId, "1000", { now: NOW }), onboardingStep(userId, "2000", { now: NOW })]);
    const st = await getState<{ onboarding: { step: number } }>(userId, "telegram");
    expect(st!.onboarding.step).toBe(1);
    expect([a.reply, b.reply].some((r) => r.includes("несколько сообщений"))).toBe(true);
  });
});

describe("Codex review follow-ups", () => {
  it("replayed Telegram update does not advance onboarding twice", async () => {
    const { userId } = await webUser(null);
    await startOnboarding(userId, "telegram");
    await onboardingStep(userId, "1000", { now: NOW, updateId: 501 });
    await onboardingStep(userId, "25.11 80000", { now: NOW, updateId: 502 });
    const again = await onboardingStep(userId, "25.11 80000", { now: NOW, updateId: 502 }); // повтор после сбоя отправки
    expect(again.reply).toContain("обязательные платежи");
    expect((await getState<{ onboarding: { step: number } }>(userId, "telegram"))!.onboarding.step).toBe(2);
  });
  it("money token is not parsed as a date; ambiguous payment lines are refused", () => {
    expect(parseDate("Потратил 10.12\u00a0₽ на кофе", "2026-10-16", { prefer: "past" })).toBeNull();
    expect(parsePaymentLines("Аренда 100 или 500 20.10", "2026-10-16").errors).toHaveLength(1);
  });
  it("absolute session lifetime is 180 days even with renewals", async () => {
    const s = await createAnonymousSession(NOW);
    let t = NOW;
    for (let i = 0; i < 12; i++) { t = new Date(t.getTime() + 20 * 86_400_000); await touchSession(s.token, t); }
    expect(await userIdForSessionToken(s.token, new Date(NOW.getTime() + 181 * 86_400_000))).toBeNull();
  });
  it("stale or exhausted inbox events are closed terminally", async () => {
    await recordInboxEvent("telegram:9", "77", { update_id: 77 });
    await (await getDb()).query("UPDATE inbox SET received_at = now() - interval '2 days' WHERE source_event_id='77'");
    expect(await pendingInboxEvents("telegram:9")).toEqual([]);
    const row = (await (await getDb()).query<{ processed_at: Date | null; last_error: string }>("SELECT processed_at, last_error FROM inbox WHERE source_event_id='77'")).rows[0];
    expect(row.processed_at).not.toBeNull();
    expect(row.last_error).toContain("GAVE_UP");
  });
});
