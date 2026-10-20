import { describe, it, expect } from "vitest";
import { onboardingStep, startOnboarding, answer } from "../lib/coach";
import { telegramUserId } from "../lib/auth";
import { getForecast, listDecisions } from "../lib/finance-service";
import { NOW, webUser } from "./helpers";

describe("telegram-style onboarding + fallback chat", () => {
  it("collects profile step by step and answers", async () => {
    const id = (await telegramUserId(1))!;
    await startOnboarding(id);
    for (const msg of ["60\u00a0000", "25.10 80000", "Аренда 30000 20.10", "10к", "нет"]) expect((await onboardingStep(id, msg, { now: NOW })).done).toBe(false);
    const last = await onboardingStep(id, "не знаю", { now: NOW });
    expect(last.done).toBe(true);
    const v = (await getForecast(id, NOW))!;
    expect(v.book.balanceMinor).toBe(6_000_000n);
    expect(v.book.reserveMinor).toBe(1_000_000n);
    expect(v.forecast.horizonEnd).toBe("2026-10-25");
    expect(v.forecast.payments).toMatchObject([{ name: "Аренда", amountMinor: 3_000_000n, dueOn: "2026-10-20" }]);
    const r = await answer(id, "Можно купить наушники за 3000?", { now: NOW, channel: "telegram" });
    expect(r.mode).toBe("fallback");
    expect(r.impact?.verdict).toBe("yes");
    expect(r.reply).toContain("17\u00a0000\u00a0₽");
    expect(await listDecisions(id)).toHaveLength(1);
  });

  it("onboarding rejects unparsed payment lines instead of silently dropping them", async () => {
    const id = (await telegramUserId(2))!;
    await startOnboarding(id);
    await onboardingStep(id, "60000", { now: NOW });
    await onboardingStep(id, "25.10 80000", { now: NOW });
    const r = await onboardingStep(id, "Аренда 30000 20.10\nпросто текст", { now: NOW });
    expect(r.reply).toContain("просто текст");
    expect(r.done).toBe(false);
  });

  it("keeps the purchase draft: '15 тысяч' after the price question", async () => {
    const { userId } = await webUser();
    const q = await answer(userId, "Хочу купить велосипед", { now: NOW });
    expect(q.reply).toContain("Сколько стоит велосипед");
    const r = await answer(userId, "15 тысяч", { now: NOW });
    expect(r.impact?.item).toBe("велосипед");
    expect(r.impact?.price).toBe(15000);
  });

  it("asking about a purchase does not change finance version", async () => {
    const { userId } = await webUser();
    const v1 = (await getForecast(userId, NOW))!.meta.financeVersion;
    await answer(userId, "Можно купить iPhone 15 за 80 000?", { now: NOW });
    expect((await getForecast(userId, NOW))!.meta.financeVersion).toBe(v1);
  });

  it("without a plan asks to onboard", async () => {
    const { userId } = await webUser(null);
    expect((await answer(userId, "привет", { now: NOW })).needsOnboarding).toBe(true);
  });

  it("works without LLM (fallback) and answers snapshot calmly", async () => {
    const { userId } = await webUser();
    const r = await answer(userId, "Сколько можно тратить в день?", { now: NOW });
    expect(r.mode).toBe("fallback");
    expect(r.reply).toMatch(/в день/);
    expect(r.reply).not.toMatch(/нельзя|плохо|зря/i);
  });
});

describe("review fixes (chat)", () => {
  it("cashback does not settle the expected salary", async () => {
    const { userId } = await webUser();
    const at = new Date("2026-10-26T09:00:00Z");
    const r = await answer(userId, "Пришёл кэшбэк 1000", { now: at });
    expect(r.proposal?.payload.occurrenceId).toBeNull();
    expect(r.proposal?.payload.amountMinor).toBe(100000n);
  });
  it("unknown essentials: conditional 'похоже, можно', not a flat yes", async () => {
    const { userId } = await webUser();
    const r = await answer(userId, "Можно купить книгу за 500?", { now: NOW });
    expect(r.reply.startsWith("Похоже, можно")).toBe(true);
    expect(r.reply).toContain("книга");
  });
  it("expense item stored in nominative", async () => {
    const { userId } = await webUser();
    const r = await answer(userId, "Купил одежду за 8000", { now: NOW });
    expect(r.proposal?.payload.description).toBe("Одежда");
  });
});
