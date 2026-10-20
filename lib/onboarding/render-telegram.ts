// Рендер сообщения онбординга для Telegram: HTML-текст (< 4096) и inline-клавиатура (callback_data ≤ 64 байт).
import { InlineKeyboard } from "grammy";
import type { AssistantMessage, Card } from "./protocol";

// Длину ограничиваем ДО экранирования: обрезка готового HTML могла бы разорвать тег или entity.
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const esc = (s: string, n = 1500) => clip(s, n).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** callback_data: o:<первые 8 символов id сообщения>:<номер варианта>. */
export const callbackData = (m: AssistantMessage, i: number) => `o:${m.id.slice(0, 8)}:${i}`;
export const CALLBACK_RE = /^o:([0-9a-f]{8}):(\d{1,2})$/i;

function cardText(c: Card): string {
  if (c.type === "preview") {
    const head = `<b>${esc(c.data.title)}: ${esc(c.data.amount)}</b>${c.preliminary ? " <i>(предварительно)</i>" : ""}\n${esc(c.data.sub)}`;
    return head + (c.caveats?.length ? `\n<i>${esc(c.caveats.join(", "))}</i>` : "");
  }
  return "<b>Вот что я понял</b>\n" + c.data.rows.map((r) => `• ${esc(r.label, 60)}: ${r.missing ? `<i>${esc(r.value, 400)}</i>` : esc(r.value, 400)}`).join("\n");
}

export function renderTelegram(m: AssistantMessage): { text: string; keyboard: InlineKeyboard | null } {
  const cards = m.cards.map(cardText).join("\n\n");
  let text = (m.lead ? esc(m.lead) + "\n\n" : "") + (cards ? cards + "\n\n" : "") + esc(m.text);
  if (text.length > 4096) text = (m.lead ? esc(m.lead, 800) + "\n\n" : "") + esc(m.text, 1500); // карточки слишком длинные — без них, разметка цела
  if (!m.choices.length) return { text, keyboard: null };
  const kb = new InlineKeyboard();
  const stack = m.choiceLayout === "stack" || m.choices.length > 3;
  m.choices.forEach((c, i) => { kb.text(c.label, callbackData(m, i)); if (stack) kb.row(); });
  return { text, keyboard: kb };
}
