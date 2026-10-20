import { describe, it, expect } from "vitest";
import { shouldShowVerdictActions, smartSuggestionFor } from "../app/verdict-actions";

const WAIT_TEXT = "Сейчас эта покупка (куртка, 30 000 ₽) задела бы резерв или деньги на цель.\nСейчас: около 1 000 ₽ в день до 25 октября.\nЕсли купить сейчас: около 200 ₽ в день до 25 октября, разово на покупки — 0 ₽; резерв или накопления уменьшатся на 5 000 ₽.\nЕсли подождать до дохода 25 октября: около 2 500 ₽ в день до 25 ноября, разово на покупки — 40 000 ₽.\nРешение за вами, я лишь показываю последствия.";

describe("demo verdict actions: smart scenario first, buttons as fallback", () => {
  it("plain «можно» has no smart scenario → demo buttons shown", () => {
    const impact = { verdict: "yes", waitIsBetter: false, cashGap: false, scenarios: { afterIncome: null } };
    const s = smartSuggestionFor(impact, "Можно: кофе за 300 ₽ — в рамках плана.");
    expect(s).toBeNull();
    expect(shouldShowVerdictActions({ me: false, impact, smartSuggestion: s })).toBe(true);
  });
  it("«careful» without a better date is still a fallback", () => {
    expect(smartSuggestionFor({ verdict: "careful", waitIsBetter: false, cashGap: false, scenarios: { afterIncome: {} } })).toBeNull();
  });
  it("wait-for-income prediction → suggestion with the engine line, no buttons", () => {
    const impact = { verdict: "wait", waitIsBetter: true, cashGap: false, scenarios: { afterIncome: {} } };
    const s = smartSuggestionFor(impact, WAIT_TEXT);
    expect(s).toEqual({ kind: "wait_for_income", line: expect.stringMatching(/^Если подождать до дохода 25 октября/) });
    expect(shouldShowVerdictActions({ me: false, impact, smartSuggestion: s })).toBe(false);
  });
  it("waitIsBetter without an after-income scenario is not a prediction", () => {
    expect(smartSuggestionFor({ verdict: "no", waitIsBetter: true, cashGap: false, scenarios: { afterIncome: null } })).toBeNull();
  });
  it("cash gap warning → suggestion, no buttons", () => {
    const impact = { verdict: "no", waitIsBetter: false, cashGap: true, scenarios: { afterIncome: {} } };
    const s = smartSuggestionFor(impact, "Сейчас с покупкой (ноутбук, 90 000 ₽) лучше не спешить.\nЕсли купить сейчас: около 0 ₽ в день; с 20 октября может не хватать, больше всего — 30 000 ₽.");
    expect(s).toEqual({ kind: "cash_gap", line: expect.stringContaining("может не хватать") });
    expect(shouldShowVerdictActions({ impact, smartSuggestion: s })).toBe(false);
  });
  it("never under user messages, non-verdicts or proposal cards", () => {
    expect(shouldShowVerdictActions({ me: true, impact: { verdict: "yes" } })).toBe(false);
    expect(shouldShowVerdictActions({ impact: undefined })).toBe(false);
    expect(shouldShowVerdictActions({ impact: { verdict: "yes" }, proposal: { id: "x" } })).toBe(false);
    expect(smartSuggestionFor(null)).toBeNull();
  });
});
