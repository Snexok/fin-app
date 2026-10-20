// Протокол сообщений онбординг-чата: один для web и Telegram. Карточки содержат только данные движка/сессии.
import type { Channel } from "../conversation";

export type SlotKey = "balance" | "income" | "planningDays" | "payments" | "reserve" | "essentialDaily" | "goal";
export const SLOT_KEYS: SlotKey[] = ["balance", "income", "planningDays", "payments", "reserve", "essentialDaily", "goal"];
export type Confidence = "exact" | "approximate" | "ambiguous";

export type ChoiceAction =
  | { type: "setFact"; slot: SlotKey; value: "unknown" | "none" | "skip" | "irregular" | "want" | string }
  | { type: "control"; name: "start" | "done" | "resume" | "restart" | "edit" | "later"; slot?: SlotKey };

export interface Choice { id: string; label: string; userText: string; action?: ChoiceAction }

export interface PreviewCardData { title: string; amount: string; sub: string; horizonEnd: string }
export interface SummaryRow { slot: SlotKey; label: string; value: string; missing: boolean }
export type Card =
  | { type: "preview"; data: PreviewCardData; preliminary?: boolean; caveats?: string[] }
  | { type: "summary"; data: { rows: SummaryRow[] }; preliminary?: boolean; caveats?: string[] };

export interface AssistantMessage {
  schemaVersion: 1;
  id: string;
  role: "assistant";
  /** Подтверждение понятого («Понял: 45 000 ₽») — показывается до карточек. */
  lead?: string;
  /** Вопрос или основной текст — после карточек. */
  text: string;
  cards: Card[];
  choices: Choice[];
  choiceLayout?: "row" | "stack";
  /** Ревизия сессии, к которой относятся варианты: устаревший выбор отклоняется мягко. */
  revision: number;
  /** Подсказка для поля ввода («Например: 45 000»). */
  placeholder?: string;
  createdAt: string;
}

export interface UserMessage { schemaVersion: 1; id: string; role: "user"; text: string; via: "text" | "choice"; channel: Channel; createdAt: string }
export type ChatMessage = AssistantMessage | UserMessage;

export interface UserTurn {
  clientMessageId: string;
  text: string;
  selection?: { assistantMessageId: string; choiceId: string; revision: number };
}
