// Календарные даты (YYYY-MM-DD) без времени и зоны; "сегодня" определяется в зоне пользователя.
export type ISODate = string;
export const DEFAULT_TZ = "Europe/Moscow";

export class DateError extends Error { code = "INVALID_DATE"; }

const RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeap(y: number) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
export function daysInMonth(y: number, m: number) { return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }

export function isValidDate(s: unknown): s is ISODate {
  if (typeof s !== "string") return false;
  const m = s.match(RE);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  return y >= 1970 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function assertDate(s: unknown, field = "date"): ISODate {
  if (!isValidDate(s)) throw new DateError(`${field}: некорректная дата ${String(s)}`);
  return s;
}

export function makeDate(y: number, m: number, d: number): ISODate | null {
  const s = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isValidDate(s) ? s : null;
}

const toEpochDay = (s: ISODate) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86_400_000;
const fromEpochDay = (n: number): ISODate => new Date(n * 86_400_000).toISOString().slice(0, 10);

export function addDays(d: ISODate, n: number): ISODate { return fromEpochDay(toEpochDay(assertDate(d)) + n); }
/** b - a в календарных днях. */
export function diffDays(a: ISODate, b: ISODate): number { return toEpochDay(assertDate(b)) - toEpochDay(assertDate(a)); }
export const daysBetween = diffDays;

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** Локальная дата пользователя для момента now. */
export function localDate(now: Date, tz = DEFAULT_TZ): ISODate {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Совместимость: раньше бралась дата UTC. Теперь — дата в зоне пользователя (по умолчанию Москва). */
export function todayISO(now = new Date(), tz = DEFAULT_TZ): ISODate { return localDate(now, tz); }

/** Месячное повторение: день якоря, при коротком месяце — последний день. Следующий месяц снова от якоря. */
function assertEveryN(n: number) { if (!Number.isInteger(n) || n < 1 || n > 52) throw new RangeError("everyN должен быть целым от 1 до 52"); }

export function monthlyDates(anchor: ISODate, from: ISODate, to: ISODate, everyN = 1): ISODate[] {
  assertDate(anchor); assertDate(from); assertDate(to); assertEveryN(everyN);
  const ay = +anchor.slice(0, 4), am = +anchor.slice(5, 7), ad = +anchor.slice(8, 10);
  const out: ISODate[] = [];
  for (let i = 0; i < 12 * 50; i += everyN) {
    const idx = am - 1 + i;
    const y = ay + Math.floor(idx / 12), m = (idx % 12) + 1;
    const d = makeDate(y, m, Math.min(ad, daysInMonth(y, m)))!;
    if (d > to) break;
    if (d >= from) out.push(d);
  }
  return out;
}

export function weeklyDates(anchor: ISODate, from: ISODate, to: ISODate, everyN = 1): ISODate[] {
  assertDate(anchor); assertDate(from); assertDate(to); assertEveryN(everyN);
  const out: ISODate[] = [];
  for (let d = anchor; d <= to; d = addDays(d, 7 * everyN)) if (d >= from) out.push(d);
  return out;
}
