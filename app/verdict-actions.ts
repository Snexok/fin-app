// Когда под ответом «Можно?» показывать демо-строку действий («✓ Купил», «Почему так? ✦», «Поделиться»).
// Правило демо: если у ответа есть «умный сценарий» (прогноз/рекомендация движка именно для этой покупки) —
// показываем его, без кнопок. Если такого нет — запасной вариант: демо-кнопки, чтобы сразу было видно, что умеет продукт.
// Чистые функции без React — покрыты тестами (tests/verdict-actions.test.ts).

/** Умный сценарий ответа. kind — что сработало; line — строка ответа движка, которую подсвечиваем (если нашлась). */
export type SmartSuggestion = { kind: "wait_for_income" | "cash_gap"; line: string | null };

type ImpactLike = {
  verdict?: string;
  waitIsBetter?: boolean;
  cashGap?: boolean;
  scenarios?: { afterIncome?: unknown | null } | null;
} | null | undefined;

/**
 * Прогноз/рекомендация из расчёта движка (те же поля impact, что приходят с /api/chat):
 *  • wait_for_income — движок считает, что после ближайшего дохода покупка заметно безопаснее (waitIsBetter и есть сценарий afterIncome):
 *    в ответе строка «Если подождать до дохода <дата>: …»;
 *  • cash_gap — покупка сейчас приводит к нехватке на обязательные траты (cashGap): строка «…с <даты> может не хватать…».
 * Остальное («можно», «аккуратно», «задела бы резерв» без лучшей даты) — без умного сценария → null.
 */
export function smartSuggestionFor(impact: ImpactLike, text = ""): SmartSuggestion | null {
  if (!impact?.verdict) return null;
  const lines = text.split("\n").filter(Boolean);
  if (impact.waitIsBetter && impact.scenarios?.afterIncome) {
    return { kind: "wait_for_income", line: lines.find((l) => l.startsWith("Если подождать до дохода")) ?? null };
  }
  if (impact.cashGap) {
    return { kind: "cash_gap", line: lines.find((l) => /может не хватать/.test(l)) ?? null };
  }
  return null;
}

type MsgLike = { me?: boolean; impact?: ImpactLike; proposal?: unknown; smartSuggestion?: SmartSuggestion | null };

/** Демо-строка действий: только под ответом-вердиктом без карточки записи и без умного сценария. */
export function shouldShowVerdictActions(m: MsgLike): boolean {
  return !m.me && !!m.impact?.verdict && !m.proposal && !m.smartSuggestion;
}
