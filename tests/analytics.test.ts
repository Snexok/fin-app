// Продуктовая аналитика: allowlist и отсутствие PII, дедупликация, отказ, воронка и метрики, клиентский endpoint.
import { describe, it, expect, vi } from "vitest";
vi.mock("next/headers", async () => (await import("./http-helpers")).nextHeadersMock);
import { EVENTS, REMINDER_KINDS as A_KINDS, pseudonym, setAnalyticsConsent, track, trackActivity, validateEvent, attemptToken } from "../lib/analytics";
import { REMINDER_KINDS } from "../lib/reminders";
import { dashboard } from "../lib/analytics-metrics";
import { answer } from "../lib/coach";
import { confirmProposal, createEntryProposal, rejectProposal } from "../lib/proposals";
import { handleTurn, openOnboarding } from "../lib/onboarding/orchestrator";
import { runRetention } from "../lib/retention";
import { createAnonymousSession } from "../lib/auth";
import { getDb } from "../lib/db";
import { issueAdminToken, verifyAdminToken } from "../lib/admin";
import type { AssistantMessage, ChatMessage } from "../lib/onboarding/protocol";
import { NOW, rub, tgUser, webUser } from "./helpers";
import { call, newSession, req } from "./http-helpers";

const rows = async (where = "true", params: unknown[] = []) =>
  (await (await getDb()).query<{ name: string; subject: string; props: Record<string, string>; channel: string; attempt: string | null; occurred_at: Date; dedup_key: string }>(`SELECT * FROM analytics_events WHERE ${where} ORDER BY id`, params)).rows;
const names = async (userId: string) => (await rows("subject=$1", [pseudonym(userId, 0)])).map((r) => r.name);
const lastA = (ms: ChatMessage[]) => [...ms].reverse().find((m) => m.role === "assistant") as AssistantMessage;
let n = 0;

describe("analytics: schema allowlist", () => {
  it("rejects unknown events, unknown props and free-form values", () => {
    expect(validateEvent("purchase_text", {}).ok).toBe(false);
    expect(validateEvent("purchase_result", { verdict: "fits_plan", amount: "15000" })).toEqual({ ok: false, error: "PROP_NOT_ALLOWED:amount" });
    expect(validateEvent("purchase_result", { verdict: "наушники за 15 000" })).toEqual({ ok: false, error: "VALUE_NOT_ALLOWED:verdict" });
    expect(validateEvent("onboarding_step_answered", { step: "balance", answer_kind: 45000 }).ok).toBe(false);
    expect(validateEvent("onboarding_preview_shown", { preliminary: true })).toEqual({ ok: true, props: { preliminary: "true" } });
    expect(validateEvent("screen_viewed", ["home"]).ok).toBe(false);
  });
  it("every property in the schema is a closed enum without free text", () => {
    for (const [name, props] of Object.entries(EVENTS)) for (const [k, vals] of Object.entries(props)) {
      expect(Array.isArray(vals), `${name}.${k}`).toBe(true);
      for (const v of vals as readonly string[]) expect(v, `${name}.${k}`).toMatch(/^[a-zA-Z0-9_]{1,32}$/);
    }
    expect(A_KINDS).toEqual(REMINDER_KINDS);
  });
  it("track() refuses invalid props instead of storing them", async () => {
    const s = await webUser();
    // @ts-expect-error — намеренно неверное свойство
    expect(await track(s.userId, "purchase_asked", { text: "можно айфон?" }, { channel: "web" })).toBe(false);
    expect(await names(s.userId)).toEqual([]);
  });
});

describe("analytics: no PII end to end", () => {
  it("chat question, expense, onboarding: no texts, amounts, names or ids in stored rows", async () => {
    const { userId, tgId } = await tgUser();
    await answer(userId, "Можно купить наушники за 15 000?", { channel: "telegram", now: NOW });
    const r = await answer(userId, "Потратил 1234 на кофе", { channel: "telegram", now: NOW });
    await confirmProposal(userId, r.proposal!.id, { revision: r.proposal!.revision }, NOW);
    const w = await createAnonymousSession(NOW);
    const o = await openOnboarding(w.userId, "web", { now: NOW });
    const intro = lastA(o.messages);
    const c = intro.choices[0];
    await handleTurn(w.userId, { clientMessageId: `p${++n}`, text: c.userText, selection: { assistantMessageId: intro.id, choiceId: c.id, revision: intro.revision } }, "web", NOW);
    await handleTurn(w.userId, { clientMessageId: `p${++n}`, text: "45к, зарплата 80 тысяч 25 октября" }, "web", NOW);
    const all = await rows();
    expect(all.length).toBeGreaterThan(5);
    // хеш-поля (dedup_key, subject, attempt) — шестнадцатеричные; в них цифры вроде «1001» встречаются случайно, их форма проверяется ниже
    const dump = JSON.stringify(all.map(({ dedup_key: _k, subject: _s, attempt: _a, ...rest }) => rest));
    for (const bad of ["наушник", "кофе", "15000", "15 000", "1234", "45000", "80000", "Зарплата", "Аренда", userId, w.userId, String(tgId)]) expect(dump).not.toContain(bad);
    for (const x of all) {
      expect(x.subject).toMatch(/^[0-9a-f]{32}$/);
      expect(x.dedup_key).toMatch(/^[0-9a-f]{40}$/);
      if (x.attempt != null) expect(x.attempt).toMatch(/^[0-9a-f]{24}$/);
      expect(new Date(x.occurred_at).getUTCSeconds()).toBe(0); // минута, не секунда
    }
    const mine = await names(userId);
    expect(mine).toEqual(expect.arrayContaining(["purchase_asked", "purchase_result", "proposal_created", "proposal_confirmed", "expense_logged"]));
    const verdict = all.find((x) => x.name === "purchase_result" && x.subject === pseudonym(userId, 0))!;
    expect(Object.keys(verdict.props).sort()).toEqual(["engine", "verdict"]);
    expect(verdict.channel).toBe("telegram");
    const web = await names(w.userId);
    expect(web).toEqual(expect.arrayContaining(["onboarding_started", "onboarding_step_shown", "onboarding_step_answered", "onboarding_preview_shown"]));
  });
});

describe("analytics: dedup", () => {
  it("replayed confirm / alreadyApplied / repeated reject create no extra events", async () => {
    const s = await webUser();
    const p = await createEntryProposal(s.userId, { direction: "expense", amountMinor: rub(500), description: "x" }, NOW);
    await confirmProposal(s.userId, p.id, { revision: p.revision, idempotencyKey: "k1" }, NOW);
    await confirmProposal(s.userId, p.id, { revision: p.revision, idempotencyKey: "k1" }, NOW); // replay
    await confirmProposal(s.userId, p.id, { revision: p.revision, idempotencyKey: "k2" }, NOW); // alreadyApplied
    const q = await createEntryProposal(s.userId, { direction: "income", amountMinor: rub(100) }, NOW);
    await rejectProposal(s.userId, q.id); await rejectProposal(s.userId, q.id);
    const ev = await names(s.userId);
    expect(ev.filter((x) => x === "proposal_confirmed")).toHaveLength(1);
    expect(ev.filter((x) => x === "expense_logged")).toHaveLength(1);
    expect(ev.filter((x) => x === "proposal_rejected")).toHaveLength(1);
  });
  it("activity: one session per 30-minute window and one active-day per channel", async () => {
    const s = await webUser(null);
    await trackActivity(s.userId, "web", new Date("2026-10-15T09:01:00Z"));
    await trackActivity(s.userId, "web", new Date("2026-10-15T09:20:00Z"));
    await trackActivity(s.userId, "web", new Date("2026-10-15T10:05:00Z"));
    await trackActivity(s.userId, "telegram", new Date("2026-10-15T10:06:00Z"));
    const ev = await rows("subject=$1", [pseudonym(s.userId, 0)]);
    expect(ev.filter((x) => x.name === "session_started")).toHaveLength(3);
    expect(ev.filter((x) => x.name === "user_active").map((x) => x.channel).sort()).toEqual(["telegram", "web"]);
  });
  it("onboarding step outcome is counted once per attempt even if the same answer is retried", async () => {
    const w = await createAnonymousSession(NOW);
    const o = await openOnboarding(w.userId, "web", { now: NOW });
    const intro = lastA(o.messages); const c = intro.choices[0];
    await handleTurn(w.userId, { clientMessageId: "d1", text: c.userText, selection: { assistantMessageId: intro.id, choiceId: c.id, revision: intro.revision } }, "web", NOW);
    await handleTurn(w.userId, { clientMessageId: "d2", text: "45000" }, "web", NOW);
    await handleTurn(w.userId, { clientMessageId: "d2", text: "45000" }, "web", NOW); // повтор того же хода
    await handleTurn(w.userId, { clientMessageId: "d3", text: "абракадабра" }, "web", NOW);
    await handleTurn(w.userId, { clientMessageId: "d4", text: "не знаю" }, "web", NOW);
    const ev = await rows("subject=$1", [pseudonym(w.userId, 0)]);
    expect(ev.filter((x) => x.name === "onboarding_step_answered" && x.props.step === "balance")).toHaveLength(1);
    expect(ev.filter((x) => x.name === "onboarding_not_understood")).toHaveLength(1);
    expect(ev.filter((x) => x.name === "onboarding_step_unknown" && x.props.step === "income")).toHaveLength(1);
    expect(ev.filter((x) => x.name === "onboarding_step_shown").map((x) => x.props.step)).toEqual(expect.arrayContaining(["balance", "income"]));
    expect(new Set(ev.filter((x) => x.attempt).map((x) => x.attempt)).size).toBe(1);
  });
});

describe("analytics: opt-out and retention", () => {
  it("opt-out deletes events, stops tracking; opting back in gets a new unlinkable pseudonym", async () => {
    const s = await webUser();
    await trackActivity(s.userId, "web", NOW);
    expect((await names(s.userId)).length).toBe(2);
    await setAnalyticsConsent(s.userId, false);
    expect(await names(s.userId)).toEqual([]);
    expect(await track(s.userId, "purchase_asked", {}, { channel: "web" })).toBe(false);
    await setAnalyticsConsent(s.userId, true);
    await trackActivity(s.userId, "web", NOW);
    expect(await names(s.userId)).toEqual([]); // старый псевдоним пуст
    expect((await rows("subject=$1", [pseudonym(s.userId, 1)])).length).toBe(2);
  });
  it("events older than 180 days are deleted by retention", async () => {
    const s = await webUser(null);
    await track(s.userId, "purchase_asked", {}, { channel: "web", now: new Date(NOW.getTime() - 181 * 86_400_000) });
    await track(s.userId, "purchase_asked", {}, { channel: "web", now: new Date(NOW.getTime() - 179 * 86_400_000) });
    const out = await runRetention(NOW);
    expect(out.analyticsEvents).toBeGreaterThanOrEqual(1);
    expect(await names(s.userId)).toEqual(["purchase_asked"]);
  });
});

describe("analytics: metrics", () => {
  const now = new Date("2026-10-15T12:00:00Z"); // чт; период — 30 полных дней до 15.10 00:00 UTC
  const at = (daysAgo: number, min = 0) => new Date(now.getTime() - daysAgo * 86_400_000 + min * 60_000);
  async function seed() {
    await (await getDb()).query("DELETE FROM analytics_events");
    const users: string[] = [];
    for (let i = 0; i < 6; i++) users.push((await webUser(null)).userId);
    for (const [i, u] of users.entries()) {
      const t0 = at(5, i); // сб 10.10
      const attempt = attemptToken(u, t0.toISOString());
      const o = { channel: "web" as const, attempt };
      await track(u, "onboarding_started", { mode: "initial" }, { ...o, now: t0, key: "s" });
      await trackActivity(u, "web", t0);
      await track(u, "onboarding_step_shown", { step: "balance" }, { ...o, now: t0, key: "b" });
      if (i === 5) continue; // бросил на остатке
      await track(u, "onboarding_step_answered", { step: "balance", input: "text", answer_kind: "value" }, { ...o, now: at(5, i + 1), key: "ba" });
      if (i === 4) continue; // бросил на доходе
      await track(u, "onboarding_step_unknown", { step: "income", input: "choice" }, { ...o, now: at(5, i + 2), key: "iu" });
      await track(u, "onboarding_preview_shown", { preliminary: "true" }, { ...o, now: at(5, i + 3), key: "p" });
      for (const step of ["payments", "reserve", "essentialDaily", "goal"] as const) {
        if (step === "reserve" && i === 3) { await track(u, "onboarding_step_skipped", { step, input: "choice" }, { ...o, now: at(5, i + 4), key: "k" + step }); continue; }
        await track(u, "onboarding_step_answered", { step, input: "choice", answer_kind: "value" }, { ...o, now: at(5, i + 4), key: "a" + step });
      }
      if (i === 3) continue; // дошёл до цели, но не нажал «Готово»
      await track(u, "onboarding_completed", { mode: "initial", duration: "1_3m" }, { ...o, now: at(5, i + 5), key: "c" });
      if (i < 3) await trackActivity(u, "web", at(4)); // D1 у трёх из шести (вс 11.10)
    }
    for (const [i, u] of users.slice(0, 4).entries()) {
      await track(u, "purchase_asked", {}, { channel: "web", now: at(1), key: `a${i}` });
      await track(u, "purchase_result", { verdict: i < 3 ? "fits_plan" : "cash_gap", engine: "fallback" }, { channel: "web", now: at(1), key: `a${i}` });
      await track(u, "reminder_sent", { kind: "payday" }, { channel: "telegram", now: at(3), key: `r${i}` }); // пн 12.10
      if (i < 2) {
        await track(u, "reminder_clicked", { kind: "payday", action: "inc" }, { channel: "telegram", now: at(3, 30), key: `c${i}` });
        await trackActivity(u, "telegram", at(3, 30));
      }
      if (i === 2) await track(u, "reminder_clicked", { kind: "payday", action: "inc" }, { channel: "telegram", now: at(1), key: `late${i}` }); // через 2 дня — не клик
    }
    return users;
  }

  it("funnel stages are monotonic with drops, unknown and skipped shares", async () => {
    await seed();
    const d = await dashboard(now, 30);
    expect(d.cur.from).toBe("2026-09-15T00:00:00.000Z");
    expect(d.cur.to).toBe("2026-10-15T00:00:00.000Z");
    const st = Object.fromEntries(d.cur.funnel.stages.map((s) => [s.key, s]));
    expect(d.cur.funnel.stages.map((s) => s.n)).toEqual([6, 5, 4, 4, 4, 4, 4, 4, 3]);
    expect(st.balance).toMatchObject({ drop: 1, ofStart: 5 / 6 });
    expect(st.income.dropRate).toBeCloseTo(0.2);
    expect(st.income.unknownShare).toBe(1);
    expect(st.reserve.skippedShare).toBeCloseTo(0.25);
    expect(st.completed).toMatchObject({ n: 3, drop: 1 });
    expect(d.cur.funnel.completion).toBeCloseTo(0.5);
  });

  it("activation, time to value, asks frequency, verdicts", async () => {
    await seed();
    const { cur } = await dashboard(now, 30);
    expect(cur.activation).toMatchObject({ starters: 6, matured: 6, activated: 4, reached: 4, never: 2, p50Min: 3 });
    expect(cur.activation.buckets).toEqual([0, 0, 4, 0, 0, 0]); // ровно 3 мин → «3–10 мин»
    expect(cur.asks).toMatchObject({ total: 4, askers: 4, freq: [2, 4, 0, 0, 0], repeatShare: 0 });
    expect(cur.activeUserWeeks).toBe(8); // 6 за неделю с 05.10 + 2 за неделю с 12.10
    expect(cur.asks.perActiveWeek).toBeCloseTo(0.5);
    expect(cur.verdicts).toMatchObject({ fits_plan: 3, cash_gap: 1 });
  });

  it("retention windows, cohort heatmap and daily series", async () => {
    await seed();
    const d = await dashboard(now, 30);
    expect(d.cur.retention.d1).toEqual({ n: 6, returned: 3, rate: 0.5 });
    expect(d.cur.retention.d7).toMatchObject({ n: 0, rate: null }); // окно 7–13 ещё не закрылось
    expect(d.cohorts).toHaveLength(1);
    expect(d.cohorts[0].week).toBe("2026-10-05");
    expect(d.cohorts[0].size).toBe(6);
    expect(d.cohorts[0].cells[0]).toEqual({ day: 1, matured: 6, rate: 0.5 });
    expect(d.cohorts[0].cells[1]).toMatchObject({ day: 7, matured: 0, rate: null });
    const day = (iso: string) => d.series.find((p) => p.day === iso)!;
    expect(d.series).toHaveLength(30);
    expect(d.series.at(-1)!.day).toBe("2026-10-14"); // сегодняшний неполный день не входит
    expect(day("2026-10-10")).toMatchObject({ dau: 6, newUsers: 6, starters: 6, activated: 4, web: 6 });
    expect(day("2026-10-12")).toMatchObject({ dau: 2, telegram: 2, remSent: 4, remClicked: 2 });
    expect(day("2026-10-14")).toMatchObject({ asks: 4, wau: 6 });
    expect(d.cur.wauEnd).toBe(6);
    expect(d.prev.active).toBe(0);
  });

  it("reminder CTR counts clicks within 24h; effect compares reminded vs other days", async () => {
    await seed();
    const { cur } = await dashboard(now, 30);
    expect(cur.reminders.kinds.find((k) => k.kind === "payday")).toMatchObject({ sent: 4, recipients: 4, clicked: 2, ctr: 0.5 });
    expect(cur.reminders.ctr).toBe(0.5);
    // дни 11–14.10 у четырёх получателей: 4 дня с напоминанием (2 активны), 12 без (3 активны)
    expect(cur.reminders.effect).toEqual({ remindedDays: 4, remindedActive: 2, otherDays: 12, otherActive: 3, lift: 0.25 });
  });

  it("channel filter narrows every block; reminders only for Telegram", async () => {
    await seed();
    const web = await dashboard(now, 30, "web");
    expect(web.cur.funnel.attempts).toBe(6);
    expect(web.cur.reminders.sent).toBe(0);
    expect(web.cur.reminders.effect).toBeNull();
    expect(web.channels.map((c) => c.channel)).toEqual(["web"]);
    const tg = await dashboard(now, 30, "telegram");
    expect(tg.cur.funnel.attempts).toBe(0);
    expect(tg.cur.active).toBe(2);
    expect(tg.cur.reminders.sent).toBe(4);
    const all = await dashboard(now, 30);
    expect(all.channels.find((c) => c.channel === "web")).toMatchObject({ active: 6, starters: 6 });
    expect(all.channels.find((c) => c.channel === "web")!.activation).toBeCloseTo(4 / 6);
    expect(all.demo).toBe(false);
  });

  it("edge cases: sequence-based funnel, target clicks only, one click per send, distinct disablers, visits before a send", async () => {
    await (await getDb()).query("DELETE FROM analytics_events");
    const u = (await webUser(null)).userId, v = (await webUser(null)).userId;
    // проход v перепрыгнул «Доход»: дальше по воронке его не считаем
    for (const [x, steps] of [[u, ["balance", "income"]], [v, ["balance", "payments", "reserve"]]] as const) {
      const attempt = attemptToken(x, at(6).toISOString());
      await track(x, "onboarding_started", { mode: "initial" }, { channel: "web", attempt, now: at(6), key: "s" });
      for (const step of steps) {
        await track(x, "onboarding_step_unknown", { step, input: "choice" }, { channel: "web", attempt, now: at(6, 1), key: "u" + step });
        await track(x, "onboarding_step_answered", { step, input: "text", answer_kind: "value" }, { channel: "web", attempt, now: at(6, 2), key: "a" + step }); // исправил «не знаю» на ответ
      }
    }
    await trackActivity(u, "web", at(6)); await trackActivity(v, "web", at(6));
    // две отправки одного вида и один клик после второй; клик «выключить» — не успех
    await track(u, "reminder_sent", { kind: "payday" }, { channel: "telegram", now: at(3), key: "r1" });
    await track(u, "reminder_sent", { kind: "payday" }, { channel: "telegram", now: at(3, 120), key: "r2" });
    await track(u, "reminder_clicked", { kind: "payday", action: "inc" }, { channel: "telegram", now: at(3, 150), key: "c1" });
    await track(v, "reminder_sent", { kind: "payday" }, { channel: "telegram", now: at(3), key: "r3" });
    await track(v, "reminder_clicked", { kind: "payday", action: "off" }, { channel: "telegram", now: at(3, 5), key: "c2" });
    for (const k of ["d1", "d2"]) await track(v, "reminder_disabled", { scope: "kind", kind: "payday", reason: "user" }, { channel: "telegram", now: at(3, 6), key: k });
    // v зашёл ДО отправки в тот же день — это не возврат после напоминания
    await trackActivity(v, "telegram", at(3, -60));
    const { cur } = await dashboard(now, 30);
    const st = Object.fromEntries(cur.funnel.stages.map((x) => [x.key, x.n]));
    expect(st).toMatchObject({ started: 2, balance: 2, income: 1, payments: 0, reserve: 0 });
    expect(cur.funnel.stages.find((x) => x.key === "balance")!.unknownShare).toBe(0); // один итог на шаг — ответ
    expect(cur.reminders.kinds.find((k) => k.kind === "payday")).toMatchObject({ sent: 3, recipients: 2, clicked: 1, disabled: 1, disableRate: 0.5 });
    expect(cur.reminders.effect).toMatchObject({ remindedDays: 2, remindedActive: 0 });
  });

  it("small cohorts are suppressed", async () => {
    await (await getDb()).query("DELETE FROM analytics_events");
    const u = (await webUser(null)).userId;
    await trackActivity(u, "web", at(10));
    await trackActivity(u, "web", at(9));
    const d = await dashboard(now, 30);
    expect(d.cohorts[0].size).toBeNull();
    expect(d.cohorts[0].cells.every((c) => c.rate === null)).toBe(true);
    expect(d.cur.retention.d1).toMatchObject({ n: 1, returned: 1, rate: null });
  });
});

describe("analytics: client endpoint and admin access", () => {
  it("accepts only allowlisted client events, ignores financial ones; requires same origin", async () => {
    await newSession();
    const { POST } = await import("../app/api/v1/analytics/route");
    const ok = await call(POST, req("/api/v1/analytics", { method: "POST", body: { channel: "miniapp", events: [
      { name: "session_started" }, { name: "screen_viewed", props: { screen: "plan" }, id: "6f1d3c1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f" },
      { name: "screen_viewed", props: { screen: "plan" }, id: "6f1d3c1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f" }, // дубль по id
      { name: "purchase_result", props: { verdict: "fits_plan" } }, { name: "screen_viewed", props: { screen: "https://evil" } },
    ] } }));
    expect(ok.status).toBe(202);
    expect(ok.body).toEqual({ accepted: 2, rejected: 2 });
    const all = await rows("name IN ('screen_viewed','purchase_result') AND source='client'");
    expect(all.map((x) => [x.name, x.channel])).toEqual([["screen_viewed", "web"]]); // miniapp без привязки Telegram → web
    const bad = await call(POST, req("/api/v1/analytics", { method: "POST", origin: "https://evil.example", body: { events: [] } }));
    expect(bad.status).toBe(403);
    const big = await call(POST, req("/api/v1/analytics", { method: "POST", raw: JSON.stringify({ events: Array(400).fill({ name: "session_started" }) }) }));
    expect(big.status).toBe(413);
  });
  it("admin token: signed, expiring; disabled without a secret", () => {
    const prev = process.env.ANALYTICS_ADMIN_SECRET;
    delete process.env.ANALYTICS_ADMIN_SECRET;
    expect(issueAdminToken()).toBeNull();
    process.env.ANALYTICS_ADMIN_SECRET = "s".repeat(32);
    const t = issueAdminToken(Date.now())!;
    expect(verifyAdminToken(t)).toBe(true);
    expect(verifyAdminToken(t.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBe(false);
    expect(verifyAdminToken(t, Date.now() + 13 * 3600_000)).toBe(false);
    process.env.ANALYTICS_ADMIN_SECRET = "z".repeat(32);
    expect(verifyAdminToken(t)).toBe(false);
    if (prev === undefined) delete process.env.ANALYTICS_ADMIN_SECRET; else process.env.ANALYTICS_ADMIN_SECRET = prev;
  });
});
