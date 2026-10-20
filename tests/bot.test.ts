// Бот через тот же сервисный слой. Telegram API перехвачен, сеть не используется.
import { describe, it, expect, beforeAll } from "vitest";
import { createBot } from "../lib/bot";
import { startLink, telegramUserId } from "../lib/auth";
import { getForecast, recentEntries } from "../lib/finance-service";
import { answer } from "../lib/coach";
import { NOW, webUser } from "./helpers";

type Call = { method: string; payload: Record<string, any> };  
const calls: Call[] = [];
const bot = createBot("123456:TEST", { botInfo: { id: 123456, is_bot: true, first_name: "Можно", username: "mozhno_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never });
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload: payload as Record<string, unknown> });
  const result = method === "sendMessage" ? { message_id: calls.length, date: 0, chat: { id: 1, type: "private" }, text: (payload as { text: string }).text } : true;
  return { ok: true, result } as never;
});

let uid = 1;
const from = (id: number) => ({ id, is_bot: false, first_name: "U" });
const msg = (id: number, text: string) => bot.handleUpdate({
  update_id: uid++,
  message: { message_id: uid, date: 0, chat: { id, type: "private", first_name: "U" }, from: from(id), text, ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] } : {}) },
} as never);
const tap = (id: number, data: string, cbId = String(uid)) => bot.handleUpdate({
  update_id: uid++,
  callback_query: { id: cbId, from: from(id), chat_instance: "x", data, message: { message_id: 1, date: 0, chat: { id, type: "private", first_name: "U" }, text: "..." } },
} as never);
const lastSent = () => [...calls].reverse().find((c) => c.method === "sendMessage" && c.payload.reply_markup)!;
/** Нажать вариант онбординга по надписи на последней клавиатуре. */
const tapLabel = (id: number, label: string) => {
  const btn = (lastSent().payload.reply_markup.inline_keyboard as { text: string; callback_data: string }[][]).flat().find((b) => b.text === label);
  if (!btn) throw new Error("no button " + label);
  return tap(id, btn.callback_data);
};
async function onboard(id: number, answers: string[]) {
  await msg(id, "/start");
  for (const t of answers) await msg(id, t);
  await tapLabel(id, "Готово");
}
const lastText = () => [...calls].reverse().find((c) => c.method === "sendMessage" || c.method === "editMessageText")!.payload.text as string;

describe("telegram bot", () => {
  beforeAll(() => { calls.length = 0; });

  it("/start onboards via the chat flow with inline keyboards, second /start does not wipe an existing plan", async () => {
    const id = 50001;
    await msg(id, "/start");
    expect(lastText()).toContain("Привет");
    const kb = lastSent().payload.reply_markup.inline_keyboard[0][0];
    expect(kb.text).toBe("Начнём");
    expect(Buffer.byteLength(kb.callback_data)).toBeLessThanOrEqual(64);
    expect(kb.callback_data).toMatch(/^o:[0-9a-f]{8}:0$/);
    await tapLabel(id, "Начнём");
    // клавиатура снята, эхо выбора
    expect(calls.some((c) => c.method === "editMessageReplyMarkup")).toBe(true);
    expect(calls.some((c) => c.method === "sendMessage" && c.payload.text === "› Начнём")).toBe(true);
    expect(lastText()).toContain("Сколько сейчас денег");
    for (const t of ["60000", "25.10 80000", "Аренда 30000 20.10", "10000", "1000", "нет"]) await msg(id, t);
    expect(lastText()).toContain("Вот что я понял");
    await tapLabel(id, "Готово");
    expect(lastText()).toContain("Теперь можно спросить");
    const userId = (await telegramUserId(id, false))!;
    expect((await getForecast(userId))!.book.essentialDailyMinor).toBe(100000n);
    await msg(id, "/start");
    expect(lastText()).toContain("С возвращением");
    expect(await getForecast(userId)).not.toBeNull();
  });

  it("/link with a raw web user id is refused; one-time code works", async () => {
    const web = await webUser();
    await msg(50002, `/link ${web.userId}`);
    expect(lastText()).toContain("Такого кода нет");
    const link = await startLink(web.userId, new Date());
    await msg(50002, `/start link_${link.code}`);
    // Deep link не одобряет сам: показывает контекст и кнопки.
    const sent = [...calls].reverse().find((c) => c.method === "sendMessage")!;
    expect(sent.payload.text).toContain("Разрешить доступ браузеру?");
    const [allow, deny] = sent.payload.reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data);
    expect(allow).toBe(`la:${link.id}`);
    expect(deny).toBe(`ld:${link.id}`);
    await tap(50099, allow); // чужое нажатие ничего не одобряет
    expect(lastText()).toContain("недоступен");
    await tap(50002, allow);
    expect(lastText()).toContain("Доступ разрешён");
  });

  it("deny button cancels the link request", async () => {
    const web = await webUser();
    const link = await startLink(web.userId, new Date());
    await msg(50007, `/link ${link.code}`);
    await tap(50007, `ld:${link.id}`);
    expect(lastText()).toContain("Браузер не получит доступ");
    await msg(50007, `/start link_${link.code}`);
    expect(lastText()).toContain("уже использован");
  });

  it("expense proposal with buttons; double tap records once; same numbers as web", async () => {
    const id = 50003;
    await onboard(id, ["60000", "25.06.2027 80000", "нет", "0", "не знаю", "нет"]);
    await msg(id, "Потратил 500 на кофе");
    const sent = [...calls].reverse().find((c) => c.method === "sendMessage")!;
    expect(sent.payload.text).toContain("Записать расход");
    const button = sent.payload.reply_markup.inline_keyboard[0][0].callback_data as string;
    await tap(id, button, "cb-1");
    await tap(id, button, "cb-2");
    expect(lastText()).toContain("уже записано");
    const userId = (await telegramUserId(id, false))!;
    expect(await recentEntries(userId)).toHaveLength(1);
    // веб и бот видят одну и ту же версию и суммы
    const web = await answer(userId, "Сколько можно тратить в день?", { channel: "web" });
    const v = (await getForecast(userId))!;
    expect(web.meta?.financeVersion).toBe(v.meta.financeVersion);
    expect(v.book.balanceMinor).toBe(5_950_000n);
  });

  it("verdict «✓ Купил»: proposal for the exact item and price, button removed, recorded once after confirm", async () => {
    const id = 50006;
    await onboard(id, ["60000", "25.06.2027 80000", "нет", "0", "не знаю", "нет"]);
    await msg(id, "Можно купить кофе за 300?");
    const verdictMsg = [...calls].reverse().find((c) => c.method === "sendMessage")!;
    const rows = verdictMsg.payload.reply_markup.inline_keyboard as { text: string; callback_data: string }[][];
    // компактно: «✓ Купил» + «Почему так? ✦» одной строкой, «Поделиться» — второй
    expect(rows.map((r) => r.map((b) => b.text))).toEqual([["✓ Купил", "Почему так? ✦"], ["Поделиться"]]);
    expect(rows[0][0].callback_data).toMatch(/^bp:[0-9a-f-]{36}$/);
    expect(Buffer.byteLength(rows[0][0].callback_data)).toBeLessThanOrEqual(64);
    const before = calls.length;
    await bot.handleUpdate({ update_id: uid++, callback_query: { id: "bp-1", from: from(id), chat_instance: "x", data: rows[0][0].callback_data, message: { message_id: 1, date: 0, chat: { id, type: "private", first_name: "U" }, text: "...", reply_markup: { inline_keyboard: rows } } } } as never);
    const after = calls.slice(before);
    const edit = after.find((c) => c.method === "editMessageReplyMarkup")!.payload;
    expect(JSON.stringify(edit.reply_markup)).not.toContain("bp:"); // кнопка снята — второй записи не будет
    expect(JSON.stringify(edit.reply_markup)).toContain("ex:");
    const prop = after.find((c) => c.method === "sendMessage")!.payload;
    expect(prop.text).toContain("Записать расход «Кофе» на 300");
    const [rec, rej] = prop.reply_markup.inline_keyboard[0] as { text: string; callback_data: string }[];
    expect([rec.text, rej.text]).toEqual(["Записать", "Не записывать"]);
    const userId = (await telegramUserId(id, false))!;
    expect(await recentEntries(userId)).toHaveLength(0); // до подтверждения ничего не записано
    await tap(id, rec.callback_data, "bp-confirm-1");
    await tap(id, rec.callback_data, "bp-confirm-2");
    expect(await recentEntries(userId)).toHaveLength(1);
    expect((await getForecast(userId))!.book.balanceMinor).toBe(5_970_000n);
    // чужой расчёт: ничего не готовим
    await msg(50007, "/start");
    calls.length = 0;
    await tap(50007, rows[0][0].callback_data);
    expect(lastText()).toContain("расчёт уже недоступен");
  });

  it("someone else's button does nothing", async () => {
    const owner = 50004, stranger = 50005;
    await onboard(owner, ["1000", "25.06.2027 80000", "нет", "0", "не знаю", "нет"]);
    await msg(owner, "Потратил 100 на чай");
    const sent = [...calls].reverse().find((c) => c.method === "sendMessage")!;
    const button = sent.payload.reply_markup.inline_keyboard[0][0].callback_data as string;
    await msg(stranger, "/start");
    await tap(stranger, button);
    expect(await recentEntries((await telegramUserId(owner, false))!)).toHaveLength(0);
  });

  it("stale onboarding button: gentle refusal, keyboard removed, current question repeated", async () => {
    const id = 50010;
    await msg(id, "/start");
    await tapLabel(id, "Начнём");
    await msg(id, "50000");
    const incomeKb = lastSent();
    const unknownBtn = (incomeKb.payload.reply_markup.inline_keyboard as { text: string; callback_data: string }[][]).flat().find((b) => b.text === "Не знаю")!;
    await msg(id, "80000 25.12");
    const before = calls.length;
    await tap(id, unknownBtn.callback_data);
    const after = calls.slice(before);
    expect(after.find((c) => c.method === "answerCallbackQuery")!.payload.text).toContain("неактуален");
    expect(after.some((c) => c.method === "editMessageReplyMarkup")).toBe(true);
    expect(lastText()).toContain("уже неактуален");
    expect(lastText()).toContain("платежи");
    const userId = (await telegramUserId(id, false))!;
    expect((await getForecast(userId))!.forecast.nextIncome).not.toBeNull();
  });

  it("web onboarding session continues in Telegram with «Продолжим?»", async () => {
    const id = 50011;
    const userId = (await telegramUserId(id))!;
    const { openOnboarding, handleTurn } = await import("../lib/onboarding/orchestrator");
    const o = await openOnboarding(userId, "web");
    const intro = o.messages[0] as { id: string; revision: number; choices: { id: string }[] };
    await handleTurn(userId, { clientMessageId: "w1", text: "Начнём", selection: { assistantMessageId: intro.id, choiceId: intro.choices[0].id, revision: intro.revision } }, "web");
    await handleTurn(userId, { clientMessageId: "w2", text: "30000" }, "web");
    await msg(id, "/start");
    expect(lastText()).toContain("Продолжим");
    await tapLabel(id, "Продолжить");
    expect(lastText()).toContain("ближайший доход");
  });

  it("/cancel pauses the chat onboarding: free text no longer fills slots, /start offers to continue", async () => {
    const id = 50012;
    await msg(id, "/start");
    await tapLabel(id, "Начнём");
    await msg(id, "/cancel");
    await msg(id, "40000");
    const userId = (await telegramUserId(id, false))!;
    const { loadSession } = await import("../lib/onboarding/session");
    expect((await loadSession(userId))!.facts.balance.status).toBe("missing");
    expect(lastText()).toContain("Продолжим");
  });

  it("group chats get no financial data", async () => {
    await bot.handleUpdate({ update_id: uid++, message: { message_id: 1, date: 0, chat: { id: -1, type: "group", title: "g" }, from: from(50006), text: "Сколько можно тратить?" } } as never);
    expect(lastText()).toContain("только в личном чате");
  });
});
void NOW;
