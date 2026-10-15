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
const lastText = () => [...calls].reverse().find((c) => c.method === "sendMessage" || c.method === "editMessageText")!.payload.text as string;

describe("telegram bot", () => {
  beforeAll(() => { calls.length = 0; });

  it("/start onboards, second /start does not wipe an existing plan", async () => {
    const id = 50001;
    await msg(id, "/start");
    expect(lastText()).toContain("Сколько сейчас денег");
    for (const t of ["60000", "25.10 80000", "Аренда 30000 20.10", "10000", "нет", "1000"]) await msg(id, t);
    expect(lastText()).toContain("план сохранён");
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
    await msg(id, "/start");
    for (const t of ["60000", "25.06.2027 80000", "нет", "0", "нет", "не знаю"]) await msg(id, t);
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

  it("someone else's button does nothing", async () => {
    const owner = 50004, stranger = 50005;
    await msg(owner, "/start");
    for (const t of ["1000", "25.06.2027 80000", "нет", "0", "нет", "не знаю"]) await msg(owner, t);
    await msg(owner, "Потратил 100 на чай");
    const sent = [...calls].reverse().find((c) => c.method === "sendMessage")!;
    const button = sent.payload.reply_markup.inline_keyboard[0][0].callback_data as string;
    await msg(stranger, "/start");
    await tap(stranger, button);
    expect(await recentEntries((await telegramUserId(owner, false))!)).toHaveLength(0);
  });

  it("group chats get no financial data", async () => {
    await bot.handleUpdate({ update_id: uid++, message: { message_id: 1, date: 0, chat: { id: -1, type: "group", title: "g" }, from: from(50006), text: "Сколько можно тратить?" } } as never);
    expect(lastText()).toContain("только в личном чате");
  });
});
void NOW;
