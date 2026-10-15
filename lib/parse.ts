// Детерминированный разбор русских фраз: fallback без LLM, онбординг и проверка текста от LLM.
// Возвращает распознанные поля, неоднозначности и ошибки; ничего не угадывает молча.
import { addDays, daysInMonth, isValidDate, makeDate, type ISODate } from "./engine/dates";
import { MAX_MINOR, type Minor } from "./engine/money";

const MONTHS = ["январ", "феврал", "март", "апрел", "ма", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
const MONTH_RE = "(январ[а-я]*|феврал[а-я]*|март[а-я]*|апрел[а-я]*|ма[йя]|июн[а-я]*|июл[а-я]*|август[а-я]*|сентябр[а-я]*|октябр[а-я]*|ноябр[а-я]*|декабр[а-я]*)";
// Год после месяца: 2020–2099 и не сумма ("5 ноября 2050 ₽" — сумма).
const YEAR_RE = "20[2-9]\\d(?!\\d|\\s*(?:₽|руб|р\\.|к(?![а-яё])|тыс))";
const L = "a-zа-яё"; // буквы для границ слов (\b не работает с кириллицей)

const norm = (t: string) => t.toLowerCase().replace(/[\u00a0\u202f]/g, " ").replace(/−/g, "-");

/** Удаляет из текста даты, чтобы их числа не стали суммой. Одинаково для всех мест разбора. */
export function stripDates(text: string): string {
  return norm(text)
    .replace(/\d{4}-\d{2}-\d{2}/g, " ")
    // ДД.ММ(.ГГГГ) вырезается, только если это возможная дата: "15.50" и "15.10 ₽" остаются суммами.
    .replace(new RegExp(`(?<![\\d.,])(\\d{1,2})[./](\\d{1,2})(?:[./]\\d{2,4})?(?![\\d]|[.,]\\d|\\s*(?:млн|миллион|тыс|т\\.?р|к(?![${L}])|k(?![${L}])|₽|руб|р\\.|р(?![${L}])))`, "g"),
      (m, d, mo) => (+d >= 1 && +d <= 31 && +mo >= 1 && +mo <= 12 ? " " : m))
    .replace(new RegExp(`(?<![\\d])\\d{1,2}\\s+${MONTH_RE}(?:\\s+${YEAR_RE})?`, "g"), " ")
    .replace(/(?<!\d)\d{1,2}(?:-?го|\s*числа)/g, " ")
    .replace(/через\s+\d+\s*(?:дн[а-я]*|день|недел[а-я]*)/g, " ");
}

export interface AmountCandidate { minor: Minor; negative: boolean; raw: string; index: number; hasUnit: boolean; priceCue: boolean; afterLatinWord: boolean; badPrecision: boolean }
export interface AmountParse { minor: Minor | null; negative: boolean; ambiguous: boolean; candidates: AmountCandidate[]; error?: string }

const AMOUNT_RE = new RegExp(
  // Целая часть: группы по 3 через пробел или точку ("1 234", "1.234"), иначе подряд. Дробная — любой длины, >2 знаков = ошибка точности.
  `(?<![${L}\\d.,])(-\\s*)?(\\d{1,3}(?:[ .]\\d{3})+(?!\\d)|\\d+)(?:[.,](\\d+))?(?!\\d)\\s*` +
  `(тыс[${L}]*\\.?|т\\.?\\s?р\\.?|млн\\.?|миллион[${L}]*|к(?![${L}])|k(?![${L}])|₽|руб[${L}]*\\.?|р\\.(?![${L}])|р(?![${L}]))?`,
  "g",
);
const PRICE_CUE = /(?:^|[^a-zа-яё])(за|по|стоит|стоимостью|ценой|цена|на сумму|всего)\s*$/;

/** Все суммы-кандидаты в тексте (даты предварительно удалены). */
export function amountCandidates(text: string): AmountCandidate[] {
  const t = stripDates(text);
  const out: AmountCandidate[] = [];
  for (const m of t.matchAll(AMOUNT_RE)) {
    const unit = (m[4] ?? "").trim();
    const frac = m[3] ?? "";
    const badPrecision = frac.length > 2;
    let minor = BigInt(m[2].replace(/[ .]/g, "")) * 100n + BigInt(badPrecision ? "0" : frac.padEnd(2, "0"));
    if (/^(тыс|т\.?\s?р|к|k)/.test(unit)) minor *= 1000n;
    else if (/^(млн|миллион)/.test(unit)) minor *= 1_000_000n;
    const before = t.slice(0, m.index);
    out.push({
      minor, negative: !!m[1], raw: m[0].trim(), index: m.index!,
      hasUnit: unit.length > 0,
      priceCue: PRICE_CUE.test(before),
      afterLatinWord: /[a-z]+\s*$/.test(before),
      badPrecision,
    });
  }
  return out;
}

/** Разбор суммы в копейках с выбором кандидата: "за 80 000" важнее "iPhone 15". */
export function parseAmountDetailed(text: string): AmountParse {
  const c = amountCandidates(text);
  if (!c.length) return { minor: null, negative: false, ambiguous: false, candidates: c };
  const pick = (xs: AmountCandidate[]) => xs[xs.length - 1];
  let chosen: AmountCandidate | undefined;
  let ambiguous = false;
  const cued = c.filter((x) => x.priceCue);
  const withUnit = c.filter((x) => x.hasUnit);
  const plain = c.filter((x) => !x.afterLatinWord);
  const distinct = (xs: AmountCandidate[]) => new Set(xs.map((x) => x.minor)).size > 1;
  if (cued.length) { chosen = pick(cued); ambiguous = distinct(cued); }
  else if (withUnit.length) { chosen = pick(withUnit); ambiguous = distinct(withUnit); }
  else if (c.length === 1) chosen = c[0];
  else if (plain.length) { chosen = pick(plain); ambiguous = distinct(plain); }
  else { chosen = pick(c); ambiguous = true; }
  if (chosen.negative) return { minor: null, negative: true, ambiguous, candidates: c, error: "NEGATIVE_AMOUNT" };
  if (chosen.badPrecision) return { minor: null, negative: false, ambiguous, candidates: c, error: "BAD_PRECISION" };
  if (chosen.minor > MAX_MINOR) return { minor: null, negative: false, ambiguous, candidates: c, error: "AMOUNT_TOO_LARGE" };
  return { minor: chosen.minor, negative: false, ambiguous, candidates: c };
}

export function parseAmountMinor(text: string): Minor | null { return parseAmountDetailed(text).minor; }

/** Совместимость: сумма в рублях (number) или null. Отрицательные суммы не превращаются в положительные. */
export function parseAmount(text: string): number | null {
  const m = parseAmountMinor(text);
  return m == null ? null : Number(m) / 100;
}

/** Строгий разбор даты. Невозможные даты (31.02) -> null. "20-го" после 20-го -> следующий месяц. */
export function parseDate(text: string, today: ISODate, opts: { prefer?: "future" | "past" } = {}): ISODate | null {
  const t = norm(text);
  const past = opts.prefer === "past";
  if (/сегодня/.test(t)) return today;
  if (/позавчера/.test(t)) return addDays(today, -2);
  if (/вчера/.test(t)) return addDays(today, -1);
  if (/послезавтра/.test(t)) return addDays(today, 2);
  if (/завтра/.test(t)) return addDays(today, 1);
  let m = t.match(/через\s+(\d+)\s*(дн|день|недел)/);
  if (m) { const n = Number(m[1]); if (n > 3650) return null; return addDays(today, n * (m[2].startsWith("недел") ? 7 : 1)); }
  m = t.match(/(\d+)\s*(дн[а-я]*|день|недел[а-я]*)\s+назад/);
  if (m) { const n = Number(m[1]); if (n > 3650) return null; return addDays(today, -n * (m[2].startsWith("недел") ? 7 : 1)); }
  const [y, mo, dd] = today.split("-").map(Number);
  const withYear = (d: number, month: number, year?: number): ISODate | null => {
    if (year != null) return makeDate(year < 100 ? 2000 + year : year, month, d);
    const cur = makeDate(y, month, d);
    // Для операций (prefer past) "5 октября" после 5 октября — этот год, до него — прошлый; для планов — наоборот.
    if (past) return cur && cur <= today ? cur : makeDate(y - 1, month, d);
    if (cur && cur >= today) return cur;
    return makeDate(y + 1, month, d); // 29.02 без года тоже попадёт сюда, если в этом году её нет
  };
  m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) { const iso = `${m[1]}-${m[2]}-${m[3]}`; return isValidDate(iso) ? iso : null; }
  m = t.match(/(?<![\d.,])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d])/);
  if (m) return withYear(+m[1], +m[2], m[3] ? +m[3] : undefined);
  m = t.match(new RegExp(`(?<!\\d)(\\d{1,2})\\s+${MONTH_RE}(?:\\s+(${YEAR_RE}))?`));
  if (m) { const idx = MONTHS.findIndex((p) => m![2].startsWith(p)); if (idx >= 0) return withYear(+m[1], idx + 1, m[3] ? +m[3] : undefined); }
  m = t.match(/(?<!\d)(\d{1,2})(?:-?го|\s*числа)/);
  if (m) {
    const d = +m[1];
    if (d < 1 || d > 31) return null;
    if (past) {
      if (d <= dd) return makeDate(y, mo, d);
      const py = mo === 1 ? y - 1 : y, pm = mo === 1 ? 12 : mo - 1;
      return makeDate(py, pm, d);
    }
    if (d >= dd && d <= daysInMonth(y, mo)) return makeDate(y, mo, d);
    const ny = mo === 12 ? y + 1 : y, nm = mo === 12 ? 1 : mo + 1;
    return makeDate(ny, nm, d); // 31-го в 30-дневном месяце -> null, лучше уточнить
  }
  return null;
}

export type IntentKind = "purchase" | "snapshot" | "expense" | "income" | "amount_only" | "other";
export interface PurchaseIntent {
  intent: IntentKind;
  item?: string;
  /** Цена в рублях (совместимость). */
  price?: number;
  priceMinor?: Minor;
  dateText?: string;
  ambiguous?: boolean;
  error?: string;
}

const EXPENSE_RE = /(потратил|потратила|заплатил|заплатила|оплатил|оплатила|купил(?![а-я]*\s+бы)|купила|отдал|отдала|списали|записать расход|запиши расход)/;
const INCOME_RE = /(получил|получила|пришл[аио]|пришёл|пришел|поступил[аио]?|начислили|перевели мне|зарплата пришла)/;
const PURCHASE_RE = /(купить|куплю|взять|возьму|потратить|позволить|заказать|можно)/;

// Частые категории в винительном падеже -> именительный ("купил одежду" -> "одежда").
const NOMINATIVE: Record<string, string> = {
  одежду: "одежда", еду: "еда", аренду: "аренда", коммуналку: "коммуналка", квартплату: "квартплата", страховку: "страховка",
  ипотеку: "ипотека", подписку: "подписка", технику: "техника", косметику: "косметика", книгу: "книга", игрушку: "игрушка",
  машину: "машина", поездку: "поездка", учёбу: "учёба", учебу: "учёба", доставку: "доставка", парковку: "парковка",
  стрижку: "стрижка", шаурму: "шаурма", пиццу: "пицца", куртку: "куртка", обувь: "обувь", рубашку: "рубашка", сумку: "сумка",
  химчистку: "химчистка", медицину: "медицина", аптеку: "аптека", зарплату: "зарплата", премию: "премия", кредитку: "кредитка",
};
export function toNominative(s: string): string {
  return s.replace(/[а-яё]+/gi, (w) => {
    const n = NOMINATIVE[w.toLowerCase()];
    if (!n) return w;
    return w[0] === w[0].toUpperCase() ? n[0].toUpperCase() + n.slice(1) : n;
  });
}

function cleanItem(s: string): string {
  return s.replace(/\s+(сейчас|сегодня|завтра)$/, "").replace(/^(себе|бы)\s+/, "").replace(/[?!.,]+$/, "").trim();
}

/** Возвращает исходное написание фрагмента ("iPhone 15", а не "iphone 15"). */
function restoreCase(original: string, item: string): string {
  if (!item) return item;
  const i = norm(original).indexOf(item);
  return i >= 0 ? original.slice(i, i + item.length) : item;
}

export function parseIntentRegex(text: string): PurchaseIntent {
  const r = parseIntentRegexLower(text);
  return r.item ? { ...r, item: toNominative(restoreCase(text.trim(), r.item)) } : r;
}

function parseIntentRegexLower(text: string): PurchaseIntent {
  const low = norm(text.trim());
  const a = parseAmountDetailed(low);
  const price = a.minor;
  const extra = { ambiguous: a.ambiguous || undefined, error: a.error };
  const base = (o: PurchaseIntent): PurchaseIntent => {
    const r: PurchaseIntent = { ...o };
    if (price != null && (o.intent === "purchase" || o.intent === "expense" || o.intent === "income" || o.intent === "amount_only")) { r.priceMinor = price; r.price = Number(price) / 100; }
    if (extra.ambiguous) r.ambiguous = true;
    if (extra.error) r.error = extra.error;
    return r;
  };
  if (EXPENSE_RE.test(low) && (price != null || a.negative)) {
    let item = "";
    const m1 = low.match(/(?:на|за)\s+([^\d?!.,]+?)\s*(?:$|[?!.,])/);
    const m2 = low.match(/(?:купил[а]?|оплатил[а]?|заплатил[а]?)\s+(?:за\s+)?([^\d?!.,]+?)\s+(?:за\s+|на\s+)?\d/);
    if (m2) item = m2[1];
    else if (m1) item = m1[1];
    return base({ intent: "expense", item: cleanItem(item) || "расход" });
  }
  if (INCOME_RE.test(low) && !PURCHASE_RE.test(low)) {
    const m = low.match(/(зарплат[а-я]*|аванс[а-я]*|преми[а-я]*|гонорар[а-я]*|кэшбэк[а-я]*|возврат[а-я]*)/);
    return base({ intent: "income", item: m ? m[1] : "доход" });
  }
  if (PURCHASE_RE.test(low)) {
    let item = "";
    const m = low.match(/(?:купить|куплю|взять|возьму|заказать|позволить себе|позволить)\s+(.+?)\s+(?:за|по|стоимостью|ценой)\s+-?\d/);
    if (m) item = m[1];
    else { const m2 = low.match(/(?:купить|куплю|взять|возьму|заказать|позволить себе)\s+([^?!,.]+?)(?:\s+-?\d[\d\s]*(?:к|k|тыс[а-я]*|₽|руб[а-я]*)?\s*$|\s*[?!,.]|$)/); if (m2) item = m2[1]; }
    item = cleanItem(item);
    if (price != null || a.negative) return base({ intent: "purchase", item: item || "покупка" });
    if (item) return { intent: "purchase", item };
  }
  if (/(сколько|свободн|в день|на день|остал|баланс|ситуац|прогноз)/.test(low)) return { intent: "snapshot" };
  // Только сумма ("15 тысяч") — ответ на уточняющий вопрос о цене.
  if ((price != null || a.negative) && /^[\s\d.,]*(?:тыс[а-я]*\.?|т\.?\s?р\.?|к|k|млн|₽|руб[а-я]*\.?|р\.?)?[\s.!]*$/.test(low.replace(/(?:примерно|около|где-то|ну|стоит|за)\s*/g, ""))) {
    return base({ intent: "amount_only" });
  }
  return { intent: "other" };
}

export interface LineError { line: number; text: string; reason: string }
export interface ParsedPayment { name: string; amountMinor: Minor; date: ISODate }

/** Платежи построчно. Любая нераспознанная строка возвращается как ошибка: частичного сохранения нет. */
export function parsePaymentLines(text: string, today: ISODate): { items: ParsedPayment[]; errors: LineError[] } {
  if (/^\s*(нет|-)\s*$/i.test(text)) return { items: [], errors: [] };
  const items: ParsedPayment[] = [];
  const errors: LineError[] = [];
  text.split(/\n|;/).forEach((line, i) => {
    if (!line.trim()) return;
    const date = parseDate(line, today);
    const a = parseAmountDetailed(line);
    const name = line.replace(/[-−]?\s*\d.*$/, "").trim() || "Платёж";
    if (!date) errors.push({ line: i + 1, text: line.trim(), reason: "не понял дату" });
    else if (a.negative) errors.push({ line: i + 1, text: line.trim(), reason: "сумма не может быть отрицательной" });
    else if (a.minor == null || a.minor <= 0n) errors.push({ line: i + 1, text: line.trim(), reason: "не понял сумму" });
    else items.push({ name, amountMinor: a.minor, date });
  });
  return { items, errors };
}

/** Совместимость со старым API: рубли; бросает ошибку при нераспознанных строках. */
export function parsePaymentsText(text: string, today: ISODate): { name: string; amount: number; date: ISODate }[] {
  const r = parsePaymentLines(text, today);
  if (r.errors.length) throw new Error(r.errors.map((e) => `строка ${e.line}: ${e.reason}`).join("; "));
  return r.items.map((p) => ({ name: p.name, amount: Number(p.amountMinor) / 100, date: p.date }));
}
