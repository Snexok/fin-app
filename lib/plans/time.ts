// Окна квот по Москве (UTC+3 без перехода на летнее время с 2014 г.): день и 30-дневное окно тарифа.
import { budgetDay } from "../llm/config";

const DAY = 86_400_000;
export const moscowDay = (d: Date = new Date()): string => budgetDay(d);
const idx = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
const fromIdx = (i: number) => new Date(i * DAY).toISOString().slice(0, 10);
export const addDaysIso = (iso: string, n: number) => fromIdx(idx(iso) + n);
export const daysBetween = (a: string, b: string) => idx(b) - idx(a);
/** Полночь дня `iso` по Москве как момент времени. */
export const moscowMidnight = (iso: string) => new Date(`${iso}T00:00:00+03:00`);

/** Начало текущего окна: окна по `len` дней подряд от даты-якоря (начало тарифа или регистрации). */
export function windowStart(anchorDay: string, today: string, len = 30): string {
  const d = daysBetween(anchorDay, today);
  // Якорь в будущем (часы клиента/импорт) — окна просто продолжаются назад с тем же шагом.
  return addDaysIso(anchorDay, Math.floor(d / len) * len);
}

const ruTime = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long" });
/** «завтра в 00:00» / «20 ноября» — когда появятся новые AI-ответы. */
export function resetLabel(resetAt: Date, now: Date): string {
  const today = moscowDay(now), day = moscowDay(new Date(resetAt.getTime() - 1));
  if (moscowDay(resetAt) === addDaysIso(today, 1) && day === today) return "завтра в 00:00";
  return ruTime.format(resetAt);
}
