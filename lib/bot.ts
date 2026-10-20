// Telegram-бот: тот же сервисный слой, что и веб. Собственных формул нет.
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { answer, onboardingActive, onboardingStep, proposalFromDecision, proposalText, snapshotText, startOnboarding } from "./coach";
import { approveLink, denyLink, previewLink, telegramUserId, type LinkPreview } from "./auth";
import { getForecast } from "./finance-service";
import { confirmProposal, getProposal, rejectProposal, type ProposalView } from "./proposals";
import { setState } from "./conversation";
import { sttEnabled, transcribeAudio } from "./llm";
import { enforce, LIMITS } from "./rate-limit";
import { requireTelegramBotToken } from "./telegram-token";
import { DEFAULT_TZ } from "./engine";
import { handleTurn, openOnboarding, pauseOnboarding } from "./onboarding/orchestrator";
import { getAnalyticsConsent, setAnalyticsConsent, track, trackActivity } from "./analytics";
import { loadSession, assistantByPrefix } from "./onboarding/session";
import { CALLBACK_RE, renderTelegram } from "./onboarding/render-telegram";
import type { AssistantMessage, ChatMessage } from "./onboarding/protocol";
import { createEntryProposal } from "./proposals";
import { logServiceError, setCallType, setCallUser, withCall, type CallType } from "./service-log";
import { recordFirstTouch, startPayloadAttribution } from "./traffic-source";
import { markInternalIfListed } from "./internal-users";
import { attributeReferral, parseRefPayload, referralMe, telegramShareUrl, type ReferralMe } from "./referrals";
import { explainDecision, tokenNote } from "./explain";
import { getPlan, plansConfig, recordVoice, upsertInterest, voiceLeft } from "./plans";
import { interestThanks, plusText } from "./plans/copy";
import { clearBlocked, getSettings, KIND_LABEL, REMINDER_KINDS, settingsKeyboard, settingsText, slowerNudge, updateSettings, type ReminderKind } from "./reminders";

const proposalKeyboard = (p: ProposalView) => new InlineKeyboard().text("Записать", `pc:${p.id}:${p.revision}`).text("Не записывать", `pr:${p.id}`);

const LINK_REPLY: Record<string, string> = {
  approved: "Доступ разрешён. Вернитесь в браузер и нажмите «Подтвердить» — так мы убедимся, что привязку начали именно вы.",
  invalid: "Такого кода нет. Возьмите свежий код в приложении: «Связать с Telegram».",
  expired: "Код устарел. Создайте новый в приложении, это займёт пару секунд.",
  already_used: "Этот код уже использован. Если нужно, создайте новый в приложении.",
};

const MAX_VOICE_BYTES = 10 * 1024 * 1024;

/** Вердикт ответа «Можно?» для карточки «Мне бот сказал…» (без сумм и товара). */
const SHARE_VERDICT: Record<string, string> = { yes: "можно ✅", careful: "можно, но аккуратно 👌", wait: "лучше подождать ⏳", no: "пока не стоит 🙅" };
export const shareResultText = (verdict: string | null) => verdict && SHARE_VERDICT[verdict]
  ? `Спросил у «Можно?», хватит ли денег до зарплаты. Мне бот сказал: ${SHARE_VERDICT[verdict]}\nСуммы — только у меня, бот считает сам. Попробуй:`
  : "Проверяю покупки до зарплаты в «Можно?»: бот считает, хватит ли денег до дохода. Попробуй:";

/** Ответ на /invite и кнопку «Пригласить друга»: личная ссылка и счётчики. */
export function inviteText(m: ReferralMe): string {
  return [
    "Пригласить друга в «Можно?»",
    "",
    "Ваша личная ссылка:",
    m.links.bot,
    "",
    `Пришли по ссылке: ${m.invited} · начали пользоваться: ${m.active}`,
    "",
    "Друг получает тот же доступ, что и все. Ваших сумм и данных он не увидит.",
  ].join("\n");
}
const inviteKeyboard = (m: ReferralMe, verdict: string | null) => new InlineKeyboard().url("Отправить другу", telegramShareUrl(m.links.bot, shareResultText(verdict)));

const linkTime = (d: Date) => new Intl.DateTimeFormat("ru-RU", { timeZone: DEFAULT_TZ, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(d);

/** Текст подтверждения привязки: что произойдёт, откуда запрос и предупреждение о фишинге. */
export function linkPreviewText(p: Extract<LinkPreview, { status: "ok" }>): string {
  return [
    "Запрос доступа к вашим финансам",
    "",
    "Кто-то (возможно, вы) открыл «Можно?» в браузере и хочет связать его с этим Telegram-аккаунтом.",
    p.device ? `Устройство: ${p.device}` : null,
    `Запрос создан: ${linkTime(p.createdAt)} (МСК), действует до ${linkTime(p.expiresAt).split(", ").pop()}.`,
    "",
    p.telegramHasPlan
      ? "Если разрешить, этот браузер получит полный доступ к вашему плану, остатку и операциям."
      : "Если разрешить, браузер и бот будут работать с одним общим планом.",
    "Разрешайте, только если вы сами только что нажали «Связать с Telegram». Если ссылку прислал кто-то другой, нажмите «Отклонить».",
    "",
    "Разрешить доступ браузеру?",
  ].filter((x) => x != null).join("\n");
}

export function createBot(token = requireTelegramBotToken(), opts: { botInfo?: UserFromGetMe; rethrow?: boolean } = {}) {
  const bot = new Bot(token, opts.botInfo ? { botInfo: opts.botInfo } : undefined);

  // Журнал обращений: одно обращение на входящее сообщение или нажатие кнопки (тип уточняют обработчики ниже).
  bot.use(async (ctx, next) => {
    if (!ctx.message && !ctx.callbackQuery) return next();
    return withCall({ type: botCallType(ctx), channel: "telegram" }, () => next());
  });

  // Финансовые данные — только в личном чате.
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== "private") { if (ctx.message) await ctx.reply("Я работаю с личными финансами только в личном чате."); return; }
    if (!ctx.from) return;
    await next();
  });
  // Пользователь снова пишет боту — значит, не заблокировал: напоминания можно возобновить.
  // Снимаем до обработки, чтобы /reminders сразу показал актуальное состояние (ревью Codex).
  bot.use(async (ctx, next) => {
    const uid = await telegramUserId(ctx.from!.id, false).catch(() => null);
    if (uid) { setCallUser(uid); await markInternalIfListed(uid, ctx.from!.id); await clearBlocked(uid).catch(() => {}); }
    await next();
    // Аналитика активности: только входящие действия пользователя (сообщение/кнопка); новый пользователь — после /start.
    if (ctx.message || ctx.callbackQuery) {
      const id = uid ?? (await telegramUserId(ctx.from!.id, false).catch(() => null));
      if (id) { setCallUser(id); if (!uid) await markInternalIfListed(id, ctx.from!.id); await trackActivity(id, "telegram"); }
    }
  });

  const userOf = (ctx: Context) => telegramUserId(ctx.from!.id);

  // Deep link и /link ничего не одобряют: только показывают запрос и кнопки (защита от фишинговой ссылки).
  async function linkFlow(ctx: Context, code: string) {
    const p = await previewLink(code, ctx.from!.id);
    if (p.status !== "ok") { await ctx.reply(LINK_REPLY[p.status]); return; }
    await ctx.reply(linkPreviewText(p), { reply_markup: new InlineKeyboard().text("Разрешить", `la:${p.id}`).text("Отклонить", `ld:${p.id}`) });
  }

  /** Отправляет сообщения ассистента онбординга (общий сценарий с вебом) с inline-клавиатурой. */
  async function sendOnboarding(ctx: Context, userId: string, messages: ChatMessage[]) {
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      const r = renderTelegram(m);
      await ctx.reply(r.text, { parse_mode: "HTML", ...(r.keyboard ? { reply_markup: r.keyboard } : {}) });
    }
    const s = await loadSession(userId);
    if (s?.phase === "done" && messages.some((m) => m.role === "assistant")) {
      const v = await getForecast(userId);
      if (v) await ctx.reply(snapshotText(v.forecast) + "\n\nТеперь можно спросить: «Можно купить наушники за 15 000?» Текстом или голосом.");
    }
  }
  async function startChatOnboarding(ctx: Context, userId: string): Promise<boolean> {
    const o = await openOnboarding(userId, "telegram");
    if (o.skip) return false;
    const last = [...o.history].reverse().find((m): m is AssistantMessage => m.role === "assistant");
    await sendOnboarding(ctx, userId, o.messages.length ? o.messages : last ? [last] : []);
    return true;
  }
  const onboardingOpen = async (userId: string) => { const s = await loadSession(userId); return !!s && s.phase !== "done" && s.phase !== "paused"; };

  bot.command("start", async (ctx) => {
    const payload = (ctx.match ?? "").trim();
    if (payload.startsWith("link_")) return linkFlow(ctx, payload.slice(5));
    // Приглашение друга: ?start=ref_<код>. Атрибуция только для нового аккаунта (identity ещё не было).
    const ref = parseRefPayload(payload);
    const existed = ref ? (await telegramUserId(ctx.from!.id, false)) != null : true;
    const userId = (await userOf(ctx))!;
    setCallUser(userId);
    // Источник трафика: payload ссылки t.me/<бот>?start=src_<источник>__<канал>__<кампания> (только первое касание).
    await recordFirstTouch(userId, "telegram", startPayloadAttribution(payload));
    if (ref) { await markInternalIfListed(userId, ctx.from!.id); await attributeReferral(userId, ref.code, "bot", { isNew: !existed }); }
    if (await startChatOnboarding(ctx, userId)) return;
    const v = await getForecast(userId);
    if (v) return ctx.reply("С возвращением! Ваш план на месте.\n\n" + snapshotText(v.forecast) + "\n\nЕсли захотите заполнить план заново, нажмите /setup.");
  });
  bot.command("setup", async (ctx) => {
    const first = await startOnboarding((await userOf(ctx))!);
    await ctx.reply("Хорошо, обновим план. Старые записи сохранятся.\n\n" + first);
  });
  bot.command("cancel", async (ctx) => {
    const uid = (await userOf(ctx))!;
    await setState(uid, "telegram", null);
    await pauseOnboarding(uid);
    await ctx.reply("Хорошо, остановились. Всё, что уже было сохранено, на месте.");
  });
  bot.command("status", async (ctx) => {
    const v = await getForecast((await userOf(ctx))!);
    await ctx.reply(v ? snapshotText(v.forecast) : "Данных пока нет. Нажмите /start, и за минуту заполним план.");
  });
  bot.command("reminders", async (ctx) => {
    const s = await getSettings((await userOf(ctx))!);
    await ctx.reply(settingsText(s), { reply_markup: settingsKeyboard(s) });
  });
  // Анонимная статистика использования: отказ в одно нажатие, действует во всех каналах.
  const privacyText = (on: boolean) => on
    ? "Анонимная статистика включена: я считаю только действия вроде «задан вопрос» или «пройден шаг знакомства» — без текстов, сумм и имён, под псевдонимом. Хранится до 180 дней."
    : "Анонимная статистика выключена. Ничего о ваших действиях не записываю.";
  const privacyKb = (on: boolean) => new InlineKeyboard().text(on ? "Выключить статистику" : "Включить статистику", on ? "pv:off" : "pv:on");
  bot.command("privacy", async (ctx) => {
    const on = await getAnalyticsConsent((await userOf(ctx))!);
    await ctx.reply(privacyText(on), { reply_markup: privacyKb(on) });
  });
  bot.callbackQuery(/^pv:(on|off)$/, async (ctx) => {
    const userId = await telegramUserId(ctx.from.id, false);
    if (!userId) return ctx.answerCallbackQuery();
    const on = await setAnalyticsConsent(userId, ctx.match![1] === "on");
    await ctx.answerCallbackQuery({ text: on ? "Включено" : "Выключено, данные удалены" });
    await ctx.editMessageText(privacyText(on), { reply_markup: privacyKb(on) }).catch(() => {});
  });
  // Пригласить друга: личная ссылка, счётчики и кнопка «Отправить другу» (t.me/share/url).
  async function sendInvite(ctx: Context, verdict: string | null) {
    const userId = (await userOf(ctx))!;
    setCallType("referral.share");
    const m = await referralMe(userId);
    await track(userId, "invite_shared", { method: "bot", surface: "bot" }, { channel: "telegram", key: `bot:${ctx.update.update_id}` });
    await ctx.reply(inviteText(m), { reply_markup: inviteKeyboard(m, verdict), link_preview_options: { is_disabled: true } });
  }
  bot.command("invite", (ctx) => sendInvite(ctx, null));
  bot.callbackQuery(/^iv(?::(yes|careful|wait|no))?$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendInvite(ctx, ctx.match?.[1] ?? null);
  });
  // Плюс: что бесплатно всегда, что в Плюсе, будущая цена и заявка «Хочу Плюс» без оплаты (выбор «честной цены»).
  const plusKb = (wanted: boolean) => new InlineKeyboard().text(wanted ? "Поменять цену" : "Хочу Плюс", "pl:want");
  async function sendPlus(ctx: Context) {
    const userId = (await userOf(ctx))!;
    setCallType("plan.status");
    const p = await getPlan(userId);
    await track(userId, "plus_viewed", { surface: "bot" }, { channel: "telegram", key: `bot:${ctx.update.update_id}` });
    await ctx.reply(plusText(p), { reply_markup: plusKb(!!p.interest) });
  }
  bot.command("plus", (ctx) => sendPlus(ctx));
  bot.callbackQuery("pl:show", async (ctx) => { await ctx.answerCallbackQuery(); await sendPlus(ctx); });
  bot.callbackQuery("pl:want", async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard();
    for (const o of plansConfig().price.options) kb.text(`${o} ₽`, `pl:p:${o}`);
    kb.row().text("Не знаю", "pl:p:0");
    await ctx.reply("Сколько, по-вашему, честно платить за Плюс в месяц? Это просто опрос — ничего не списываем.", { reply_markup: kb });
  });
  bot.callbackQuery(/^pl:p:(\d{1,5})$/, async (ctx) => {
    const userId = await telegramUserId(ctx.from.id, false);
    if (!userId) return ctx.answerCallbackQuery({ text: "Не нашёл ваш план. Нажмите /start." });
    const n = Number(ctx.match![1]);
    try {
      const r = await upsertInterest(userId, { price: n || null, channel: "telegram" });
      await ctx.answerCallbackQuery({ text: "Записали, спасибо!" });
      await ctx.editMessageText(interestThanks(r.priceChoice)).catch(() => {});
    } catch { await ctx.answerCallbackQuery({ text: "Выберите один из вариантов" }); }
  });
  // «Почему так?» под ответом «Можно?»: AI-объяснение (1 AI-ответ) или шаблон с теми же числами.
  async function sendExplain(ctx: Context, userId: string, decisionId: string) {
    const r = await explainDecision(userId, decisionId, { channel: "telegram" });
    if (!r) return ctx.reply("Этот расчёт уже недоступен. Спросите «Можно?» ещё раз — посчитаю заново.");
    const note = r.note ?? tokenNote(r.tokens);
    const text = note ? `${r.reply}\n\n${note}` : r.reply;
    return ctx.reply(text, r.tokens?.exhausted ? { reply_markup: new InlineKeyboard().text("Что такое Плюс", "pl:show") } : {});
  }
  bot.callbackQuery(/^ex:([0-9a-f-]{36})$/i, async (ctx) => {
    const userId = await telegramUserId(ctx.from.id, false);
    if (!userId) return ctx.answerCallbackQuery({ text: "Не нашёл ваш план. Нажмите /start." });
    await ctx.answerCallbackQuery();
    // Убираем только «Почему так? ✦» (без повторного объяснения), «Поделиться с другом» остаётся.
    const rest = (ctx.callbackQuery.message?.reply_markup?.inline_keyboard ?? []).map((row) => row.filter((btn) => !("callback_data" in btn && btn.callback_data?.startsWith("ex:")))).filter((row) => row.length);
    await ctx.editMessageReplyMarkup({ reply_markup: rest.length ? { inline_keyboard: rest } : undefined }).catch(() => {});
    await sendExplain(ctx, userId, ctx.match![1]);
  });
  // «Купил — записать» под ответом «Можно?»: предложение на товар и цену из расчёта, кнопка снимается (без повторной записи).
  bot.callbackQuery(/^bp:([0-9a-f-]{36})$/i, async (ctx) => {
    const userId = await telegramUserId(ctx.from.id, false);
    if (!userId) return ctx.answerCallbackQuery({ text: "Не нашёл ваш план. Нажмите /start." });
    setCallType("entry.create");
    const rest = (ctx.callbackQuery.message?.reply_markup?.inline_keyboard ?? []).map((row) => row.filter((btn) => !("callback_data" in btn && btn.callback_data?.startsWith("bp:")))).filter((row) => row.length);
    await ctx.editMessageReplyMarkup({ reply_markup: rest.length ? { inline_keyboard: rest } : undefined }).catch(() => {});
    try {
      const r = await proposalFromDecision(userId, ctx.match![1], "telegram");
      if (!r) { await ctx.answerCallbackQuery({ text: "Расчёт недоступен" }); return ctx.reply("Этот расчёт уже недоступен. Напишите, например, «Купил кофе за 300» — подготовлю запись."); }
      await ctx.answerCallbackQuery({ text: "Проверьте и подтвердите" });
      return ctx.reply(r.reply, { reply_markup: proposalKeyboard(r.proposal) });
    } catch (e) {
      await logServiceError({ error: e });
      await ctx.answerCallbackQuery({ text: "Не получилось" });
      return ctx.reply("Не получилось подготовить запись. Можно написать текстом, например «Купил кофе за 300».");
    }
  });
  bot.command("link", async (ctx) => {
    const code = (ctx.match ?? "").trim();
    if (!code) return ctx.reply("Чтобы связать Telegram с веб-версией, откройте приложение и нажмите «Связать с Telegram». Там будет ссылка или код для команды /link КОД.");
    return linkFlow(ctx, code);
  });

  async function handle(ctx: Context, text: string) {
    const userId = (await userOf(ctx))!;
    try { await enforce([LIMITS.chatPerUser(userId), LIMITS.chatPerUserDay(userId)]); }
    catch { return ctx.reply("Давайте сделаем небольшую паузу, через минуту продолжим."); }
    if (await onboardingActive(userId)) { setCallType("onboarding.turn"); return ctx.reply((await onboardingStep(userId, text, { updateId: ctx.update.update_id })).reply); }
    if (await onboardingOpen(userId)) {
      setCallType("onboarding.turn");
      const r = await handleTurn(userId, { clientMessageId: `tg:${ctx.update.update_id}`, text }, "telegram");
      return sendOnboarding(ctx, userId, r.messages);
    }
    setCallType("chat.message"); // answer() уточнит до chat.question, если это вопрос «Можно?»
    const r = await answer(userId, text, { channel: "telegram" });
    if (r.needsOnboarding) { if (await startChatOnboarding(ctx, userId)) return; return ctx.reply("Давайте начнём с /start, чтобы я узнал остаток, доход и платежи."); }
    if (r.proposal) return ctx.reply(r.reply, { reply_markup: proposalKeyboard(r.proposal) });
    // Ответ «Можно?»: тихая кнопка поделиться результатом (без сумм) и личной ссылкой.
    const verdict = (r as { impact?: { verdict?: string } }).impact?.verdict;
    if (verdict && SHARE_VERDICT[verdict]) {
      const kb = new InlineKeyboard();
      // Компактно: «✓ Купил» и «Почему так? ✦» в одной строке, «Поделиться» — второй.
      // «Купил» — только через подтверждаемое предложение (bp: → pc:/pr:).
      if (r.decisionId && (r as { impact?: { price?: number } }).impact?.price) kb.text("✓ Купил", `bp:${r.decisionId}`);
      if (r.decisionId) kb.text("Почему так? ✦", `ex:${r.decisionId}`).row();
      kb.text("Поделиться", `iv:${verdict}`);
      return ctx.reply(r.reply, { reply_markup: kb });
    }
    // «А почему?» текстом: объяснение + мягкая строка, если AI-ответов мало или они закончились.
    if (r.explain) {
      const note = r.explain.note ?? tokenNote(r.explain.tokens);
      return ctx.reply(note ? `${r.reply}\n\n${note}` : r.reply, r.explain.tokens?.exhausted ? { reply_markup: new InlineKeyboard().text("Что такое Плюс", "pl:show") } : {});
    }
    return ctx.reply(r.reply);
  }

  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    const lm = data.match(/^l([ad]):([0-9a-f-]{36})$/i);
    if (!lm) return next();
    if (lm[1] === "a") {
      const r = await approveLink(lm[2], ctx.from.id);
      await ctx.answerCallbackQuery({ text: r === "approved" ? "Доступ разрешён" : "Запрос недоступен" });
      await ctx.editMessageText(r === "invalid" ? "Этот запрос недоступен. Создайте новый в приложении." : LINK_REPLY[r]).catch(() => {});
      return;
    }
    const ok = await denyLink(lm[2], ctx.from.id);
    await ctx.answerCallbackQuery({ text: ok ? "Отклонено" : "Запрос недоступен" });
    await ctx.editMessageText(ok ? "Отклонено. Браузер не получит доступ к вашим финансам." : "Этот запрос уже недоступен.").catch(() => {});
  });

  // Напоминания: rm:<действие>[:<аргумент>]. Все действия — тихие и обратимые; деньги — только через подтверждаемое предложение.
  bot.on("callback_query:data", async (ctx, next) => {
    const m = ctx.callbackQuery.data.match(/^rm:([a-z]+)(?::([0-9a-z_-]{1,40}))?$/i);
    if (!m) return next();
    const userId = await telegramUserId(ctx.from.id, false);
    if (!userId) return ctx.answerCallbackQuery({ text: "Не нашёл ваш план. Нажмите /start." });
    const [, act, arg] = m;
    const kind = (REMINDER_KINDS as readonly string[]).includes(arg ?? "") ? (arg as ReminderKind) : null;
    // Клик по кнопке напоминания (не по экрану настроек /reminders): вид выводится из действия.
    const clickKind: ReminderKind | null = act === "paid" ? "payment_due" : act === "inc" ? "payday" : act === "ob" ? "onboarding" : act === "log" ? "log_nudge" : (act === "later" || act === "less" || act === "off") ? kind : null;
    if (clickKind) await track(userId, "reminder_clicked", { kind: clickKind, action: act as "paid" }, { channel: "telegram", key: `cb:${ctx.callbackQuery.id}` });
    const done = async (toast: string, note?: string) => {
      await ctx.answerCallbackQuery({ text: toast });
      const old = (ctx.callbackQuery.message as { text?: string } | undefined)?.text;
      if (note && old) await ctx.editMessageText(`${old}\n\n${note}`).catch(() => {});
      else await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    };
    if ((act === "tog" && kind) || act === "all") {
      const cur = await getSettings(userId);
      const s = act === "all" ? await updateSettings(userId, { enabled: arg === "on", ...(arg === "on" ? { blocked: false } : {}) })
        : await updateSettings(userId, { kinds: { [kind!]: !cur.kinds[kind!] } });
      await ctx.answerCallbackQuery({ text: act === "all" ? (arg === "on" ? "Включено" : "Выключено") : `${KIND_LABEL[kind!]}: ${s.kinds[kind!] ? "вкл" : "выкл"}` });
      await ctx.editMessageText(settingsText(s), { reply_markup: settingsKeyboard(s) }).catch(() => {});
      return;
    }
    if (act === "off" && kind) { await updateSettings(userId, { kinds: { [kind]: false } }); return done("Выключено", "Хорошо, такие больше не присылаю. Вернуть можно в /reminders."); }
    if (act === "less" && kind === "log_nudge") {
      const s = await slowerNudge(userId);
      return done("Буду реже", `Хорошо, теперь не чаще раза в ${s.nudgeEveryDays} дн.`);
    }
    if (act === "later") return done("Хорошо", "Хорошо, не тороплю. Когда придёт — просто напишите, например «зарплата пришла».");
    if (act === "log") { await done("Жду сумму"); return ctx.reply("Напишите сумму и что купили, например «продукты 1200». Покажу, как изменится план, и запишу после подтверждения."); }
    if (act === "ob") { await done("Продолжаем"); if (!(await startChatOnboarding(ctx, userId))) await ctx.reply("План уже готов. /status покажет, сколько можно в день."); return; }
    if ((act === "paid" || act === "inc") && arg && /^[0-9a-f-]{36}$/i.test(arg)) {
      const v = await getForecast(userId);
      const occ = v?.book.occurrences.find((o) => o.id === arg && o.direction === (act === "inc" ? "income" : "expense"));
      if (!v || !occ || occ.remainingMinor <= 0n) return done("Уже учтено", "Это уже отмечено, ничего делать не нужно.");
      try {
        const p = await createEntryProposal(userId, { direction: occ.direction, amountMinor: occ.remainingMinor, occurrenceId: occ.id, description: occ.name, source: "telegram" }, new Date(), { origin: "reminder" });
        await done("Проверьте и подтвердите");
        const after = v.book.balanceMinor + (occ.direction === "expense" ? -occ.remainingMinor : occ.remainingMinor);
        return ctx.reply(proposalText(p, after, occ.name), { reply_markup: proposalKeyboard(p) });
      } catch { return done("Не получилось", "Не получилось подготовить запись. Можно написать текстом, например «оплатил аренду»."); }
    }
    return ctx.answerCallbackQuery();
  });

  // Варианты ответа онбординга: снять клавиатуру, эхо «› …», дальше — тот же обработчик, что и для текста.
  bot.on("callback_query:data", async (ctx, next) => {
    const om = ctx.callbackQuery.data.match(CALLBACK_RE);
    if (!om) return next();
    const userId = await telegramUserId(ctx.from.id, false);
    if (!userId) return ctx.answerCallbackQuery({ text: "Не нашёл ваш план. Нажмите /start." });
    const msg = await assistantByPrefix(userId, om[1]);
    const choice = msg?.choices[Number(om[2])];
    const s = await loadSession(userId);
    const stale = !msg || !choice || !s || s.phase === "done" || s.phase === "paused" || s.lastAssistantId !== msg.id;
    await ctx.answerCallbackQuery(stale ? { text: "Этот вопрос уже неактуален" } : {});
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    if (choice) await ctx.reply(`› ${choice.label}`);
    if (!s || s.phase === "done" || s.phase === "paused") return;
    const r = await handleTurn(userId, {
      clientMessageId: `tg-cb:${ctx.callbackQuery.id}`, text: choice?.userText ?? "",
      selection: { assistantMessageId: msg?.id ?? "00000000-0000-0000-0000-000000000000", choiceId: choice?.id ?? "-", revision: msg?.revision ?? -1 },
    }, "telegram");
    await sendOnboarding(ctx, userId, r.messages);
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = await telegramUserId(ctx.from.id, false);
    if (!userId) return ctx.answerCallbackQuery({ text: "Не нашёл ваш план. Нажмите /start." });
    try {
      let m = data.match(/^pc:([0-9a-f-]{36}):(\d+)$/i);
      if (m) {
        const out = await confirmProposal(userId, m[1], { revision: Number(m[2]), idempotencyKey: `tg-cb:${ctx.callbackQuery.id}` });
        if (out.status === 200) {
          const v = await getForecast(userId);
          await ctx.answerCallbackQuery({ text: out.body.alreadyApplied ? "Уже записано" : "Записано" });
          await ctx.editMessageText((out.body.alreadyApplied ? "Это уже записано, повторно не добавляю.\n\n" : "Записал.\n\n") + (v ? snapshotText(v.forecast) : "")).catch(() => {});
          return;
        }
        const err = (out.body.error as { code: string; message: string }) ?? { code: "", message: "" };
        if (err.code === "STALE_PROPOSAL" || err.code === "PROPOSAL_REVISION_MISMATCH") {
          const p = await getProposal(userId, m[1]);
          const v = await getForecast(userId);
          const after = v ? v.book.balanceMinor + (p.payload.direction === "expense" ? -p.payload.amountMinor : p.payload.amountMinor) : null;
          await ctx.answerCallbackQuery({ text: "Данные обновились" });
          if (p.status === "pending") await ctx.editMessageText("Данные изменились, проверьте ещё раз.\n" + proposalText(p, after, null), { reply_markup: proposalKeyboard(p) }).catch(() => {});
          return;
        }
        await ctx.answerCallbackQuery({ text: err.message.slice(0, 190) || "Не получилось" });
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
        return;
      }
      m = data.match(/^pr:([0-9a-f-]{36})$/i);
      if (m) {
        const p = await rejectProposal(userId, m[1]);
        if (p.status === "applied") {
          await ctx.answerCallbackQuery({ text: "Это уже записано" });
          await ctx.editMessageText("Эта запись уже сохранена. Если она лишняя, напишите об этом, и мы её поправим.").catch(() => {});
          return;
        }
        await ctx.answerCallbackQuery({ text: "Хорошо, не записываю" });
        await ctx.editMessageText(p.status === "expired" ? "Это предложение устарело, ничего не записал." : "Хорошо, ничего не записал.").catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery();
    } catch (e) {
      const code = (e as { code?: string }).code;
      await logServiceError({ error: e });
      await ctx.answerCallbackQuery({ text: code === "NOT_FOUND" ? "Это предложение недоступно" : "Не получилось, попробуйте ещё раз" });
    }
  });

  bot.on("message:text", (ctx) => handle(ctx, ctx.message.text));
  bot.on(["message:voice", "message:audio"], async (ctx) => {
    if (!sttEnabled()) return ctx.reply("Голосовые пока недоступны. Напишите текстом, пожалуйста.");
    const dur = ctx.message.voice?.duration ?? ctx.message.audio?.duration ?? 0;
    if (dur > 120) return ctx.reply("Голосовое длинновато. Попробуйте уложиться в пару минут или напишите текстом.");
    try { await enforce([LIMITS.sttPerUser((await userOf(ctx))!)]); }
    catch { return ctx.reply("Давайте сделаем небольшую паузу, через минуту продолжим."); }
    // Минуты голоса по тарифу (lib/plans); AI-ответы распознавание не тратит.
    if ((await voiceLeft((await userOf(ctx))!)) === 0) return ctx.reply("Голосовые минуты пока закончились. Напишите текстом — посчитаю так же. /plus — что входит в тариф.");
    try {
      const declared = ctx.message.voice?.file_size ?? ctx.message.audio?.file_size ?? 0;
      if (declared > MAX_VOICE_BYTES) return ctx.reply("Голосовое слишком большое. Попробуйте покороче или напишите текстом.");
      const file = await ctx.getFile();
      if (!file.file_path || (file.file_size ?? 0) > MAX_VOICE_BYTES) return ctx.reply("Голосовое слишком большое. Попробуйте покороче или напишите текстом.");
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`telegram file ${res.status}`);
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > MAX_VOICE_BYTES) return ctx.reply("Голосовое слишком большое. Попробуйте покороче или напишите текстом.");
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_VOICE_BYTES) return ctx.reply("Голосовое слишком большое. Попробуйте покороче или напишите текстом.");
      // Учёт и бюджет — lib/llm/stt.ts (ai_usage, purpose=voice_transcribe); длительность из Telegram — для резерва и стоимости.
      const r = await transcribeAudio(new Blob([buf], { type: "audio/ogg" }), { filename: "voice.ogg", durationSec: dur || null, userId: await userOf(ctx), channel: "telegram" });
      if (!r.ok && r.reason === "budget") return ctx.reply("Голосовые на сегодня закончились. Напишите текстом, пожалуйста: посчитаю так же.");
      if (!r.ok) throw Object.assign(new Error("STT failed"), { code: r.code });
      const text = r.text;
      await recordVoice((await userOf(ctx))!, r.seconds);
      await ctx.reply(`Я услышал: "${text}"`);
      await handle(ctx, text);
    } catch (e) {
      await ctx.reply("Не получилось распознать голосовое. Попробуйте ещё раз или напишите текстом."); console.error("voice error", { name: (e as Error)?.name });
      await logServiceError({ route: "bot.voice", code: "STT_FAILED", error: e });
    }
  });
  // В лог — только тип и код ошибки: сообщения могут содержать текст пользователя или токен.
  bot.catch((e) => {
    console.error("bot error", { name: (e.error as Error)?.name, code: (e.error as { code?: string })?.code, update: e.ctx?.update?.update_id });
    if (!opts.rethrow) void logServiceError({ channel: "telegram", route: "bot.update", error: e.error }); // вебхук пишет сам (без дубля)
    if (opts.rethrow) throw e.error; // вебхук: апдейт останется необработанным и будет повторён (lib/telegram-webhook.ts)
  });
  return bot;
}

/** Тип обращения по входящему апдейту; обработчики уточняют его через setCallType. */
export function botCallType(ctx: Pick<Context, "message" | "callbackQuery">): CallType {
  const m = ctx.message;
  if (m) {
    if (m.voice || m.audio) return "bot.voice";
    const t = m.text ?? "";
    if (/^\/start(\s|@|$)/.test(t)) return "bot.start";
    if (t.startsWith("/")) return "bot.command";
    return "bot.message";
  }
  const d = ctx.callbackQuery?.data ?? "";
  if (/^pc:/.test(d)) return "proposal.confirm";
  if (/^pr:/.test(d)) return "proposal.reject";
  if (/^rm:/.test(d)) return "reminder.click";
  if (/^l[ad]:/.test(d)) return "account.link";
  if (/^pv:/.test(d)) return "analytics.consent";
  if (/^iv(:|$)/.test(d)) return "referral.share";
  if (/^ex:/.test(d)) return "chat.explain";
  if (/^bp:/.test(d)) return "entry.create";
  if (/^pl:p:/.test(d)) return "plus.interest";
  if (/^pl:/.test(d)) return "plan.status";
  if (CALLBACK_RE.test(d)) return "onboarding.turn";
  return "bot.callback";
}
