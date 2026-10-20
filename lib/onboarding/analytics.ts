// События онбординга выводятся из разницы состояний сессии до и после хода — одинаково для web и Telegram.
// В событие попадают только шаг (слот), исход и способ ввода; значения фактов не читаются.
import { attemptToken, durationBucket, track, ONBOARDING_STEPS, type Channel } from "../analytics";
import type { OnboardingSession } from "./session";

type Input = "text" | "choice";
const isEmptyValue = (f: unknown) => { const v = (f as { value?: unknown }).value; return Array.isArray(v) && v.length === 0; };

export async function trackOnboardingStart(userId: string, s: OnboardingSession, channel: Channel, now: Date) {
  await track(userId, "onboarding_started", { mode: s.mode }, { channel, attempt: attemptToken(userId, s.startedAt), key: `${s.startedAt}:started`, now });
  await trackShown(userId, s, channel, now);
}

async function trackShown(userId: string, s: OnboardingSession, channel: Channel, now: Date) {
  const slot = s.lastQuestion?.slot;
  if (!slot || s.phase !== "collecting") return;
  const attempt = attemptToken(userId, s.startedAt);
  await track(userId, "onboarding_step_shown", { step: slot }, { channel, attempt, key: `${attempt}:${slot}:shown`, now });
}

export async function trackOnboardingTurn(userId: string, before: OnboardingSession, after: OnboardingSession,
  out: { cards: { type: string; preliminary?: boolean }[] }, channel: Channel, input: Input, now: Date, notUnderstood: string | null) {
  const attempt = attemptToken(userId, after.startedAt);
  const base = { channel, attempt, now };
  for (const step of ONBOARDING_STEPS) {
    const b = before.facts[step] as { status: string; updatedAt?: string };
    const a = after.facts[step] as { status: string; updatedAt?: string };
    if (a.status === "missing") continue; // сброс для правки — не ответ
    if (b.status === a.status && (a.status !== "confirmed" || b.updatedAt === a.updatedAt)) continue;
    const correction = b.status !== "missing" || after.mode === "edit" || after.previous?.[step] !== undefined;
    if (correction) { await track(userId, "onboarding_corrected", { step, input }, { ...base, key: `${attempt}:${step}:corr:${after.lastAssistantId ?? now.getTime()}` }); continue; }
    const key = `${attempt}:${step}:resolved`; // один исход шага на проход
    if (a.status === "confirmed") await track(userId, "onboarding_step_answered", { step, input, answer_kind: isEmptyValue(a) ? "none" : "value" }, { ...base, key });
    else if (a.status === "unknown") await track(userId, "onboarding_step_unknown", { step, input }, { ...base, key });
    else if (a.status === "skipped") await track(userId, "onboarding_step_skipped", { step, input }, { ...base, key });
  }
  if (notUnderstood) {
    const step = (ONBOARDING_STEPS as readonly string[]).includes(notUnderstood) ? (notUnderstood as (typeof ONBOARDING_STEPS)[number]) : "summary";
    await track(userId, "onboarding_not_understood", { step, input }, { ...base, key: `${attempt}:nu:${after.lastAssistantId ?? now.getTime()}` });
  }
  await trackShown(userId, after, channel, now);
  for (const c of out.cards) {
    if (c.type !== "preview") continue;
    const preliminary = c.preliminary ? "true" : "false";
    await track(userId, "onboarding_preview_shown", { preliminary }, { ...base, key: `${attempt}:preview:${preliminary}` });
  }
  if (after.mode === "initial" && before.phase !== "done" && after.phase === "done") {
    await track(userId, "onboarding_completed", { mode: "initial", duration: durationBucket(now.getTime() - Date.parse(after.startedAt)) }, { ...base, key: `${attempt}:completed` });
  }
}
