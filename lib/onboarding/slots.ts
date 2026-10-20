// Слоты онбординга: значения, статусы, извлечение нескольких фактов из одного ответа (детерминированно, lib/parse).
import { addDays, FUTURE_WINDOW_DAYS, GOAL_FUTURE_DAYS, PAST_WINDOW_DAYS, type ISODate } from "../engine";
import { parseAmountDetailed, parseDate } from "../parse";
import type { Channel } from "../conversation";
import type { Confidence, SlotKey } from "./protocol";

export interface PaymentValue { name: string; amountMinor: string; date: ISODate }
export interface SlotValue {
  balance: string; // копейки строкой (JSON)
  income: { amountMinor: string; date: ISODate };
  planningDays: number;
  payments: PaymentValue[];
  reserve: string;
  essentialDaily: string;
  goal: { name: string; amountMinor: string; date: ISODate };
}
export type Via = "text" | "choice" | "import" | "llm";
export type Fact<T> =
  | { status: "missing" | "unknown" | "skipped"; askCount: number; note?: "irregular" }
  | { status: "candidate" | "confirmed"; value: T; confidence: Confidence; source: { messageId: string; channel: Channel; via: Via }; updatedAt: string; askCount: number };
export type Facts = { [K in SlotKey]: Fact<SlotValue[K]> };

export const emptyFacts = (): Facts => ({
  balance: { status: "missing", askCount: 0 }, income: { status: "missing", askCount: 0 }, planningDays: { status: "missing", askCount: 0 },
  payments: { status: "missing", askCount: 0 }, reserve: { status: "missing", askCount: 0 }, essentialDaily: { status: "missing", askCount: 0 }, goal: { status: "missing", askCount: 0 },
});

export const hasValue = <F extends { status: string }>(f: F): f is Extract<F, { value: unknown }> => f.status === "candidate" || f.status === "confirmed";
export const isResolved = (f: Fact<unknown>) => f.status !== "missing";

/** Извлечённый факт (или его часть) из текста пользователя. */
export type Extracted =
  | { kind: "value"; slot: "balance" | "reserve" | "essentialDaily"; minor: bigint; confidence: Confidence }
  | { kind: "value"; slot: "income"; amountMinor: bigint; date: ISODate; confidence: Confidence }
  | { kind: "value"; slot: "planningDays"; days: number; confidence: Confidence }
  | { kind: "value"; slot: "goal"; name: string; amountMinor: bigint; date: ISODate; confidence: Confidence }
  | { kind: "payment"; name: string; amountMinor: bigint; date: ISODate | null }
  | { kind: "status"; slot: SlotKey; status: "unknown" | "none" }
  | { kind: "partialIncome"; amountMinor?: bigint; date?: ISODate }
  | { kind: "partialGoal"; name?: string; amountMinor?: bigint; date?: ISODate }
  | { kind: "dateOnly"; date: ISODate }
  | { kind: "problem"; slot: SlotKey | null; reason: "negative" | "ambiguous" | "out_of_window" | "too_large" | "bad_precision"; text: string };

const KEYWORDS: [SlotKey, RegExp][] = [
  ["reserve", /(резерв|неприкоснов|подушк)/],
  ["essentialDaily", /(в день|на день|ежедневн|еда|продукт|транспорт)/],
  ["goal", /(коплю|накоп|цель|мечта)/],
  ["income", /(зарплат|зп\b|доход|аванс|получ|придёт|придет|поступ|гонорар|стипенд|пенси)/],
  ["balance", /(остат|на карте|на счету|налич|баланс|сейчас есть|у меня)/],
  ["payments", /(аренд|кредит|ипотек|интернет|связь|телефон|коммун|квартплат|платёж|платеж|подписк|рассрочк|страхов|долг|садик|секци)/],
];

const UNKNOWN_RE = /^(?:я\s+)?(не\s*знаю|незнаю|хз|не\s+уверен[а]?|пока\s+не\s+знаю|не\s+помню|сложно\s+сказать)[\s.!]*$/i;
const NONE_RE = /^(нет|нету|не\s*(?:коплю|надо|нужно)|без\s+\S+|ничего|никаких|0|ноль)[\s.!]*$/i;
const PLAN_DAYS_RE = /^\D*(\d{1,3})\s*(?:дн[а-я]*|день|сут[а-я]*)?\D*$/;

const inWindow = (d: ISODate, today: ISODate, futureDays = FUTURE_WINDOW_DAYS) => d >= addDays(today, -PAST_WINDOW_DAYS) && d <= addDays(today, futureDays);
const normText = (t: string) => t.toLowerCase().replace(/[\u00a0\u202f]/g, " ").replace(/ё/g, "е").trim();
const approx = (t: string): Confidence => (/(около|примерно|где-то|~|приблизительно|порядка)/.test(t) ? "approximate" : "exact");
const cleanTitle = (s: string) => {
  const t = s.replace(/[-−–:]?\s*\d.*$/, "").replace(/^(на|за|коплю на|цель|хочу)\s+/i, "").replace(/[,.;]+$/, "").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1, 80) : "";
};

/** Делит ответ на смысловые куски: запятая с пробелом, точка с запятой, перевод строки, « и ». Десятичные «1,5» не режутся. */
export function segments(text: string): string[] {
  return text.split(/\n|;|,\s+|\s+и\s+|\s+а\s+(?=\S*\s*(?:зарплат|доход|аванс|резерв|аренд))/i).map((s) => s.trim()).filter(Boolean);
}

function slotByKeyword(seg: string): SlotKey | null {
  const t = normText(seg);
  for (const [k, re] of KEYWORDS) if (re.test(t)) return k;
  return null;
}

/**
 * Разбор ответа на вопрос focus. Принимает несколько фактов («45к, зарплата 80к 25-го»), исправления по ключевым словам
 * («остаток всё-таки 42 тысячи») и «не знаю» (никогда не становится нулём).
 */
export function extractFacts(text: string, focus: SlotKey | null, today: ISODate, opts: { pendingPayment?: boolean; pendingIncome?: boolean; pendingGoal?: boolean } = {}): Extracted[] {
  const raw = text.trim().slice(0, 2000);
  const whole = normText(raw);
  if (!whole) return [];
  if (focus && UNKNOWN_RE.test(whole)) return [{ kind: "status", slot: focus, status: "unknown" }];
  if (focus && (focus === "payments" || focus === "goal") && NONE_RE.test(whole)) return [{ kind: "status", slot: focus, status: "none" }];
  if (focus === "reserve" && /^(без резерва|не нужен|нет|0|ноль)[\s.!]*$/.test(whole)) return [{ kind: "value", slot: "reserve", minor: 0n, confidence: "exact" }];
  if (focus === "planningDays") {
    const m = whole.match(PLAN_DAYS_RE);
    if (m && +m[1] >= 1 && +m[1] <= 90 && !parseDate(raw, today)) return [{ kind: "value", slot: "planningDays", days: +m[1], confidence: "exact" }];
  }
  const out: Extracted[] = [];
  const used = new Set<SlotKey>();
  for (const seg of segments(raw)) {
    const low = normText(seg);
    const kw = slotByKeyword(seg);
    const date = parseDate(seg, today);
    const a = parseAmountDetailed(seg);
    if (a.error === "NEGATIVE_AMOUNT") { out.push({ kind: "problem", slot: kw ?? focus, reason: "negative", text: seg }); continue; }
    if (a.error === "AMOUNT_TOO_LARGE") { out.push({ kind: "problem", slot: kw ?? focus, reason: "too_large", text: seg }); continue; }
    if (a.error === "BAD_PRECISION") { out.push({ kind: "problem", slot: kw ?? focus, reason: "bad_precision", text: seg }); continue; }
    if (a.ambiguous) { out.push({ kind: "problem", slot: kw ?? focus, reason: "ambiguous", text: seg }); continue; }
    const conf = approx(low);
    // Слот куска: ключевое слово > контекст вопроса. Сумма+дата без ключевого слова на вопросе об остатке — это доход.
    let slot: SlotKey | null = kw;
    if (!slot) {
      if (a.minor != null && date) slot = focus === "payments" ? "payments" : focus === "goal" ? "goal" : focus === "balance" || focus === "income" ? "income" : focus;
      else if (a.minor != null) slot = focus === "income" && used.has("income") ? null : focus;
      else if (date) slot = focus;
    }
    if (slot === "income" && focus === "balance" && !kw && a.minor != null && !date && !used.has("balance")) slot = "balance";
    if (!slot) continue;
    if (date && !inWindow(date, today, slot === "goal" ? GOAL_FUTURE_DAYS : FUTURE_WINDOW_DAYS)) { out.push({ kind: "problem", slot, reason: "out_of_window", text: seg }); continue; }
    switch (slot) {
      case "balance": case "reserve": case "essentialDaily":
        if (a.minor != null && !used.has(slot)) { out.push({ kind: "value", slot, minor: a.minor, confidence: conf }); used.add(slot); }
        else if (a.minor == null && UNKNOWN_RE.test(low.replace(/^(остаток|резерв|в день)\s*/, ""))) out.push({ kind: "status", slot, status: "unknown" });
        break;
      case "income":
        if (a.minor != null && date) { out.push({ kind: "value", slot: "income", amountMinor: a.minor, date, confidence: conf }); used.add("income"); }
        else if (a.minor != null || date) out.push({ kind: "partialIncome", ...(a.minor != null ? { amountMinor: a.minor } : {}), ...(date ? { date } : {}) });
        else if (/нерегуляр|по-разному|по разному|фриланс|непостоян/.test(low)) out.push({ kind: "status", slot: "income", status: "none" });
        break;
      case "planningDays":
        break;
      case "payments":
        if (a.minor != null) out.push({ kind: "payment", name: cleanTitle(seg) || "Платёж", amountMinor: a.minor, date });
        else if (date && opts.pendingPayment) out.push({ kind: "dateOnly", date });
        break;
      case "goal": {
        const name = cleanTitle(seg);
        if (a.minor != null && date) out.push({ kind: "value", slot: "goal", name: name || "Цель", amountMinor: a.minor, date, confidence: conf });
        else if (a.minor != null || date || name) out.push({ kind: "partialGoal", ...(name ? { name } : {}), ...(a.minor != null ? { amountMinor: a.minor } : {}), ...(date ? { date } : {}) });
        break;
      }
    }
  }
  // Ответ только датой на уточнение дохода/платежа.
  if (!out.length && opts.pendingIncome) { const d = parseDate(raw, today); if (d) out.push({ kind: "partialIncome", date: d }); }
  return out;
}
