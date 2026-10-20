import { describe, expect, it } from "vitest";
import { deltaText } from "../app/internal/analytics/live-format";

const sp = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

describe("deltaText (сравнение с прошлым периодом в подсказке)", () => {
  it("counts: relative %, arrow and tone", () => {
    expect(sp(deltaText(213, 144, "int", true).text)).toBe("▲ +48 %");
    expect(deltaText(213, 144, "int", true).tone).toBe("up");
    expect(sp(deltaText(90, 120, "int").text)).toBe("▼ −25 %");
    expect(deltaText(90, 120, "int", true).tone).toBe("down");
    expect(deltaText(90, 120, "int").tone).toBe("neutral");
  });
  it("noise, few data, missing and zero prev", () => {
    expect(sp(deltaText(110, 100, "int", false).text)).toBe("≈ +10 % · шум");
    expect(deltaText(110, 100, "int", false).tone).toBe("noise");
    expect(sp(deltaText(6, 3, "int", "few").text)).toBe("+100 % · мало данных");
    expect(deltaText(5, null, "int").tone).toBe("na");
    expect(sp(deltaText(4, 0, "int").text)).toBe("▲ +4");
    expect(deltaText(7, 7, "int").text).toBe("без изменений");
  });
  it("shares: percentage points", () => {
    expect(sp(deltaText(0.72, 0.639, "pct", true).text)).toBe("▲ +8,1 п.п.");
    expect(sp(deltaText(0.3, 0.32, "pct", false).text)).toBe("≈ −2,0 п.п. · шум");
  });
});

import { alignPrev, prevDayOf } from "../app/internal/analytics/live-format";

const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => ({ day: new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10) }));

describe("сравнение: выравнивание и края", () => {
  it("current missing, few-equal, zero prev kept", () => {
    expect(deltaText(null, 0.64, "pct", true).text).toBe("нет данных за этот период");
    expect(deltaText(3, 3, "int", "few").text).toBe("без изменений · мало данных");
    expect(deltaText(0, 0, "int", "few").text).toBe("без изменений · мало данных");
  });
  it.each([7, 30, 90])("aligns by expected date for %i days", (n) => {
    const cur = days("2026-09-01", n);
    const prev = days(prevDayOf("2026-09-01", n), n).map((d, i) => ({ ...d, v: i }));
    expect(alignPrev(cur, prev, n, (p) => p.v)).toEqual(prev.map((p) => p.v));
    expect(prevDayOf(cur[0].day, n)).toBe(prev[0].day);
  });
  it("a missing previous day gives null without shifting neighbours; zero stays zero", () => {
    const cur = days("2026-10-01", 7);
    const prev = days("2026-09-24", 7).map((d, i) => ({ ...d, v: i === 0 ? 0 : i * 10 })).filter((_, i) => i !== 3);
    expect(alignPrev(cur, prev, 7, (p) => p.v)).toEqual([0, 10, 20, null, 40, 50, 60]);
  });
  it("empty previous period → all null (cmp shows «нет данных»)", () => {
    expect(alignPrev(days("2026-10-01", 3), [] as { day: string; v: number }[], 3, (p) => p.v)).toEqual([null, null, null]);
  });
});
