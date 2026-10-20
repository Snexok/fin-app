// Общий диалоговый слой для веба и Telegram. Финансовые факты — из движка, текст — шаблоны (§6.4).
import { track } from "./analytics";
import {
  addDays, formatRub, forecastToSnapshot, FUTURE_WINDOW_DAYS, GOAL_FUTURE_DAYS, localDate, PAST_WINDOW_DAYS, simulationToImpact,
  type Assessment, type Forecast, type ISODate, type Minor, type PurchaseImpact, type Scenario, type Simulation, type Snapshot,
} from "./engine";
import { amountCandidates, parseAmountDetailed, parseDate, parseIntentRegex, parsePaymentLines, toNominative, type PurchaseIntent } from "./parse";
import { llmEnabled, parseIntentLLM, type LlmIntent } from "./llm";
import { getDb } from "./db";
import { userTimezone } from "./finance-service";
import { getForecast, savePlan, simulate, type CalculationMeta, type PlanInput } from "./finance-service";
import { createEntryProposal, matchOccurrence, type ProposalView } from "./proposals";
import { getState, setState, type Channel } from "./conversation";
import { setCallType } from "./service-log";
import { activateReferral } from "./referrals";
import { isUuid } from "./util";
import { ESSENTIAL_HINT, explainDecision, lastDecisionId, type ExplainResult } from "./explain";

const rub = (m: Minor) => formatRub(m);
/** Суммы, которые пользователь подтверждает (цена, запись, остаток после), показываются с копейками, если они есть. */
const rubExact = (m: Minor) => formatRub(m, { kopecks: true });
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
export const humanDate = (d: ISODate) => `${+d.slice(8, 10)}\u00a0${MONTHS_GEN[+d.slice(5, 7) - 1]}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- Шаблоны ----------

export function snapshotText(f: Forecast): string {
  const lines: string[] = [];
  const until = f.horizonKind === "until_income" ? `До дохода ${humanDate(f.horizonEnd)} — ${f.days} дн.` : `Ближайший доход не указан, поэтому смотрю на ${f.days} дн. вперёд, до ${humanDate(f.horizonEnd)}.`;
  lines.push(until);
  if (f.freeMoneyMinor != null) lines.push(`Можно тратить около ${rub(f.safeDailyMinor)} в день до ${humanDate(f.horizonEnd)} — на еду, транспорт и покупки. Разово на покупки сверх еды и транспорта: ${rub(f.freeMoneyMinor > 0n ? f.freeMoneyMinor : 0n)}.`);
  else lines.push(`Можно тратить около ${rub(f.safeDailyMinor)} в день до ${humanDate(f.horizonEnd)} — на еду, транспорт и покупки.`);
  if (f.overdueIncomes.length) lines.push(`Доход ${humanDate(f.overdueIncomes[0].dueOn)} ещё не отмечен, пока считаю без него. Когда придёт, просто напишите «зарплата пришла».`);
  const cash = f.gaps.mandatory ?? f.gaps.essential;
  if (cash) lines.push(`Обратите внимание: с ${humanDate(cash.firstDate)} может не хватать на обязательные траты, до ${rub(cash.amountMinor)} к ${humanDate(cash.worstDate)}.`);
  else if (f.gaps.protected) lines.push(`С ${humanDate(f.gaps.protected.firstDate)} план задевает резерв или накопления, до ${rub(f.gaps.protected.amountMinor)}.`);
  if (f.goal?.overdue) lines.push(`Срок цели «${f.goal.name}» уже прошёл. Пока берегу всю недостающую сумму; можно назначить новую дату.`);
  if (f.goal && f.goal.setAsideInHorizonMinor > 0n) lines.push(`На цель «${f.goal.name}» за это время откладываем ${rub(f.goal.setAsideInHorizonMinor)}.`);
  const pays = f.payments.slice(0, 5).map((p) => `• ${p.name}: ${rub(p.amountMinor)} (${p.overdue ? "уже пора оплатить" : humanDate(p.dueOn)})`);
  if (pays.length) lines.push("Ближайшие платежи:\n" + pays.join("\n"));
  return lines.join("\n");
}

// Заголовки ответа. «X за N ₽ — …» вместо «X … укладывается»: название покупки — свободный текст, глагол с ним не согласуется.
// «Аккуратно» — по той же ветке, что и вердикт (assess): если повседневные траты указаны, сравнивается сумма в день сверх них.
const HEAD: Record<Assessment, (item: string, price: string, essentialKnown: boolean) => string> = {
  fits_plan: (i, p) => `Можно: ${i} за ${p} — в рамках плана.`,
  reduces_daily_margin: (i, p, known) => `Можно, но аккуратно: ${i} за ${p} — ${known ? "денег сверх еды и транспорта на день останется меньше половины" : "денег на день останется меньше половины"}.`,
  touches_protected_money: (i, p) => `Сейчас эта покупка (${i}, ${p}) задела бы резерв или деньги на цель.`,
  cash_gap: (i, p) => `Сейчас с покупкой (${i}, ${p}) лучше не спешить: может не хватить на обязательные траты.`,
  insufficient_data: () => "Пока не хватает данных, чтобы спокойно ответить.",
};

function scenarioLine(s: Scenario): string {
  const f = s.forecast;
  const free = s.freeAfterMinor ?? s.envelopeAfterMinor;
  let t = `около ${rub(s.safeDailyAfterMinor)} в день до ${humanDate(f.horizonEnd)}, разово на покупки — ${rub(free > 0n ? free : 0n)}`;
  if (s.firstGapDate) t += `; с ${humanDate(s.firstGapDate)} может не хватать, больше всего — ${rub(s.gapMinor)}`;
  else if (s.reserveShortfallMinor > 0n) t += `; резерв или накопления уменьшатся на ${rub(s.reserveShortfallMinor)}`;
  return t;
}

export function purchaseText(sim: Simulation): string {
  const n = sim.now, b = sim.baseline;
  const unknownEssential = b.limitations.includes("ESSENTIAL_SPENDING_UNKNOWN");
  const lines = [unknownEssential && n.assessment === "fits_plan"
    ? `Похоже, можно: ${sim.item} за ${rubExact(n.priceMinor)} — в рамках плана, если на еду, транспорт и другие нужды хватит около ${rub(n.safeDailyAfterMinor)} в день.`
    : HEAD[n.assessment](sim.item, rubExact(n.priceMinor), !unknownEssential)];
  lines.push(`Сейчас: около ${rub(b.safeDailyMinor)} в день до ${humanDate(b.horizonEnd)}.`);
  lines.push(`Если купить сейчас: ${scenarioLine(n)}.`);
  const a = sim.afterIncome;
  if (a && n.assessment !== "fits_plan") {
    const caveat = a.forecast.limitations.includes("HORIZON_ASSUMED") ? " Следующий доход я не знаю, так что это ориентир, а не гарантия." : "";
    if (sim.waitIsBetter) lines.push(`Если подождать до дохода ${humanDate(a.date)}: ${scenarioLine(a)}.${caveat}`);
    else lines.push(`После дохода ${humanDate(a.date)} тоже будет тесно: ${scenarioLine(a)}.${caveat}`);
  }
  if (unknownEssential) lines.push(ESSENTIAL_HINT);
  lines.push("Решение за вами, я лишь показываю последствия.");
  return lines.join("\n");
}

export function proposalText(p: ProposalView, balanceAfter: Minor | null, occurrenceName: string | null): string {
  const pl = p.payload;
  const what = pl.direction === "expense" ? `расход «${pl.description}» на ${rubExact(pl.amountMinor)}` : `поступление «${pl.description}» ${rubExact(pl.amountMinor)}`;
  const when = `, ${humanDate(pl.date)}`;
  let t = `Записать ${what}${when}?`;
  if (occurrenceName) t += ` Отмечу как ${pl.direction === "expense" ? "оплату" : "поступление"} «${occurrenceName}».`;
  if (balanceAfter != null) t += ` Остаток станет ${rubExact(balanceAfter)}.`;
  return t + " Подтвердите, и я пересчитаю план.";
}

// ---------- Ответ в чате ----------

export interface ChatResult {
  reply: string;
  mode: "llm" | "fallback";
  impact?: PurchaseImpact;
  snapshot?: Snapshot;
  needsOnboarding?: boolean;
  /** Новое: предложение, которое нужно подтвердить кнопкой (POST /api/v1/proposals/:id/confirm). */
  proposal?: ProposalView;
  /** Новое: полный расчёт в копейках. */
  simulation?: Simulation;
  forecast?: Forecast;
  meta?: CalculationMeta;
  decisionId?: string;
  /** «А почему?»: объяснение последнего ответа «Можно?» (AI-ответ или шаблон с теми же числами). */
  explain?: ExplainResult;
}

/** «Почему?», «объясни», «а почему так» — просьба объяснить последний ответ «Можно?». */
export const isWhyQuestion = (t: string) => /^\s*(а\s+)?(почему|объясни|поясни|из-за\s+чего)(\s+так|\s+это|\s+нельзя|\s+можно)?\s*[?!.]*\s*$/i.test(t);

interface Draft { pendingItem?: string; at?: string }
const MAX_TEXT = 1000;

/** Сумма из LLM принимается, только если её текст действительно есть в сообщении (Evidence §6.1). */
function intentFromLlm(text: string, o: LlmIntent): PurchaseIntent {
  const regex = parseIntentRegex(text);
  const norm = (s: string) => s.toLowerCase().replace(/[\s\u00a0]/g, "");
  if (regex.error) return { ...regex, intent: o.intent }; // ошибки детерминированного парсера не стираются
  let priceMinor: Minor | undefined;
  if (o.priceText && norm(text).includes(norm(o.priceText))) {
    const a = parseAmountDetailed(o.priceText);
    // Принимаем только целый денежный токен исходного текста с тем же знаком и единицей.
    if (a.minor != null && amountCandidates(text).some((c) => !c.negative && c.minor === a.minor)) priceMinor = a.minor;
  }
  if (priceMinor == null) priceMinor = regex.priceMinor;
  const item = o.item ? toNominative(o.item) : regex.item;
  // Неоднозначность детерминированного разбора не снимается выбором модели: переспрашиваем.
  return { intent: o.intent, item, priceMinor, price: priceMinor == null ? undefined : Number(priceMinor) / 100, ambiguous: regex.ambiguous };
}

/**
 * Парсер «не уверен»: ничего не распознал, но в тексте есть слова (не пустое сообщение и не только знаки).
 * Распознанное намерение, неоднозначные суммы и ошибки суммы LLM не исправляет (переспрашиваем), поэтому её не зовём.
 */
export function regexUnsure(r: PurchaseIntent, text: string): boolean {
  return r.intent === "other" && !r.error && /[a-zа-яё]{2,}/i.test(text);
}

export async function answer(userId: string, rawText: string, opts: { now?: Date; channel?: Channel } = {}): Promise<ChatResult> {
  const now = opts.now ?? new Date();
  const channel = opts.channel ?? "web";
  const text = rawText.slice(0, MAX_TEXT);
  const view = await getForecast(userId, now);
  if (!view) return { reply: "Давайте сначала познакомимся: расскажите об остатке, доходе и платежах, и я смогу посчитать.", mode: "fallback", needsOnboarding: true };

  // «А почему?» после ответа «Можно?» — объяснение (тратит AI-ответ, только если ответила модель; иначе шаблон).
  if (isWhyQuestion(text)) {
    const id = await lastDecisionId(userId, now);
    const ex = id ? await explainDecision(userId, id, { now, channel: channel === "telegram" ? "telegram" : "web" }) : null;
    if (ex) {
      setCallType("chat.explain");
      return { reply: ex.reply, mode: ex.mode === "ai" ? "llm" : "fallback", snapshot: forecastToSnapshot(view.forecast), forecast: view.forecast, meta: view.meta, explain: ex, decisionId: id! };
    }
  }

  // Regex первым; LLM — только если детерминированный парсер не уверен (docs/LLM-COST.md §6). Любой отказ LLM
  // (выключена, нет ключа, бюджет, таймаут, невалидный ответ) — остаётся regex, числа всё равно считает движок.
  let mode: ChatResult["mode"] = "fallback";
  let intent: PurchaseIntent = parseIntentRegex(text);
  if (regexUnsure(intent, text) && llmEnabled()) {
    const o = await parseIntentLLM(text, { userId, now });
    if (o) { intent = intentFromLlm(text, o); mode = "llm"; }
  }

  const draft = (await getState<Draft>(userId, channel)) ?? {};
  if (intent.intent === "amount_only" && draft.pendingItem) intent = { ...intent, intent: "purchase", item: draft.pendingItem };
  const today = view.today;
  const base = { mode, snapshot: forecastToSnapshot(view.forecast), forecast: view.forecast, meta: view.meta };

  if (intent.error === "NEGATIVE_AMOUNT") return { ...base, reply: "Сумма получилась отрицательной. Назовите её без минуса, пожалуйста." };
  if (intent.error === "BAD_PRECISION") return { ...base, reply: "Не понял сумму: после запятой бывает не больше двух знаков (копейки). Напишите, например, 1234 или 1234,50." };
  if (intent.error === "AMOUNT_TOO_LARGE") return { ...base, reply: "Сумма слишком большая. Проверьте, пожалуйста, число." };
  const moneyIntent = intent.intent === "purchase" || intent.intent === "expense" || intent.intent === "income";
  if (moneyIntent && intent.ambiguous) {
    const vals = [...new Set(amountCandidates(text).filter((c) => !c.negative).map((c) => c.minor))].slice(0, 4).map(rubExact);
    return { ...base, reply: `В сообщении несколько сумм (${vals.join(", ")}). Какую записать или проверить? Напишите одну сумму, например: «Потратил 500 на кофе».` };
  }

  if (intent.intent === "purchase") {
    setCallType("chat.question"); // журнал обращений: это вопрос «Можно?», а не просто сообщение
    if (intent.priceMinor == null || intent.priceMinor <= 0n) {
      await setState(userId, channel, { pendingItem: intent.item || "покупка", at: now.toISOString() });
      return { ...base, reply: `Сколько стоит ${intent.item || "покупка"}? Назовите сумму, и я посчитаю.` };
    }
    if (draft.pendingItem) await setState(userId, channel, null);
    const item = intent.item || "покупка";
    const sv = await simulate(userId, { item, priceMinor: intent.priceMinor }, text, now);
    // Свободный текст модели в ответ с финансовым решением не попадает (§6.4): только шаблон.
    const reply = purchaseText(sv.simulation);
    // «Можно?»: только факт вопроса и корзина вердикта движка — без текста, суммы и товара.
    const key = sv.decisionId;
    await track(userId, "purchase_asked", {}, { channel, key, now });
    await track(userId, "purchase_result", { verdict: sv.simulation.now.assessment, engine: mode }, { channel, key, now });
    await activateReferral(userId, channel, now); // первый ответ «Можно?» — целевой сценарий приглашённого
    return { ...base, mode, reply, impact: simulationToImpact(sv.simulation, intent.priceMinor), simulation: sv.simulation, meta: sv.meta, decisionId: sv.decisionId };
  }

  if (intent.intent === "expense" || intent.intent === "income") {
    const direction = intent.intent;
    const description = cap(intent.item || (direction === "expense" ? "расход" : "доход"));
    const match = await matchOccurrence(userId, intent.item ?? "", direction);
    let amount = intent.priceMinor ?? null;
    let occ: { id: string; name: string } | null = match;
    if (direction === "income" && amount == null && /^(зарплат|аванс|доход)/i.test(intent.item ?? "доход")) {
      // "Зарплата пришла" без суммы: берём ожидаемый доход, если он один и понятен.
      const pending = [...view.forecast.overdueIncomes, ...(view.forecast.nextIncome ? [view.forecast.nextIncome] : [])].filter((i) => i.dueOn <= today);
      if (pending.length === 1) { amount = pending[0].amountMinor; occ = { id: pending[0].id, name: pending[0].name }; }
    }
    // Поступление с суммой привязываем к ожидаемому доходу только по совпадению названия (matchOccurrence),
    // а без названия — только если это «зарплата/аванс/доход»: кэшбэк не гасит зарплату.
    if (direction === "income" && !occ && /^(зарплат|аванс|доход)/i.test(intent.item ?? "")) {
      const pending = [...view.forecast.overdueIncomes, ...(view.forecast.nextIncome && view.forecast.nextIncome.dueOn <= today ? [view.forecast.nextIncome] : [])];
      if (pending.length === 1) occ = { id: pending[0].id, name: pending[0].name };
    }
    if (amount == null || amount <= 0n) return { ...base, reply: direction === "expense" ? "Сколько потратили? Назовите сумму, и я подготовлю запись." : "Сколько пришло? Назовите сумму, и я подготовлю запись." };
    const dateText = parseDate(text, today, { prefer: "past" });
    if (dateText && dateText > today) return { ...base, reply: "Эта дата ещё не наступила. Записываю только уже совершённые операции; будущие платежи добавьте в план." };
    if (dateText && dateText < addDays(today, -PAST_WINDOW_DAYS)) return { ...base, reply: "Эта дата слишком давно. Можно записать операции не старше года." };
    const date = dateText ?? today;
    const proposal = await createEntryProposal(userId, { direction, amountMinor: amount, date, description, occurrenceId: occ?.id ?? null, source: channel === "telegram" ? "telegram" : "chat" }, now);
    const after = view.book.balanceMinor + (direction === "expense" ? -amount : amount);
    return { ...base, reply: proposalText(proposal, after, occ?.name ?? null), proposal };
  }

  if (intent.intent === "snapshot") return { ...base, reply: snapshotText(view.forecast) };
  return { ...base, reply: "Я помогаю спокойно решить, можно ли сейчас позволить покупку, и записываю траты. Например: «Можно купить наушники за 15 000?» или «Потратил 500 на кофе»." };
}

/**
 * «Купил — записать» под ответом «Можно?»: предложение расхода ровно на товар и цену из сохранённого расчёта.
 * Сумма и название берутся с сервера (decisions), а не от клиента; запись — только после «Записать» (confirmProposal).
 * null — расчёт не найден (чужой, удалён) или без цены.
 */
export async function proposalFromDecision(userId: string, decisionId: string, channel: Channel, now = new Date()): Promise<{ reply: string; proposal: ProposalView } | null> {
  if (!isUuid(decisionId)) return null;
  const db = await getDb();
  const row = (await db.query<{ input: { item?: string; priceMinor?: string } | string }>("SELECT input FROM decisions WHERE id=$1 AND user_id=$2", [decisionId, userId])).rows[0];
  if (!row) return null;
  const input = typeof row.input === "string" ? JSON.parse(row.input) : row.input;
  const amount = /^\d+$/.test(String(input?.priceMinor ?? "")) ? BigInt(input.priceMinor) : 0n;
  if (amount <= 0n) return null;
  const item = String(input.item ?? "").trim() || "покупка";
  const occ = await matchOccurrence(userId, item, "expense");
  const proposal = await createEntryProposal(userId, { direction: "expense", amountMinor: amount, description: cap(item), occurrenceId: occ?.id ?? null, source: channel === "telegram" ? "telegram" : "chat" }, now);
  const view = await getForecast(userId, now);
  const after = view ? view.book.balanceMinor - amount : null;
  return { reply: proposalText(proposal, after, occ?.name ?? null), proposal };
}

// ---------- Пошаговый онбординг (Telegram) ----------

const STEPS = [
  "Сколько сейчас денег на карте и в кошельке, которыми вы пользуетесь?",
  "Когда и сколько вы ожидаете получить в ближайший доход? Например: 25.10 80000",
  "Какие обязательные платежи впереди? По одному в строке: Аренда 30000 20.10. Если их нет, напишите «нет».",
  "Какую сумму хотите всегда держать в резерве? Например: 10000 или 0.",
  "Есть ли цель накопления? Например: Отпуск 60000 01.06.2027. Если нет, напишите «нет».",
  "И последнее: сколько примерно нужно в день на еду, транспорт и другие необходимые траты? Можно написать «не знаю».",
];
export const ONBOARDING_FIRST = STEPS[0];
export const ONBOARDING_STEPS = STEPS.length;

interface OnboardingDraft {
  step: number;
  /** Версия для compare-and-set: два одновременных сообщения не продвинут шаг дважды. */
  rev?: number;
  /** finance_version на старте онбординга (null — бюджета не было). */
  base?: string | null;
  saving?: boolean;
  /** update_id Telegram, уже применённый к этому шагу: повтор того же апдейта не продвигает онбординг второй раз. */
  lastUpdateId?: number;
  balanceMinor?: string; incomeMinor?: string; incomeDate?: string;
  payments?: { name: string; amountMinor: string; date: string }[];
  reserveMinor?: string;
  goal?: { name: string; amountMinor: string; date: string } | null;
}

export async function startOnboarding(userId: string, channel: Channel = "telegram") {
  const v = await getForecast(userId);
  await setState(userId, channel, { onboarding: { step: 0, rev: 0, base: v ? v.book.financeVersion.toString() : null } });
  return ONBOARDING_FIRST;
}

const inWindow = (d: ISODate, today: ISODate, futureDays = FUTURE_WINDOW_DAYS) => d >= addDays(today, -PAST_WINDOW_DAYS) && d <= addDays(today, futureDays);

export async function onboardingActive(userId: string, channel: Channel = "telegram"): Promise<boolean> {
  const s = await getState<{ onboarding?: OnboardingDraft }>(userId, channel);
  return !!s?.onboarding;
}

export async function onboardingStep(userId: string, text: string, opts: { now?: Date; channel?: Channel; timezone?: string; updateId?: number } = {}): Promise<{ reply: string; done: boolean }> {
  const now = opts.now ?? new Date();
  const channel = opts.channel ?? "telegram";
  const today = localDate(now, opts.timezone ?? (await userTimezone(await getDb(), userId)));
  const st = (await getState<{ onboarding?: OnboardingDraft }>(userId, channel))?.onboarding ?? { step: 0 };
  const d: OnboardingDraft = { ...st };
  const rev = st.rev ?? 0;
  if (st.saving) return { reply: "Сохраняю план, секунду…", done: false };
  // Повторная доставка уже применённого апдейта (сбой после записи шага): только повторяем текущий вопрос.
  if (opts.updateId != null && st.lastUpdateId === opts.updateId) return { reply: STEPS[st.step], done: false };
  const busy = { reply: "Получил несколько сообщений подряд. Ответьте, пожалуйста, ещё раз на вопрос:\n" + STEPS[st.step], done: false };
  const t = text.trim().slice(0, 2000);
  const amount = (s: string) => parseAmountDetailed(s);
  if (st.step !== 2 && st.step !== 4 && parseAmountDetailed(t).ambiguous) return { reply: "В ответе несколько сумм. Напишите, пожалуйста, одну.", done: false };
  switch (d.step) {
    case 0: { const a = amount(t); if (a.negative) return { reply: "Если на счету минус, пока укажите 0, а долг добавим платежом.", done: false }; if (a.minor == null) return { reply: "Не получилось понять сумму. Напишите число, например 45000.", done: false }; d.balanceMinor = a.minor.toString(); break; }
    case 1: {
      const date = parseDate(t, today);
      const a = amount(t);
      if (!date || a.minor == null || a.minor <= 0n) return { reply: "Нужны и дата, и сумма. Например: 25.10 80000. Дату дохода я не угадываю.", done: false };
      if (!inWindow(date, today)) return { reply: `Дата дохода должна быть в пределах года, не позже ${humanDate(addDays(today, FUTURE_WINDOW_DAYS))}.`, done: false };
      d.incomeDate = date; d.incomeMinor = a.minor.toString(); break;
    }
    case 2: {
      const r = parsePaymentLines(t, today);
      r.items = r.items.filter((p) => { if (inWindow(p.date, today)) return true; r.errors.push({ line: 0, text: p.name, reason: "дата дальше чем через год" }); return false; });
      if (r.errors.length) return { reply: "Не все строки получилось понять:\n" + r.errors.map((e) => `• «${e.text}»: ${e.reason}`).join("\n") + "\nНапишите платежи ещё раз в формате: Аренда 30000 20.10, или «нет».", done: false };
      d.payments = r.items.map((p) => ({ name: p.name, amountMinor: p.amountMinor.toString(), date: p.date })); break;
    }
    case 3: { const a = /^\s*(нет|0)\s*$/i.test(t) ? { minor: 0n, negative: false } : amount(t); if (a.minor == null || a.negative) return { reply: "Напишите сумму резерва числом, например 10000 или 0.", done: false }; d.reserveMinor = a.minor.toString(); break; }
    case 4: {
      if (/^\s*нет/i.test(t)) d.goal = null;
      else {
        const date = parseDate(t, today);
        const a = amount(t);
        if (!date || a.minor == null || a.minor <= 0n) return { reply: "Укажите цель так: Отпуск 60000 01.06.2027, или «нет».", done: false };
        if (!inWindow(date, today, GOAL_FUTURE_DAYS)) return { reply: "Дата цели должна быть в пределах десяти лет.", done: false };
        d.goal = { name: t.replace(/[-−]?\s*\d.*$/, "").trim() || "Цель", amountMinor: a.minor.toString(), date };
      }
      break;
    }
    case 5: {
      let essential: Minor | null = null;
      if (!/(не знаю|незнаю|пропуст|нет|^-$)/i.test(t)) {
        const a = amount(t);
        if (a.minor == null || a.negative) return { reply: "Напишите примерную сумму в день, например 1500, или «не знаю».", done: false };
        essential = a.minor;
      }
      const plan: PlanInput = {
        balanceMinor: BigInt(d.balanceMinor!), reserveMinor: BigInt(d.reserveMinor ?? "0"), essentialDailyMinor: essential,
        incomes: [{ name: "Доход", amountMinor: BigInt(d.incomeMinor!), dueOn: d.incomeDate! }],
        payments: (d.payments ?? []).map((p) => ({ name: p.name, amountMinor: BigInt(p.amountMinor), dueOn: p.date })),
        // savedMinor не задаём: накопления по существующей цели сохраняются.
        goal: d.goal ? { name: d.goal.name, targetMinor: BigInt(d.goal.amountMinor), targetDate: d.goal.date } : null,
      };
      if (!(await casOnboarding(userId, channel, rev, { ...d, rev: rev + 1, saving: true }))) return busy;
      try {
        await savePlan(userId, plan, channel === "telegram" ? "telegram" : "chat", now, { baseFinanceVersion: d.base == null ? null : BigInt(d.base), requireBase: true });
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "FINANCE_VERSION_CONFLICT") {
          const first = await startOnboarding(userId, channel);
          return { reply: "Пока мы заполняли план, данные изменились (например, записалась трата в приложении). Чтобы ничего не потерять, давайте проверим остаток заново.\n\n" + first, done: false };
        }
        await casOnboarding(userId, channel, rev + 1, { ...d, rev: rev + 2, saving: false });
        if (code === "INVALID_DATE" || code === "INVALID_AMOUNT" || code === "INVALID_INPUT") return { reply: "Не получилось сохранить план: " + (e as Error).message + ". Нажмите /setup, чтобы заполнить заново.", done: false };
        throw e;
      }
      await setState(userId, channel, null);
      await activateReferral(userId, channel, now); // знакомство завершено (старый текстовый сценарий)
      const v = await getForecast(userId, now);
      return { reply: "Готово, план сохранён.\n" + snapshotText(v!.forecast) + "\n\nТеперь можно спросить: «Можно купить наушники за 15 000?» Текстом или голосом.", done: true };
    }
  }
  d.step += 1;
  d.rev = rev + 1;
  if (opts.updateId != null) d.lastUpdateId = opts.updateId;
  if (!(await casOnboarding(userId, channel, rev, d))) return busy;
  return { reply: STEPS[d.step], done: false };
}

/** Compare-and-set шага онбординга по rev: проигравшее параллельное сообщение ничего не меняет. */
async function casOnboarding(userId: string, channel: Channel, expectedRev: number, next: OnboardingDraft): Promise<boolean> {
  const db = await getDb();
  const r = await db.query(
    `UPDATE conversation_state SET state=$3, updated_at=now()
      WHERE user_id=$1 AND channel=$2 AND COALESCE((state->'onboarding'->>'rev')::int, 0) = $4 RETURNING user_id`,
    [userId, channel, JSON.stringify({ onboarding: next }), expectedRev]);
  if (r.rows.length) return true;
  // Состояния ещё нет (онбординг начат без startOnboarding): создаём, если никто не успел раньше.
  if (expectedRev !== 0) return false;
  const ins = await db.query("INSERT INTO conversation_state(user_id, channel, state) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id", [userId, channel, JSON.stringify({ onboarding: next })]);
  return ins.rows.length > 0;
}
