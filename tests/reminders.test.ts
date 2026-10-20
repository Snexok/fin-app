// Мягкие напоминания: выбор, лимит, тихие часы, дедуп, 403, колбэки бота.
import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_KINDS, inQuietHours, runReminders, selectReminders, getSettings, updateSettings, type SelectInput, type Sender } from "../lib/reminders";
const ALL = { ...DEFAULT_KINDS, log_nudge: true };
import { createBot } from "../lib/bot";
import { getDb } from "../lib/db";
import type { Forecast } from "../lib/engine";
import { tgUser, rub } from "./helpers";

const F = (over: Partial<Forecast> = {}): Forecast => ({
  today: "2026-10-19", safeDailyMinor: rub(1430), nextIncome: { id: "inc-1", name: "Зарплата", amountMinor: rub(80000), dueOn: "2026-10-25" }, overdueIncomes: [],
  payments: [{ id: "pay-1", name: "Аренда", amountMinor: rub(30000), dueOn: "2026-10-20", overdue: false, inHorizon: true }], ...over,
} as Forecast);
const base = (over: Partial<SelectInput> = {}): SelectInput => ({
  today: "2026-10-19", hour: 10, weekday: 1, settings: { ...DEFAULT_SETTINGS, kinds: { ...ALL }, nudgeEveryDays: 4, timezone: "Europe/Moscow" },
  forecast: F(), onboarding: null, lastExpenseDay: "2026-10-18", hasEntries: true, log: [], ...over,
});

describe("reminders: selection", () => {
  it("payment due tomorrow: one calm message with numbers from the forecast", () => {
    const r = selectReminders(base());
    expect(r.map((x) => x.kind)).toEqual(["payment_due"]);
    expect(r[0].text).toContain("Аренда");
    expect(r[0].text).toContain("30\u00a0000");
    expect(r[0].text).not.toContain("не изменится");
    expect(r[0].buttons.flat().map((b) => b.data)).toContain("rm:paid:pay-1");
  });
  it("quiet hours and before send hour: silence", () => {
    expect(inQuietHours(23, 22, 9)).toBe(true);
    expect(inQuietHours(8, 22, 9)).toBe(true);
    expect(inQuietHours(12, 22, 9)).toBe(false);
    expect(selectReminders(base({ hour: 23 }))).toEqual([]);
    expect(selectReminders(base({ hour: 9 }))).toEqual([]);
    const late = { ...base().settings, sendHour: 14 };
    expect(selectReminders(base({ hour: 10, settings: late })).length).toBe(0);
    expect(selectReminders(base({ hour: 10, settings: late, mode: "daily" })).length).toBe(1);
    expect(selectReminders(base({ hour: 23, settings: late, mode: "daily" })).length).toBe(0);
  });
  it("global cap: one message per day including payment; payment wins; soft hints ≤2/week", () => {
    const s = { ...DEFAULT_SETTINGS, kinds: { ...ALL, morning: true, weekly: true }, timezone: "Europe/Moscow" };
    const r = selectReminders(base({ settings: s, weekday: 0, lastExpenseDay: "2026-10-01" }));
    expect(r.map((x) => x.kind)).toEqual(["payment_due"]);
    expect(selectReminders(base({ settings: s, weekday: 0, log: [{ kind: "payment_due", ref: "2026-10-20", day: "2026-10-19", status: "sent" }] }))).toEqual([]);
    const noPay = F({ payments: [] });
    expect(selectReminders(base({ settings: s, weekday: 0, forecast: noPay })).map((x) => x.kind)).toEqual(["weekly"]);
    const soft = [{ kind: "morning" as const, ref: "x", day: "2026-10-16", status: "sent" }, { kind: "log_nudge" as const, ref: "y", day: "2026-10-17", status: "sent" }];
    expect(selectReminders(base({ settings: s, weekday: 0, forecast: noPay, log: soft }))).toEqual([]);
  });
  it("defaults are conservative: hints off, events on", () => {
    expect(DEFAULT_KINDS).toMatchObject({ payment_due: true, payday: true, onboarding: true, log_nudge: false, weekly: false, morning: false });
    expect(DEFAULT_SETTINGS.nudgeEveryDays).toBe(7);
  });
  it("payday wins priority; once per income", () => {
    const f = F({ nextIncome: { id: "inc-1", name: "Зарплата", amountMinor: rub(80000), dueOn: "2026-10-19" }, payments: [] });
    const r = selectReminders(base({ forecast: f, lastExpenseDay: "2026-10-01" }));
    expect(r.map((x) => x.kind)).toEqual(["payday"]);
    expect(r[0].text).toMatch(/На сегодня запланирован доход «Зарплата» — 80\u00a0000/);
    const overdue = F({ nextIncome: null, overdueIncomes: [{ id: "inc-0", name: "Аванс", amountMinor: rub(20000), dueOn: "2026-10-18" }], payments: [] });
    expect(selectReminders(base({ forecast: overdue }))[0].text).toContain("На 18\u00a0октября был запланирован");
    expect(selectReminders(base({ forecast: f, log: [{ kind: "payday", ref: "inc-1", day: "2026-10-18", status: "sent" }] })).map((x) => x.kind)).not.toContain("payday");
  });
  it("log nudge: only for people who log, after N silent days, respects «Реже»", () => {
    const noPay = F({ payments: [] });
    expect(selectReminders(base({ forecast: noPay, lastExpenseDay: "2026-10-17" }))).toEqual([]);
    expect(selectReminders(base({ forecast: noPay, lastExpenseDay: "2026-10-14" })).map((x) => x.kind)).toEqual(["log_nudge"]);
    expect(selectReminders(base({ forecast: noPay, lastExpenseDay: null, hasEntries: false }))).toEqual([]);
    const rare = { ...DEFAULT_SETTINGS, kinds: { ...ALL }, nudgeEveryDays: 8, timezone: "Europe/Moscow" };
    expect(selectReminders(base({ forecast: noPay, lastExpenseDay: "2026-10-14", settings: rare }))).toEqual([]);
  });
  it("unfinished onboarding: once ever, not when paused", () => {
    const o = { phase: "collect", updatedAt: "2026-10-17T10:00:00Z", startedAt: "2026-10-17T10:00:00Z" };
    expect(selectReminders(base({ forecast: null, onboarding: o })).map((x) => x.kind)).toEqual(["onboarding"]);
    expect(selectReminders(base({ forecast: null, onboarding: { ...o, phase: "paused" } }))).toEqual([]);
    expect(selectReminders(base({ forecast: null, onboarding: o, log: [{ kind: "onboarding", ref: "once", day: "2026-03-01", status: "sent" }] }))).toEqual([]);
  });
  it("disabled or blocked: nothing", () => {
    expect(selectReminders(base({ settings: { ...base().settings, enabled: false } }))).toEqual([]);
    expect(selectReminders(base({ settings: { ...base().settings, blockedAt: "2026-10-01T00:00:00Z" } }))).toEqual([]);
  });
});

describe("reminders: runner", () => {
  const AT = new Date("2026-10-19T08:00:00Z"); // 11:00 МСК, накануне аренды 20.10
  const collect = () => { const out: { chatId: string; text: string }[] = []; const s: Sender = { send: async (chatId, text) => { out.push({ chatId, text }); } }; return { out, s }; };

  it("sends once per day even if run twice (dedup), and nothing in quiet hours", async () => {
    const u = await tgUser();
    const { out, s } = collect();
    await runReminders(s, AT);
    await runReminders(s, new Date(AT.getTime() + 3_600_000));
    const mine = out.filter((m) => m.chatId === String(u.tgId));
    expect(mine).toHaveLength(1);
    expect(mine[0].text).toContain("Аренда");
    const night = collect();
    await runReminders(night.s, new Date("2026-10-19T20:30:00Z")); // 23:30 МСК
    expect(night.out.filter((m) => m.chatId === String(u.tgId))).toHaveLength(0);
  });
  it("onboarding reminder is once ever even after 40+ days", async () => {
    const u = await tgUser(null);
    const db = await getDb();
    await db.query("INSERT INTO reminder_log(user_id, kind, ref, local_day, status) VALUES ($1,'onboarding','once','2026-01-10','sent')", [u.userId]);
    const { out, s } = collect();
    await runReminders(s, AT);
    expect(out.filter((m) => m.chatId === String(u.tgId))).toHaveLength(0);
  });
  it("uncertain delivery (timeout without Telegram code): no resend", async () => {
    const u = await tgUser();
    const unsure: Sender = { send: async (chatId) => { if (chatId === String(u.tgId)) throw new Error("timeout"); } };
    await runReminders(unsure, AT);
    const { out, s } = collect();
    await runReminders(s, new Date(AT.getTime() + 3_600_000));
    expect(out.filter((m) => m.chatId === String(u.tgId))).toHaveLength(0);
  });
  it("parallel runs send at most one message per user per day", async () => {
    const u = await tgUser();
    const { out, s } = collect();
    await Promise.all([runReminders(s, AT), runReminders(s, AT)]);
    expect(out.filter((m) => m.chatId === String(u.tgId))).toHaveLength(1);
  });
  it("Telegram 403 disables reminders; a transient error releases the claim", async () => {
    const u = await tgUser();
    const flaky: Sender = { send: async (chatId) => { if (chatId === String(u.tgId)) throw Object.assign(new Error("net"), { error_code: 502 }); } };
    await runReminders(flaky, AT);
    const db = await getDb();
    expect((await db.query("SELECT 1 FROM reminder_log WHERE user_id=$1", [u.userId])).rows).toHaveLength(0);
    await Promise.all([updateSettings(u.userId, { kinds: { weekly: true } }), updateSettings(u.userId, { sendHour: 12 }), updateSettings(u.userId, { kinds: { morning: true } })]);
    const st = await getSettings(u.userId);
    expect(st.kinds).toMatchObject({ weekly: true, morning: true, payment_due: true });
    expect(st.sendHour).toBe(12);
    await updateSettings(u.userId, { sendHour: 10 });
    const blocked: Sender = { send: async (chatId) => { if (chatId === String(u.tgId)) throw Object.assign(new Error("Forbidden"), { error_code: 403 }); } };
    await runReminders(blocked, AT);
    expect((await getSettings(u.userId)).blockedAt).not.toBeNull();
    const { out, s } = collect();
    await runReminders(s, new Date(AT.getTime() + 86_400_000));
    expect(out.filter((m) => m.chatId === String(u.tgId))).toHaveLength(0);
  });
});

describe("reminders: bot", () => {
  type Call = { method: string; payload: Record<string, any> };
  const calls: Call[] = [];
  const bot = createBot("123456:TEST", { botInfo: { id: 123456, is_bot: true, first_name: "Можно", username: "mozhno_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never });
  bot.api.config.use(async (_p, method, payload) => { calls.push({ method, payload: payload as Record<string, unknown> }); return { ok: true, result: method === "sendMessage" ? { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: "" } : true } as never; });
  let n = 9000;
  const from = (id: number) => ({ id, is_bot: false, first_name: "U" });
  const cmd = (id: number, text: string) => bot.handleUpdate({ update_id: n++, message: { message_id: n, date: 0, chat: { id, type: "private", first_name: "U" }, from: from(id), text, entities: [{ type: "bot_command", offset: 0, length: text.length }] } } as never);
  const tap = (id: number, data: string, text = "…") => bot.handleUpdate({ update_id: n++, callback_query: { id: String(n), from: from(id), chat_instance: "x", data, message: { message_id: 1, date: 0, chat: { id, type: "private", first_name: "U" }, text } } } as never);

  it("/reminders shows settings; toggles and «Выключить» persist; blocked flag clears when the user writes", async () => {
    const u = await tgUser();
    await updateSettings(u.userId, { blocked: true });
    await cmd(u.tgId, "/reminders");
    const sent = calls.filter((c) => c.method === "sendMessage").pop()!;
    expect(sent.payload.text).toMatch(/приостановлены|Редко|редко/);
    expect((await getSettings(u.userId)).blockedAt).toBeNull();
    await tap(u.tgId, "rm:tog:morning");
    expect((await getSettings(u.userId)).kinds.morning).toBe(true);
    await tap(u.tgId, "rm:off:log_nudge", "Если были траты…");
    expect((await getSettings(u.userId)).kinds.log_nudge).toBe(false);
    const edit = calls.filter((c) => c.method === "editMessageText").pop()!;
    expect(edit.payload.text).toContain("/reminders");
    await tap(u.tgId, "rm:less:log_nudge");
    expect((await getSettings(u.userId)).nudgeEveryDays).toBe(14);
    await tap(u.tgId, "rm:all:off");
    expect((await getSettings(u.userId)).enabled).toBe(false);
  });
  it("«Уже оплатил» creates a confirmable proposal (no silent money change)", async () => {
    const u = await tgUser();
    const db = await getDb();
    const occ = (await db.query<{ id: string }>("SELECT id FROM occurrences WHERE user_id=$1 AND direction='expense' LIMIT 1", [u.userId])).rows[0];
    calls.length = 0;
    await tap(u.tgId, `rm:paid:${occ.id}`);
    const sent = calls.find((c) => c.method === "sendMessage")!;
    const btns = (sent.payload.reply_markup.inline_keyboard as { callback_data: string }[][]).flat().map((b) => b.callback_data);
    expect(btns.some((d) => d.startsWith("pc:"))).toBe(true);
    expect((await db.query("SELECT 1 FROM ledger_entries WHERE user_id=$1 AND occurrence_id=$2", [u.userId, occ.id])).rows).toHaveLength(0);
  });
});
