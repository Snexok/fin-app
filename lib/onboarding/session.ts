// Хранение сессии онбординга (одна на пользователя, общая для web и Telegram) и ленты сообщений.
import { getDb, type Queryable } from "../db";
import type { Channel } from "../conversation";
import { uuid } from "../util";
import type { AssistantMessage, ChatMessage, SlotKey } from "./protocol";
import { emptyFacts, type Facts, type PaymentValue } from "./slots";

export interface OnboardingSession {
  schemaVersion: 1;
  userId: string;
  revision: number;
  baseFinanceVersion: string | null;
  mode: "initial" | "update" | "edit";
  editSlot?: SlotKey;
  facts: Facts;
  phase: "intro" | "collecting" | "summary" | "done" | "paused";
  planSaved: boolean;
  lastQuestion?: { slot: SlotKey | null; messageId: string; templateId: string };
  /** Последнее сообщение ассистента: только его варианты активны. */
  lastAssistantId?: string;
  /** Незавершённый ответ: сумма без даты дохода, платёж без даты, цель без суммы/даты. */
  pending?: { slot: "income"; amountMinor?: string; date?: string } | { slot: "payments"; name: string; amountMinor: string } | { slot: "goal"; name?: string; amountMinor?: string; date?: string };
  /** Платежи, уже добавленные этим диалогом (для исправления без дублей). */
  paymentIds?: string[];
  /** Плановый доход, заданный этим диалогом (заменяется только он). */
  incomeIds?: string[];
  /** Аренда хода: пока ход обрабатывается (финансовые записи), параллельный ход получает мягкий отказ. */
  busyUntil?: string;
  /** Значение слота до исправления — для «Исправил: … (было …)». */
  previous?: Partial<Record<SlotKey, string>>;
  policyVersion: string;
  startedAt: string;
  updatedAt: string;
}

export function newSession(userId: string, mode: OnboardingSession["mode"], base: string | null, now: Date, policyVersion: string): OnboardingSession {
  return { schemaVersion: 1, userId, revision: 0, baseFinanceVersion: base, mode, facts: emptyFacts(), phase: "intro", planSaved: false, policyVersion, startedAt: now.toISOString(), updatedAt: now.toISOString() };
}

const parse = <T,>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;

export async function loadSession(userId: string, q?: Queryable): Promise<OnboardingSession | null> {
  const db = q ?? (await getDb());
  const r = await db.query<{ state: unknown; revision: number }>("SELECT state, revision FROM onboarding_session WHERE user_id=$1", [userId]);
  if (!r.rows[0]) return null;
  const s = parse<OnboardingSession>(r.rows[0].state);
  return { ...s, revision: Number(r.rows[0].revision) };
}

/** Compare-and-set: запись проходит, только если ревизия не изменилась (параллельные ходы web+Telegram). */
export async function casSession(next: OnboardingSession, expectedRevision: number | null, q?: Queryable): Promise<boolean> {
  const db = q ?? (await getDb());
  const state = JSON.stringify(next);
  if (expectedRevision == null) {
    const r = await db.query("INSERT INTO onboarding_session(user_id, state, revision, updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (user_id) DO NOTHING RETURNING user_id", [next.userId, state, next.revision]);
    return r.rows.length > 0;
  }
  const r = await db.query("UPDATE onboarding_session SET state=$2, revision=$3, updated_at=now() WHERE user_id=$1 AND revision=$4 RETURNING user_id", [next.userId, state, next.revision, expectedRevision]);
  return r.rows.length > 0;
}

/** Полный сброс (Начать заново): сессия и лента удаляются. */
export async function deleteSession(userId: string, q?: Queryable) {
  const db = q ?? (await getDb());
  await db.query("DELETE FROM onboarding_session WHERE user_id=$1", [userId]);
  await db.query("DELETE FROM onboarding_message WHERE user_id=$1", [userId]);
}

export async function insertMessage(userId: string, channel: Channel, m: ChatMessage, clientKey: string | null, q?: Queryable): Promise<boolean> {
  const db = q ?? (await getDb());
  const r = await db.query("INSERT INTO onboarding_message(id, user_id, channel, role, payload, client_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id",
    [m.id, userId, channel, m.role, JSON.stringify(m), clientKey]);
  return r.rows.length > 0;
}

export async function deleteMessage(userId: string, id: string) {
  const db = await getDb();
  await db.query("DELETE FROM onboarding_message WHERE user_id=$1 AND id=$2", [userId, id]);
}

export async function messageByClientKey(userId: string, clientKey: string): Promise<ChatMessage | null> {
  const db = await getDb();
  const r = await db.query<{ payload: unknown }>("SELECT payload FROM onboarding_message WHERE user_id=$1 AND client_key=$2", [userId, clientKey]);
  return r.rows[0] ? parse<ChatMessage>(r.rows[0].payload) : null;
}

export async function getMessage(userId: string, id: string): Promise<ChatMessage | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const db = await getDb();
  const r = await db.query<{ payload: unknown }>("SELECT payload FROM onboarding_message WHERE user_id=$1 AND id=$2", [userId, id]);
  return r.rows[0] ? parse<ChatMessage>(r.rows[0].payload) : null;
}

/** Сообщение ассистента по префиксу id (callback_data Telegram несёт 8 символов). */
export async function assistantByPrefix(userId: string, prefix: string): Promise<AssistantMessage | null> {
  if (!/^[0-9a-f]{8}$/i.test(prefix)) return null;
  const db = await getDb();
  const r = await db.query<{ payload: unknown }>("SELECT payload FROM onboarding_message WHERE user_id=$1 AND role='assistant' AND id::text LIKE $2 ORDER BY created_at DESC LIMIT 1", [userId, prefix.toLowerCase() + "%"]);
  return r.rows[0] ? parse<AssistantMessage>(r.rows[0].payload) : null;
}

export async function listMessages(userId: string, limit = 200): Promise<ChatMessage[]> {
  const db = await getDb();
  const r = await db.query<{ payload: unknown }>("SELECT payload FROM (SELECT payload, created_at FROM onboarding_message WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2) x ORDER BY created_at", [userId, limit]);
  return r.rows.map((x) => parse<ChatMessage>(x.payload));
}

export const newId = () => uuid();
export type { PaymentValue };
