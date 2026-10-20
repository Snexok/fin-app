import { describe, it, expect } from "vitest";
import { parseAmount, parseAmountMinor, parseDate, parseIntentRegex, parsePaymentLines, parsePaymentsText } from "../lib/parse";
const T = "2026-10-15";
describe("parse", () => {
  it("amounts", () => {
    expect(parseAmount("50 000 руб")).toBe(50000);
    expect(parseAmount("за 15к")).toBe(15000);
    expect(parseAmount("1,5 млн")).toBe(1500000);
    expect(parseAmount("3.5 тыс")).toBe(3500);
    expect(parseAmountMinor("199,90 ₽")).toBe(19990n);
  });
  it("dates", () => {
    expect(parseDate("25.10", T)).toBe("2026-10-25");
    expect(parseDate("5\u00a0ноября", T)).toBe("2026-11-05");
    expect(parseDate("10\u00a0октября", T)).toBe("2027-10-10");
    expect(parseDate("через 10 дней", T)).toBe("2026-10-25");
    expect(parseDate("завтра", T)).toBe("2026-10-16");
  });
  it("intent", () => {
    expect(parseIntentRegex("Можно купить наушники за 15 000?")).toMatchObject({ intent: "purchase", item: "наушники", price: 15000 });
    expect(parseIntentRegex("Хочу купить кроссовки за 8к").item).toBe("кроссовки");
    expect(parseIntentRegex("Сколько можно тратить в день?").intent).toBe("snapshot");
    expect(parseIntentRegex("привет").intent).toBe("other");
  });
});

describe("parser bugs from §5", () => {
  it("'iPhone 15 за 80 000': цена после 'за', а не номер модели", () => {
    expect(parseAmount("iPhone 15 за 80 000")).toBe(80000);
    expect(parseIntentRegex("Можно купить iPhone 15 за 80 000?")).toMatchObject({ intent: "purchase", item: "iPhone 15", price: 80000 });
    expect(parseAmount("PS5 за 50к")).toBe(50000);
  });
  it("отрицательная сумма не становится положительной", () => {
    expect(parseAmount("-5000")).toBeNull();
    expect(parseIntentRegex("можно купить за -5000").error).toBe("NEGATIVE_AMOUNT");
  });
  it("невозможные даты отклоняются", () => {
    expect(parseDate("31.02", T)).toBeNull();
    expect(parseDate("2026-02-30", T)).toBeNull();
    expect(parseDate("32.01.2027", T)).toBeNull();
  });
  it("'10-го' после 10-го числа — следующий месяц, а не следующий год", () => {
    expect(parseDate("10-го", T)).toBe("2026-11-10");
    expect(parseDate("20-го", T)).toBe("2026-10-20");
    expect(parseDate("31 числа", "2026-11-05")).toBe("2026-12-31"); // в ноябре нет 31-го: ближайшее реальное 31-е
    expect(parseDate("1\u00a0июня 2027", T)).toBe("2027-06-01");
  });
  it("даты удаляются одинаково перед разбором суммы", () => {
    expect(parseAmount("Аренда 30000 20.10")).toBe(30000);
    expect(parseAmount("25.10 80000")).toBe(80000);
    expect(parseAmount("5\u00a0ноября 1000")).toBe(1000);
    expect(parseAmount("1.5 млн")).toBe(1500000);
  });
  it("платежи: нераспознанные строки не отбрасываются молча", () => {
    const r = parsePaymentLines("Аренда 30000 20.10\nчто-то непонятное\nИнтернет 1000 5 ноября", T);
    expect(r.items).toHaveLength(2);
    expect(r.errors).toEqual([{ line: 2, text: "что-то непонятное", reason: "не понял дату" }]);
    expect(() => parsePaymentsText("Аренда 30000", T)).toThrow();
    expect(parsePaymentLines("нет", T)).toEqual({ items: [], errors: [] });
  });
  it("траты, доходы и ответ-сумма на уточнение", () => {
    expect(parseIntentRegex("Потратил 500 на кофе")).toMatchObject({ intent: "expense", item: "кофе", priceMinor: 50000n });
    expect(parseIntentRegex("Оплатил аренду 30000")).toMatchObject({ intent: "expense", item: "аренда" });
    expect(parseIntentRegex("зарплата пришла")).toMatchObject({ intent: "income" });
    expect(parseIntentRegex("15 тысяч")).toMatchObject({ intent: "amount_only", priceMinor: 1500000n });
    expect(parseIntentRegex("Хочу купить велосипед")).toEqual({ intent: "purchase", item: "велосипед" });
  });
});

describe("item names in nominative", () => {
  it("common category nouns are normalised from accusative", () => {
    expect(parseIntentRegex("Купил одежду за 8000").item).toBe("одежда");
    expect(parseIntentRegex("Потратил 700 на еду").item).toBe("еда");
    expect(parseIntentRegex("Оплатил подписку 299").item).toBe("подписка");
    expect(parseIntentRegex("Можно купить куртку за 9000?").item).toBe("куртка");
    expect(parseIntentRegex("Можно купить iPhone 15 за 80 000?").item).toBe("iPhone 15");
  });
});
