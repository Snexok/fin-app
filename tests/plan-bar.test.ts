// v28: полоса плана «На карте» = платежи до дохода + резерв + на цель + на жизнь до дохода — ровно, в копейках.
// Только показ: числа движка (safeDaily, freeMoney) не меняются.
import { describe, it, expect } from "vitest";
import { forecast, forecastToSnapshot, planBar, snapshot, type ForecastInput, type OccurrenceInput } from "../lib/engine";

const T = "2026-10-15";
const rub = (n: number) => BigInt(Math.round(n * 100));
const income = (dueOn: string, amount: number): OccurrenceInput => ({ id: `i-${dueOn}`, direction: "income", name: "Зарплата", remainingMinor: rub(amount), dueOn, certainty: "committed" });
const pay = (name: string, dueOn: string, amount: number): OccurrenceInput => ({ id: `p-${name}`, direction: "expense", name, remainingMinor: rub(amount), dueOn, certainty: "committed" });
const base = (o: Partial<ForecastInput> = {}): ForecastInput => ({ today: T, balanceMinor: rub(60000), reserveMinor: rub(10000), essentialDailyMinor: null, occurrences: [income("2026-10-25", 80000), pay("Аренда", "2026-10-20", 30000)], goal: null, ...o });

const CASES: [string, ForecastInput][] = [
  ["платёж и резерв", base()],
  ["с копейками и едой", base({ balanceMinor: rub(48123.45), essentialDailyMinor: rub(777.77), occurrences: [income("2026-10-31", 85000), pay("Аренда", "2026-10-18", 25000.5), pay("Связь", "2026-10-29", 600.33)] })],
  ["просроченный платёж ложится на сегодня", base({ occurrences: [income("2026-10-25", 80000), pay("Интернет", "2026-10-10", 1000), pay("Аренда", "2026-10-20", 30000)] })],
  ["цель: откладываем + уже накоплено на карте", base({ goal: { name: "Отпуск", targetMinor: rub(60000), savedMinor: rub(5000), savedInBalance: true, targetDate: "2027-06-01" } })],
  ["цель без накоплений", base({ balanceMinor: rub(90000), goal: { name: "Подушка", targetMinor: rub(100000), savedMinor: 0n, savedInBalance: false, targetDate: "2027-10-01" } })],
  ["без дохода — 30 дней", base({ occurrences: [pay("Аренда", "2026-10-20", 30000)] })],
  ["не хватает на всё запланированное", base({ balanceMinor: rub(20000), occurrences: [income("2026-10-25", 80000), pay("Аренда", "2026-10-20", 30000)] })],
];

describe("planBar: части складываются в «На карте»", () => {
  for (const [name, input] of CASES) {
    it(name, () => {
      const f = forecast(input);
      const b = planBar(f);
      expect(b.balanceMinor).toBe(input.balanceMinor);
      expect(b.paymentsMinor + b.reserveMinor + b.goalMinor + b.lifeMinor).toBe(b.balanceMinor);
      expect(b.paymentsMinor).toBe(f.mandatoryMinor);
      expect(b.reserveMinor).toBe(f.reserveMinor);
      expect(b.goalMinor).toBe((f.goal?.setAsideInHorizonMinor ?? 0n) + f.protectedSavedMinor);
      // «Как считаем»: дневная сумма не больше «на жизнь» / дни (минимум по всем дням до дохода).
      if (b.lifeMinor >= 0n) expect(f.safeDailyMinor * BigInt(f.days)).toBeLessThanOrEqual(b.lifeMinor);
      // В рублях (снимок для UI) — та же сумма с точностью до копейки.
      const s = forecastToSnapshot(f).planBar;
      expect(Math.round((s.payments + s.reserve + s.goal + s.life) * 100)).toBe(Math.round(s.balance * 100));
      expect(s.balance).toBe(Number(input.balanceMinor) / 100);
    });
  }

  it("нехватка: «на жизнь» отрицательная, а не обрезанная до нуля", () => {
    const b = planBar(forecast(CASES[6][1]));
    expect(b.lifeMinor).toBe(rub(20000 - 30000 - 10000));
  });

  it("числа движка не меняются: снимок совпадает с прежними полями", () => {
    const f = forecast(CASES[1][1]);
    const s = forecastToSnapshot(f);
    expect(s.safeDaily).toBe(Number(f.safeDailyMinor) / 100);
    expect(s.freeMoney).toBe(Number(f.freeMoneyMinor ?? f.dailyEnvelopeMinor) / 100);
    expect(s.mandatoryBeforeIncome).toBe(Number(f.mandatoryMinor) / 100);
  });

  it("совместимый профиль в рублях (веб): полоса сходится с балансом профиля", () => {
    const s = snapshot({ balance: 48000, reserve: 10000, nextIncome: { date: "2026-10-23", amount: 85000 }, payments: [{ name: "Аренда", amount: 25000, date: "2026-10-18" }], goal: { name: "Отпуск", amount: 60000, date: "2027-06-01" }, essentialDaily: 900 }, T);
    expect(s.planBar.balance).toBe(48000);
    expect(Math.round((s.planBar.payments + s.planBar.reserve + s.planBar.goal + s.planBar.life) * 100)).toBe(4800000);
  });
});
