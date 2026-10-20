// Периоды Плюса (entitlements): выдача днями, награды за друзей (за флагом REFERRAL_REWARDS_ENABLED), слияние при /link.
// Платёжных веток нет: source='paid' здесь не создаётся (этап 1 Sber500).
import { getDb, type Queryable } from "../db";
import { referralConfig } from "../referrals";
import { addDaysIso, moscowMidnight } from "./time";
import { plansConfig } from "./config";

const DAY = 86_400_000;

export interface Grant { id: string; startsAt: Date; endsAt: Date }

/**
 * +N дней Плюса. Начало — позже из: сейчас, конец уже выданного Плюса (периоды складываются),
 * конец беты (PLANS_MODE=beta и задана BETA_ENDS_AT — иначе награда «сгорела» бы внутри общей беты).
 * Идемпотентно по referralRewardId / idempotencyKey: повтор возвращает null и ничего не продлевает.
 */
export async function grantPlusDays(o: { userId: string; days: number; source: "referral" | "manual"; referralRewardId?: string | null; idempotencyKey?: string | null; note?: string | null; now?: Date; q?: Queryable }): Promise<Grant | null> {
  const now = o.now ?? new Date();
  const days = Math.max(1, Math.min(366, Math.floor(o.days)));
  const db = o.q ?? (await getDb());
  const run = async (q: Queryable): Promise<Grant | null> => {
    await q.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [o.userId]); // параллельные выдачи одному пользователю — по очереди
    const last = (await q.query<{ until: Date | null }>(
      "SELECT max(ends_at) AS until FROM entitlements WHERE user_id=$1 AND plan='plus' AND revoked_at IS NULL AND ends_at > $2", [o.userId, now])).rows[0]?.until;
    const cfg = plansConfig();
    const betaEnd = cfg.mode === "beta" && cfg.betaEndsAt ? moscowMidnight(addDaysIso(cfg.betaEndsAt, 1)) : null;
    const start = new Date(Math.max(now.getTime(), last ? new Date(last).getTime() : 0, betaEnd?.getTime() ?? 0));
    const end = new Date(start.getTime() + days * DAY);
    const r = await q.query<{ id: string }>(
      `INSERT INTO entitlements(user_id, plan, source, starts_at, ends_at, referral_reward_id, idempotency_key, note, created_at)
       VALUES ($1,'plus',$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
      [o.userId, o.source, start, end, o.referralRewardId ?? null, o.idempotencyKey ?? null, o.note?.slice(0, 200) ?? null, now]);
    return r.rows[0] ? { id: String(r.rows[0].id), startsAt: start, endsAt: end } : null;
  };
  return o.q ? run(o.q) : (db as Awaited<ReturnType<typeof getDb>>).tx(run);
}

/**
 * Обслуживание (cron /api/cron/cleanup): созревшие награды пригласившим (pending, прошла проверка eligible_at) → +N дней Плюса.
 * Флаг REFERRAL_REWARDS_ENABLED выключен — ничего не делает (по умолчанию). Команда/тесты и снятые приглашения не награждаются.
 */
export async function maturePendingRewards(now = new Date(), limit = 200): Promise<{ enabled: boolean; granted: number; skipped: number }> {
  const cfg = referralConfig();
  if (!cfg.rewardsEnabled) return { enabled: false, granted: 0, skipped: 0 };
  const db = await getDb();
  const due = (await db.query<{ id: string }>(
    "SELECT id FROM referral_rewards WHERE status='pending' AND eligible_at <= $1 ORDER BY eligible_at LIMIT $2", [now, limit])).rows;
  let granted = 0, skipped = 0;
  for (const { id } of due) {
    const ok = await db.tx(async (q) => {
      const r = (await q.query<{ user_id: string; amount: number; referral_id: string; status: string; ref_status: string; a_int: boolean; b_int: boolean }>(
        `SELECT w.user_id, w.amount, w.referral_id, w.status, r.status AS ref_status, a.is_internal AS a_int, b.is_internal AS b_int
           FROM referral_rewards w JOIN referrals r ON r.id = w.referral_id JOIN users a ON a.id = r.referrer_user_id JOIN users b ON b.id = r.referee_user_id
          WHERE w.id = $1 FOR UPDATE OF w`, [id])).rows[0];
      if (!r || r.status !== "pending") return false;
      if (r.ref_status !== "activated" || r.a_int || r.b_int) {
        await q.query("UPDATE referral_rewards SET status='revoked', revoked_at=$2 WHERE id=$1", [id, now]);
        await q.query("UPDATE referrals SET reward_status='revoked' WHERE id=$1", [r.referral_id]);
        return false;
      }
      const g = await grantPlusDays({ userId: r.user_id, days: Number(r.amount), source: "referral", referralRewardId: id, note: "referral reward", now, q });
      if (!g) return false;
      await q.query("UPDATE referral_rewards SET status='granted', granted_at=$2, expires_at=$3 WHERE id=$1", [id, now, g.endsAt]);
      await q.query("UPDATE referrals SET reward_status='granted' WHERE id=$1", [r.referral_id]);
      return true;
    }).catch(() => false);
    if (ok) granted++; else skipped++;
  }
  return { enabled: true, granted, skipped };
}

/** /link: аккаунт `from` сливается в `to`. Периоды Плюса, счётчики AI-ответов и заявка переходят к `to` (права одинаковы во всех каналах). */
export async function mergePlans(q: Queryable, from: string, to: string): Promise<void> {
  await q.query("UPDATE entitlements SET user_id=$2 WHERE user_id=$1", [from, to]);
  await q.query("UPDATE ai_token_ledger SET user_id=$2 WHERE user_id=$1", [from, to]);
  await q.query(
    `INSERT INTO ai_token_buckets(user_id, period_kind, period_start, used, reserved)
     SELECT $2, period_kind, period_start, used, reserved FROM ai_token_buckets WHERE user_id=$1
     ON CONFLICT (user_id, period_kind, period_start) DO UPDATE SET used = ai_token_buckets.used + EXCLUDED.used, reserved = ai_token_buckets.reserved + EXCLUDED.reserved, updated_at = now()`, [from, to]);
  await q.query("DELETE FROM ai_token_buckets WHERE user_id=$1", [from]);
  // Заявка: остаётся более поздняя.
  await q.query(
    `INSERT INTO plus_interest(user_id, price_choice, offered_price, variant, channel, created_at, updated_at, updates)
     SELECT $2, price_choice, offered_price, variant, channel, created_at, updated_at, updates FROM plus_interest WHERE user_id=$1
     ON CONFLICT (user_id) DO UPDATE SET price_choice = EXCLUDED.price_choice, channel = EXCLUDED.channel, updated_at = EXCLUDED.updated_at,
       created_at = LEAST(plus_interest.created_at, EXCLUDED.created_at)
       WHERE EXCLUDED.updated_at > plus_interest.updated_at`, [from, to]);
  await q.query("DELETE FROM plus_interest WHERE user_id=$1", [from]);
}
