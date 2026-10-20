// Онбординг-чат: политика, разбор нескольких фактов, «не знаю», исправления, возобновление, устаревшие варианты.
import { describe, it, expect } from "vitest";
import { createAnonymousSession } from "../lib/auth";
import { getForecast } from "../lib/finance-service";
import { extractFacts } from "../lib/onboarding/slots";
import { RulePolicy } from "../lib/onboarding/policy";
import { newSession } from "../lib/onboarding/session";
import { handleTurn, openOnboarding } from "../lib/onboarding/orchestrator";
import type { AssistantMessage, ChatMessage } from "../lib/onboarding/protocol";
import { NOW, webUser } from "./helpers";

const TODAY = "2026-10-15";
let n = 0;
const full = (a: AssistantMessage) => [a.lead, a.text].filter(Boolean).join(" ");
const lastA = (ms: ChatMessage[]) => [...ms].reverse().find((m) => m.role === "assistant") as AssistantMessage;
async function say(userId: string, text: string) { return handleTurn(userId, { clientMessageId: `t${++n}`, text }, "web", NOW); }
async function pick(userId: string, msg: AssistantMessage, label: string) {
  const c = msg.choices.find((x) => x.label === label);
  if (!c) throw new Error(`no choice ${label} in ${msg.choices.map((x) => x.label).join(",")}`);
  return handleTurn(userId, { clientMessageId: `t${++n}`, text: c.userText, selection: { assistantMessageId: msg.id, choiceId: c.id, revision: msg.revision } }, "web", NOW);
}
async function fresh() {
  const s = await createAnonymousSession(NOW);
  const o = await openOnboarding(s.userId, "web", { now: NOW });
  return { userId: s.userId, intro: lastA(o.messages) };
}

describe("slots: extraction", () => {
  it("multi-fact answer: balance + income in one message", () => {
    const xs = extractFacts("45к, зарплата 80 тысяч 25 октября", "balance", TODAY);
    expect(xs).toContainEqual({ kind: "value", slot: "balance", minor: 4_500_000n, confidence: "exact" });
    expect(xs).toContainEqual({ kind: "value", slot: "income", amountMinor: 8_000_000n, date: "2026-10-25", confidence: "exact" });
  });
  it("payments list with a missing date", () => {
    const xs = extractFacts("аренда 30000 20.10, интернет 700", "payments", TODAY);
    expect(xs[0]).toMatchObject({ kind: "payment", name: "Аренда", amountMinor: 3_000_000n, date: "2026-10-20" });
    expect(xs[1]).toMatchObject({ kind: "payment", name: "Интернет", amountMinor: 70_000n, date: null });
  });
  it("«не знаю» is a status, never 0", () => {
    for (const slot of ["reserve", "essentialDaily", "payments", "income"] as const) expect(extractFacts("не знаю", slot, TODAY)).toEqual([{ kind: "status", slot, status: "unknown" }]);
  });
  it("correction by keyword overrides the current question", () => {
    expect(extractFacts("остаток всё-таки 42 тысячи", "reserve", TODAY)).toEqual([{ kind: "value", slot: "balance", minor: 4_200_000n, confidence: "exact" }]);
  });
  it("approximate amounts are marked", () => {
    expect(extractFacts("около 800", "essentialDaily", TODAY)[0]).toMatchObject({ slot: "essentialDaily", confidence: "approximate" });
  });
  it("negative balance and two amounts are problems, not values", () => {
    expect(extractFacts("-5000", "balance", TODAY)[0]).toMatchObject({ kind: "problem", reason: "negative" });
    expect(extractFacts("5000 или 6000", "balance", TODAY)[0]).toMatchObject({ kind: "problem", reason: "ambiguous" });
  });
});

describe("policy: RulePolicy", () => {
  const p = new RulePolicy();
  const ctx = { today: TODAY };
  const src = { messageId: "m", channel: "web" as const, via: "text" as const };
  const conf = <T,>(value: T) => ({ status: "confirmed" as const, value, confidence: "exact" as const, source: src, updatedAt: "", askCount: 1 });
  it("asks balance, then income; preview after both; then optional slots", async () => {
    const s = newSession("u", "initial", null, NOW, p.id);
    expect(await p.nextQuestion(s, ctx)).toMatchObject({ kind: "ask", slot: "balance" });
    s.facts.balance = conf("100");
    expect(await p.nextQuestion(s, ctx)).toMatchObject({ kind: "ask", slot: "income", choices: ["income_irregular", "unknown"] });
    s.facts.income = conf({ amountMinor: "100", date: "2026-10-25" });
    expect(await p.nextQuestion(s, ctx)).toEqual({ kind: "preview" });
    s.planSaved = true;
    expect(await p.nextQuestion(s, ctx)).toMatchObject({ kind: "ask", slot: "payments" });
  });
  it("unknown income → planning period question; skip offered after two asks", async () => {
    const s = newSession("u", "initial", null, NOW, p.id);
    s.facts.balance = conf("100");
    s.facts.income = { status: "unknown", askCount: 1 };
    expect(await p.nextQuestion(s, ctx)).toMatchObject({ kind: "ask", slot: "planningDays", choices: ["days_14", "days_30"] });
    s.facts.planningDays = conf(30); s.planSaved = true;
    s.facts.payments = { status: "missing", askCount: 2 };
    expect(await p.nextQuestion(s, ctx)).toMatchObject({ kind: "ask", slot: "payments", choices: ["payments_none", "payments_unknown", "skip"] });
  });
  it("edit mode asks only the edited slot, then summary", async () => {
    const s = newSession("u", "edit", "1", NOW, p.id);
    s.facts.balance = conf("1"); s.facts.income = conf({ amountMinor: "1", date: "2026-10-25" }); s.planSaved = true;
    s.editSlot = "reserve";
    expect(await p.nextQuestion(s, ctx)).toMatchObject({ kind: "ask", slot: "reserve" });
    s.facts.reserve = conf("0");
    expect(await p.nextQuestion(s, ctx)).toEqual({ kind: "summary" });
  });
});

describe("orchestrator: full dialogue", () => {
  it("example A: multi-fact, preview, payments with clarification, «не знаю» reserve, correction, done", async () => {
    const { userId, intro } = await fresh();
    expect(full(intro)).toContain("Привет");
    let r = await pick(userId, intro, "Начнём");
    expect(full(lastA(r.messages))).toContain("Сколько сейчас денег");
    r = await say(userId, "45к, зарплата 80 тысяч 25 октября");
    let a = lastA(r.messages);
    expect(full(a)).toContain("45\u00a0000\u00a0₽");
    expect(full(a)).toContain("80\u00a0000\u00a0₽");
    expect(a.cards[0]).toMatchObject({ type: "preview", preliminary: true });
    expect(full(a)).toContain("обязательные платежи до 25\u00a0октября");
    expect(r.session.planSaved).toBe(true);
    r = await say(userId, "аренда 30000 20.10, интернет 700");
    a = lastA(r.messages);
    expect(full(a)).toContain("Интернет");
    expect(full(a)).toContain("нет даты");
    r = await say(userId, "22-го");
    a = lastA(r.messages);
    expect(full(a)).toContain("неприкосновенным");
    r = await pick(userId, a, "Не знаю");
    a = lastA(r.messages);
    expect(full(a)).toContain("не задан");
    let v = (await getForecast(userId, NOW))!;
    expect(v.book.reserveMinor).toBe(0n);
    expect(v.book.occurrences.filter((o) => o.direction === "expense")).toHaveLength(2);
    r = await say(userId, "около 800");
    a = lastA(r.messages);
    r = await pick(userId, a, "Нет");
    a = lastA(r.messages);
    expect(a.cards[0].type).toBe("summary");
    const rows = (a.cards[0] as { data: { rows: { slot: string; value: string }[] } }).data.rows;
    expect(rows.find((x) => x.slot === "reserve")!.value).toBe("не задан");
    r = await say(userId, "остаток всё-таки 42 тысячи");
    a = lastA(r.messages);
    expect(full(a)).toContain("Исправил");
    expect(full(a)).toContain("было 45\u00a0000\u00a0₽");
    v = (await getForecast(userId, NOW))!;
    expect(v.book.balanceMinor).toBe(4_200_000n);
    expect(v.book.essentialDailyMinor).toBe(80_000n);
    r = await pick(userId, a, "Готово");
    expect(r.done).toBe(true);
  });

  it("irregular income → planning period → preview on 30 days; essentials unknown stays null", async () => {
    const { userId, intro } = await fresh();
    let r = await pick(userId, intro, "Начнём");
    r = await say(userId, "20000");
    r = await pick(userId, lastA(r.messages), "Нерегулярный доход");
    expect(full(lastA(r.messages))).toContain("На какой срок");
    r = await pick(userId, lastA(r.messages), "30 дней");
    const a = lastA(r.messages);
    expect(a.cards[0]).toMatchObject({ type: "preview", data: { title: "На покупки за 30 дн." } });
    const v = (await getForecast(userId, NOW))!;
    expect(v.book.planningDays).toBe(30);
    expect(v.book.essentialDailyMinor).toBeNull();
  });

  it("stale option is rejected gently and current question is repeated", async () => {
    const { userId, intro } = await fresh();
    let r = await pick(userId, intro, "Начнём");
    r = await say(userId, "50000");
    const incomeQ = lastA(r.messages);
    r = await say(userId, "80000 25.10");
    r = await pick(userId, incomeQ, "Не знаю"); // старая кнопка
    const a = lastA(r.messages);
    expect(full(a)).toContain("уже неактуален");
    expect(full(a)).toContain("платежи");
    expect((await getForecast(userId, NOW))!.forecast.nextIncome).not.toBeNull();
  });

  it("idempotent: the same clientMessageId does not apply twice", async () => {
    const { userId, intro } = await fresh();
    await pick(userId, intro, "Начнём");
    const t = { clientMessageId: "dup-1", text: "50000" };
    const a = await handleTurn(userId, t, "web", NOW);
    const b = await handleTurn(userId, t, "web", NOW);
    expect(b.session.revision).toBe(a.session.revision);
    expect(lastA(b.messages).id).toBe(lastA(a.messages).id);
  });

  it("resume: reopening shows «Продолжим?», «Продолжить» re-asks, «Начать заново» resets", async () => {
    const { userId, intro } = await fresh();
    await pick(userId, intro, "Начнём");
    await say(userId, "50000");
    const o = await openOnboarding(userId, "telegram", { now: NOW });
    const resume = lastA(o.messages);
    expect(full(resume)).toContain("Продолжим");
    expect(resume.choices.map((c) => c.label)).toEqual(["Продолжить", "Начать заново"]);
    // повторное открытие не дублирует приглашение
    expect((await openOnboarding(userId, "web", { now: NOW })).messages).toHaveLength(0);
    let r = await pick(userId, resume, "Продолжить");
    expect(full(lastA(r.messages))).toContain("ближайший доход");
    const o2 = await openOnboarding(userId, "web", { now: NOW });
    r = await pick(userId, lastA(o2.messages), "Начать заново");
    expect(full(lastA(r.messages))).toContain("Привет");
    expect(r.session.facts.balance.status).toBe("missing");
  });

  it("users with an existing budget skip onboarding; edit mode changes one slot via patch", async () => {
    const { userId } = await webUser();
    expect((await openOnboarding(userId, "web", { now: NOW })).skip).toBe(true);
    const before = (await getForecast(userId, NOW))!;
    const o = await openOnboarding(userId, "web", { mode: "edit", slot: "reserve", now: NOW });
    expect(full(lastA(o.messages))).toContain("неприкосновенным");
    const r = await say(userId, "15 000");
    const a = lastA(r.messages);
    expect(full(a)).toContain("Исправил");
    expect(a.choices.map((c) => c.label)).toEqual(["Готово"]);
    const after = (await getForecast(userId, NOW))!;
    expect(after.book.reserveMinor).toBe(1_500_000n);
    expect(after.book.balanceMinor).toBe(before.book.balanceMinor);
    expect(after.book.occurrences).toHaveLength(before.book.occurrences.length);
    const done = await pick(userId, a, "Готово");
    expect(done.done).toBe(true);
  });

  it("negative balance gets a hint and nothing is saved", async () => {
    const { userId, intro } = await fresh();
    await pick(userId, intro, "Начнём");
    const r = await say(userId, "-3000");
    expect(full(lastA(r.messages))).toContain("укажите 0");
    expect(r.session.facts.balance.status).toBe("missing");
  });
});

describe("account linking merges onboarding sessions", () => {
  it("the more recent session (Telegram) survives when the web account keeps the identity", async () => {
    const { startLink, previewLink, approveLink, confirmLink, telegramUserId } = await import("../lib/auth");
    const { loadSession } = await import("../lib/onboarding/session");
    const web = await createAnonymousSession(NOW);
    const tgId = 777001;
    const tgUser = (await telegramUserId(tgId))!;
    const o = await openOnboarding(tgUser, "telegram", { now: NOW });
    await pick(tgUser, lastA(o.messages), "Начнём");
    await handleTurn(tgUser, { clientMessageId: "m-1", text: "30000" }, "telegram", NOW);
    const link = await startLink(web.userId, NOW);
    const p = await previewLink(link.code, tgId, NOW);
    if (p.status !== "ok") throw new Error(p.status);
    await approveLink(p.id, tgId, NOW);
    const r = await confirmLink(web.userId, link.id, link.browserSecret, NOW);
    const s = await loadSession(r.userId);
    expect(s?.facts.balance.status).toBe("confirmed");
    expect(s?.userId).toBe(r.userId);
  });
});

describe("review follow-ups", () => {
  it("«не знаю» for the balance does not close the slot", async () => {
    const { userId, intro } = await fresh();
    await pick(userId, intro, "Начнём");
    const r = await say(userId, "не знаю");
    expect(full(lastA(r.messages))).toContain("Без остатка не получится");
    expect(r.session.facts.balance.status).toBe("missing");
  });

  it("edit payments: clarification keeps the earlier items; same-name payment replaces instead of duplicating", async () => {
    const { userId } = await webUser();
    await openOnboarding(userId, "web", { mode: "edit", slot: "payments", now: NOW });
    await say(userId, "аренда 30000 20.10, интернет 700");
    let r = await say(userId, "22-го");
    expect(full(lastA(r.messages))).toContain("План пересчитан");
    let pays = (await getForecast(userId, NOW))!.book.occurrences.filter((o) => o.direction === "expense");
    expect(pays.map((p) => p.name).sort()).toEqual(["Аренда", "Интернет"]);
    await pick(userId, lastA(r.messages), "Готово");
    // повторная правка: «аренда 25000 20.10» заменяет аренду
    await openOnboarding(userId, "web", { mode: "edit", slot: "payments", now: NOW });
    r = await say(userId, "аренда 30000 20.10; аренда 25000 20.10");
    pays = (await getForecast(userId, NOW))!.book.occurrences.filter((o) => o.direction === "expense");
    expect(pays.map((p) => [p.name, p.amountMinor])).toEqual([["Аренда", 2_500_000n]]);
  });

  it("a finance change in another channel between question and answer is not overwritten", async () => {
    const { userId } = await webUser();
    await openOnboarding(userId, "web", { mode: "edit", slot: "balance", now: NOW });
    const { setReserve } = await import("../lib/finance-service");
    await setReserve(userId, 500_000n, { now: NOW }); // другой канал меняет данные
    const before = (await getForecast(userId, NOW))!.book.balanceMinor;
    let r = await say(userId, "42 000");
    expect(full(lastA(r.messages))).toContain("данные изменились");
    expect((await getForecast(userId, NOW))!.book.balanceMinor).toBe(before);
    r = await say(userId, "42 000"); // после обновления версии — применяется
    expect((await getForecast(userId, NOW))!.book.balanceMinor).toBe(4_200_000n);
  });

  it("setNextIncome replaces only the given income occurrence", async () => {
    const { savePlan, setNextIncome } = await import("../lib/finance-service");
    const s = await createAnonymousSession(NOW);
    await savePlan(s.userId, { balanceMinor: 100n, reserveMinor: 0n, essentialDailyMinor: null, payments: [], goal: null,
      incomes: [{ name: "Зарплата", amountMinor: 1000n, dueOn: "2026-10-25" }, { name: "Аванс", amountMinor: 500n, dueOn: "2026-11-10" }] }, "form", NOW);
    const v = (await getForecast(s.userId, NOW))!;
    const salary = v.book.occurrences.find((o) => o.name === "Зарплата")!;
    await setNextIncome(s.userId, { amountMinor: 2000n, dueOn: "2026-10-26" }, undefined, [salary.id], { now: NOW });
    const names = (await getForecast(s.userId, NOW))!.book.occurrences.filter((o) => o.direction === "income").map((o) => o.name).sort();
    expect(names).toEqual(["Аванс", "Доход"]);
  });

  it("parallel turns: only one applies, the other gets a gentle retry message", async () => {
    const { userId, intro } = await fresh();
    await pick(userId, intro, "Начнём");
    const [a, b] = await Promise.all([say(userId, "1000"), say(userId, "2000")]);
    const texts = [full(lastA(a.messages)), full(lastA(b.messages))];
    expect(texts.filter((t) => t.includes("несколько сообщений подряд"))).toHaveLength(1);
  });
});

describe("facts strip («Уже учтено»)", () => {
  it("responses carry accepted facts; corrections update the chip", async () => {
    const { userId, intro } = await fresh();
    let r = await pick(userId, intro, intro.choices[0].label);
    expect(r.facts).toEqual([]);
    r = await say(userId, "45к, зарплата 80 тысяч 25 октября");
    expect(r.facts.map((f) => f.slot)).toEqual(["balance", "income"]);
    expect(r.facts[0]).toMatchObject({ label: "Остаток", approximate: false });
    expect(r.facts[0].value).toContain("45");
    const before = r.facts[0].updatedAt;
    r = await say(userId, "остаток 42000");
    const bal = r.facts.find((f) => f.slot === "balance")!;
    expect(bal.value).toContain("42");
    expect(bal.updatedAt >= before).toBe(true);
    const o = await openOnboarding(userId, "web", { now: NOW });
    expect(o.facts.map((f) => f.slot)).toEqual(r.facts.map((f) => f.slot));
  });
});
