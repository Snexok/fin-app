// Telegram-бот: тот же сервисный слой, что и веб. Собственных формул нет.
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { answer, onboardingActive, onboardingStep, proposalText, snapshotText, startOnboarding } from "./coach";
import { approveLink, denyLink, previewLink, telegramUserId, type LinkPreview } from "./auth";
import { getForecast } from "./finance-service";
import { confirmProposal, getProposal, rejectProposal, type ProposalView } from "./proposals";
import { setState } from "./conversation";
import { transcribe } from "./ai/llm";
import { enforce, LIMITS } from "./rate-limit";
import { requireTelegramBotToken } from "./telegram-token";
import { DEFAULT_TZ } from "./engine";

const proposalKeyboard = (p: ProposalView) => new InlineKeyboard().text("Записать", `pc:${p.id}:${p.revision}`).text("Не нужно", `pr:${p.id}`);

const LINK_REPLY: Record<string, string> = {
  approved: "Доступ разрешён. Вернитесь в браузер и нажмите «Подтвердить» — так мы убедимся, что привязку начали именно вы.",
  invalid: "Такого кода нет. Возьмите свежий код в приложении: «Связать с Telegram».",
  expired: "Код устарел. Создайте новый в приложении, это займёт пару секунд.",
  already_used: "Этот код уже использован. Если нужно, создайте новый в приложении.",
};

const MAX_VOICE_BYTES = 10 * 1024 * 1024;

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

  // Финансовые данные — только в личном чате.
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== "private") { if (ctx.message) await ctx.reply("Я работаю с личными финансами только в личном чате."); return; }
    if (!ctx.from) return;
    await next();
  });

  const userOf = (ctx: Context) => telegramUserId(ctx.from!.id);

  // Deep link и /link ничего не одобряют: только показывают запрос и кнопки (защита от фишинговой ссылки).
  async function linkFlow(ctx: Context, code: string) {
    const p = await previewLink(code, ctx.from!.id);
    if (p.status !== "ok") { await ctx.reply(LINK_REPLY[p.status]); return; }
    await ctx.reply(linkPreviewText(p), { reply_markup: new InlineKeyboard().text("Разрешить", `la:${p.id}`).text("Отклонить", `ld:${p.id}`) });
  }

  bot.command("start", async (ctx) => {
    const payload = (ctx.match ?? "").trim();
    if (payload.startsWith("link_")) return linkFlow(ctx, payload.slice(5));
    const userId = await userOf(ctx);
    const v = await getForecast(userId!);
    if (v) return ctx.reply("С возвращением! Ваш план на месте.\n\n" + snapshotText(v.forecast) + "\n\nЕсли захотите заполнить план заново, нажмите /setup.");
    const first = await startOnboarding(userId!);
    await ctx.reply("Привет! Я «Можно?», помогаю спокойно решить, можно ли позволить покупку сейчас. Задам шесть коротких вопросов.\n\n" + first);
  });
  bot.command("setup", async (ctx) => {
    const first = await startOnboarding((await userOf(ctx))!);
    await ctx.reply("Хорошо, обновим план. Старые записи сохранятся.\n\n" + first);
  });
  bot.command("cancel", async (ctx) => {
    await setState((await userOf(ctx))!, "telegram", null);
    await ctx.reply("Хорошо, остановились. Всё, что уже было сохранено, на месте.");
  });
  bot.command("status", async (ctx) => {
    const v = await getForecast((await userOf(ctx))!);
    await ctx.reply(v ? snapshotText(v.forecast) : "Данных пока нет. Нажмите /start, и за минуту заполним план.");
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
    if (await onboardingActive(userId)) return ctx.reply((await onboardingStep(userId, text, { updateId: ctx.update.update_id })).reply);
    const r = await answer(userId, text, { channel: "telegram" });
    if (r.needsOnboarding) return ctx.reply("Давайте начнём с /start, чтобы я узнал остаток, доход и платежи.");
    if (r.proposal) return ctx.reply(r.reply, { reply_markup: proposalKeyboard(r.proposal) });
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
      await ctx.answerCallbackQuery({ text: code === "NOT_FOUND" ? "Это предложение недоступно" : "Не получилось, попробуйте ещё раз" });
    }
  });

  bot.on("message:text", (ctx) => handle(ctx, ctx.message.text));
  bot.on(["message:voice", "message:audio"], async (ctx) => {
    if (!process.env.OPENAI_API_KEY && !process.env.STT_API_KEY) return ctx.reply("Голосовые пока недоступны. Напишите текстом, пожалуйста.");
    const dur = ctx.message.voice?.duration ?? ctx.message.audio?.duration ?? 0;
    if (dur > 120) return ctx.reply("Голосовое длинновато. Попробуйте уложиться в пару минут или напишите текстом.");
    try { await enforce([LIMITS.sttPerUser((await userOf(ctx))!)]); }
    catch { return ctx.reply("Давайте сделаем небольшую паузу, через минуту продолжим."); }
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
      const text = await transcribe(new Blob([buf], { type: "audio/ogg" }), "voice.ogg");
      await ctx.reply(`Я услышал: "${text}"`);
      await handle(ctx, text);
    } catch (e) { await ctx.reply("Не получилось распознать голосовое. Попробуйте ещё раз или напишите текстом."); console.error("voice error", { name: (e as Error)?.name }); }
  });
  // В лог — только тип и код ошибки: сообщения могут содержать текст пользователя или токен.
  bot.catch((e) => {
    console.error("bot error", { name: (e.error as Error)?.name, code: (e.error as { code?: string })?.code, update: e.ctx?.update?.update_id });
    if (opts.rethrow) throw e.error; // вебхук: апдейт останется необработанным и будет повторён (lib/telegram-webhook.ts)
  });
  return bot;
}
