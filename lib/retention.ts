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
  /** Лента онбординга: после «Готово» — 30 дней, брошенная — 90. */
  onboardingDoneDays: 30,
  onboardingAbandonedDays: 90,
  proposalsClosedDays: 90,
  /** Вопросы покупок хранятся только при users.history_enabled; без него — 30 дней. */
  decisionsNoHistoryDays: 30,
  decisionsHistoryDays: 365,
  /** Журнал напоминаний: 60 дней (дедуп/частота); «знакомство» — 180 (одно напоминание за всё время). */
  reminderLogDays: 60,
  reminderOnceDays: 180,
  /** Продуктовая аналитика (псевдонимные события): 180 дней. */
  analyticsEventsDays: 180,
  /** Журналы обращений и ошибок (псевдонимные): 180 дней, как аналитика. */
  serviceCallsDays: 180,
  serviceErrorsDays: 180,
  /** Журнал стоимости LLM (псевдонимный): 180 дней; дневные счётчики бюджета — 90 дней (накопительный не удаляется). */
  aiUsageDays: 180,
  budgetBucketsDays: 90,
  /** Счётчики и журнал AI-ответов (lib/plans): 90 дней — больше трёх 30-дневных окон квоты. */
  tokenBucketsDays: 90,
  tokenLedgerDays: 180,
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
    onboardingMessages: await run(
      `DELETE FROM onboarding_message m USING onboarding_session s WHERE s.user_id = m.user_id AND
         ((s.state->>'phase' = 'done' AND s.updated_at < $1) OR s.updated_at < $2)`, [ago(now, R.onboardingDoneDays), ago(now, R.onboardingAbandonedDays)]),
    onboardingSessions: await run("DELETE FROM onboarding_session WHERE (state->>'phase' = 'done' AND updated_at < $1) OR updated_at < $2", [ago(now, R.onboardingDoneDays), ago(now, R.onboardingAbandonedDays)]),
    analyticsEvents: await run("DELETE FROM analytics_events WHERE occurred_at < $1", [ago(now, R.analyticsEventsDays)]),
    serviceCalls: await run("DELETE FROM service_calls WHERE occurred_at < $1", [ago(now, R.serviceCallsDays)]),
    serviceErrors: await run("DELETE FROM service_errors WHERE occurred_at < $1", [ago(now, R.serviceErrorsDays)]),
    aiUsage: await run("DELETE FROM ai_usage WHERE created_at < $1", [ago(now, R.aiUsageDays)]),
    budgetBuckets: await run("DELETE FROM budget_buckets WHERE period_kind = 'day' AND period_start < $1::date", [ago(now, R.budgetBucketsDays).toISOString().slice(0, 10)]),
    tokenBuckets: await run("DELETE FROM ai_token_buckets WHERE period_start < $1::date", [ago(now, R.tokenBucketsDays).toISOString().slice(0, 10)]),
    tokenLedger: await run("DELETE FROM ai_token_ledger WHERE created_at < $1", [ago(now, R.tokenLedgerDays)]),
    proposals: await run("DELETE FROM proposals WHERE (status <> 'pending' AND created_at < $1) OR (status = 'pending' AND expires_at < $2)", [ago(now, R.proposalsClosedDays), ago(now, 7)]),
    decisions: await run(
      `DELETE FROM decisions d USING users u WHERE u.id = d.user_id AND
         ((NOT u.history_enabled AND d.created_at < $1) OR d.created_at < $2)`, [ago(now, R.decisionsNoHistoryDays), ago(now, R.decisionsHistoryDays)]),
    reminderLog: await run("DELETE FROM reminder_log WHERE (kind <> 'onboarding' AND created_at < $1) OR created_at < $2", [ago(now, R.reminderLogDays), ago(now, R.reminderOnceDays)]),
    rateLimits: await run("DELETE FROM rate_limits WHERE window_start < $1", [ago(now, 2)]),
  };
}
