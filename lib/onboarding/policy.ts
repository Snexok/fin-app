// Выбор следующего вопроса. Сейчас — детерминированные правила; LLM-политика позже реализует тот же интерфейс.
import type { ISODate } from "../engine";
import type { SlotKey } from "./protocol";
import type { OnboardingSession } from "./session";
import { isResolved } from "./slots";

export type ChoiceTemplateId =
  | "start" | "income_irregular" | "unknown" | "days_14" | "days_30" | "payments_none" | "payments_unknown"
  | "reserve_none" | "reserve_10k" | "daily_500" | "daily_1000" | "goal_want" | "goal_none" | "skip";

export type QuestionDecision =
  | { kind: "ask"; slot: SlotKey; templateId: string; choices: ChoiceTemplateId[] }
  | { kind: "clarify"; slot: SlotKey; reason: "ambiguous" | "partial" | "out_of_window"; choices: ChoiceTemplateId[] }
  | { kind: "preview" }
  | { kind: "summary" }
  | { kind: "done" };

export interface PolicyContext { today: ISODate }

export interface QuestionPolicy {
  id: string;
  nextQuestion(s: OnboardingSession, ctx: PolicyContext): Promise<QuestionDecision>;
}

const OPTIONAL: SlotKey[] = ["payments", "reserve", "essentialDaily", "goal"];
const ORDER: SlotKey[] = ["balance", "income", "planningDays", "payments", "reserve", "essentialDaily", "goal"];

const CHOICES: Record<SlotKey, ChoiceTemplateId[]> = {
  balance: [],
  income: ["income_irregular", "unknown"],
  planningDays: ["days_14", "days_30"],
  payments: ["payments_none", "payments_unknown"],
  reserve: ["reserve_none", "reserve_10k", "unknown"],
  essentialDaily: ["daily_500", "daily_1000", "unknown"],
  goal: ["goal_want", "goal_none"],
};

/** Нужен ли слот сейчас (planningDays — только если ближайший доход не указан). */
export function slotNeeded(s: OnboardingSession, slot: SlotKey): boolean {
  if (slot === "planningDays") return s.facts.income.status === "unknown" || s.facts.income.status === "skipped";
  return true;
}

/** Минимум для предварительного расчёта: остаток + (доход или период). */
export function minimumReady(s: OnboardingSession): boolean {
  const f = s.facts;
  return f.balance.status === "confirmed" && (f.income.status === "confirmed" || f.planningDays.status === "confirmed");
}

export class RulePolicy implements QuestionPolicy {
  id = "rules-v1";
  async nextQuestion(s: OnboardingSession, _ctx: PolicyContext): Promise<QuestionDecision> {
    void _ctx;
    if (s.phase === "done") return { kind: "done" };
    const withSkip = (slot: SlotKey, base: ChoiceTemplateId[]) => {
      const askCount = s.facts[slot].askCount;
      const c = askCount >= 2 && OPTIONAL.includes(slot) && !base.includes("skip") ? [...base, "skip" as const] : base;
      return c.slice(0, 4);
    };
    // Незавершённый ответ (сумма без даты и т. п.) уточняем точечно.
    if (s.pending) return { kind: "clarify", slot: s.pending.slot, reason: "partial", choices: withSkip(s.pending.slot, s.pending.slot === "goal" ? ["goal_none"] : s.pending.slot === "payments" ? ["skip"] : []) };
    // Исправление одного слота (из итога или «Изменить» на главной).
    if (s.editSlot) {
      if (!isResolved(s.facts[s.editSlot])) return { kind: "ask", slot: s.editSlot, templateId: `${s.editSlot}.edit`, choices: withSkip(s.editSlot, CHOICES[s.editSlot]) };
      if (s.editSlot === "income" && slotNeeded(s, "planningDays") && !isResolved(s.facts.planningDays)) return { kind: "ask", slot: "planningDays", templateId: "planningDays.ask", choices: CHOICES.planningDays };
      return { kind: "summary" };
    }
    if (s.mode === "edit") return { kind: "summary" };
    for (const slot of ORDER) {
      if (!slotNeeded(s, slot)) continue;
      const f = s.facts[slot];
      const ambiguous = (f.status === "candidate" || f.status === "confirmed") && f.confidence === "ambiguous";
      // Остаток и период обязательны: «не знаю» их не закрывает.
      const required = (slot === "balance" || slot === "planningDays") && f.status !== "confirmed";
      if (f.status === "missing" || ambiguous || required) {
        if (!OPTIONAL.includes(slot) || s.planSaved || !minimumReady(s)) return { kind: "ask", slot, templateId: `${slot}.ask`, choices: withSkip(slot, CHOICES[slot]) };
        break;
      }
    }
    if (!s.planSaved && minimumReady(s)) return { kind: "preview" };
    for (const slot of ORDER) {
      if (slotNeeded(s, slot) && s.facts[slot].status === "missing") return { kind: "ask", slot, templateId: `${slot}.ask`, choices: withSkip(slot, CHOICES[slot]) };
    }
    return { kind: "summary" };
  }
}

/**
 * Заготовка LLM-политики (не подключена). Контракт: модель предлагает только slot/templateId из схемы,
 * числа не считает; любой сбой/таймаут/невалидный ответ → fallback (RulePolicy).
 */
export interface LlmPolicyDeps {
  selectQuestion(input: { slots: Record<SlotKey, string>; lastTurns: string[] }): Promise<{ slot: SlotKey; templateId: string } | null>;
}
export class LlmPolicy implements QuestionPolicy {
  id = "llm-v0-stub";
  constructor(private deps: LlmPolicyDeps, private fallback: QuestionPolicy = new RulePolicy()) {}
  async nextQuestion(s: OnboardingSession, ctx: PolicyContext): Promise<QuestionDecision> {
    const rules = await this.fallback.nextQuestion(s, ctx);
    if (rules.kind !== "ask") return rules;
    try {
      const pick = await this.deps.selectQuestion({ slots: Object.fromEntries(ORDER.map((k) => [k, s.facts[k].status])) as Record<SlotKey, string>, lastTurns: [] });
      if (!pick || !ORDER.includes(pick.slot) || s.facts[pick.slot].status !== "missing" || !slotNeeded(s, pick.slot)) return rules;
      return { kind: "ask", slot: pick.slot, templateId: `${pick.slot}.ask`, choices: CHOICES[pick.slot] };
    } catch { return rules; }
  }
}
