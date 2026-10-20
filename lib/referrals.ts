// Реферальная программа (Монетизация.md §3): сейчас только атрибуция, награды собраны и выключены флагом.
//  • код: случайный, 8 символов из [2-9a-z без i,l,o], не раскрывает id; создаётся лениво (users.ref_code);
//  • ссылки: бот t.me/<бот>?start=ref_<код>, Mini App …?startapp=ref_<код>, веб /?ref=<код> (до 64 символов,
//    алфавит Telegram [A-Za-z0-9_-]); к payload можно дописать «__<кампания>» — уйдёт в user_sources.campaign;
//  • атрибуция: один раз, при первом касании НОВОГО пользователя (referee_user_id UNIQUE). Не записываются:
//    самоприглашение, команда/тесты (users.is_internal), уже существующие аккаунты (есть план или создан раньше окна);
//  • антифрод: больше REFERRAL_DAILY_LIMIT атрибуций по коду за сутки — status=held (награды нет, ручная проверка);
//  • активация: друг сам выполнил первый целевой сценарий — завершил знакомство (первый прогноз) или получил
//    первый ответ «Можно?» (то же определение «первой пользы», что в аналитике);
//  • награда (REFERRAL_REWARDS_ENABLED=1): +7 дней Плюса пригласившему за активированного друга, не больше 4 в месяц,
//    с проверкой 48 ч. Плюса пока нет — пишется только строка pending в referral_rewards, доступ не выдаётся.
// Ни одна функция атрибуции/активации не бросает исключений: реферальная программа не ломает вход и ответы.
import { randomBytes } from "node:crypto";
import { getDb, type Queryable } from "./db";
import { pseudonym, track, type Channel } from "./analytics";
import { cleanTag, type Attribution } from "./traffic-source";

export const REF_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"; // 31 символ, без 0/1/i/l/o
export const REF_CODE_LEN = 8;
export const REF_CHANNELS = ["web", "bot", "miniapp"] as const;
export type RefChannel = (typeof REF_CHANNELS)[number];
export const ATTRIBUTION_RESULTS = ["attributed", "held", "invalid", "self", "internal", "existing", "already"] as const;
export type AttributionResult = (typeof ATTRIBUTION_RESULTS)[number];

const envInt = (name: string, def: number, min = 0, max = 10_000) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== "" && process.env[name] != null ? Math.min(max, Math.max(min, Math.floor(n))) : def;
};
export const referralConfig = () => ({
  rewardsEnabled: /^(1|true|on|yes)$/i.test(process.env.REFERRAL_REWARDS_ENABLED ?? ""),
  /** Атрибуций по одному коду за 24 ч, сверх — held. */
  dailyLimit: envInt("REFERRAL_DAILY_LIMIT", 5, 1),
  /** Наград пригласившему за календарный месяц (МСК). */
  monthlyRewards: envInt("REFERRAL_MONTHLY_REWARDS", 4, 0, 31),
  rewardDays: envInt("REFERRAL_REWARD_DAYS", 7, 1, 31),
  /** Проверка перед выдачей награды после активации друга. */
  holdHours: envInt("REFERRAL_REWARD_HOLD_HOURS", 48, 0, 24 * 30),
  /** «Новый пользователь»: аккаунт создан не раньше, чем за столько минут до перехода по ссылке. */
  newUserMinutes: envInt("REFERRAL_NEW_USER_MINUTES", 60, 1, 7 * 24 * 60),
});

// ---------- Коды и ссылки ----------

/** Случайный код без смещения (rejection sampling). */
export function generateRefCode(rand: (n: number) => Buffer = randomBytes, len = REF_CODE_LEN): string {
  const max = 256 - (256 % REF_ALPHABET.length);
  let out = "";
  while (out.length < len) {
    for (const b of rand(len * 2)) { if (b < max && out.length < len) out += REF_ALPHABET[b % REF_ALPHABET.length]; }
  }
  return out;
}
export const isRefCode = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9]{6,16}$/.test(v);
/** Код из ввода (веб ?ref=, хвост payload): регистр не важен, остальное — отказ. */
export function normalizeRefCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return isRefCode(s) ? s : null;
}

/**
 * Payload /start или start_param Mini App: ref_<код>[__<кампания>]. Telegram пропускает только [A-Za-z0-9_-] до 64.
 * Не ref-ссылка — null (тогда работает обычный формат src_… из lib/traffic-source).
 */
export function parseRefPayload(payload: unknown): { code: string; campaign: string | null } | null {
  const p = typeof payload === "string" ? payload.trim() : "";
  if (!p || p.length > 64 || !/^[A-Za-z0-9_-]+$/.test(p)) return null;
  const m = p.match(/^ref[_-]([A-Za-z0-9]{6,16})(?:__([A-Za-z0-9_-]{1,40}))?$/i);
  if (!m) return null;
  const code = normalizeRefCode(m[1]);
  return code ? { code, campaign: cleanTag(m[2]) } : null;
}

/** Первое касание по приглашению: source=referral, medium=invite (код в user_sources не пишем — он указывает на пригласившего). */
export const referralAttribution = (campaign: string | null = null): Attribution => ({ source: "referral", medium: "invite", campaign: cleanTag(campaign), referrerHost: null });

export const PUBLIC_WEB_ORIGIN = "https://mozhno-mvp.vercel.app";
export const botUsername = () => (process.env.TELEGRAM_BOT_USERNAME || "sber_fin_app_bot").replace(/^@/, "");
export const webOrigin = () => ((process.env.APP_ORIGIN ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).find((s) => /^https?:\/\//.test(s)) || PUBLIC_WEB_ORIGIN);

export interface InviteLinks { bot: string; miniapp: string | null; web: string; telegramShare: string }
export const SHARE_TEXT = "Проверяю покупки до зарплаты в «Можно?» — бот считает, хватит ли денег до дохода. Попробуй:";
/** Ссылки приглашения. Mini App — только если задано короткое имя приложения (TELEGRAM_MINIAPP_SHORT_NAME). */
export function inviteLinks(code: string): InviteLinks {
  const bot = `https://t.me/${botUsername()}?start=ref_${code}`;
  const app = (process.env.TELEGRAM_MINIAPP_SHORT_NAME ?? "").trim();
  const miniapp = /^[A-Za-z0-9_]{3,64}$/.test(app) ? `https://t.me/${botUsername()}/${app}?startapp=ref_${code}` : null;
  return { bot, miniapp, web: `${webOrigin()}/?ref=${code}`, telegramShare: telegramShareUrl(bot, SHARE_TEXT) };
}
export const telegramShareUrl = (url: string, text: string) => `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;

/** Личный код пользователя: создаётся при первом запросе, дальше стабилен. */
export async function getOrCreateRefCode(userId: string, q?: Queryable): Promise<string> {
  const db = q ?? (await getDb());
  const cur = await db.query<{ ref_code: string | null }>("SELECT ref_code FROM users WHERE id=$1", [userId]);
  if (!cur.rows[0]) throw Object.assign(new Error("user not found"), { code: "NOT_FOUND" });
  if (cur.rows[0].ref_code) return cur.rows[0].ref_code;
  for (let i = 0; i < 5; i++) {
    const code = generateRefCode();
    try {
      const r = await db.query<{ ref_code: string }>(
        "UPDATE users SET ref_code = COALESCE(ref_code, $2) WHERE id=$1 RETURNING ref_code", [userId, code]);
      if (r.rows[0]?.ref_code) return r.rows[0].ref_code;
    } catch (e) { if ((e as { code?: string }).code !== "23505") throw e; } // коллизия кода — пробуем другой
  }
  throw new Error("ref code generation failed");
}

// ---------- Атрибуция ----------

const EV_CHANNEL: Record<RefChannel, Channel> = { web: "web", bot: "telegram", miniapp: "miniapp" };

/**
 * Записать приглашение для пользователя `refereeId`, пришедшего по коду `code`.
 * isNew — аккаунт создан этим же входом (вызывающий знает точно); дополнительно проверяются возраст аккаунта и наличие плана.
 */
export async function attributeReferral(refereeId: string, code: unknown, channel: RefChannel, opts: { isNew: boolean; now?: Date }): Promise<AttributionResult> {
  const now = opts.now ?? new Date();
  let result: AttributionResult = "invalid";
  try {
    const c = normalizeRefCode(code);
    const db = await getDb();
    if (c) {
      const cfg = referralConfig();
      result = await db.tx(async (q) => {
        const ref = await q.query<{ id: string; is_internal: boolean }>("SELECT id, is_internal FROM users WHERE ref_code=$1 AND deleted_at IS NULL FOR UPDATE", [c]);
        const referrer = ref.rows[0];
        if (!referrer) return "invalid";
        if (referrer.id === refereeId) return "self";
        const me = await q.query<{ is_internal: boolean; created_at: Date; has_book: boolean; deleted_at: Date | null }>(
          "SELECT is_internal, created_at, deleted_at, EXISTS (SELECT 1 FROM books b WHERE b.user_id = u.id) AS has_book FROM users u WHERE id=$1", [refereeId]);
        const u = me.rows[0];
        if (!u || u.deleted_at) return "invalid";
        if ((await q.query("SELECT 1 FROM referrals WHERE referee_user_id=$1", [refereeId])).rows.length) return "already";
        if (referrer.is_internal || u.is_internal) return "internal";
        if (!opts.isNew || u.has_book || new Date(u.created_at).getTime() < now.getTime() - cfg.newUserMinutes * 60_000) return "existing";
        const day = await q.query<{ n: string }>("SELECT count(*) n FROM referrals WHERE referrer_user_id=$1 AND created_at > $2", [referrer.id, new Date(now.getTime() - 86_400_000)]);
        const held = Number(day.rows[0]?.n ?? 0) >= cfg.dailyLimit;
        const ins = await q.query(
          `INSERT INTO referrals(referrer_user_id, referee_user_id, code, channel, status, risk_reasons, created_at)
           VALUES ($1,$2,$3,$4,$5,$6::text[],$7) ON CONFLICT (referee_user_id) DO NOTHING RETURNING id`,
          [referrer.id, refereeId, c, channel, held ? "held" : "attributed", held ? ["velocity"] : [], now]);
        if (!ins.rows.length) return "already";
        return held ? "held" : "attributed";
      });
    }
    const ch = EV_CHANNEL[channel];
    await track(refereeId, "invite_opened", { result }, { channel: ch, key: `ref:${c ?? "-"}`, now });
    if (result === "attributed" || result === "held") {
      await track(refereeId, "referral_attributed", { via: channel, held: result === "held" ? "true" : "false" }, { channel: ch, key: "referral", now });
    }
  } catch (e) {
    if (process.env.NODE_ENV !== "production") console.warn("[referral] attribute failed", (e as Error).message);
  }
  return result;
}

// ---------- Активация и награды ----------

const moscowMonth = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit" }).format(d).slice(0, 7);

/**
 * Друг выполнил первый целевой сценарий (знакомство завершено / первый ответ «Можно?»).
 * Дёшево для повторных вызовов: один UPDATE по уникальному индексу. Возвращает true, если активирован сейчас.
 */
export async function activateReferral(refereeId: string, channel: Channel, now = new Date(), q?: Queryable): Promise<boolean> {
  try {
    const db = q ?? (await getDb());
    const r = await db.query<{ id: string; referrer_user_id: string; status: string }>(
      `UPDATE referrals SET activated_at=$2, status = CASE WHEN status='attributed' THEN 'activated' ELSE status END
        WHERE referee_user_id=$1 AND activated_at IS NULL AND status IN ('attributed','held') RETURNING id, referrer_user_id, status`, [refereeId, now]);
    const row = r.rows[0];
    if (!row) return false;
    await track(refereeId, "referral_activated", {}, { channel, key: "referral", now, q });
    await considerReward(String(row.id), now, q);
    return true;
  } catch (e) {
    if (process.env.NODE_ENV !== "production") console.warn("[referral] activate failed", (e as Error).message);
    return false;
  }
}

export type RewardDecision = "pending" | "disabled" | "limit" | "held" | "none" | "exists";

/**
 * Награда пригласившему за активированного друга. Флаг выключен — reward_status=disabled (ретроактивно ничего не начисляется).
 * Включён — строка pending в referral_rewards (Плюса пока нет, доступ не выдаётся), не больше monthlyRewards в месяц.
 */
export async function considerReward(referralId: string, now = new Date(), q?: Queryable): Promise<RewardDecision> {
  const cfg = referralConfig();
  const db = q ?? (await getDb());
  if (!cfg.rewardsEnabled) {
    await db.query("UPDATE referrals SET reward_status='disabled' WHERE id=$1 AND reward_status IS NULL", [referralId]);
    return "disabled";
  }
  const run = async (t: Queryable): Promise<{ d: RewardDecision; referrer?: string }> => {
    const r = await t.query<{ referrer_user_id: string; status: string; activated_at: Date | null; reward_id: string | null; referrer_internal: boolean; referee_internal: boolean }>(
      `SELECT r.referrer_user_id, r.status, r.activated_at, r.reward_id, a.is_internal AS referrer_internal, b.is_internal AS referee_internal
         FROM referrals r JOIN users a ON a.id = r.referrer_user_id JOIN users b ON b.id = r.referee_user_id WHERE r.id=$1`, [referralId]);
    const x = r.rows[0];
    if (!x) return { d: "none" };
    if (x.reward_id) return { d: "exists" };
    // Блокировка пригласившего: параллельные активации не превысят месячный лимит.
    await t.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [x.referrer_user_id]);
    const set = async (s: string) => { await t.query("UPDATE referrals SET reward_status=$2 WHERE id=$1", [referralId, s]); };
    if (!x.activated_at) { await set("none"); return { d: "none" }; }
    if (x.status !== "activated") { await set("held"); return { d: "held" }; }
    if (x.referrer_internal || x.referee_internal) { await set("none"); return { d: "none" }; }
    const period = moscowMonth(now);
    const used = await t.query<{ n: string }>("SELECT count(*) n FROM referral_rewards WHERE user_id=$1 AND period=$2 AND status IN ('pending','granted')", [x.referrer_user_id, period]);
    if (Number(used.rows[0]?.n ?? 0) >= cfg.monthlyRewards) { await set("limit"); return { d: "limit" }; }
    const ins = await t.query<{ id: string }>(
      `INSERT INTO referral_rewards(referral_id, user_id, kind, amount, period, status, created_at, eligible_at)
       VALUES ($1,$2,'plus_days',$3,$4,'pending',$5,$6) ON CONFLICT (referral_id) DO NOTHING RETURNING id`,
      [referralId, x.referrer_user_id, cfg.rewardDays, period, now, new Date(now.getTime() + cfg.holdHours * 3_600_000)]);
    if (!ins.rows.length) return { d: "exists" };
    await t.query("UPDATE referrals SET reward_status='pending', reward_id=$2 WHERE id=$1", [referralId, ins.rows[0].id]);
    return { d: "pending", referrer: x.referrer_user_id };
  };
  const out = q ? await run(q) : await (db as Awaited<ReturnType<typeof getDb>>).tx(run);
  if (out.d === "pending" && out.referrer) await track(out.referrer, "referral_reward_pending", {}, { channel: "system", key: `reward:${referralId}`, now, q });
  return out.d;
}

// ---------- Личный кабинет ----------

export interface ReferralMe { code: string; links: InviteLinks; invited: number; active: number; rewards: { enabled: boolean; pending: number; days: number; monthlyLimit: number } }

export async function referralMe(userId: string, q?: Queryable): Promise<ReferralMe> {
  const db = q ?? (await getDb());
  const code = await getOrCreateRefCode(userId, db);
  const r = await db.query<{ invited: string; active: string }>(
    "SELECT count(*) FILTER (WHERE status <> 'rejected') invited, count(*) FILTER (WHERE activated_at IS NOT NULL AND status <> 'rejected') active FROM referrals WHERE referrer_user_id=$1", [userId]);
  const w = await db.query<{ n: string }>("SELECT count(*) n FROM referral_rewards WHERE user_id=$1 AND status='pending'", [userId]);
  const cfg = referralConfig();
  return {
    code, links: inviteLinks(code), invited: Number(r.rows[0]?.invited ?? 0), active: Number(r.rows[0]?.active ?? 0),
    rewards: { enabled: cfg.rewardsEnabled, pending: Number(w.rows[0]?.n ?? 0), days: cfg.rewardDays, monthlyLimit: cfg.monthlyRewards },
  };
}

// ---------- Слияние аккаунтов (/link) ----------

/**
 * Аккаунт `from` удаляется, `to` остаётся (один человек). Приглашённые `from` переходят к `to`; если среди них сам `to` —
 * это самоприглашение, запись удаляется. Атрибуция `from` как приглашённого переносится, только если у `to` её нет
 * и `to` не старше окна «нового пользователя» на момент приглашения. Код `from` сохраняется, если у `to` своего нет.
 */
export async function mergeReferrals(q: Queryable, from: string, to: string): Promise<void> {
  const cfg = referralConfig();
  await q.query("DELETE FROM referrals WHERE (referrer_user_id=$1 AND referee_user_id=$2) OR (referrer_user_id=$2 AND referee_user_id=$1)", [from, to]);
  await q.query("UPDATE referrals SET referrer_user_id=$2 WHERE referrer_user_id=$1", [from, to]);
  await q.query("UPDATE referral_rewards SET user_id=$2 WHERE user_id=$1", [from, to]);
  await q.query(
    `UPDATE referrals r SET referee_user_id=$2 FROM users t
      WHERE r.referee_user_id=$1 AND t.id=$2
        AND NOT EXISTS (SELECT 1 FROM referrals x WHERE x.referee_user_id=$2)
        AND t.created_at >= r.created_at - make_interval(mins => $3::int)`, [from, to, cfg.newUserMinutes]);
  const code = await q.query<{ ref_code: string | null }>("SELECT ref_code FROM users WHERE id=$1", [from]);
  const c = code.rows[0]?.ref_code;
  if (c) {
    const has = await q.query<{ ref_code: string | null }>("SELECT ref_code FROM users WHERE id=$1", [to]);
    if (!has.rows[0]?.ref_code) {
      await q.query("UPDATE users SET ref_code=NULL WHERE id=$1", [from]);
      await q.query("UPDATE users SET ref_code=$2 WHERE id=$1", [to, c]);
    }
  }
}

// ---------- Дашборд ----------

export interface ReferralSummary {
  invitesShared: number; sharers: number; opened: number;
  signups: number; activated: number; held: number; activationRate: number | null;
  activeUsers: number; kFactor: number | null;
  rewards: { enabled: boolean; pending: number; limited: number };
  byChannel: { channel: string; n: number }[];
  top: { subject: string | null; signups: number; activated: number; small: boolean }[];
  minCohort: number; includeInternal: boolean;
}

/**
 * Сводка за [from, to). Команда и тесты исключены (по обеим сторонам приглашения), если не includeInternal.
 * K-фактор (приближённо) = приглашённых зарегистрировалось за период / активных пользователей за период.
 * Топ пригласивших — по псевдониму (8 символов того же HMAC, что в событиях); значения меньше minCohort скрыты.
 */
export async function referralSummary(from: Date, to: Date, opts: { includeInternal?: boolean; minCohort?: number; q?: Queryable } = {}): Promise<ReferralSummary> {
  const db = opts.q ?? (await getDb());
  const inc = !!opts.includeInternal, min = opts.minCohort ?? 5;
  const P = [from, to];
  const EV = `occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz${inc ? "" : " AND NOT internal"}`;
  const ev = (await db.query<Record<string, string>>(
    `SELECT count(*) FILTER (WHERE name='invite_shared') shared, count(DISTINCT subject) FILTER (WHERE name='invite_shared') sharers,
            count(*) FILTER (WHERE name='invite_opened') opened, count(DISTINCT subject) FILTER (WHERE name='user_active') active
       FROM analytics_events WHERE ${EV}`, P)).rows[0] ?? {};
  const R = `r.created_at >= $1::timestamptz AND r.created_at < $2::timestamptz AND r.status <> 'rejected'${inc ? "" : " AND NOT a.is_internal AND NOT b.is_internal"}`;
  const J = "FROM referrals r JOIN users a ON a.id = r.referrer_user_id JOIN users b ON b.id = r.referee_user_id";
  const s = (await db.query<Record<string, string>>(
    `SELECT count(*) n, count(*) FILTER (WHERE r.activated_at IS NOT NULL) act, count(*) FILTER (WHERE r.status='held') held,
            count(*) FILTER (WHERE r.reward_status='pending') pend, count(*) FILTER (WHERE r.reward_status='limit') lim ${J} WHERE ${R}`, P)).rows[0] ?? {};
  const ch = (await db.query<{ channel: string; n: string }>(`SELECT r.channel, count(*) n ${J} WHERE ${R} GROUP BY 1 ORDER BY 2 DESC`, P)).rows;
  const top = (await db.query<{ id: string; epoch: number; enabled: boolean; n: string; act: string }>(
    `SELECT a.id, a.analytics_epoch epoch, a.analytics_enabled enabled, count(*) n, count(*) FILTER (WHERE r.activated_at IS NOT NULL) act
       ${J} WHERE ${R} GROUP BY 1, 2, 3 ORDER BY 4 DESC, 5 DESC LIMIT 5`, P)).rows;
  const n = Number(s.n ?? 0), act = Number(s.act ?? 0), active = Number(ev.active ?? 0);
  return {
    invitesShared: Number(ev.shared ?? 0), sharers: Number(ev.sharers ?? 0), opened: Number(ev.opened ?? 0),
    signups: n, activated: act, held: Number(s.held ?? 0), activationRate: n ? act / n : null,
    activeUsers: active, kFactor: active ? n / active : null,
    rewards: { enabled: referralConfig().rewardsEnabled, pending: Number(s.pend ?? 0), limited: Number(s.lim ?? 0) },
    byChannel: ch.map((x) => ({ channel: x.channel, n: Number(x.n) })),
    top: top.map((x) => ({ subject: x.enabled ? pseudonym(x.id, Number(x.epoch)).slice(0, 8) : null, signups: Number(x.n), activated: Number(x.act), small: Number(x.n) < min })),
    minCohort: min, includeInternal: inc,
  };
}
