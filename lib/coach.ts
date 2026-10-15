// Общий диалоговый слой для веба и Telegram. Финансовые факты — из движка, текст — шаблоны (§6.4).
import {
  formatRub, forecastToSnapshot, localDate, simulationToImpact,
  type Assessment, type Forecast, type ISODate, type Minor, type PurchaseImpact, type Scenario, type Simulation, type Snapshot,
} from "./engine";
import { amountCandidates, parseAmountDetailed, parseDate, parseIntentRegex, parsePaymentLines, toNominative, type PurchaseIntent } from "./parse";
import { llmEnabled, parseIntentLLM } from "./ai/llm";
import { getDb } from "./db";
import { userTimezone } from "./finance-service";
import { getForecast, savePlan, simulate, type CalculationMeta, type PlanInput } from "./finance-service";
import { createEntryProposal, matchOccurrence, type ProposalView } from "./proposals";
import { getState, setState, type Channel } from "./conversation";

const rub = (m: Minor) => formatRub(m);
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
export const humanDate = (d: ISODate) => `${+d.slice(8, 10)} ${MONTHS_GEN[+d.slice(5, 7) - 1]}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- Шаблоны ----------

export function snapshotText(f: Forecast): string {
  const lines: string[] = [];
  const until = f.horizonKind === "until_income" ? `До дохода ${humanDate(f.horizonEnd)} — ${f.days} дн.` : `Ближайший доход не указан, поэтому смотрю на ${f.days} дн. вперёд, до ${humanDate(f.horizonEnd)}.`;
  lines.push(until);
  if (f.freeMoneyMinor != null) lines.push(`Свободно ${rub(f.freeMoneyMinor > 0n ? f.freeMoneyMinor : 0n)}, спокойно тратить около ${rub(f.safeDailyMinor)} в день.`);
  else lines.push(`На повседневную жизнь и покупки — около ${rub(f.safeDailyMinor)} в день.`);
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

const HEAD: Record<Assessment, (item: string, price: string) => string> = {
  fits_plan: (i, p) => `Можно. ${cap(i)} за ${p} укладывается в план.`,
  reduces_daily_margin: (i, p) => `Можно, но после покупки (${i}, ${p}) запас на день станет заметно меньше.`,
  touches_protected_money: (i, p) => `Сейчас ${i} за ${p} задела бы резерв или накопления на цель.`,
  cash_gap: (i, p) => `Сейчас с покупкой (${i}, ${p}) лучше не спешить: может не хватить на обязательные траты.`,
  insufficient_data: () => "Пока не хватает данных, чтобы спокойно ответить.",
};

function scenarioLine(s: Scenario): string {
  const f = s.forecast;
  const free = s.freeAfterMinor ?? s.envelopeAfterMinor;
  let t = `останется ${rub(free > 0n ? free : 0n)}, около ${rub(s.safeDailyAfterMinor)} в день до ${humanDate(f.horizonEnd)}`;
  if (s.firstGapDate) t += `; с ${humanDate(s.firstGapDate)} может не хватать, до ${rub(s.gapMinor)}`;
  else if (s.reserveShortfallMinor > 0n) t += `; резерв или накопления уменьшатся на ${rub(s.reserveShortfallMinor)}`;
  return t;
}

export function purchaseText(sim: Simulation): string {
  const n = sim.now, b = sim.baseline;
  const unknownEssential = b.limitations.includes("ESSENTIAL_SPENDING_UNKNOWN");
  const lines = [unknownEssential && (n.assessment === "fits_plan" || n.assessment === "reduces_daily_margin")
    ? `Похоже, можно: ${sim.item} за ${rub(n.priceMinor)} укладывается в план, если на еду, транспорт и другие нужды хватит около ${rub(n.safeDailyAfterMinor)} в день.`
    : HEAD[n.assessment](sim.item, rub(n.priceMinor))];
  lines.push(`Сейчас: около ${rub(b.safeDailyMinor)} в день до ${humanDate(b.horizonEnd)}.`);
  lines.push(`Если купить сейчас: ${scenarioLine(n)}.`);
  const a = sim.afterIncome;
  if (a && n.assessment !== "fits_plan") {
    const caveat = a.forecast.limitations.includes("HORIZON_ASSUMED") ? " Следующий доход я не знаю, так что это ориентир, а не гарантия." : "";
    if (sim.waitIsBetter) lines.push(`Если подождать до дохода ${humanDate(a.date)}: ${scenarioLine(a)}.${caveat}`);
    else lines.push(`После дохода ${humanDate(a.date)} тоже будет тесно: ${scenarioLine(a)}.${caveat}`);
  }
  if (unknownEssential) lines.push("Сумма в день — на всё сразу. Если подскажете, сколько нужно в день на необходимое, оценка станет точнее.");
  lines.push("Решение за вами, я лишь показываю последствия.");
  return lines.join("\n");
}

export function proposalText(p: ProposalView, balanceAfter: Minor | null, occurrenceName: string | null): string {
  const pl = p.payload;
  const what = pl.direction === "expense" ? `расход «${pl.description}» на ${rub(pl.amountMinor)}` : `поступление «${pl.description}» ${rub(pl.amountMinor)}`;
  const when = `, ${humanDate(pl.date)}`;
  let t = `Записать ${what}${when}?`;
  if (occurrenceName) t += ` Отмечу как ${pl.direction === "expense" ? "оплату" : "поступление"} «${occurrenceName}».`;
  if (balanceAfter != null) t += ` Остаток станет ${rub(balanceAfter)}.`;
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
}

interface Draft { pendingItem?: string; at?: string }
const MAX_TEXT = 1000;

/** Сумма из LLM принимается, только если её текст действительно есть в сообщении (Evidence §6.1). */
function intentFromLlm(text: string, o: Awaited<ReturnType<typeof parseIntentLLM>>): PurchaseIntent {
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
  return { intent: o.intent, item, priceMinor, price: priceMinor == null ? undefined : Number(priceMinor) / 100 };
}

export async function answer(userId: string, rawText: string, opts: { now?: Date; channel?: Channel } = {}): Promise<ChatResult> {
  const now = opts.now ?? new Date();
  const channel = opts.channel ?? "web";
  const text = rawText.slice(0, MAX_TEXT);
  const view = await getForecast(userId, now);
  if (!view) return { reply: "Давайте сначала познакомимся: расскажите об остатке, доходе и платежах, и я смогу посчитать.", mode: "fallback", needsOnboarding: true };

  let mode: ChatResult["mode"] = llmEnabled() ? "llm" : "fallback";
  let intent: PurchaseIntent;
  try { intent = mode === "llm" ? intentFromLlm(text, await parseIntentLLM(text)) : parseIntentRegex(text); }
  catch { intent = parseIntentRegex(text); mode = "fallback"; }

  const draft = (await getState<Draft>(userId, channel)) ?? {};
  if (intent.intent === "amount_only" && draft.pendingItem) intent = { ...intent, intent: "purchase", item: draft.pendingItem };
  const today = view.today;
  const base = { mode, snapshot: forecastToSnapshot(view.forecast), forecast: view.forecast, meta: view.meta };

  if (intent.error === "NEGATIVE_AMOUNT") return { ...base, reply: "Сумма получилась отрицательной. Назовите её без минуса, пожалуйста." };

  if (intent.intent === "purchase") {
    if (intent.priceMinor == null || intent.priceMinor <= 0n) {
      await setState(userId, channel, { pendingItem: intent.item || "покупка", at: now.toISOString() });
      return { ...base, reply: `Сколько стоит ${intent.item || "покупка"}? Назовите сумму, и я посчитаю.` };
    }
    if (draft.pendingItem) await setState(userId, channel, null);
    const item = intent.item || "покупка";
    const sv = await simulate(userId, { item, priceMinor: intent.priceMinor }, text, now);
    // Свободный текст модели в ответ с финансовым решением не попадает (§6.4): только шаблон.
    const reply = purchaseText(sv.simulation);
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
    const dateText = parseDate(text, today);
    const date = dateText && dateText <= today ? dateText : today;
    const proposal = await createEntryProposal(userId, { direction, amountMinor: amount, date, description, occurrenceId: occ?.id ?? null, source: channel === "telegram" ? "telegram" : "chat" }, now);
    const after = view.book.balanceMinor + (direction === "expense" ? -amount : amount);
    return { ...base, reply: proposalText(proposal, after, occ?.name ?? null), proposal };
  }

  if (intent.intent === "snapshot") return { ...base, reply: snapshotText(view.forecast) };
  return { ...base, reply: "Я помогаю спокойно решить, можно ли сейчас позволить покупку, и записываю траты. Например: \"Можно купить наушники за 15 000?\" или \"Потратил 500 на кофе\"." };
}

// ---------- Пошаговый онбординг (Telegram) ----------

const STEPS = [
  "Сколько сейчас денег на карте и в кошельке, которыми вы пользуетесь?",
  "Когда и сколько вы ожидаете получить в ближайший доход? Например: 25.10 80000",
  "Какие обязательные платежи впереди? По одному в строке: Аренда 30000 20.10. Если их нет, напишите \"нет\".",
  "Какую сумму хотите всегда держать в резерве? Например: 10000 или 0.",
  "Есть ли цель накопления? Например: Отпуск 60000 01.06.2027. Если нет, напишите \"нет\".",
  "И последнее: сколько примерно нужно в день на еду, транспорт и другие необходимые траты? Можно написать \"не знаю\".",
];
export const ONBOARDING_FIRST = STEPS[0];
export const ONBOARDING_STEPS = STEPS.length;

interface OnboardingDraft {
  step: number;
  balanceMinor?: string; incomeMinor?: string; incomeDate?: string;
  payments?: { name: string; amountMinor: string; date: string }[];
  reserveMinor?: string;
  goal?: { name: string; amountMinor: string; date: string } | null;
}

export async function startOnboarding(userId: string, channel: Channel = "telegram") {
  await setState(userId, channel, { onboarding: { step: 0 } });
  return ONBOARDING_FIRST;
}

export async function onboardingActive(userId: string, channel: Channel = "telegram"): Promise<boolean> {
  const s = await getState<{ onboarding?: OnboardingDraft }>(userId, channel);
  return !!s?.onboarding;
}

export async function onboardingStep(userId: string, text: string, opts: { now?: Date; channel?: Channel; timezone?: string } = {}): Promise<{ reply: string; done: boolean }> {
  const now = opts.now ?? new Date();
  const channel = opts.channel ?? "telegram";
  const today = localDate(now, opts.timezone ?? (await userTimezone(await getDb(), userId)));
  const st = (await getState<{ onboarding?: OnboardingDraft }>(userId, channel))?.onboarding ?? { step: 0 };
  const d = st;
  const t = text.trim().slice(0, 2000);
  const amount = (s: string) => parseAmountDetailed(s);
  switch (d.step) {
    case 0: { const a = amount(t); if (a.negative) return { reply: "Если на счету минус, пока укажите 0, а долг добавим платежом.", done: false }; if (a.minor == null) return { reply: "Не получилось понять сумму. Напишите число, например 45000.", done: false }; d.balanceMinor = a.minor.toString(); break; }
    case 1: {
      const date = parseDate(t, today);
      const a = amount(t);
      if (!date || a.minor == null || a.minor <= 0n) return { reply: "Нужны и дата, и сумма. Например: 25.10 80000. Дату дохода я не угадываю.", done: false };
      d.incomeDate = date; d.incomeMinor = a.minor.toString(); break;
    }
    case 2: {
      const r = parsePaymentLines(t, today);
      if (r.errors.length) return { reply: "Не все строки получилось понять:\n" + r.errors.map((e) => `• «${e.text}»: ${e.reason}`).join("\n") + "\nНапишите платежи ещё раз в формате: Аренда 30000 20.10, или \"нет\".", done: false };
      d.payments = r.items.map((p) => ({ name: p.name, amountMinor: p.amountMinor.toString(), date: p.date })); break;
    }
    case 3: { const a = /^\s*(нет|0)\s*$/i.test(t) ? { minor: 0n, negative: false } : amount(t); if (a.minor == null || a.negative) return { reply: "Напишите сумму резерва числом, например 10000 или 0.", done: false }; d.reserveMinor = a.minor.toString(); break; }
    case 4: {
      if (/^\s*нет/i.test(t)) d.goal = null;
      else {
        const date = parseDate(t, today);
        const a = amount(t);
        if (!date || a.minor == null || a.minor <= 0n) return { reply: "Укажите цель так: Отпуск 60000 01.06.2027, или \"нет\".", done: false };
        d.goal = { name: t.replace(/[-−]?\s*\d.*$/, "").trim() || "Цель", amountMinor: a.minor.toString(), date };
      }
      break;
    }
    case 5: {
      let essential: Minor | null = null;
      if (!/(не знаю|незнаю|пропуст|нет|^-$)/i.test(t)) {
        const a = amount(t);
        if (a.minor == null || a.negative) return { reply: "Напишите примерную сумму в день, например 1500, или \"не знаю\".", done: false };
        essential = a.minor;
      }
      const plan: PlanInput = {
        balanceMinor: BigInt(d.balanceMinor!), reserveMinor: BigInt(d.reserveMinor ?? "0"), essentialDailyMinor: essential,
        incomes: [{ name: "Доход", amountMinor: BigInt(d.incomeMinor!), dueOn: d.incomeDate! }],
        payments: (d.payments ?? []).map((p) => ({ name: p.name, amountMinor: BigInt(p.amountMinor), dueOn: p.date })),
        goal: d.goal ? { name: d.goal.name, targetMinor: BigInt(d.goal.amountMinor), targetDate: d.goal.date, savedMinor: 0n, savedInBalance: false } : null,
      };
      await savePlan(userId, plan, channel === "telegram" ? "telegram" : "chat", now);
      await setState(userId, channel, null);
      const v = await getForecast(userId, now);
      return { reply: "Готово, план сохранён.\n" + snapshotText(v!.forecast) + "\n\nТеперь можно спросить: \"Можно купить наушники за 15000?\" Текстом или голосом.", done: true };
    }
  }
  d.step += 1;
  await setState(userId, channel, { onboarding: d });
  return { reply: STEPS[d.step], done: false };
}
