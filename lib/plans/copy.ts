// Тексты про тарифы для бота (веб рисует то же в app/plus.tsx). Тон: спокойно, без давления; денег на этапе 1 не берём.
import type { PlanState, TokenSummary } from "./index";

const plural = (n: number, one: string, few: string, many: string) => { const m = n % 100, k = n % 10; return m >= 11 && m <= 14 ? many : k === 1 ? one : k >= 2 && k <= 4 ? few : many; };
export const answersWord = (n: number) => plural(n, "AI-ответ", "AI-ответа", "AI-ответов");
const ruDate = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long" });
const rub = (n: number) => `${n.toLocaleString("ru-RU").replace(/\s/g, "\u00a0")}\u00a0₽`;

/** «осталось 12 из 15 на сегодня (обновятся завтра в 00:00 по Москве)». */
export function tokensLine(t: TokenSummary): string {
  if (t.left == null) return "AI-ответы: без ограничений.";
  const per = t.scope === "day" ? "на сегодня" : "на 30 дней";
  if (t.exhausted) return `AI-ответы ${per} закончились. Новые — ${t.resetLabel}${t.scope === "day" ? " по Москве" : ""}. Расчёты и «Можно?» работают как обычно.`;
  return `AI-ответы: осталось ${t.left} из ${t.limit} ${per}.`;
}

export function plusText(p: PlanState): string {
  const q = p.quotas, beta = p.mode === "beta";
  const lines = ["✦ Плюс в «Можно?»", ""];
  if (beta) lines.push(`Сейчас бета: всё бесплатно, у всех одинаковый «Бета-Плюс»${p.betaEndsAt ? ` до ${ruDate.format(new Date(`${p.betaEndsAt}T12:00:00+03:00`))}` : ""}. Денег не берём.`);
  else lines.push(p.plan === "plus" ? `Ваш тариф: Плюс${p.endsAt ? ` до ${ruDate.format(new Date(p.endsAt))}` : ""}.` : "Ваш тариф: бесплатный.");
  if (beta && p.plusUntil) lines.push(`После беты у вас будет Плюс до ${ruDate.format(new Date(p.plusUntil))} — спасибо, что позвали друзей.`);
  lines.push(tokensLine(p.tokens), "");
  lines.push("Бесплатно всегда:", "• вопросы «Можно?» — без лимита; сколько можно тратить в день", "• предупреждение, если до дохода может не хватить; записи трат и доходов, напоминания", "• объяснения по шаблону с теми же цифрами", "");
  lines.push(`В Плюсе${beta ? " (после беты)" : ""}:`,
    `• AI-объяснения «почему», сравнения вариантов, обсуждение цели — ${q.plus.perWindow} ${answersWord(q.plus.perWindow)} на 30 дней (до ${q.plus.perDay} в день)`,
    "• недельный и месячный AI-разбор", `• голос — ${q.plus.voiceMin} мин на 30 дней`, "");
  lines.push(`Бесплатно${beta ? " после беты" : ""}: ${q.free.perWindow} ${answersWord(q.free.perWindow)} на 30 дней (до ${q.free.perDay} в день), голос ${q.free.voiceMin} мин.`);
  lines.push(`Плюс${beta ? " после беты" : ""}: ${rub(p.prices.plusRub)} за ${p.prices.periodDays} дней, без автопродления.`, "");
  lines.push(p.interest ? "Ваша заявка на Плюс уже у нас — спасибо! Выбор цены можно поменять." : "Хотите Плюс, когда он появится? «Хочу Плюс» — это просто заявка: ничего не списываем, карта не нужна.");
  return lines.join("\n");
}

export function interestThanks(price: number | null): string {
  return [
    "Спасибо, записали! 💚",
    price ? `Ваша честная цена: ${rub(price)} за 30 дней. Это очень помогает нам не ошибиться.` : "Цену можно выбрать позже — это необязательно.",
    "Ничего не списываем и карту не просим. Пока идёт бета, всё и так бесплатно — сообщим, когда Плюс появится.",
  ].join("\n");
}
