// Совместимый слой (рубли, старые имена полей) поверх нового движка.
// Изменённые ожидания по сравнению со старыми тестами отмечены "было:" — это исправления §5.
import { describe, it, expect } from "vitest";
import { snapshot, purchaseImpact, validateProfile, daysBetween, type FinanceProfile } from "../lib/engine";

const T = "2026-10-15";
const base: FinanceProfile = {
  balance: 60000,
  nextIncome: { date: "2026-10-25", amount: 80000 },
  payments: [{ name: "Аренда", amount: 30000, date: "2026-10-20" }, { name: "Интернет", amount: 1000, date: "2026-11-05" }],
  reserve: 10000,
  goal: null,
};

describe("snapshot", () => {
  it("free money and safe daily", () => {
    const s = snapshot(base, T);
    expect(s.daysToIncome).toBe(11); // было 10: день дохода тоже требует трат до поступления денег
    expect(s.mandatoryBeforeIncome).toBe(30000);
    expect(s.freeMoney).toBe(20000);
    expect(s.safeDaily).toBe(1818.18); // было 2000; копейки, округление вниз
    expect(s.upcomingPayments).toHaveLength(2);
    expect(s.horizonEnd).toBe("2026-10-25");
  });
  it("overdue unpaid payments count; goal set-aside is clamped and exact", () => {
    const p = { ...base, payments: [...base.payments, { name: "old", amount: 999, date: "2026-10-01" }], goal: { name: "Отпуск", amount: 30000, date: "2027-01-22" } };
    const s = snapshot(p, T);
    expect(daysBetween(T, "2027-01-22")).toBe(99); // 100 дней накопления включительно
    expect(s.mandatoryBeforeIncome).toBe(30999); // было: просроченный платёж игнорировался
    expect(s.goalDailyNeed).toBe(300);
    expect(s.goalSetAside).toBe(3300); // 11 дней × 300
    expect(s.freeMoney).toBe(60000 - 30999 - 10000 - 3300);
  });
  it("negative free gives zero safe daily", () => {
    const s = snapshot({ ...base, balance: 30000 }, T);
    expect(s.freeMoney).toBe(-10000);
    expect(s.safeDaily).toBe(0);
  });
  it("income today counts as 1 day", () => {
    expect(snapshot({ ...base, nextIncome: { date: T, amount: 1 } }, T).daysToIncome).toBe(1);
  });
  it("past income is not stretched to 1 day (было: Math.max(1, ...))", () => {
    const s = snapshot({ ...base, nextIncome: { date: "2026-10-10", amount: 80000 } }, T);
    expect(s.overdueIncome).toBe(true);
    expect(s.daysToIncome).toBe(30);
    expect(s.limitations).toContain("INCOME_OVERDUE");
  });
});

describe("purchaseImpact", () => {
  it("small purchase -> yes", () => {
    const r = purchaseImpact(base, 3000, T);
    expect(r.freeAfter).toBe(17000);
    expect(r.safeDailyAfter).toBe(1545.45);
    expect(r.risk).toBe("none");
    expect(r.verdict).toBe("yes");
  });
  it("big share -> careful", () => {
    expect(purchaseImpact(base, 15000, T).verdict).toBe("careful");
  });
  it("exceeds free but not mandatory -> medium, wait", () => {
    const r = purchaseImpact(base, 25000, T);
    expect(r.risk).toBe("medium");
    expect(r.assessment).toBe("touches_protected_money");
    expect(r.cashGap).toBe(false);
    expect(r.verdict).toBe("wait");
    expect(r.scenarios.afterIncome!.freeAfter).toBeGreaterThan(0);
    expect(r.scenarios.afterIncome!.periodDays).toBeGreaterThan(11); // явный горизонт, не придуманные 30 дней после дохода
  });
  it("cash gap -> high", () => {
    const r = purchaseImpact(base, 40000, T);
    expect(r.cashGap).toBe(true);
    expect(r.risk).toBe("high");
  });
  it("goal delay is no longer invented (было: 5 дней)", () => {
    const p = { ...base, goal: { name: "Отпуск", amount: 30000, date: "2027-01-23" } };
    expect(purchaseImpact(p, 18500, T).goalDelayDays).toBe(0);
  });
  it("rejects bad price, including Infinity", () => {
    expect(() => purchaseImpact(base, 0, T)).toThrow();
    expect(() => purchaseImpact(base, Infinity, T)).toThrow();
    expect(() => purchaseImpact(base, NaN, T)).toThrow();
    expect(() => purchaseImpact(base, -5, T)).toThrow();
  });
  it("validates strictly", () => {
    expect(validateProfile(base)).toEqual([]);
    expect(validateProfile({ ...base, balance: NaN }).length).toBe(1);
    expect(validateProfile({ ...base, nextIncome: { date: "2026-02-31", amount: 1 } }).length).toBe(1);
    expect(validateProfile({ ...base, payments: [{ name: "x", amount: 5, date: "2026-13-01" }] }).length).toBe(1);
  });
});
