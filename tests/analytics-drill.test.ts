import { describe, expect, it, vi } from "vitest";
vi.mock("next/headers", async () => (await import("./http-helpers")).nextHeadersMock);
import { drillFrom, funnelDrill, takeaway } from "../lib/analytics-drill";
import { dashboard, FUNNEL_ORDER, type AttemptEvent, type FunnelAttempt } from "../lib/analytics-metrics";
import { getDb } from "../lib/db";

const MIN = 60_000, DAY = 86_400_000;
const NOW = Date.parse("2026-10-17T12:00:00Z");
const T0 = Date.parse("2026-10-10T10:00:00Z");
const INCOME = FUNNEL_ORDER.indexOf("income"); // 2

/** Проход, дошедший до этапа k (k = число пройденных этапов подряд); ушедшие на «Доходе» имеют k = INCOME. */
let seq = 0;
function att(channel: string, k: number, extra: { name: string; step?: string; input?: string; dt: number }[] = [], t0 = T0): FunnelAttempt {
  const n = seq++;
  const events: AttemptEvent[] = [{ name: "onboarding_started", step: null, input: null, t: t0 }];
  if (k >= 2) events.push({ name: "onboarding_step_answered", step: "balance", input: "text", t: t0 + MIN });
  if (k >= INCOME) events.push({ name: "onboarding_step_shown", step: "income", input: null, t: t0 + 2 * MIN });
  if (k > INCOME) events.push({ name: "onboarding_step_answered", step: "income", input: n % 2 ? "choice" : "text", t: t0 + 4 * MIN });
  for (const e of extra) events.push({ name: e.name, step: e.step ?? null, input: e.input ?? null, t: t0 + 2 * MIN + e.dt });
  const reached = new Set(FUNNEL_ORDER.slice(0, k));
  return { attempt: `a${n}`, subject: `s${n}`, channel, k, events, x: { reached, outcome: new Map(k > INCOME ? [["income", "answered" as const]] : []), input: new Map() } };
}
const many = (n: number, f: () => FunnelAttempt) => Array.from({ length: n }, f);

describe("drill-down шага воронки", () => {
  it("counts match the funnel definition: base = reached previous stage, dropped = stopped exactly here", () => {
    const cur = [...many(40, () => att("web", INCOME)), ...many(60, () => att("web", INCOME + 1)), ...many(5, () => att("web", 1))];
    const d = drillFrom("income", cur, [], new Map(), NOW, null);
    expect([d.base, d.dropped, d.passed]).toEqual([100, 40, 60]);
    expect(d.rate).toBeCloseTo(0.4);
    expect(d.passMix).toMatchObject({ answered: 60, text: 0, choice: 0 }); // input map пуст в синтетике
    expect(d.passDwell.median).toBe(2);
  });

  it("channel takeaway: significant ratio (Bonferroni) names the channel with a hypothesis", () => {
    const cur = [...many(50, () => att("telegram", INCOME)), ...many(50, () => att("telegram", INCOME + 1)), ...many(20, () => att("web", INCOME)), ...many(80, () => att("web", INCOME + 1))];
    const d = drillFrom("income", cur, [], new Map(), NOW, null);
    expect(d.takeaway.text).toMatch(/^В боте теряем в 2,5 раза больше \(50\s%\s+против\s+20\s%\)\. Гипотеза — проверить клавиатуру/);
    expect(d.takeaway.tone).toBe("warn");
  });

  it("not understood and «no events after show» rules; dwell buckets are honest", () => {
    const nu = many(20, () => att("web", INCOME, [{ name: "onboarding_not_understood", step: "income", input: "text", dt: 0 }]));
    const quiet = many(15, () => att("web", INCOME));
    const corr = many(5, () => att("web", INCOME, [{ name: "onboarding_corrected", step: "balance", input: "text", dt: 2 * MIN }]));
    const d = drillFrom("income", [...nu, ...quiet, ...corr, ...many(60, () => att("web", INCOME + 1))], [], new Map(), NOW, null);
    expect(d.did).toEqual({ notShown: 0, notUnderstood: 20, wentBack: 5, other: 0, nothing: 15 });
    expect(d.failedInput.text).toBe(20);
    expect(d.dwell.buckets).toEqual([15, 20, 5, 0, 0]); // нет событий / та же минута / 1–3 мин
    expect(d.takeaway.text).toMatch(/^50\s%\sушедших перед уходом получили «не понял» \(писали своими словами\)/);
    const q = drillFrom("income", [...many(30, () => att("web", INCOME)), ...many(60, () => att("web", INCOME + 1))], [], new Map(), NOW, null);
    expect(q.takeaway.text).toMatch(/^У 100\s%\sушедших после показа вопроса нет ни одного события/);
  });

  it("after-leave outcomes separate «рано судить» from «событий позже нет»", () => {
    const old = att("web", INCOME), restart = att("web", INCOME), back = att("web", INCOME), fresh = att("web", INCOME, [], NOW - DAY);
    const pinged = att("web", INCOME), resumed = att("web", INCOME);
    const later = new Map([
      [restart.subject, [{ name: "onboarding_started", t: T0 + 3 * DAY }]],
      [back.subject, [{ name: "session_started", t: T0 + 2 * DAY }, { name: "session_started", t: T0 + 2 * MIN + 10 * MIN }]],
      // Рассылка — не возвращение человека.
      [pinged.subject, [{ name: "reminder_sent", t: T0 + 2 * DAY }]],
      // Ответ в том же проходе после горизонта воронки — «продолжили позже», а не «не продолжили».
      [resumed.subject, [{ name: "onboarding_step_answered", attempt: resumed.attempt, t: T0 + 8 * DAY }]],
    ]);
    const d = drillFrom("income", [old, restart, back, fresh, pinged, resumed], [], later, NOW, null);
    expect(d.after).toEqual({ resumed: 1, restarted: 1, cameBack: 1, gone: 2, recent: 1 });
  });

  it("minute precision: other-step events in the same minute as the show are ignored; later ones mean «went back»", () => {
    const same = many(10, () => att("web", INCOME, [{ name: "onboarding_step_answered", step: "balance", input: "text", dt: 0 }]));
    const back = many(10, () => att("web", INCOME, [{ name: "onboarding_step_shown", step: "balance", dt: 3 * MIN }]));
    const d = drillFrom("income", [...same, ...back], [], new Map(), NOW, null);
    expect(d.did).toMatchObject({ nothing: 10, wentBack: 10, other: 0 });
    expect(d.dwell.buckets[0]).toBe(10);
  });

  it("previous period: «мало данных» on small samples, significance otherwise; few-data takeaway", () => {
    const small = drillFrom("income", many(10, () => att("web", INCOME)), many(10, () => att("web", INCOME + 1)), new Map(), NOW, null);
    expect(small.prev.sig).toBe("few");
    expect(small.takeaway.text).toMatch(/^Мало данных/);
    const cur = [...many(60, () => att("web", INCOME)), ...many(60, () => att("web", INCOME + 1))];
    const prev = [...many(30, () => att("web", INCOME)), ...many(90, () => att("web", INCOME + 1))];
    const d = drillFrom("income", cur.map((a) => ({ ...a, events: a.events.concat({ name: "onboarding_corrected", step: "balance", input: null, t: a.events.at(-1)!.t + 2 * MIN }) })), prev, new Map(), NOW, null);
    expect(d.prev.sig).toBe(true);
    expect(takeaway(d).text).toMatch(/^Потери на шаге выросли: 50\s%\sпротив 25\s%/);
  });

  it("previous-period comparison uses only matured attempts (older than the 7-day horizon)", () => {
    const young = (k: number) => att("web", k, [], NOW - 2 * DAY);
    // Свежие проходы (ещё могут ответить) выглядят как потери — в сравнение не идут.
    const cur = [...many(60, () => att("web", INCOME)), ...many(60, () => att("web", INCOME + 1)), ...many(200, () => young(INCOME))];
    const prev = [...many(60, () => att("web", INCOME)), ...many(60, () => att("web", INCOME + 1))];
    const d = drillFrom("income", cur, prev, new Map(), NOW, null);
    expect(d.prev.matureBase).toBe(120);
    expect(d.prev.matureRate).toBeCloseTo(0.5);
    expect(d.prev.sig).toBe(false);
    expect(d.channels[0].sig).toBe(false);
    expect(takeaway(d).text).not.toMatch(/выросли/);
  });

  it("DB: funnelDrill agrees with the dashboard funnel stage", async () => {
    const db = await getDb();
    const now = new Date("2026-10-17T12:00:00Z");
    const ins = (name: string, subject: string, attempt: string, ch: string, t: number, props: Record<string, string>) =>
      db.query("INSERT INTO analytics_events(dedup_key,name,subject,attempt,channel,source,occurred_at,props) VALUES ($1,$2,$3,$4,$5,'server',$6,$7::jsonb)",
        [`drill-${seq++}`, name, subject, attempt, ch, new Date(t), JSON.stringify(props)]);
    for (let i = 0; i < 12; i++) {
      const s = `drillsubj${String(i).padStart(24, "0")}`, a = `drillatt${i}`, t = Date.parse("2026-10-12T09:00:00Z") + i * MIN;
      const ch = i % 3 === 0 ? "telegram" : "web";
      await ins("onboarding_started", s, a, ch, t, { mode: "initial" });
      await ins("onboarding_step_shown", s, a, ch, t, { step: "balance" });
      await ins("onboarding_step_answered", s, a, ch, t + MIN, { step: "balance", input: "text", answer_kind: "value" });
      await ins("onboarding_step_shown", s, a, ch, t + MIN, { step: "income" });
      if (i % 4 === 0) await ins("onboarding_not_understood", s, a, ch, t + 2 * MIN, { step: "income", input: "text" });
      if (i % 3 !== 0) await ins("onboarding_step_answered", s, a, ch, t + 3 * MIN, { step: "income", input: "choice", answer_kind: "value" });
    }
    const [dash, drill] = await Promise.all([dashboard(now, 30, null), funnelDrill(now, 30, null, "income")]);
    const st = dash.cur.funnel.stages.find((s) => s.key === "income")!;
    expect(drill.dropped).toBe(st.drop);
    expect(drill.rate).toBeCloseTo(st.dropRate!);
    expect(drill.channels.find((c) => c.channel === "telegram")).toMatchObject({ base: 4, dropped: 4 });
    expect(drill.did.notUnderstood).toBe(1); // среди ушедших (i % 3 = 0) «не понял» только у i = 0
  });
});

describe("малые ячейки в графиках шторки", () => {
  it("Histogram/Donut with `small` do not leak exact small counts in tips, aria or labels", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { Histogram, Donut } = await import("../app/internal/analytics/charts");
    const h = renderToStaticMarkup(createElement(Histogram, { labels: ["a", "b"], values: [3, 97], small: 5 }));
    expect(h).toContain("a: &lt;5");
    expect(h).not.toMatch(/a: 3/);
    expect(h).toContain("a — &lt;5");
    const dn = renderToStaticMarkup(createElement(Donut, { parts: [{ key: "x", value: 2, color: "#fff", label: "икс" }, { key: "y", value: 98, color: "#000", label: "игрек" }], center: "", sub: "", small: 5 }));
    expect(dn).toContain("икс &lt;5");
  });
});
