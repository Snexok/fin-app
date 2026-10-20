// Детерминированные выводы дашборда: форматирование, статистика, шаблоны и пороги «мало данных»/«шум».
import { describe, expect, it } from "vitest";
import type { Dashboard, DayPoint, FunnelStage, Period } from "../lib/analytics-metrics";
import { biggestDrop, int, kpis, mins, pct, pp, rel, rolling, significantCount, takeaways, weekdayPeak, zProp } from "../lib/analytics-insights";

const NB = "\u00a0";
const strip = (s: string) => s.replace(/\u00a0/g, " ");

function stages(ns: number[], unknown: Record<string, number> = {}): FunnelStage[] {
  const keys = ["started", "balance", "income", "preview", "payments", "reserve", "essentialDaily", "goal", "completed"];
  return keys.map((key, i) => {
    const prev = i ? ns[i - 1] : ns[0];
    return { key, n: ns[i], drop: prev - ns[i], dropRate: i ? (prev - ns[i]) / prev : null, ofStart: ns[i] / ns[0], unknownShare: unknown[key] ?? (["balance", "income", "payments", "reserve", "essentialDaily", "goal"].includes(key) ? 0 : null), skippedShare: null };
  });
}
function period(over: Partial<Period> = {}): Period {
  const ns = [200, 190, 130, 128, 120, 115, 112, 110, 100];
  return {
    from: "2026-09-15T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z", active: 500, newUsers: 200, wauEnd: 300, activeUserWeeks: 1200,
    activation: { starters: 200, matured: 200, activated: 140, rate: 0.7, reached: 150, p50Min: 3, buckets: [10, 60, 60, 10, 5, 5], never: 50 },
    funnel: { attempts: 200, stages: stages(ns, { reserve: 0.42 }), completed: 100, completion: 0.5 },
    asks: { total: 1200, askers: 300, perActiveWeek: 1, freq: [200, 100, 120, 70, 10], repeatShare: 0.66 },
    verdicts: { fits_plan: 600, reduces_daily_margin: 300, touches_protected_money: 150, cash_gap: 100, insufficient_data: 50 },
    reminders: {
      kinds: [
        { kind: "payday", sent: 400, recipients: 200, clicked: 200, ctr: 0.5, disabled: 2, disableRate: 0.01 },
        { kind: "morning", sent: 400, recipients: 200, clicked: 28, ctr: 0.07, disabled: 20, disableRate: 0.1 },
      ],
      sent: 800, clicked: 228, ctr: 0.285, disabledAll: 3, blocked: 1, recipients: 300,
      effect: { remindedDays: 1000, remindedActive: 400, otherDays: 5000, otherActive: 500, lift: 0.3 },
    },
    retention: { d1: { n: 200, returned: 60, rate: 0.3 }, d7: { n: 200, returned: 80, rate: 0.4 } },
    value: { proposalsCreated: 10, proposalsConfirmed: 8, completion: 0.8, corrections: 1, notUnderstood: 2 },
    ...over,
  };
}
function series(days: number, dau: (wd: number, i: number) => number): DayPoint[] {
  const start = Date.parse("2026-09-15T00:00:00Z");
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    const v = dau(new Date(`${day}T00:00:00Z`).getUTCDay(), i);
    return { day, dau: v, wau: v * 3, asks: v, newUsers: 5, starters: 7, activated: 5, matured: 7, remSent: 20, remClicked: 6, web: v, telegram: 0, miniapp: 0 };
  });
}
function dash(over: Partial<Dashboard> = {}): Dashboard {
  return {
    generatedAt: "2026-10-15T12:00:00.000Z", days: 30, channel: null, demo: false, minCohort: 5, minSample: 30,
    totals: { events: 1, subjects: 1 }, cur: period(), prev: period({ activation: { ...period().activation, activated: 100, rate: 0.5 }, wauEnd: 200 }),
    series: series(30, (wd) => (wd === 1 ? 160 : wd === 6 ? 100 : 130)), prevSeries: [],
    cohorts: [0.3, 0.32, 0.38, 0.41].map((r, i) => ({ week: `2026-09-${String(7 + i * 7).padStart(2, "0")}`, size: 100, cells: [{ day: 1, matured: 100, rate: 0.3 }, { day: 7, matured: 100, rate: r }, { day: 14, matured: 0, rate: null }, { day: 30, matured: 0, rate: null }] })),
    verdictWeeks: [],
    channels: [
      { channel: "web", active: 200, share: 0.4, activation: 0.6, starters: 100, d7: 0.3, d7n: 100, asksPerActiveWeek: 1 },
      { channel: "telegram", active: 300, share: 0.6, activation: 0.8, starters: 100, d7: 0.5, d7n: 100, asksPerActiveWeek: 1.2 },
      { channel: "miniapp", active: 10, share: 0.02, activation: 0.9, starters: 8, d7: null, d7n: 3, asksPerActiveWeek: null },
    ],
    ...over,
  };
}

describe("insights: formatting and statistics", () => {
  it("formats Russian numbers with non-breaking spaces", () => {
    expect(pct(0.316)).toBe(`32${NB}%`);
    expect(pct(0.2894, 1)).toBe(`28,9${NB}%`);
    expect(pct(null)).toBe("—");
    expect(pp(0.071)).toBe(`+7,1${NB}п.п.`);
    expect(pp(-0.04)).toBe(`−4${NB}п.п.`);
    expect(rel(-0.13)).toBe(`−13${NB}%`);
    expect(int(12345)).toBe(`12${NB}345`);
    expect([mins(0.4), mins(3.2), mins(90), mins(3000)].map(strip)).toEqual(["<1 мин", "3 мин", "1,5 ч", "2,1 дн"]);
  });
  it("z-test needs ≥ 30 per group and detects real differences", () => {
    expect(zProp(10, 20, 5, 20)).toBeNull();
    expect(Math.abs(zProp(52, 100, 50, 100)!)).toBeLessThan(1.96);
    expect(zProp(70, 100, 40, 100)!).toBeGreaterThan(1.96);
    expect(zProp(2, 100, 0, 100)).toBeNull(); // слишком мало «успехов» для нормального приближения
    expect(significantCount(140, 100)).toBe(true);
    expect(significantCount(105, 100)).toBe(false);
    expect(significantCount(12, 5)).toBe(false); // мало событий
  });
  it("rolling share and weekday peak", () => {
    const s = series(14, () => 10);
    s[0].activated = 0; s[0].matured = 2;
    expect(rolling(s, "activated", "matured", 5)[0]).toBeNull(); // знаменатель < 5
    expect(rolling(s, "activated", "matured", 5)[6]).toBeCloseTo(30 / 44);
    expect(weekdayPeak(series(13, (wd) => wd + 1))).toBeNull(); // меньше двух недель
    expect(weekdayPeak(series(28, () => 50))).toBeNull(); // нет сезонности
    expect(weekdayPeak(series(28, (wd) => (wd === 1 ? 160 : wd === 6 ? 100 : 130)))).toEqual({ peak: 1, low: 6, ratio: 1.6 });
  });
  it("biggest drop ignores small funnels", () => {
    expect(biggestDrop(period().funnel)!.key).toBe("income");
    expect(biggestDrop({ ...period().funnel, attempts: 10 })).toBeNull();
  });
});

describe("insights: KPI cards and takeaways", () => {
  it("builds five KPIs with deterministic texts and significance", () => {
    const k = kpis(dash());
    expect(k.map((x) => x.id)).toEqual(["activation", "d7", "wau", "asks", "reminders"]);
    const [act, d7, wau, asks, rem] = k;
    expect(act).toMatchObject({ value: `70${NB}%`, delta: `+20${NB}п.п.`, trend: "up", good: true });
    expect(strip(act.insight)).toBe("Больше всего теряем на шаге «Доход»: −32 % дошедших.");
    expect(d7.trend).toBe("noise"); // та же доля в прошлом периоде
    expect(strip(d7.insight)).toBe("Бот удерживает лучше: 50 % против 30 % (веб).");
    expect(wau).toMatchObject({ value: "300", trend: "up", good: true });
    expect(strip(wau.insight)).toBe("Пик — по понедельникам: в 1,6 раза больше, чем по субботам.");
    expect(asks.trend).toBe("noise");
    expect(strip(rem.insight)).toBe("Лучше всего — «День дохода» (50 %), хуже — «Утро» (7 %).");
    expect(kpis(dash()).map((x) => x.insight)).toEqual(k.map((x) => x.insight)); // детерминированно
  });
  it("says «мало данных» instead of drawing conclusions on small samples", () => {
    const small = period({ activation: { ...period().activation, matured: 12, activated: 8, rate: 8 / 12 }, retention: { d1: { n: 4, returned: 1, rate: null }, d7: { n: 4, returned: 1, rate: null } } });
    const k = kpis(dash({ cur: small }));
    expect(strip(k[0].insight)).toBe("Мало данных: 12 начавших — выводы рано.");
    expect(k[0].trend).toBe("na");
    expect(strip(k[1].insight)).toBe("Мало данных: 4 человек с закрытым окном D7.");
  });
  it("hides the reminders KPI for non-Telegram channels", () => {
    expect(kpis(dash({ channel: "web" })).map((x) => x.id)).not.toContain("reminders");
    expect(takeaways(dash({ channel: "web" })).reminders).toBe("Напоминания приходят только в Telegram.");
  });
  it("writes section takeaways", () => {
    const t = takeaways(dash());
    expect(strip(t.funnel)).toBe("Доходят до конца 50 %. Больше всего теряем на шаге «Доход» (−32 %); на «Резерв» 42 % отвечают «не знаю».");
    expect(strip(t.ttv)).toBe("65 % получают прогноз быстрее 10 минут, 25 % не получают его за сутки. Медиана среди получивших — 3 мин.");
    expect(strip(t.retention)).toBe("D7 у последних когорт вырос до 40 % (было 31 %).");
    expect(strip(t.usage)).toBe("40 % активных не спрашивали; 40 % спросили 2 раза и больше.");
    expect(strip(t.verdicts)).toBe("Чаще всего — «Вписывается» (50 %).");
    expect(strip(t.reminders)).toBe("CTR 28,5 %; чаще всего выключают «Утро» (10,0 % получателей).");
    expect(strip(t.effect)).toBe("За сутки после напоминания заходят 40 % получателей, в обычные дни — 10 % (+30 п.п.). Это наблюдаемая связь, не доказанный эффект.");
    expect(strip(t.channels)).toBe("Больше всего активных — бот (60 %). Активация выше в канале «Бот»: 80 % против 60 %. По Mini App мало данных.");
    expect(strip(t.activity)).toBe("DAU стабилен; пик по понедельникам.");
  });
  it("does not claim a channel difference that is within noise", () => {
    const channels = dash().channels.map((c) => (c.channel === "telegram" ? { ...c, activation: 0.64 } : c));
    expect(strip(takeaways(dash({ channels })).channels)).toBe("Больше всего активных — бот (60 %). Активация по каналам различается в пределах шума (60 %–64 %). По Mini App мало данных.");
  });
  it("labels noise and short periods", () => {
    const e = { remindedDays: 100, remindedActive: 21, otherDays: 100, otherActive: 20, lift: 0.01 };
    const cur = period({ reminders: { ...period().reminders, effect: e } });
    expect(takeaways(dash({ cur })).effect).toBe("Разница между днями с напоминанием и без — в пределах шума.");
    expect(takeaways(dash({ series: series(5, () => 10) })).activity).toBe("Короткий период — смотрите 30 или 90 дней.");
    expect(takeaways(dash({ cohorts: [] })).retention).toBe("Пока мало созревших когорт для тренда.");
  });
});
