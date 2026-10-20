// Чистые форматтеры для подсказок интерактивных графиков (без ECharts — тестируются в node).
import type { Fmt, Sig } from "./live-spec";

const NB = "\u00a0", NNB = "\u202f";
const int = (v: number) => Math.round(v).toLocaleString("ru-RU");

/** Разница «сейчас − прошлый период» для подсказки: % для счётчиков, п.п. для долей; «шум», если вне значимости. */
export function deltaText(cur: number | null, prev: number | null, f: Fmt, sig?: Sig): { text: string; tone: "up" | "down" | "neutral" | "flat" | "noise" | "na" } {
  if (cur == null) return { text: "нет данных за этот период", tone: "na" };
  if (prev == null) return { text: "нет данных за прошлый период", tone: "na" };
  const d = cur - prev;
  if (d === 0) return { text: sig === "few" ? "без изменений · мало данных" : "без изменений", tone: "flat" };
  const sign = d > 0 ? "+" : "−", a = Math.abs(d);
  const body = f === "pct" ? `${sign}${(a * 100).toFixed(1).replace(".", ",")}${NB}п.п.` : prev > 0 ? `${sign}${Math.round((a / prev) * 100)}${NNB}%` : `${sign}${int(a)}`;
  if (sig === false) return { text: `≈${NB}${body} · шум`, tone: "noise" };
  if (sig === "few") return { text: `${body} · мало данных`, tone: "noise" };
  // Цвет «хорошо/плохо» — только если разница проверена на шум; без проверки (WAU, вопросы) — нейтральный.
  const tone = sig === true ? (d > 0 ? "up" : "down") : "neutral";
  return { text: `${d > 0 ? "▲" : "▼"}${NB}${body}`, tone };
}

/** Дата того же дня прошлого периода: сдвиг на длину периода (UTC). */
export const prevDayOf = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** Выравнивание прошлого периода по ожидаемой дате, а не по индексу: пропуск дня даёт null и не сдвигает соседей; 0 остаётся 0. */
export function alignPrev<T extends { day: string }>(cur: readonly { day: string }[], prev: readonly T[], days: number, get: (p: T) => number): (number | null)[] {
  const by = new Map(prev.map((p) => [p.day, p]));
  return cur.map((c) => { const p = by.get(prevDayOf(c.day, days)); return p ? get(p) : null; });
}
