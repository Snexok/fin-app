// Тарифы, права и пользовательские «токены» (1 токен = 1 AI-ответ). Монетизация.md §1–2, план MVP шаг 2.
//  • План: PLANS_MODE=beta — у всех «Бета-Плюс» (15 AI-ответов в день, голос как в Плюсе), строк в БД не нужно;
//    PLANS_MODE=live — активный период Плюса из entitlements (награда за друга, ручная выдача), иначе Free.
//  • Квоты: дневная (по Москве) и на 30-дневное окно тарифа. Резерв до вызова модели (хук allow в lib/llm/client.ts),
//    списание только после успешного AI-ответа (onAnswer), возврат при сбое (onRelease). Разбор намерения, голос и шаблоны
//    квоту не тратят. Ядро («Можно?», «сколько можно сегодня», разрыв, записи, напоминания) квоты не касается вовсе.
//  • Нет AI-ответов — ответ шаблоном с теми же числами движка и мягкая подсказка, когда появятся новые. Продукт не блокируется.
//  • Платёжных веток нет: source='paid' в коде этапа 1 не создаётся.
import { getDb, type Queryable } from "../db";
import { AI_ANSWER_PURPOSES, setLlmHooks, type LlmPurpose } from "../llm";
import { track, type Channel } from "../analytics";
import { currentCall } from "../service-log";
import { PLAN_LABEL, plansConfig, type PlanCode, type PlanLimits, type PlansConfig } from "./config";
import { addDaysIso, moscowDay, moscowMidnight, resetLabel, windowStart } from "./time";
import { shownPrice } from "./price";
export { shownPrice } from "./price";

export { plansConfig, PLAN_LABEL, PLAN_CODES, PRICE_POINTS, type PlanCode, type PlansConfig } from "./config";
export { moscowDay, windowStart, addDaysIso, moscowMidnight } from "./time";

const UNLIMITED = 2_147_483_647;
const lim = (n: number) => (n > 0 ? n : UNLIMITED);
const warn = (what: string, e: unknown) => { if (process.env.NODE_ENV !== "production") console.warn(`[plans] ${what} failed`, (e as Error)?.message); };

export type EntitlementSource = "beta" | "referral" | "manual" | "paid";
export interface PlanContext {
  mode: PlansConfig["mode"]; plan: PlanCode; source: EntitlementSource | null;
  /** Конец текущего периода Плюса (live) или беты (если задана BETA_ENDS_AT). */
  endsAt: Date | null;
  /** День-якорь окна квоты (МСК). */
  anchorDay: string;
  limits: PlanLimits;
  /** Будущие и текущие периоды Плюса (например, награда, которая начнётся после беты). */
  plusUntil: Date | null;
}

/** Текущий тариф пользователя. Никогда не бросает на отсутствии строк: нет пользователя — Free/beta с якорем «сегодня». */
export async function planContext(userId: string, now = new Date(), q?: Queryable, cfg = plansConfig()): Promise<PlanContext> {
  const db = q ?? (await getDb());
  const r = await db.query<{ created_at: Date | null; plan: string | null; source: EntitlementSource | null; starts_at: Date | null; ends_at: Date | null; plus_until: Date | null }>(
    `SELECT u.created_at, a.plan, a.source, a.starts_at, a.ends_at,
            (SELECT max(e.ends_at) FROM entitlements e WHERE e.user_id = u.id AND e.plan = 'plus' AND e.revoked_at IS NULL AND e.ends_at > $2) AS plus_until
       FROM users u
       LEFT JOIN LATERAL (SELECT plan, source, starts_at, ends_at FROM entitlements e
                           WHERE e.user_id = u.id AND e.plan = 'plus' AND e.revoked_at IS NULL AND e.starts_at <= $2 AND (e.ends_at IS NULL OR e.ends_at > $2)
                           ORDER BY e.starts_at DESC LIMIT 1) a ON true
      WHERE u.id = $1`, [userId, now]);
  const row = r.rows[0];
  const created = row?.created_at ? moscowDay(new Date(row.created_at)) : moscowDay(now);
  const plusUntil = row?.plus_until ? new Date(row.plus_until) : null;
  if (cfg.mode === "beta") {
    return { mode: "beta", plan: "beta_plus", source: "beta", endsAt: cfg.betaEndsAt ? moscowMidnight(addDaysIso(cfg.betaEndsAt, 1)) : null, anchorDay: created, limits: cfg.limits.beta_plus, plusUntil };
  }
  if (row?.plan === "plus" && row.starts_at) {
    return { mode: "live", plan: "plus", source: row.source, endsAt: row.ends_at ? new Date(row.ends_at) : null, anchorDay: moscowDay(new Date(row.starts_at)), limits: cfg.limits.plus, plusUntil };
  }
  return { mode: "live", plan: "free", source: null, endsAt: null, anchorDay: created, limits: cfg.limits.free, plusUntil };
}

export interface TokenSummary {
  plan: PlanCode; label: string;
  /** Сколько AI-ответов можно получить прямо сейчас (минимум из дня и окна); null — без лимита. */
  left: number | null;
  /** Лимит, который сейчас ограничивает (день или окно). */
  limit: number | null; scope: "day" | "window" | null;
  day: { used: number; limit: number | null; left: number | null };
  window: { used: number; limit: number | null; left: number | null; start: string; end: string } | null;
  exhausted: boolean; low: boolean;
  /** Когда появятся новые AI-ответы (по ограничивающему лимиту), ISO и «завтра в 00:00» / «20 ноября». */
  resetAt: string; resetLabel: string;
}
export interface VoiceSummary { windowLeftSec: number | null; dayLeftSec: number | null; leftSec: number | null; windowLimitSec: number | null; dayLimitSec: number | null }
export interface PlanState {
  mode: PlansConfig["mode"]; plan: PlanCode; label: string; source: EntitlementSource | null; endsAt: string | null; betaEndsAt: string | null;
  plusUntil: string | null;
  tokens: TokenSummary; voice: VoiceSummary;
  prices: { free: 0; plusRub: number; periodDays: number; autoRenew: false; afterBeta: boolean; options: number[]; variant: string; currency: "RUB" };
  quotas: { beta: { perDay: number }; free: { perDay: number; perWindow: number; voiceMin: number }; plus: { perDay: number; perWindow: number; voiceMin: number } };
  interest: { priceChoice: number | null; createdAt: string; updatedAt: string } | null;
}

interface Buckets { day: { used: number; reserved: number }; window: { used: number; reserved: number }; vday: number; vwin: number }
async function readBuckets(db: Queryable, userId: string, day: string, win: string): Promise<Buckets> {
  const r = await db.query<{ period_kind: string; period_start: string; used: number; reserved: number }>(
    `SELECT period_kind, period_start::text, used, reserved FROM ai_token_buckets
      WHERE user_id = $1 AND ((period_kind IN ('day', 'voice_day') AND period_start = $2::date) OR (period_kind IN ('window', 'voice_window') AND period_start = $3::date))`,
    [userId, day, win]);
  const get = (k: string) => r.rows.find((x) => x.period_kind === k);
  const b = (k: string) => ({ used: Number(get(k)?.used ?? 0), reserved: Number(get(k)?.reserved ?? 0) });
  return { day: b("day"), window: b("window"), vday: Number(get("voice_day")?.used ?? 0), vwin: Number(get("voice_window")?.used ?? 0) };
}

export function summarize(ctx: PlanContext, b: Buckets, now: Date, cfg = plansConfig()): { tokens: TokenSummary; voice: VoiceSummary } {
  const today = moscowDay(now);
  const win = windowStart(ctx.anchorDay, today, cfg.windowDays);
  const winEnd = addDaysIso(win, cfg.windowDays);
  const L = ctx.limits;
  const dayUsed = b.day.used + b.day.reserved, winUsed = b.window.used + b.window.reserved;
  const dayLeft = L.perDay > 0 ? Math.max(0, L.perDay - dayUsed) : null;
  const winLeft = L.perWindow > 0 ? Math.max(0, L.perWindow - winUsed) : null;
  // Ограничивает тот лимит, где осталось меньше; при равенстве — окно (его сброс дальше, честнее показать его).
  let scope: TokenSummary["scope"] = null, left: number | null = null;
  if (dayLeft != null) { scope = "day"; left = dayLeft; }
  if (winLeft != null && (left == null || winLeft <= left)) { scope = "window"; left = winLeft; }
  const exhausted = left === 0;
  const resetDay = scope === "window" && (exhausted || dayLeft == null) ? winEnd : addDaysIso(today, 1);
  const resetAt = moscowMidnight(resetDay);
  const vWinLeft = L.voiceWindowSec > 0 ? Math.max(0, L.voiceWindowSec - b.vwin) : null;
  const vDayLeft = L.voiceDaySec > 0 ? Math.max(0, L.voiceDaySec - b.vday) : null;
  const vLeft = vWinLeft == null ? vDayLeft : vDayLeft == null ? vWinLeft : Math.min(vWinLeft, vDayLeft);
  return {
    tokens: {
      plan: ctx.plan, label: PLAN_LABEL[ctx.plan], left, limit: scope === "day" ? L.perDay : scope === "window" ? L.perWindow : null, scope,
      day: { used: b.day.used, limit: L.perDay || null, left: dayLeft },
      window: L.perWindow > 0 ? { used: b.window.used, limit: L.perWindow, left: winLeft, start: win, end: winEnd } : null,
      exhausted, low: left != null && !exhausted && left <= cfg.lowThreshold,
      resetAt: resetAt.toISOString(), resetLabel: resetLabel(resetAt, now),
    },
    voice: { windowLeftSec: vWinLeft, dayLeftSec: vDayLeft, leftSec: vLeft, windowLimitSec: L.voiceWindowSec || null, dayLimitSec: L.voiceDaySec || null },
  };
}

export async function getPlan(userId: string, now = new Date(), q?: Queryable): Promise<PlanState> {
  const cfg = plansConfig();
  const db = q ?? (await getDb());
  const ctx = await planContext(userId, now, db, cfg);
  const today = moscowDay(now);
  const b = await readBuckets(db, userId, today, windowStart(ctx.anchorDay, today, cfg.windowDays));
  const { tokens, voice } = summarize(ctx, b, now, cfg);
  const i = (await db.query<{ price_choice: number | null; created_at: Date; updated_at: Date }>("SELECT price_choice, created_at, updated_at FROM plus_interest WHERE user_id=$1", [userId])).rows[0];
  const sp = shownPrice(userId, cfg);
  const L = cfg.limits;
  return {
    mode: ctx.mode, plan: ctx.plan, label: PLAN_LABEL[ctx.plan], source: ctx.source, endsAt: ctx.endsAt?.toISOString() ?? null, betaEndsAt: cfg.betaEndsAt,
    plusUntil: ctx.plusUntil?.toISOString() ?? null,
    tokens, voice,
    prices: { free: 0, plusRub: sp.price, periodDays: cfg.price.periodDays, autoRenew: false, afterBeta: ctx.mode === "beta", options: cfg.price.options, variant: sp.variant, currency: "RUB" },
    quotas: {
      beta: { perDay: L.beta_plus.perDay },
      free: { perDay: L.free.perDay, perWindow: L.free.perWindow, voiceMin: Math.round(L.free.voiceWindowSec / 60) },
      plus: { perDay: L.plus.perDay, perWindow: L.plus.perWindow, voiceMin: Math.round(L.plus.voiceWindowSec / 60) },
    },
    interest: i ? { priceChoice: i.price_choice == null ? null : Number(i.price_choice), createdAt: new Date(i.created_at).toISOString(), updatedAt: new Date(i.updated_at).toISOString() } : null,
  };
}

export async function tokenSummary(userId: string, now = new Date()): Promise<TokenSummary | null> {
  try { return (await getPlan(userId, now)).tokens; } catch (e) { warn("tokenSummary", e); return null; }
}

// ---------- Атомарный расход ----------

export type ReserveTokenResult = { ok: true } | { ok: false; scope: "day" | "window" | "unavailable" };
class Denied extends Error { constructor(public scope: "day" | "window") { super("TOKENS_DENIED"); } }

const TAKE = `
  INSERT INTO ai_token_buckets(user_id, period_kind, period_start, reserved)
  SELECT $1, $2, $3::date, 1 WHERE 1 <= $4::int
  ON CONFLICT (user_id, period_kind, period_start) DO UPDATE
     SET reserved = ai_token_buckets.reserved + 1, updated_at = now()
   WHERE ai_token_buckets.used + ai_token_buckets.reserved + 1 <= $4::int
  RETURNING 1 AS ok`;

/** Вернуть зависшие резервы (вызов модели упал вместе с процессом): строки старше TTL → released, резерв счётчиков −1. */
async function releaseStale(q: Queryable, userId: string | null, now: Date, ttlSec: number): Promise<number> {
  const r = await q.query<{ user_id: string; day: string; window_start: string | null }>(
    `UPDATE ai_token_ledger SET status = 'released', settled_at = $2
      WHERE status = 'reserved' AND created_at < $3 AND ($1::uuid IS NULL OR user_id = $1::uuid)
      RETURNING user_id, day::text, window_start::text`, [userId, now, new Date(now.getTime() - ttlSec * 1000)]);
  for (const x of r.rows) await unreserve(q, x.user_id, x.day, x.window_start, 0);
  return r.rows.length;
}
async function unreserve(q: Queryable, userId: string, day: string, win: string | null, used: 0 | 1, dec: 0 | 1 = 1) {
  await q.query(
    `UPDATE ai_token_buckets SET reserved = GREATEST(0, reserved - $5::int), used = used + $4::int, updated_at = now()
      WHERE user_id = $1 AND ((period_kind = 'day' AND period_start = $2::date) OR (period_kind = 'window' AND period_start = $3::date))`,
    [userId, day, win, used, dec]);
}

const evChannel = (): Channel => { const c = currentCall()?.channel; return c === "web" || c === "telegram" || c === "miniapp" ? c : "system"; };
const isAiPurpose = (p: LlmPurpose): p is "explain" | "compare" | "goal_chat" | "weekly_review" => AI_ANSWER_PURPOSES.includes(p);

/** Резерв одного AI-ответа под requestId. Отказ: квота дня/окна или БД недоступна (fail closed — ответ уйдёт шаблоном). */
export async function reserveToken(o: { userId: string; purpose: LlmPurpose; requestId: string; now?: Date }): Promise<ReserveTokenResult> {
  const now = o.now ?? new Date();
  const cfg = plansConfig();
  if (!isAiPurpose(o.purpose)) return { ok: true };
  let ctx: PlanContext | null = null;
  try {
    const db = await getDb();
    ctx = await planContext(o.userId, now, db, cfg);
    const c = ctx;
    const day = moscowDay(now), win = windowStart(c.anchorDay, day, cfg.windowDays);
    await db.tx(async (q) => {
      await releaseStale(q, o.userId, now, cfg.reservationTtlSec);
      // Порядок всегда окно → день (без взаимоблокировок); отказ любого откатывает транзакцию целиком.
      if ((await q.query(TAKE, [o.userId, "window", win, lim(c.limits.perWindow)])).rows.length === 0) throw new Denied("window");
      if ((await q.query(TAKE, [o.userId, "day", day, lim(c.limits.perDay)])).rows.length === 0) throw new Denied("day");
      await q.query(
        `INSERT INTO ai_token_ledger(request_id, user_id, plan, purpose, day, window_start, status, created_at) VALUES ($1,$2,$3,$4,$5::date,$6::date,'reserved',$7)`,
        [o.requestId, o.userId, c.plan, o.purpose, day, win, now]);
    });
    return { ok: true };
  } catch (e) {
    if (e instanceof Denied) {
      await track(o.userId, "tokens_exhausted", { plan: ctx!.plan, scope: e.scope }, { channel: evChannel(), key: `${e.scope}:${moscowDay(now)}`, now });
      return { ok: false, scope: e.scope };
    }
    warn("reserve", e);
    return { ok: false, scope: "unavailable" };
  }
}

/** Успешный AI-ответ: резерв → списание. Повтор ничего не делает. Никогда не бросает. */
export async function consumeToken(requestId: string, now = new Date()): Promise<boolean> {
  try {
    const db = await getDb();
    const row = await db.tx(async (q) => {
      const r = await q.query<{ user_id: string; day: string; window_start: string | null; plan: PlanCode; purpose: string }>(
        `UPDATE ai_token_ledger SET status = 'consumed', settled_at = $2 WHERE request_id = $1 AND status = 'reserved' RETURNING user_id, day::text, window_start::text, plan, purpose`, [requestId, now]);
      if (r.rows[0]) { await unreserve(q, r.rows[0].user_id, r.rows[0].day, r.rows[0].window_start, 1); return r.rows[0]; }
      // Резерв успел истечь (очень долгий вызов): ответ всё равно получен — списываем без резерва.
      const late = await q.query<{ user_id: string; day: string; window_start: string | null; plan: PlanCode; purpose: string }>(
        `UPDATE ai_token_ledger SET status = 'consumed', settled_at = $2 WHERE request_id = $1 AND status = 'released' RETURNING user_id, day::text, window_start::text, plan, purpose`, [requestId, now]);
      if (late.rows[0]) await unreserve(q, late.rows[0].user_id, late.rows[0].day, late.rows[0].window_start, 1, 0);
      return late.rows[0] ?? null;
    });
    if (!row) return false;
    await track(row.user_id, "ai_answer_consumed", { purpose: row.purpose as "explain", plan: row.plan }, { channel: evChannel(), key: requestId, now });
    return true;
  } catch (e) { warn("consume", e); return false; }
}

/** Сбой модели, невалидный ответ, отказ бюджета: резерв вернуть, токен не тратится. Никогда не бросает. */
export async function releaseToken(requestId: string, now = new Date()): Promise<boolean> {
  try {
    const db = await getDb();
    return await db.tx(async (q) => {
      const r = await q.query<{ user_id: string; day: string; window_start: string | null }>(
        `UPDATE ai_token_ledger SET status = 'released', settled_at = $2 WHERE request_id = $1 AND status = 'reserved' RETURNING user_id, day::text, window_start::text`, [requestId, now]);
      if (!r.rows[0]) return false;
      await unreserve(q, r.rows[0].user_id, r.rows[0].day, r.rows[0].window_start, 0);
      return true;
    });
  } catch (e) { warn("release", e); return false; }
}

/** Обслуживание (cron): вернуть все зависшие резервы. */
export async function releaseStaleTokens(now = new Date()): Promise<number> {
  const db = await getDb();
  return db.tx((q) => releaseStale(q, null, now, plansConfig().reservationTtlSec));
}

// ---------- Голос ----------

/** Сколько секунд голоса осталось (null — без лимита). Распознавание AI-ответов не тратит. */
export async function voiceLeft(userId: string, now = new Date()): Promise<number | null> {
  try { return (await getPlan(userId, now)).voice.leftSec; } catch (e) { warn("voiceLeft", e); return null; }
}
/** Учесть распознанные секунды (после успешного распознавания). Никогда не бросает. */
export async function recordVoice(userId: string, seconds: number, now = new Date()): Promise<void> {
  try {
    const cfg = plansConfig();
    const db = await getDb();
    const ctx = await planContext(userId, now, db, cfg);
    const day = moscowDay(now), win = windowStart(ctx.anchorDay, day, cfg.windowDays);
    const s = Math.max(0, Math.ceil(seconds));
    for (const [k, p] of [["voice_day", day], ["voice_window", win]] as const) {
      await db.query(`INSERT INTO ai_token_buckets(user_id, period_kind, period_start, used) VALUES ($1,$2,$3::date,$4)
        ON CONFLICT (user_id, period_kind, period_start) DO UPDATE SET used = ai_token_buckets.used + EXCLUDED.used, updated_at = now()`, [userId, k, p, s]);
    }
  } catch (e) { warn("recordVoice", e); }
}

// ---------- Хуки LLM ----------

/** Подключить квоты к единой точке вызова модели. Идемпотентно; вызывается при импорте модуля. */
export function installPlanHooks() {
  setLlmHooks({
    allow: async ({ userId, purpose, requestId, now }) => {
      if (!userId || !isAiPurpose(purpose)) return true; // cron/система и разбор намерения квоту не тратят
      return (await reserveToken({ userId, purpose, requestId, now })).ok;
    },
    onAnswer: async ({ userId, purpose, requestId, now }) => { if (userId && isAiPurpose(purpose)) await consumeToken(requestId, now); },
    onRelease: async ({ userId, purpose, requestId, now }) => { if (userId && isAiPurpose(purpose)) await releaseToken(requestId, now); },
  });
}
installPlanHooks();

export { upsertInterest, type InterestResult } from "./interest";
export { grantPlusDays, maturePendingRewards, mergePlans } from "./entitlements";
