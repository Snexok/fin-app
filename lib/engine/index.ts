// Детерминированный финансовый модуль "Можно?". Только чистые функции. LLM здесь ничего не считает.
export * from "./money";
export * from "./dates";
export * from "./types";
export * from "./forecast";
export * from "./purchase";
export * from "./legacy";
import { formatRub, rublesToMinor } from "./money";

/** Совместимость: форматирование суммы в рублях (number). Новый код использует formatRub(minor). */
export const rub = (n: number) => formatRub(rublesToMinor(Math.round(n * 100) / 100));
