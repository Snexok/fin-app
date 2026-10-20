// Приёмочные проверки движка (ARCHITECTURE.md §13, "Финансовый движок" 1–12 + инварианты).
import { describe, it, expect } from "vitest";
import {
  forecast, simulatePurchase, remainingOf, computeBalance, monthlyDates, isValidDate, localDate, rublesToMinor, formatRub, floorDiv,
  type ForecastInput, type OccurrenceInput,
} from "../lib/engine";

const T = "2026-10-15";
const rub = (n: number) => BigInt(Math.round(n * 100));
const income = (dueOn: string, amount: number, certainty: OccurrenceInput["certainty"] = "committed"): OccurrenceInput => ({ id: `i-${dueOn}-${certainty}`, direction: "income", name: "Зарплата", remainingMinor: rub(amount), dueOn, certainty });
const pay = (name: string, dueOn: string, amount: number): OccurrenceInput => ({ id: `p-${name}`, direction: "expense", name, remainingMinor: rub(amount), dueOn, certainty: "committed" });
const base = (o: Partial<ForecastInput> = {}): ForecastInput => ({ today: T, balanceMinor: rub(60000), reserveMinor: rub(10000), essentialDailyMinor: null, occurrences: [income("2026-10-25", 80000), pay("Аренда", "2026-10-20", 30000)], goal: null, ...o });

describe("1. доход сегодня, завтра, с прошедшей датой", () => {
  it("доход сегодня: один день трат, деньги в конце дня", () => {
    const f = forecast(base({ occurrences: [income(T, 50000)] }));
    expect(f.days).toBe(1);
    expect(f.horizonEnd).toBe(T);
    expect(f.safeDailyMinor).toBe(rub(50000)); // 60000 - 10000 резерв, доход не помогает сегодняшним тратам
  });
  it("доход завтра: два дня трат", () => {
    const f = forecast(base({ occurrences: [income("2026-10-16", 50000)] }));
    expect(f.days).toBe(2);
    expect(f.safeDailyMinor).toBe(rub(25000));
  });
  it("прошедший неподтверждённый доход не учитывается и не переносится на завтра", () => {
    const f = forecast(base({ occurrences: [income("2026-10-10", 80000)] }));
    expect(f.limitations).toContain("INCOME_OVERDUE");
    expect(f.limitations).toContain("INCOME_UNKNOWN");
    expect(f.horizonKind).toBe("planning_period");
    expect(f.days).toBe(30);
    expect(f.incomeInHorizonMinor).toBe(0n);
    expect(f.overdueIncomes).toHaveLength(1);
  });
});

describe("2. платёж в день дохода", () => {
  it("учитывается: деньги приходят позже платежа", () => {
    const f = forecast(base({ occurrences: [income("2026-10-25", 80000), pay("Кредит", "2026-10-25", 20000)] }));
    expect(f.mandatoryMinor).toBe(rub(20000));
    expect(f.payments[0].inHorizon).toBe(true);
  });
  it("разрыв в день дохода виден, даже если доход его покрывает к вечеру", () => {
    const f = forecast(base({ balanceMinor: rub(5000), reserveMinor: 0n, occurrences: [income("2026-10-25", 80000), pay("Кредит", "2026-10-25", 8000)] }));
    expect(f.gaps.mandatory).toEqual({ firstDate: "2026-10-25", amountMinor: rub(3000), worstDate: "2026-10-25" });
  });
});

describe("3. разрыв до дохода при положительном конечном остатке", () => {
  it("5000 сейчас, завтра платёж 8000, послезавтра доход 10000", () => {
    const f = forecast(base({ balanceMinor: rub(5000), reserveMinor: 0n, occurrences: [pay("Платёж", "2026-10-16", 8000), income("2026-10-17", 10000)] }));
    expect(f.gaps.mandatory).toEqual({ firstDate: "2026-10-16", amountMinor: rub(3000), worstDate: "2026-10-16" });
    expect(f.safeDailyMinor).toBe(0n);
  });
});

describe("4. просроченный неоплаченный платёж", () => {
  it("ложится на сегодня и уменьшает свободные деньги", () => {
    const f = forecast(base({ occurrences: [income("2026-10-25", 80000), pay("Аренда", "2026-10-20", 30000), pay("Интернет", "2026-10-10", 1000)] }));
    expect(f.mandatoryMinor).toBe(rub(31000));
    expect(f.payments.find((p) => p.name === "Интернет")!.overdue).toBe(true);
  });
});

describe("5. частичная оплата и её отмена", () => {
  it("remaining = planned - settled, сторно возвращает обязательство", () => {
    expect(remainingOf(rub(30000), [rub(10000)])).toBe(rub(20000));
    expect(remainingOf(rub(30000), [rub(10000), -rub(10000)])).toBe(rub(30000));
    expect(remainingOf(rub(30000), [rub(35000)])).toBe(0n); // переплата не делает обязательство отрицательным
  });
});

describe("6. отрицательный остаток, резерв больше остатка", () => {
  it("отрицательный остаток — сразу разрыв", () => {
    const f = forecast(base({ balanceMinor: -rub(1000), reserveMinor: 0n }));
    expect(f.gaps.mandatory?.firstDate).toBe(T);
    expect(f.safeDailyMinor).toBe(0n);
  });
  it("резерв больше остатка: план невыполним, не разрыв на обязательства", () => {
    const f = forecast(base({ balanceMinor: rub(5000), reserveMinor: rub(10000), occurrences: [income("2026-10-25", 80000)] }));
    expect(f.limitations).toContain("PLAN_INFEASIBLE");
    expect(f.safeDailyMinor).toBe(0n);
    expect(f.gaps.mandatory).toBeNull();
    expect(f.gaps.protected?.amountMinor).toBe(rub(5000));
  });
});

describe("7. неизвестный нерегулярный доход", () => {
  it("expected/speculative не входят в консервативный прогноз; горизонт — явный период", () => {
    const f = forecast(base({ occurrences: [income("2026-10-25", 80000, "expected"), income("2026-10-20", 50000, "speculative")], planningDays: 20 }));
    expect(f.horizonKind).toBe("planning_period");
    expect(f.days).toBe(20);
    expect(f.limitations).toContain("INCOME_UNKNOWN");
    const g = forecast(base({ occurrences: [income("2026-10-25", 80000, "expected")], scenario: "expected" }));
    expect(g.horizonEnd).toBe("2026-10-25");
  });
});

describe("8. цель: накоплена, просрочена, заканчивается раньше горизонта", () => {
  const goal = (target: number, saved: number, date: string) => ({ name: "Отпуск", targetMinor: rub(target), savedMinor: rub(saved), savedInBalance: false, targetDate: date });
  it("уже накоплена: взносов нет", () => {
    const f = forecast(base({ goal: goal(30000, 30000, "2027-01-01") }));
    expect(f.goal!.remainingMinor).toBe(0n);
    expect(f.goal!.setAsideInHorizonMinor).toBe(0n);
  });
  it("просрочена: флаг, недостающая сумма защищается целиком (по ревью)", () => {
    const f = forecast(base({ goal: goal(30000, 1000, "2026-10-01") }));
    expect(f.goal!.overdue).toBe(true);
    expect(f.limitations).toContain("GOAL_OVERDUE");
    expect(f.goal!.setAsideInHorizonMinor).toBe(rub(29000));
  });
  it("срок раньше горизонта: отложенное не превышает остатка цели (clamp)", () => {
    const f = forecast(base({ goal: goal(3000, 0, "2026-10-17"), occurrences: [income("2026-11-30", 80000)] }));
    expect(f.goal!.setAsideInHorizonMinor).toBe(rub(3000));
  });
  it("накопленное внутри остатка защищается (S)", () => {
    const a = forecast(base({ goal: { ...goal(30000, 5000, "2027-06-01"), savedInBalance: true } }));
    const b = forecast(base({ goal: goal(30000, 5000, "2027-06-01") }));
    expect(b.dailyEnvelopeMinor - a.dailyEnvelopeMinor).toBe(rub(5000));
  });
});

describe("9. платёж 31-го, високосный февраль", () => {
  it("31-е -> последний день месяца, следующий месяц снова от якоря", () => {
    expect(monthlyDates("2027-01-31", "2027-01-01", "2027-05-31")).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]);
    expect(monthlyDates("2028-01-31", "2028-02-01", "2028-02-29")).toEqual(["2028-02-29"]);
  });
  it("строгие даты", () => {
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2027-02-29")).toBe(false);
    expect(isValidDate("2026-02-31")).toBe(false);
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(() => forecast(base({ today: "2026-02-30" }))).toThrow();
  });
  it("сегодня — в зоне пользователя, а не UTC", () => {
    const now = new Date("2026-10-15T22:30:00Z");
    expect(localDate(now, "Europe/Moscow")).toBe("2026-10-16");
    expect(localDate(now, "UTC")).toBe("2026-10-15");
  });
});

describe("10. подписка после первой оплаты", () => {
  it("учитываются все списания в горизонте, а не только первое", () => {
    const input = base({ occurrences: [income("2027-01-15", 80000)], balanceMinor: rub(100000) });
    const one = simulatePurchase(input, { item: "подписка", priceMinor: rub(1000) });
    const rec = simulatePurchase(input, { item: "подписка", priceMinor: rub(1000), recurring: { cadence: "monthly" } });
    // 15.10, 15.11, 15.12, 15.01 (в день дохода, до поступления) = 4 платежа
    expect(one.now.envelopeAfterMinor - rec.now.envelopeAfterMinor).toBe(rub(3000));
  });
});

describe("11. копейки и остаток от деления дневного лимита", () => {
  it("дневной лимит округляется вниз до копейки, без накопления ошибок", () => {
    const f = forecast(base({ balanceMinor: rub(100.0), reserveMinor: 0n, occurrences: [income("2026-10-17", 1)] })); // 3 дня
    expect(f.safeDailyMinor).toBe(3333n);
    expect(f.safeDailyMinor * 3n <= rub(100)).toBe(true);
  });
  it("деньги в копейках", () => {
    expect(rublesToMinor("1\u00a0500,50")).toBe(150050n);
    expect(rublesToMinor(0.1 + 0.2)).toBe(30n);
    expect(() => rublesToMinor(Infinity)).toThrow();
    expect(formatRub(150050n)).toBe("1\u00a0500\u00a0₽");
    expect(formatRub(150050n, { kopecks: true })).toBe("1\u00a0500,50\u00a0₽");
    expect(floorDiv(-7n, 2n)).toBe(-4n);
  });
});

describe("12. операция, уже включённая в начальный остаток", () => {
  it("affects_balance=false не списывается повторно", () => {
    expect(computeBalance(rub(50000), [{ amountMinor: -rub(1000), affectsBalance: false }, { amountMinor: -rub(500), affectsBalance: true }])).toBe(rub(49500));
  });
});

describe("сценарии покупки и вердикт", () => {
  it("Infinity / 0 / отрицательная цена отклоняются", () => {
    expect(() => simulatePurchase(base(), { item: "x", priceMinor: 0n })).toThrow();
    expect(() => simulatePurchase(base(), { item: "x", priceMinor: -1n })).toThrow();
    expect(() => simulatePurchase(base(), { item: "x", priceMinor: 10n ** 13n })).toThrow();
  });
  it("причины разделены: разрыв, защита, запас, норма", () => {
    const s = (p: number) => simulatePurchase(base(), { item: "x", priceMinor: rub(p) }).now.assessment;
    // 11 дней до дохода (15..25 включительно); свободно 60000-30000-10000 = 20000
    expect(s(3000)).toBe("fits_plan");
    expect(s(15000)).toBe("reduces_daily_margin");
    expect(s(25000)).toBe("touches_protected_money");
    expect(s(40000)).toBe("cash_gap");
  });
  it("'подождать' только если вариант после дохода реально лучше", () => {
    const r = simulatePurchase(base(), { item: "x", priceMinor: rub(25000) });
    expect(r.afterIncome).not.toBeNull();
    expect(r.waitIsBetter).toBe(true);
    const huge = simulatePurchase(base(), { item: "x", priceMinor: rub(500000) });
    expect(huge.waitIsBetter).toBe(false);
  });
  it("без известного дохода нет сценария 'после дохода'", () => {
    const r = simulatePurchase(base({ occurrences: [] }), { item: "x", priceMinor: rub(1000) });
    expect(r.afterIncome).toBeNull();
  });
  it("цель: срок не выдумывается", () => {
    const r = simulatePurchase(base({ goal: { name: "Отпуск", targetMinor: rub(30000), savedMinor: 0n, savedInBalance: false, targetDate: "2027-01-23" } }), { item: "x", priceMinor: rub(18500) });
    expect(r.now.goalImpact?.delayDays).toBeNull();
    expect(r.now.goalImpact?.projectedCompletionDate).toBeNull();
  });
  it("с известными повседневными тратами есть свободные деньги и разрыв на жизнь", () => {
    const f = forecast(base({ essentialDailyMinor: rub(1000) }));
    expect(f.freeMoneyMinor).toBe(rub(20000 - 11000));
    expect(f.discretionaryDailyMinor).toBe(f.safeDailyMinor - rub(1000));
    const r = simulatePurchase(base({ essentialDailyMinor: rub(1000) }), { item: "x", priceMinor: rub(25000) });
    expect(r.now.forecast.gaps.essential).not.toBeNull();
    expect(r.now.assessment).toBe("cash_gap");
  });
});

describe("инварианты", () => {
  it("при увеличении цены свободные деньги не растут", () => {
    let prev: bigint | null = null;
    for (let p = 1000; p <= 80000; p += 3700) {
      const v = simulatePurchase(base({ essentialDailyMinor: rub(500) }), { item: "x", priceMinor: rub(p) }).now.freeAfterMinor!;
      if (prev != null) expect(v <= prev).toBe(true);
      prev = v;
    }
  });
  it("сумма обязательных платежей не отрицательна", () => {
    expect(forecast(base({ occurrences: [pay("x", "2026-10-20", 0)] })).mandatoryMinor >= 0n).toBe(true);
  });
  it("оплата обязательства уменьшает остаток и снимает плановое списание без двойного счёта", () => {
    const before = forecast(base());
    const paid = forecast(base({ balanceMinor: rub(30000), occurrences: [income("2026-10-25", 80000), pay("Аренда", "2026-10-20", 0)] }));
    expect(paid.dailyEnvelopeMinor).toBe(before.dailyEnvelopeMinor);
    expect(paid.mandatoryMinor).toBe(0n);
  });
  it("одинаковые входы дают одинаковый результат", () => {
    const j = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(j(simulatePurchase(base(), { item: "x", priceMinor: rub(5000) }))).toBe(j(simulatePurchase(base(), { item: "x", priceMinor: rub(5000) })));
  });
});

describe("review fixes", () => {
  it("everyN=0 is rejected instead of looping forever", () => {
    expect(() => monthlyDates("2026-10-15", "2026-10-15", "2026-12-31", 0)).toThrow(RangeError);
    expect(() => simulatePurchase(base(), { item: "x", priceMinor: 100n, recurring: { cadence: "weekly", everyN: 0 } })).toThrow(RangeError);
  });
  it("overdue goal keeps the whole remaining amount protected and is not feasible", () => {
    const goal = { name: "Отпуск", targetMinor: rub(10000), savedMinor: 0n, savedInBalance: false, targetDate: "2026-10-01" };
    const f = forecast(base({ goal }));
    expect(f.goal!.setAsideInHorizonMinor).toBe(rub(10000));
    expect(f.dailyEnvelopeMinor).toBe(forecast(base()).dailyEnvelopeMinor - rub(10000));
    expect(simulatePurchase(base({ goal }), { item: "x", priceMinor: rub(100) }).now.goalImpact?.deadlineFeasible).toBe(false);
  });
  it("gap reports first date and the date of the worst shortfall", () => {
    const f = forecast(base({ balanceMinor: rub(1000), reserveMinor: 0n, occurrences: [pay("a", "2026-10-16", 1100), pay("b", "2026-10-20", 9900), income("2026-10-25", 80000)] }));
    expect(f.gaps.mandatory).toEqual({ firstDate: "2026-10-16", amountMinor: rub(10000), worstDate: "2026-10-20" });
  });
  it("number rubles use one rounding rule", () => {
    expect(rublesToMinor(2.675)).toBe(268n);
    expect(rublesToMinor(-1.005)).toBe(-101n);
  });
});
