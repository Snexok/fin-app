// Оркестратор онбординг-чата: разбор хода → CAS сессии → политика → сообщение (+ карточки из движка).
// Все числа считает движок (finance-service). Текст — шаблоны; LLM здесь не участвует.
import { trackOnboardingStart, trackOnboardingTurn } from "./analytics";
import { activateReferral } from "../referrals";
import { formatRub, localDate, type ISODate, type Minor } from "../engine";
import { getDb } from "../db";
import type { Channel } from "../conversation";
import { humanDate } from "../coach";
import {
  getForecast, savePlan, setBalance, setEssentialDaily, setGoal, setNextIncome, setPayments, setReserve, userTimezone, type ForecastView, type PlanInput,
} from "../finance-service";
import type { AssistantMessage, Card, Choice, ChoiceAction, ChatMessage, SlotKey, SummaryRow, UserMessage, UserTurn } from "./protocol";
import { minimumReady, RulePolicy, slotNeeded, type ChoiceTemplateId, type QuestionDecision, type QuestionPolicy } from "./policy";
import { emptyFacts, extractFacts, hasValue, type Extracted, type Facts, type Fact, type SlotValue, type Via } from "./slots";
import {
  casSession, deleteMessage, deleteSession, getMessage, insertMessage, listMessages, loadSession, messageByClientKey, newId, newSession, type OnboardingSession,
} from "./session";

export const policy: QuestionPolicy = new RulePolicy();
const rub = (m: Minor | string) => formatRub(typeof m === "string" ? BigInt(m) : m);
const shortDate = (d: ISODate) => humanDate(d);

export const SLOT_LABEL: Record<SlotKey, string> = {
  balance: "Остаток", income: "Доход", planningDays: "Период", payments: "Платежи", reserve: "Резерв", essentialDaily: "В день на необходимое", goal: "Цель",
};
const FIX_LABEL: Partial<Record<SlotKey, string>> = { balance: "остаток", income: "доход", payments: "платежи", reserve: "резерв", essentialDaily: "траты в день", goal: "цель" };

// ---------- Варианты ответа ----------

const CHOICE_TEMPLATES: Record<ChoiceTemplateId, (s: OnboardingSession, slot: SlotKey) => { label: string; action: ChoiceAction }> = {
  start: () => ({ label: "Начнём", action: { type: "control", name: "start" } }),
  income_irregular: () => ({ label: "Нерегулярный доход", action: { type: "setFact", slot: "income", value: "irregular" } }),
  unknown: (_s, slot) => ({ label: slot === "payments" ? "Пока не знаю" : "Не знаю", action: { type: "setFact", slot, value: "unknown" } }),
  days_14: () => ({ label: "14 дней", action: { type: "setFact", slot: "planningDays", value: "14" } }),
  days_30: () => ({ label: "30 дней", action: { type: "setFact", slot: "planningDays", value: "30" } }),
  payments_none: () => ({ label: "Нет платежей", action: { type: "setFact", slot: "payments", value: "none" } }),
  payments_unknown: () => ({ label: "Пока не знаю", action: { type: "setFact", slot: "payments", value: "unknown" } }),
  reserve_none: () => ({ label: "Без резерва", action: { type: "setFact", slot: "reserve", value: "0" } }),
  reserve_10k: () => ({ label: "10 000 ₽", action: { type: "setFact", slot: "reserve", value: "1000000" } }),
  daily_500: () => ({ label: "Около 500 ₽", action: { type: "setFact", slot: "essentialDaily", value: "50000" } }),
  daily_1000: () => ({ label: "Около 1 000 ₽", action: { type: "setFact", slot: "essentialDaily", value: "100000" } }),
  goal_want: () => ({ label: "Есть цель", action: { type: "setFact", slot: "goal", value: "want" } }),
  goal_none: () => ({ label: "Нет", action: { type: "setFact", slot: "goal", value: "none" } }),
  skip: (_s, slot) => ({ label: "Пропустить", action: { type: "setFact", slot, value: "skip" } }),
};

function choicesFrom(ids: ChoiceTemplateId[], s: OnboardingSession, slot: SlotKey): Choice[] {
  return ids.slice(0, 4).map((id, i) => { const t = CHOICE_TEMPLATES[id](s, slot); return { id: `c${i}`, label: t.label, userText: t.label, action: t.action }; });
}
const control = (i: number, label: string, name: Extract<ChoiceAction, { type: "control" }>["name"], slot?: SlotKey): Choice =>
  ({ id: `c${i}`, label, userText: label, action: { type: "control", name, ...(slot ? { slot } : {}) } });

// ---------- Описание фактов ----------

export function describeFact(slot: SlotKey, f: Facts[SlotKey] | Fact<unknown>): string {
  if (!hasValue(f)) {
    if (slot === "income" && f.note === "irregular") return "нерегулярный";
    if (f.status === "missing") return "не указано";
    if (slot === "reserve") return "не задан";
    if (f.status === "skipped") return slot === "goal" ? "нет" : "пропущено";
    return "не указано";
  }
  const v = f.value as SlotValue[SlotKey];
  const pre = f.confidence === "approximate" ? "≈ " : "";
  switch (slot) {
    case "balance": case "reserve": return pre + rub(v as string);
    case "essentialDaily": return `${pre}${rub(v as string)} в день`;
    case "income": { const x = v as SlotValue["income"]; return `${pre}${rub(x.amountMinor)} · ${shortDate(x.date)}`; }
    case "planningDays": return `${v as number} дн.`;
    case "payments": { const xs = v as SlotValue["payments"]; return xs.length ? xs.map((p) => `${p.name} ${rub(p.amountMinor)} · ${shortDate(p.date)}`).join("; ") : "нет"; }
    case "goal": { const g = v as SlotValue["goal"]; return `${g.name} ${rub(g.amountMinor)} к ${shortDate(g.date)}`; }
  }
}

/** Компактный вид собранных фактов для полосы «Уже учтено» (только принятые значения, в порядке слотов). */
export interface FactChip { slot: SlotKey; label: string; value: string; approximate: boolean; updatedAt: string }
const CHIP_ORDER: SlotKey[] = ["balance", "income", "planningDays", "payments", "reserve", "essentialDaily", "goal"];
export function factsView(s: OnboardingSession): FactChip[] {
  const out: FactChip[] = [];
  for (const k of CHIP_ORDER) {
    const f = s.facts[k];
    if (!hasValue(f)) continue;
    const v = f.value as SlotValue[SlotKey];
    let value = describeFact(k, f).replace(/^≈ /, "");
    if (k === "payments") { const xs = v as SlotValue["payments"]; value = xs.length ? `${xs.length} · ${rub(String(xs.reduce((a, p) => a + BigInt(p.amountMinor), 0n)))}` : "нет"; }
    if (k === "goal") value = (v as SlotValue["goal"]).name;
    out.push({ slot: k, label: k === "essentialDaily" ? "Необходимое" : SLOT_LABEL[k], value, approximate: f.confidence === "approximate", updatedAt: f.updatedAt });
  }
  return out;
}

export function progressOf(s: OnboardingSession): number {
  if (s.phase === "done" || s.phase === "summary") return 1;
  const slots: SlotKey[] = ["balance", s.facts.income.status === "unknown" || s.facts.income.status === "skipped" ? "planningDays" : "income", "payments", "reserve", "essentialDaily", "goal"];
  const done = slots.filter((k) => s.facts[k].status !== "missing").length;
  return Math.round((done / slots.length) * 100) / 100;
}

// ---------- Применение фактов ----------

interface Applied { confirmations: string[]; changed: Set<SlotKey>; problems: string[]; understood: boolean }

function setFact<K extends SlotKey>(s: OnboardingSession, slot: K, value: SlotValue[K], confidence: Fact<unknown> extends never ? never : "exact" | "approximate", src: { messageId: string; channel: Channel; via: Via }, now: Date, a: Applied) {
  const prev = s.facts[slot];
  const before = hasValue(prev) ? describeFact(slot, prev) : s.previous?.[slot];
  const next: Fact<SlotValue[K]> = { status: "confirmed", value, confidence, source: src, updatedAt: now.toISOString(), askCount: prev.askCount };
  (s.facts as Record<SlotKey, Fact<unknown>>)[slot] = next as Fact<unknown>;
  const after = describeFact(slot, next);
  if (before && before !== after && before !== "не указано") a.confirmations.push(`Исправил: ${SLOT_LABEL[slot].toLowerCase()} ${after} (было ${before})`);
  else a.confirmations.push(confirmText(slot, next));
  if (s.previous?.[slot]) delete s.previous[slot];
  a.changed.add(slot);
}

function confirmText(slot: SlotKey, f: Facts[SlotKey] | Fact<unknown>): string {
  const d = describeFact(slot, f);
  switch (slot) {
    case "balance": return `Понял: ${d} сейчас`;
    case "income": return hasValue(f) ? `Понял: доход ${d}` : "Понял: доход нерегулярный";
    case "planningDays": return `Считаю на ${d}`;
    case "payments": return hasValue(f) && (f.value as unknown[]).length ? `Записал платежи: ${d}` : "Понял: платежей нет";
    case "reserve": return hasValue(f) && (f.value as string) === "0" ? "Понял: без резерва" : `Понял: резерв ${d}`;
    case "essentialDaily": return `Понял: ${d}`;
    case "goal": return hasValue(f) ? `Записал цель: ${d}` : "Понял: без цели";
  }
}

function setStatus(s: OnboardingSession, slot: SlotKey, status: "unknown" | "skipped", a: Applied, note?: "irregular") {
  const prev = s.facts[slot];
  (s.facts as Record<SlotKey, Fact<unknown>>)[slot] = { status, askCount: prev.askCount, ...(note ? { note } : {}) };
  a.changed.add(slot);
  if (s.pending?.slot === slot) delete s.pending;
  if (slot === "income") {
    a.confirmations.push(note === "irregular" ? "Хорошо, не буду угадывать" : "Хорошо, доход пока не указываем");
    // planningDays понадобится заново
    if (s.facts.planningDays.status !== "confirmed") s.facts.planningDays = { status: "missing", askCount: 0 };
  } else if (slot === "reserve") a.confirmations.push("Пока без резерва, отмечу как «не задан»");
  else if (slot === "essentialDaily") a.confirmations.push("Хорошо, повседневные траты пока не учитываю — расчёт будет с оговоркой");
  else if (slot === "payments") a.confirmations.push(status === "unknown" ? "Хорошо, пока считаю без учёта платежей" : "Пропускаем платежи");
  else if (slot === "goal") a.confirmations.push("Хорошо, без цели");
  else a.confirmations.push("Хорошо, пропускаем");
}

const REQUIRED_HINT: Partial<Record<SlotKey, string>> = {
  balance: "Без остатка не получится посчитать. Напишите хотя бы примерно, например 45 000.",
  planningDays: "Выберите срок — 14 или 30 дней, или напишите своё число дней.",
};

function applyAction(s: OnboardingSession, act: Extract<ChoiceAction, { type: "setFact" }>, src: { messageId: string; channel: Channel; via: Via }, now: Date, a: Applied) {
  a.understood = true;
  const { slot, value } = act;
  if ((value === "unknown" || value === "skip" || value === "none") && REQUIRED_HINT[slot]) { a.problems.push(REQUIRED_HINT[slot]!); return; }
  if (value === "unknown") return setStatus(s, slot, "unknown", a);
  if (value === "skip" && s.pending?.slot === "payments" && hasValue(s.facts.payments)) { delete s.pending; a.confirmations.push("Хорошо, этот платёж пропускаем"); return; }
  if (value === "skip") return setStatus(s, slot, "skipped", a);
  if (value === "irregular") return setStatus(s, "income", "skipped", a, "irregular");
  if (value === "want" && slot === "goal") { s.pending = { slot: "goal" }; return; }
  if (value === "none") {
    if (slot === "payments") return setFact(s, "payments", [], "exact", src, now, a);
    return setStatus(s, slot, "skipped", a);
  }
  if (slot === "planningDays" && /^\d{1,3}$/.test(value)) return setFact(s, "planningDays", Number(value), "exact", src, now, a);
  if ((slot === "reserve" || slot === "essentialDaily") && /^\d{1,15}$/.test(value)) return setFact(s, slot, value, slot === "essentialDaily" ? "approximate" : "exact", src, now, a);
}

function applyExtracted(s: OnboardingSession, xs: Extracted[], src: { messageId: string; channel: Channel; via: Via }, now: Date, a: Applied) {
  const newPayments: SlotValue["payments"] = [];
  for (const x of xs) {
    switch (x.kind) {
      case "value":
        a.understood = true;
        if (x.slot === "income") { setFact(s, "income", { amountMinor: x.amountMinor.toString(), date: x.date }, x.confidence === "approximate" ? "approximate" : "exact", src, now, a); if (s.pending?.slot === "income") delete s.pending; }
        else if (x.slot === "planningDays") setFact(s, "planningDays", x.days, "exact", src, now, a);
        else if (x.slot === "goal") { setFact(s, "goal", { name: x.name, amountMinor: x.amountMinor.toString(), date: x.date }, "exact", src, now, a); if (s.pending?.slot === "goal") delete s.pending; }
        else setFact(s, x.slot, x.minor.toString(), x.confidence === "approximate" ? "approximate" : "exact", src, now, a);
        break;
      case "status":
        a.understood = true;
        if (x.status === "none") applyAction(s, { type: "setFact", slot: x.slot, value: x.slot === "income" ? "irregular" : "none" }, src, now, a);
        else if (REQUIRED_HINT[x.slot]) a.problems.push(REQUIRED_HINT[x.slot]!);
        else setStatus(s, x.slot, "unknown", a);
        break;
      case "payment":
        a.understood = true;
        if (x.date) newPayments.push({ name: x.name, amountMinor: x.amountMinor.toString(), date: x.date });
        else if (!s.pending) s.pending = { slot: "payments", name: x.name, amountMinor: x.amountMinor.toString() };
        else a.problems.push(`У «${x.name}» тоже нет даты — напишите её отдельно, после ответа на этот вопрос.`);
        break;
      case "dateOnly":
        if (s.pending?.slot === "payments") { a.understood = true; newPayments.push({ name: s.pending.name, amountMinor: s.pending.amountMinor, date: x.date }); delete s.pending; }
        break;
      case "partialIncome": {
        a.understood = true;
        const p = s.pending?.slot === "income" ? s.pending : { slot: "income" as const };
        const amountMinor = x.amountMinor != null ? x.amountMinor.toString() : p.amountMinor;
        const date = x.date ?? p.date;
        if (amountMinor && date) { delete s.pending; setFact(s, "income", { amountMinor, date }, "exact", src, now, a); }
        else s.pending = { slot: "income", ...(amountMinor ? { amountMinor } : {}), ...(date ? { date } : {}) };
        break;
      }
      case "partialGoal": {
        a.understood = true;
        const p = s.pending?.slot === "goal" ? s.pending : { slot: "goal" as const };
        const g = { slot: "goal" as const, name: x.name ?? p.name, amountMinor: x.amountMinor != null ? x.amountMinor.toString() : p.amountMinor, date: x.date ?? p.date };
        if (g.amountMinor && g.date) { delete s.pending; setFact(s, "goal", { name: g.name || "Цель", amountMinor: g.amountMinor, date: g.date }, "exact", src, now, a); }
        else s.pending = g;
        break;
      }
      case "problem":
        a.understood = true;
        a.problems.push(x.reason === "negative" ? "Если на счету минус, пока укажите 0, а долг добавим платежом."
          : x.reason === "ambiguous" ? `В «${x.text}» несколько сумм — напишите одну, пожалуйста.`
            : x.reason === "out_of_window" ? `Дата в «${x.text}» слишком далеко или в прошлом — нужна в пределах года (для цели — десяти лет).`
              : x.reason === "too_large" ? "Сумма слишком большая — проверьте число." : "После запятой бывает не больше двух знаков (копейки).");
        break;
    }
  }
  if (newPayments.length) {
    const prev = s.facts.payments;
    // Платёж с тем же названием — исправление (заменяем), иначе добавляем к списку.
    const key = (n: string) => n.toLowerCase().replace(/ё/g, "е").trim();
    const base = hasValue(prev) ? [...(prev.value as SlotValue["payments"])] : [];
    for (const np of newPayments) {
      const i = base.findIndex((p) => key(p.name) === key(np.name));
      if (i >= 0) base[i] = np; else base.push(np);
    }
    const merged = base.slice(0, 50);
    setFact(s, "payments", merged, "exact", src, now, a);
    a.confirmations[a.confirmations.length - 1] = `Записал: ${newPayments.map((p) => `${p.name} ${rub(p.amountMinor)} · ${shortDate(p.date)}`).join("; ")}`;
  }
}

// ---------- Финансовые записи ----------

function planFromFacts(f: Facts): PlanInput {
  const v = <K extends SlotKey>(k: K) => (hasValue(f[k]) ? (f[k] as Extract<Fact<SlotValue[K]>, { value: unknown }>).value : null);
  const income = v("income"), pays = v("payments"), goal = v("goal"), reserve = v("reserve"), daily = v("essentialDaily"), days = v("planningDays");
  return {
    balanceMinor: BigInt(v("balance")!),
    reserveMinor: reserve ? BigInt(reserve) : 0n, // «не знаю» → 0 с пометкой «не задан» (в сессии status=unknown)
    essentialDailyMinor: daily ? BigInt(daily) : null, // «не знаю» → null, а не 0
    incomes: income ? [{ name: "Доход", amountMinor: BigInt(income.amountMinor), dueOn: income.date }] : [],
    payments: (pays ?? []).map((p) => ({ name: p.name, amountMinor: BigInt(p.amountMinor), dueOn: p.date })),
    goal: goal ? { name: goal.name, targetMinor: BigInt(goal.amountMinor), targetDate: goal.date } : null,
    ...(days ? { planningDays: days } : {}),
  };
}


async function applyPatches(s: OnboardingSession, changed: Set<SlotKey>, now: Date) {
  const f = s.facts, uid = s.userId;
  const val = <K extends SlotKey>(k: K) => (hasValue(f[k]) ? (f[k] as Extract<Fact<SlotValue[K]>, { value: unknown }>).value : null);
  // Каждая правка — с проверкой версии, на которой задан вопрос: трата из другого канала не будет перезаписана.
  const opts = () => ({ now, baseFinanceVersion: s.baseFinanceVersion == null ? null : BigInt(s.baseFinanceVersion) });
  const bump = (r: { financeVersion: bigint }) => { s.baseFinanceVersion = r.financeVersion.toString(); };
  if (changed.has("balance") && val("balance") != null) bump(await setBalance(uid, BigInt(val("balance")!), opts()));
  if (changed.has("income") || changed.has("planningDays")) {
    const inc = val("income");
    if (inc || val("planningDays") != null) {
      const r = await setNextIncome(uid, inc ? { amountMinor: BigInt(inc.amountMinor), dueOn: inc.date } : null, inc ? undefined : val("planningDays")!, s.incomeIds ?? [], opts());
      bump(r); s.incomeIds = r.result ? [r.result] : [];
    }
  }
  if (changed.has("payments")) {
    const xs = val("payments") ?? [];
    const r = await setPayments(uid, xs.map((p) => ({ name: p.name, amountMinor: BigInt(p.amountMinor), dueOn: p.date })), s.paymentIds ?? [], opts());
    bump(r); s.paymentIds = r.result;
  }
  if (changed.has("reserve")) bump(await setReserve(uid, val("reserve") ? BigInt(val("reserve")!) : 0n, opts()));
  if (changed.has("essentialDaily")) bump(await setEssentialDaily(uid, val("essentialDaily") ? BigInt(val("essentialDaily")!) : null, opts()));
  if (changed.has("goal")) { const g = val("goal"); bump(await setGoal(uid, g ? { name: g.name, targetMinor: BigInt(g.amountMinor), targetDate: g.date } : null, opts())); }
}

async function occurrenceIds(userId: string, direction: "income" | "expense"): Promise<string[]> {
  const db = await getDb();
  const r = await db.query<{ id: string }>("SELECT id FROM occurrences WHERE user_id=$1 AND direction=$2 AND cancelled_at IS NULL", [userId, direction]);
  return r.rows.map((x) => x.id);
}

// ---------- Карточки ----------

function previewCard(v: ForecastView, s: OnboardingSession, preliminary: boolean): Card {
  const f = v.forecast;
  const free = f.freeMoneyMinor ?? f.dailyEnvelopeMinor;
  const caveats: string[] = [];
  if (s.facts.payments.status !== "confirmed") caveats.push("без учёта платежей");
  if (s.facts.essentialDaily.status !== "confirmed") caveats.push("повседневные траты не учтены");
  if (s.facts.reserve.status !== "confirmed") caveats.push("резерв не задан");
  return {
    type: "preview", preliminary, caveats,
    data: {
      title: f.horizonKind === "until_income" ? `На покупки до ${shortDate(f.horizonEnd)}` : `На покупки за ${f.days} дн.`,
      amount: `≈ ${formatRub(free > 0n ? free : 0n)}`,
      sub: `≈ ${formatRub(f.safeDailyMinor)} в день на всё`,
      horizonEnd: f.horizonEnd,
    },
  };
}

function summaryRows(s: OnboardingSession): SummaryRow[] {
  const rows: SummaryRow[] = [];
  const f = s.facts;
  rows.push({ slot: "balance", label: "Остаток", value: describeFact("balance", f.balance), missing: !hasValue(f.balance) });
  if (hasValue(f.income)) rows.push({ slot: "income", label: "Доход", value: describeFact("income", f.income), missing: false });
  else rows.push({ slot: "income", label: "Доход", value: `${describeFact("income", f.income)}${hasValue(f.planningDays) ? ` · считаю на ${f.planningDays.value} дн.` : ""}`, missing: true });
  for (const k of ["payments", "reserve", "essentialDaily", "goal"] as SlotKey[]) {
    const ff = f[k];
    rows.push({ slot: k, label: SLOT_LABEL[k], value: describeFact(k, ff), missing: !hasValue(ff) && !(k === "goal" && ff.status === "skipped") });
  }
  return rows;
}

// ---------- Вопросы ----------

function question(slot: SlotKey, s: OnboardingSession, until: ISODate | null): { text: string; placeholder?: string } {
  const again = s.facts[slot].askCount > 0;
  switch (slot) {
    case "balance": return { text: (again ? "Без остатка не получится посчитать — это главная цифра. " : "") + "Сколько сейчас денег на карте и наличными, которые вы тратите?", placeholder: "Например: 45 000" };
    case "income": return { text: "Когда и сколько придёт ближайший доход?", placeholder: "Например: 80 000 25 октября" };
    case "planningDays": return { text: "На какой срок считать деньги?", placeholder: "Например: 21 день" };
    case "payments": return { text: until ? `Какие обязательные платежи до ${shortDate(until)}? Можно списком.` : "Какие обязательные платежи впереди? Можно списком.", placeholder: "Аренда 30 000 20.10, интернет 700 22.10" };
    case "reserve": return { text: "Сколько держать неприкосновенным? Эти деньги я не буду предлагать тратить.", placeholder: "Например: 15 000" };
    case "essentialDaily": return { text: "Сколько примерно в день уходит на еду и транспорт?", placeholder: "Например: 800" };
    case "goal": return { text: "Копите на что-то?", placeholder: "Отпуск 60 000 к 1 июня" };
  }
}

function clarify(s: OnboardingSession): { text: string; placeholder?: string } {
  const p = s.pending!;
  if (p.slot === "income") return p.amountMinor ? { text: `А когда придут ${rub(p.amountMinor)}?`, placeholder: "Например: 25-го" } : { text: `Сколько придёт ${shortDate(p.date!)}?`, placeholder: "Например: 80 000" };
  if (p.slot === "payments") return { text: `У «${p.name}» нет даты — когда списывается?`, placeholder: "Например: 22-го" };
  return { text: "Напишите цель: на что, сколько и к какой дате.", placeholder: "Отпуск 60 000 к 1 июня" };
}

const NOT_UNDERSTOOD: Partial<Record<SlotKey, string>> = {
  balance: "Не получилось понять сумму. Напишите число, например 45 000.",
  income: "Нужны сумма и дата. Например: 80 000 25-го. Дату дохода я не угадываю.",
  planningDays: "Напишите число дней, например 21.",
  payments: "Напишите платежи так: аренда 30 000 20.10 — или нажмите «Нет платежей».",
  reserve: "Напишите сумму резерва числом, например 10 000.",
  essentialDaily: "Напишите примерную сумму в день, например 800.",
  goal: "Напишите цель так: Отпуск 60 000 к 1 июня — или «Нет».",
};

interface Built { lead?: string[]; text: string[]; cards: Card[]; choices: Choice[]; choiceLayout?: "row" | "stack"; placeholder?: string }

async function render(s: OnboardingSession, now: Date, prefix: string[]): Promise<Built> {
  const out: Built = { lead: [...prefix], text: [], cards: [], choices: [] };
  const today = localDate(now, await userTimezone(await getDb(), s.userId));
  for (let guard = 0; guard < 3; guard++) {
    const d: QuestionDecision = await policy.nextQuestion(s, { today });
    if (d.kind === "preview") {
      try {
        const ver = await savePlan(s.userId, planFromFacts(s.facts), "chat", now, { baseFinanceVersion: s.baseFinanceVersion == null ? null : BigInt(s.baseFinanceVersion), requireBase: true });
        s.baseFinanceVersion = ver.toString();
        s.paymentIds = await occurrenceIds(s.userId, "expense");
        s.incomeIds = await occurrenceIds(s.userId, "income");
      } catch (e) {
        if ((e as { code?: string }).code !== "FINANCE_VERSION_CONFLICT") throw e;
        // План успели создать в другом канале: ничего чужого не перезаписываем. Применяем поверх него
        // только то, что пользователь явно назвал в этом диалоге; прочие слоты спросим дальше по одному.
        const v = (await getForecast(s.userId, now))!;
        s.baseFinanceVersion = v.book.financeVersion.toString();
        s.paymentIds = [];
        s.incomeIds = v.forecast.nextIncome ? [v.forecast.nextIncome.id] : [];
        const mine = new Set<SlotKey>((["balance", "income", "planningDays", "payments", "reserve", "essentialDaily", "goal"] as SlotKey[])
          .filter((k) => { const ff = s.facts[k]; return hasValue(ff) && ff.source.via !== "import"; }));
        await applyPatches(s, mine, now);
      }
      s.planSaved = true;
      const v = await getForecast(s.userId, now);
      if (v) { out.cards.push(previewCard(v, s, true)); out.lead!.push("Вот предварительный расчёт — дальше уточним детали."); }
      continue;
    }
    if (d.kind === "ask" || d.kind === "clarify") {
      const v = s.planSaved ? await getForecast(s.userId, now) : null;
      const q = d.kind === "clarify" ? clarify(s) : question(d.slot, s, v?.forecast.nextIncome?.dueOn ?? (hasValue(s.facts.income) ? (s.facts.income.value as SlotValue["income"]).date : null));
      if (d.kind === "ask" && d.slot === "planningDays" && s.facts.income.status === "unknown" && !prefix.length) out.text.push("Хорошо, не буду угадывать.");
      out.text.push(q.text);
      out.placeholder = q.placeholder;
      out.choices = choicesFrom(d.choices, s, d.slot);
      out.choiceLayout = d.slot === "income" ? "stack" : "row";
      const slot = d.slot;
      s.facts[slot].askCount += 1;
      s.lastQuestion = { slot, messageId: "", templateId: d.kind === "ask" ? d.templateId : `${slot}.clarify` };
      s.phase = "collecting";
      return out;
    }
    if (d.kind === "summary") {
      s.lastQuestion = { slot: null, messageId: "", templateId: "summary" };
      if (s.mode === "edit") {
        const v = await getForecast(s.userId, now);
        if (v) out.cards.push(previewCard(v, s, false));
        out.text.push("План пересчитан.");
        out.choices = [control(0, "Готово", "done")];
        s.phase = "summary";
        delete s.editSlot;
        return out;
      }
      delete s.editSlot;
      s.phase = "summary";
      out.text.push("Всё верно? Если что-то не так — напишите или нажмите «Исправить».");
      out.cards.push({ type: "summary", data: { rows: summaryRows(s) } });
      const order: SlotKey[] = ["balance", "income", "payments", "reserve", "essentialDaily", "goal"];
      const fixes = [...order.filter((k) => !hasValue(s.facts[k]) && k !== "goal"), ...order.filter((k) => hasValue(s.facts[k]))].slice(0, 3);
      out.choices = [control(0, "Готово", "done"), ...fixes.map((k, i) => control(i + 1, `Исправить ${FIX_LABEL[k]}`, "edit", k))];
      out.placeholder = "Например: остаток 42 000";
      return out;
    }
    if (d.kind === "done") return out;
  }
  return out;
}

// ---------- Публичные операции ----------

export interface TurnResult { messages: ChatMessage[]; session: OnboardingSession; progress: number; done: boolean; facts: FactChip[] }
const result = (session: OnboardingSession, messages: ChatMessage[]): TurnResult => ({ session, messages, progress: progressOf(session), done: session.phase === "done", facts: factsView(session) });

function assistantMsg(id: string, b: Built, revision: number, now: Date): AssistantMessage {
  const j = (xs?: string[]) => (xs ?? []).filter(Boolean).join(" ").replace(/\s+\./g, ".");
  const lead = j(b.lead), text = j(b.text);
  // Без карточек всё — одним пузырём.
  return { schemaVersion: 1, id, role: "assistant", ...(b.cards.length && lead ? { lead } : {}), text: b.cards.length ? text : [lead, text].filter(Boolean).join(" "), cards: b.cards, choices: b.choices, choiceLayout: b.choiceLayout, revision, placeholder: b.placeholder, createdAt: now.toISOString() };
}

/** Факты из существующего бюджета (режим правки одного слота): via import. */
function importFacts(v: ForecastView, now: Date): Facts {
  const f = emptyFacts();
  const src = { messageId: "import", channel: "web" as Channel, via: "import" as Via };
  const c = <T,>(value: T): Fact<T> => ({ status: "confirmed", value, confidence: "exact", source: src, updatedAt: now.toISOString(), askCount: 0 });
  const b = v.book;
  f.balance = c(b.balanceMinor.toString());
  const inc = v.forecast.nextIncome;
  if (inc) f.income = c({ amountMinor: inc.amountMinor.toString(), date: inc.dueOn }); else { f.income = { status: "unknown", askCount: 0 }; f.planningDays = c(b.planningDays); }
  f.payments = c(b.occurrences.filter((o) => o.direction === "expense" && o.remainingMinor > 0n).map((o) => ({ name: o.name, amountMinor: o.remainingMinor.toString(), date: o.dueOn })));
  f.reserve = b.reserveMinor > 0n ? c(b.reserveMinor.toString()) : { status: "unknown", askCount: 0 };
  f.essentialDaily = b.essentialDailyMinor != null ? c(b.essentialDailyMinor.toString()) : { status: "unknown", askCount: 0 };
  f.goal = b.goal ? c({ name: b.goal.name, amountMinor: b.goal.targetMinor.toString(), date: b.goal.targetDate }) : { status: "skipped", askCount: 0 };
  return f;
}

const EDITABLE: SlotKey[] = ["balance", "income", "reserve", "essentialDaily", "goal", "payments"];

/**
 * Открыть онбординг: новая сессия с приветствием, «Продолжим?» для незавершённой, или правка одного слота (mode=edit).
 * Пользователь с бюджетом и без активной сессии онбординг не проходит: { skip: true }.
 */
export async function openOnboarding(userId: string, channel: Channel, opts: { mode?: "initial" | "edit"; slot?: SlotKey; now?: Date } = {}): Promise<TurnResult & { skip?: boolean; history: ChatMessage[] }> {
  const now = opts.now ?? new Date();
  const cur = await loadSession(userId);
  const view = await getForecast(userId, now);
  if (opts.mode === "edit") {
    if (!view) throw Object.assign(new Error("Сначала нужен план"), { code: "NO_PLAN" });
    const slot = opts.slot && EDITABLE.includes(opts.slot) ? opts.slot : "balance";
    const s = newSession(userId, "edit", view.book.financeVersion.toString(), now, policy.id);
    s.facts = importFacts(view, now);
    s.planSaved = true;
    s.previous = { [slot]: describeFact(slot, s.facts[slot]) };
    s.facts[slot] = { status: "missing", askCount: 0 };
    if (slot === "income") s.facts.planningDays = { status: "missing", askCount: 0 };
    s.incomeIds = view.forecast.nextIncome ? [view.forecast.nextIncome.id] : [];
    s.paymentIds = slot === "payments" ? view.book.occurrences.filter((o) => o.direction === "expense" && o.remainingMinor > 0n && o.settledMinor === 0n).map((o) => o.id) : [];
    s.editSlot = slot;
    s.phase = "collecting";
    await deleteSession(userId);
    const id = newId();
    const b = await render(s, now, [`Текущее значение: ${s.previous[slot]}.`]);
    s.revision = 1; s.lastAssistantId = id; if (s.lastQuestion) s.lastQuestion.messageId = id;
    await casSession(s, null);
    const m = assistantMsg(id, b, s.revision, now);
    await insertMessage(userId, channel, m, null);
    await trackOnboardingStart(userId, s, channel, now);
    return { ...result(s, [m]), history: [m] };
  }
  if (cur && cur.phase !== "done") {
    const history = await listMessages(userId);
    const last = history[history.length - 1];
    const lastIsResume = last?.role === "assistant" && last.choices.some((c) => c.action?.type === "control" && c.action.name === "resume");
    const hasUserTurns = history.some((m) => m.role === "user");
    if (lastIsResume || !hasUserTurns || cur.mode === "edit") {
      if (cur.mode === "edit") { /* незавершённая правка: просто закрываем её и показываем главную/новый онбординг */
        if (view) { await deleteSession(userId); return { ...result({ ...cur, phase: "done" }, []), skip: true, history: [] }; }
      }
      return { ...result(cur, []), history };
    }
    const left = (["balance", "income", "planningDays", "payments", "reserve", "essentialDaily", "goal"] as SlotKey[])
      .filter((k) => slotNeeded(cur, k) && cur.facts[k].status === "missing").map((k) => (k === "planningDays" ? "срок расчёта" : FIX_LABEL[k]));
    const id = newId();
    const next: OnboardingSession = { ...cur, revision: cur.revision + 1, lastAssistantId: id, updatedAt: now.toISOString() };
    const text = cur.phase === "summary" ? "Продолжим? Осталось проверить итог." : left.length ? `Продолжим? Осталось уточнить ${left.slice(0, 2).join(" и ")}.` : "Продолжим знакомство? Осталось пару вопросов.";
    const m = assistantMsg(id, { text: [text], cards: [], choices: [control(0, "Продолжить", "resume"), control(1, "Начать заново", "restart")] }, next.revision, now);
    if (!(await casSession(next, cur.revision))) return { ...result(cur, []), history };
    await insertMessage(userId, channel, m, null);
    return { ...result(next, [m]), history: [...history, m] };
  }
  if (view) return { ...result(cur ?? newSession(userId, "initial", null, now, policy.id), []), skip: true, history: [] };
  return { ...(await startFresh(userId, channel, null, now)) };
}

async function startFresh(userId: string, channel: Channel, base: string | null, now: Date, expected?: number) {
  const s = newSession(userId, "initial", base, now, policy.id);
  const id = newId();
  s.revision = (expected ?? -1) + 1;
  s.lastAssistantId = id;
  const m = assistantMsg(id, { text: ["Привет! Я помогу понять, что можно себе позволить. Пара вопросов — около минуты."], cards: [], choices: [control(0, "Начнём", "start")] }, s.revision, now);
  if (expected == null) { await deleteSession(userId); await casSession(s, null); }
  else if (!(await casSession(s, expected))) throw Object.assign(new Error("busy"), { code: "BUSY" });
  await insertMessage(userId, channel, m, null);
  await trackOnboardingStart(userId, s, channel, now);
  return { ...result(s, [m]), history: [m] };
}

/** Один ход пользователя (текст или выбор варианта) — единый обработчик для web и Telegram. */
export async function handleTurn(userId: string, turn: UserTurn, channel: Channel, now = new Date()): Promise<TurnResult> {
  const text = String(turn.text ?? "").trim().slice(0, 2000);
  const key = turn.clientMessageId ? String(turn.clientMessageId).slice(0, 100) : null;
  // Идемпотентность: повтор того же хода возвращает прежний ответ.
  if (key) {
    const prev = await messageByClientKey(userId, key);
    if (prev && prev.role === "user") {
      const reply = (prev as UserMessage & { replyId?: string }).replyId ? await getMessage(userId, (prev as UserMessage & { replyId?: string }).replyId!) : null;
      const s = await loadSession(userId);
      return result(s!, reply ? [prev, reply] : [prev]);
    }
  }
  let cur = await loadSession(userId);
  if (!cur) {
    // Нет сессии (например, сразу пишет боту): открываем онбординг, если плана нет.
    const opened = await openOnboarding(userId, channel, { now });
    if (opened.skip) throw Object.assign(new Error("Онбординг не нужен"), { code: "ONBOARDING_NOT_ACTIVE" });
    cur = opened.session;
    if (!text) return opened;
  }
  if (cur.phase === "done") throw Object.assign(new Error("Онбординг завершён"), { code: "ONBOARDING_NOT_ACTIVE" });
  const userMsgId = newId();
  // Аренда: предыдущий ход ещё пишет финансы — мягко просим повторить (без изменений состояния).
  if (cur.busyUntil && new Date(cur.busyUntil) > now) return busy(cur, { schemaVersion: 1, id: userMsgId, role: "user", text, via: "text", channel, createdAt: now.toISOString() }, channel, key, now);
  const s: OnboardingSession = structuredClone(cur);
  s.updatedAt = now.toISOString();
  const a: Applied = { confirmations: [], changed: new Set(), problems: [], understood: false };
  const src = { messageId: userMsgId, channel, via: (turn.selection ? "choice" : "text") as Via };
  let prefix: string[] = [];
  let userText = text;
  let restart = false;
  let notUnderstood: string | null = null;

  // Выбор варианта: проверяем, что это вариант последнего сообщения и актуальной ревизии.
  let action: ChoiceAction | undefined;
  if (turn.selection) {
    const stale = turn.selection.assistantMessageId !== cur.lastAssistantId || Number(turn.selection.revision) !== cur.revision;
    const msg = stale ? null : await getMessage(userId, turn.selection.assistantMessageId);
    const choice = msg?.role === "assistant" ? msg.choices.find((c) => c.id === turn.selection!.choiceId) : undefined;
    if (!choice) prefix = ["Этот вопрос уже неактуален."];
    else { action = choice.action; userText = choice.userText; a.understood = true; }
  }
  if (!userText) userText = "…";

  if (action?.type === "control") {
    switch (action.name) {
      case "start": s.phase = "collecting"; break;
      case "resume": break;
      case "later": s.phase = "paused"; break;
      case "restart": restart = true; break;
      case "done": if (s.planSaved) s.phase = "done"; break; // без сохранённого плана завершить нельзя
      case "edit": {
        const slot = action.slot && EDITABLE.includes(action.slot) ? action.slot : "balance";
        s.previous = { ...(s.previous ?? {}), [slot]: describeFact(slot, s.facts[slot]) };
        s.facts[slot] = { status: "missing", askCount: 0 };
        if (slot === "income" && s.facts.planningDays.status !== "confirmed") s.facts.planningDays = { status: "missing", askCount: 0 };
        delete s.pending;
        s.editSlot = slot;
        s.phase = "collecting";
        break;
      }
    }
  } else if (action?.type === "setFact") {
    applyAction(s, action, src, now, a);
  } else if (!turn.selection && text) {
    const today = localDate(now, await userTimezone(await getDb(), userId));
    if (s.phase === "intro") s.phase = "collecting";
    const focus = s.pending?.slot ?? (s.phase === "summary" ? null : s.lastQuestion?.slot ?? "balance");
    const xs = extractFacts(text, focus, today, { pendingPayment: s.pending?.slot === "payments", pendingIncome: s.pending?.slot === "income", pendingGoal: s.pending?.slot === "goal" });
    applyExtracted(s, xs, src, now, a);
    if (!a.understood) notUnderstood = focus ?? "summary";
    if (!a.understood) prefix.push(focus ? NOT_UNDERSTOOD[focus] ?? "Не понял ответ." : "Не понял. Чтобы исправить, напишите, например: «остаток 42 000» — или нажмите «Исправить …».");
  }

  const userMsg: UserMessage & { replyId?: string } = { schemaVersion: 1, id: userMsgId, role: "user", text: userText, via: turn.selection ? "choice" : "text", channel, createdAt: now.toISOString() };
  const replyId = newId();
  userMsg.replyId = replyId;
  // Захват ключа идемпотентности до любых записей: повтор того же хода сюда не дойдёт.
  if (!(await insertMessage(userId, channel, userMsg, key))) return busy(cur, userMsg, channel, key, now);
  const release = () => deleteMessage(userId, userMsg.id);

  if (restart) {
    const view = await getForecast(userId, now);
    const fresh = await startFresh(userId, channel, view ? view.book.financeVersion.toString() : null, now, cur.revision).catch(() => null);
    if (!fresh) { await release(); return busy(cur, userMsg, channel, key, now); }
    return result(fresh.session, [userMsg, ...fresh.messages]);
  }

  // Захват ревизии до финансовых записей: параллельный ход (другая вкладка/бот) получит мягкий отказ.
  s.revision = cur.revision + 1;
  s.busyUntil = new Date(now.getTime() + 30_000).toISOString();
  s.lastAssistantId = replyId;
  if (!(await casSession(s, cur.revision))) { await release(); return busy(cur, userMsg, channel, key, now); }

  let built: Built;
  try {
    if (s.planSaved && a.changed.size) await applyPatches(s, a.changed, now);
    const confirm = a.confirmations.length ? [joinConfirmations(a.confirmations)] : [];
    if (s.phase === "done") {
      const v = await getForecast(userId, now);
      built = { text: [...prefix, "Готово! Первый прогноз уже на главной."], cards: v ? [previewCard(v, s, false)] : [], choices: [] };
    } else if (s.phase === "paused") {
      built = { text: ["Хорошо, вернёмся позже — всё сохранено."], cards: [], choices: [] };
    } else {
      built = await render(s, now, [...prefix, ...confirm, ...a.problems]);
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    let msg = code && /^(INVALID_|NO_PLAN)/.test(code) ? `Не получилось сохранить: ${(e as Error).message}.` : "Что-то пошло не так при сохранении. Попробуйте ещё раз.";
    if (code === "FINANCE_VERSION_CONFLICT") {
      const d = (e as { details?: { financeVersion?: string; balanceMinor?: string | null } }).details;
      if (d?.financeVersion) s.baseFinanceVersion = d.financeVersion;
      msg = `${(e as Error).message}${d?.balanceMinor ? ` Сейчас остаток ${rub(d.balanceMinor)}.` : ""} Ничего не перезаписал — ответьте, пожалуйста, ещё раз.`;
    }
    built = { text: [msg], cards: [], choices: [] };
    s.facts = cur.facts; s.pending = cur.pending; s.editSlot = cur.editSlot; s.phase = cur.phase === "intro" ? "collecting" : cur.phase;
    if (s.lastQuestion?.slot) built.text.push(question(s.lastQuestion.slot, s, null).text);
    else if (s.planSaved) built.choices = [control(0, "Готово", "done")];
  }
  if (s.lastQuestion) s.lastQuestion.messageId = replyId;
  const reply = assistantMsg(replyId, built, s.revision, now);
  delete s.busyUntil;
  await casSession(s, s.revision); // те же ревизия и id: сохраняем planSaved/paymentIds/lastQuestion, снимаем аренду
  await insertMessage(userId, channel, reply, null);
  await trackOnboardingTurn(userId, cur, s, built, channel, turn.selection ? "choice" : "text", now, notUnderstood);
  // Знакомство завершено (первый прогноз) — целевой сценарий приглашённого (lib/referrals.ts).
  if (s.phase === "done" && s.planSaved) await activateReferral(userId, channel, now);
  return result(s, [userMsg, reply]);
}

/** «Понял: 45 000 ₽ сейчас и доход 80 000 ₽ · 25 октября.» — одно подтверждение на несколько фактов. */
export function joinConfirmations(xs: string[]): string {
  const got = xs.filter((x) => x.startsWith("Понял: ")).map((x) => x.slice(7));
  const rest = xs.filter((x) => !x.startsWith("Понял: "));
  const parts = [...(got.length ? [`Понял: ${got.join(" и ")}`] : []), ...rest];
  return parts.join(". ") + ".";
}

async function busy(cur: OnboardingSession, userMsg: UserMessage, channel: Channel, key: string | null, now: Date): Promise<TurnResult> {
  void channel; void key;
  const m: AssistantMessage = { schemaVersion: 1, id: newId(), role: "assistant", text: "Получил несколько сообщений подряд. Ответьте, пожалуйста, ещё раз на последний вопрос.", cards: [], choices: [], revision: cur.revision, createdAt: now.toISOString() };
  return result(cur, [userMsg, m]);
}

/** Пауза (/cancel в боте): варианты ответа устаревают, свободный текст больше не заполняет слоты. Продолжить — через /start. */
export async function pauseOnboarding(userId: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const cur = await loadSession(userId);
    if (!cur || cur.phase === "done" || cur.phase === "paused") return false;
    if (await casSession({ ...cur, phase: "paused", revision: cur.revision + 1, lastAssistantId: undefined, busyUntil: undefined }, cur.revision)) return true;
  }
  return false;
}

export async function onboardingState(userId: string) {
  const s = await loadSession(userId);
  return s ? { phase: s.phase, mode: s.mode, planSaved: s.planSaved, progress: progressOf(s), revision: s.revision, lastAssistantId: s.lastAssistantId ?? null } : null;
}

export { minimumReady, slotNeeded };
