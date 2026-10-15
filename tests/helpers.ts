import { createAnonymousSession, telegramUserId } from "../lib/auth";
import { savePlan, type PlanInput } from "../lib/finance-service";

export const NOW = new Date("2026-10-15T09:00:00Z"); // 12:00 МСК
export const rub = (n: number) => BigInt(Math.round(n * 100));

export const PLAN: PlanInput = {
  balanceMinor: rub(60000), reserveMinor: rub(10000), essentialDailyMinor: null,
  incomes: [{ name: "Зарплата", amountMinor: rub(80000), dueOn: "2026-10-25" }],
  payments: [{ name: "Аренда", amountMinor: rub(30000), dueOn: "2026-10-20" }],
  goal: null,
};

export async function webUser(plan: PlanInput | null = PLAN) {
  const s = await createAnonymousSession(NOW);
  if (plan) await savePlan(s.userId, plan, "form", NOW);
  return s;
}

let tg = 1000;
export async function tgUser(plan: PlanInput | null = PLAN) {
  const id = ++tg;
  const userId = (await telegramUserId(id))!;
  if (plan) await savePlan(userId, plan, "telegram", NOW);
  return { tgId: id, userId };
}
