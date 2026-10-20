// v28: единый словарь (вопрос / ответ «Можно?»), без «проверки»; заголовок вердикта без ошибки согласования.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { forecast, simulatePurchase, type ForecastInput } from "../lib/engine";
import { purchaseText, snapshotText } from "../lib/coach";

const input = (essential: bigint | null): ForecastInput => ({
  today: "2026-10-15", balanceMinor: 6_000_000n, reserveMinor: 1_000_000n, essentialDailyMinor: essential, planningDays: null, goal: null,
  occurrences: [
    { id: "a", direction: "expense", name: "Аренда", remainingMinor: 3_000_000n, dueOn: "2026-10-20", certainty: "confirmed" },
    { id: "b", direction: "income", name: "Зарплата", remainingMinor: 8_000_000n, dueOn: "2026-10-25", certainty: "confirmed" },
  ],
} as never);

describe("v28: формулировки ответа «Можно?»", () => {
  it("заголовок: «Можно: <что> за <цена> — в рамках плана», без «вписывается»", () => {
    for (const ess of [30_000n, null]) {
      const t = purchaseText(simulatePurchase(input(ess), { item: "куртка", priceMinor: 50_000n }));
      expect(t.split("\n")[0]).toMatch(/^(Похоже, можно|Можно): куртка за 500[\s\u00a0]₽ — в рамках плана/);
      expect(t).not.toMatch(/вписывается/i);
    }
  });
  it("«аккуратно»: формулировка зависит от того, знаем ли еду и транспорт", () => {
    const heads = new Set<string>();
    for (const ess of [50_000n, null]) for (let p = 1000; p <= 20000; p += 500) {
      const s = simulatePurchase(input(ess), { item: "x", priceMinor: BigInt(p) * 100n });
      if (s.now.assessment === "reduces_daily_margin") heads.add(purchaseText(s).split("\n")[0].replace(/^.*— /, ""));
    }
    expect([...heads]).toEqual(expect.arrayContaining(["денег сверх еды и транспорта на день останется меньше половины."]));
  });
  it("сводка: дневная сумма — на всё, разовая — сверх еды и транспорта", () => {
    expect(snapshotText(forecast(input(50_000n)))).toMatch(/в день до .* — на еду, транспорт и покупки\. Разово на покупки сверх еды и транспорта: /);
    expect(snapshotText(forecast(input(null)))).not.toMatch(/Разово/);
  });
  it("в интерфейсе, боте и дашборде нет «проверки» и «Суммы проверки»", () => {
    for (const f of ["../app/page.tsx", "../app/plus.tsx", "../app/invite.tsx", "../lib/bot.ts", "../lib/plans/copy.ts", "../lib/reminders.ts", "../app/internal/analytics/page.tsx", "../lib/analytics-insights.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(src, f).not.toMatch(/Сумма проверки|Проверок|проверк[аиуе]\b(?! ссылк)/);
    }
  });
});
