// Сроки хранения служебных и персональных данных (152-ФЗ / GDPR: минимизация).
// Запускается cron-ом (/api/cron/cleanup) и изредка оппортунистически (lib/rate-limit.ts).
import { getDb } from "./db";

export const RETENTION = {
  sessionsAfterExpiryDays: 30,
  authChallengesDays: 2,
  inboxProcessedDays: 14,
  inboxFailedDays: 7,
  idempotencyAfterExpiryDays: 1,
  conversationStateDays: 30,
  proposalsClosedDays: 90,
  /** Вопросы покупок хранятся только при users.history_enabled; без него — 30 дней. */
  decisionsNoHistoryDays: 30,
  decisionsHistoryDays: 365,
};

const ago = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);

export async function runRetention(now = new Date()): Promise<Record<string, number>> {
  const db = await getDb();
  const R = RETENTION;
  const run = async (sql: string, params: unknown[]) => { const r = await db.query(sql, params) as { rowCount?: number | null; affectedRows?: number }; return r.rowCount ?? r.affectedRows ?? 0; };
  return {
    sessions: await run("DELETE FROM sessions WHERE expires_at < $1 OR revoked_at < $1", [ago(now, R.sessionsAfterExpiryDays)]),
    authChallenges: await run("DELETE FROM auth_challenges WHERE created_at < $1", [ago(now, R.authChallengesDays)]),
    inbox: await run("DELETE FROM inbox WHERE (processed_at IS NOT NULL AND processed_at < $1) OR (processed_at IS NULL AND received_at < $2)", [ago(now, R.inboxProcessedDays), ago(now, R.inboxFailedDays)]),
    idempotencyKeys: await run("DELETE FROM idempotency_keys WHERE expires_at < $1", [ago(now, R.idempotencyAfterExpiryDays)]),
    conversationState: await run("DELETE FROM conversation_state WHERE updated_at < $1", [ago(now, R.conversationStateDays)]),
    proposals: await run("DELETE FROM proposals WHERE status <> 'pending' AND created_at < $1", [ago(now, R.proposalsClosedDays)]),
    decisions: await run(
      `DELETE FROM decisions d USING users u WHERE u.id = d.user_id AND
         ((NOT u.history_enabled AND d.created_at < $1) OR d.created_at < $2)`, [ago(now, R.decisionsNoHistoryDays), ago(now, R.decisionsHistoryDays)]),
    rateLimits: await run("DELETE FROM rate_limits WHERE window_start < $1", [ago(now, 2)]),
  };
}
