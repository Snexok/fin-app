// Источник трафика: первое касание пользователя (одна строка в user_sources, пишется один раз).
//  • веб: utm_source / utm_medium / utm_campaign и домен реферера при первом визите (POST /api/v1/session);
//  • бот: payload /start (t.me/<bot>?start=src_<источник>[__<канал>[__<кампания>]] или просто ?start=<источник>);
//  • Mini App: start_param из подписанного initData (t.me/<bot>/<app>?startapp=...), тот же формат.
//  • приглашение друга: ?start=ref_<код> / ?startapp=ref_<код> / веб ?ref=<код> → source=referral, medium=invite.
// Значения нормализуются ([a-z0-9._-], до 40 символов), от реферера остаётся только домен — без путей и параметров.
// При отказе от статистики источник не пишется, а при отказе после записи — удаляется.
import { getDb, type Queryable } from "./db";
import { analyticsEnabled } from "./analytics";

export type SourceChannel = "web" | "telegram" | "miniapp";
export interface Attribution { source: string; medium: string | null; campaign: string | null; referrerHost: string | null }

const TOKEN_RE = /[^a-z0-9._-]+/g;
/** Нормализация метки: нижний регистр, только [a-z0-9._-], до 40 символов; пустое — null. */
export function cleanTag(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().replace(/\s+/g, "_").replace(TOKEN_RE, "").replace(/^[._-]+|[._-]+$/g, "").slice(0, 40);
  return s || null;
}

/** Домен реферера без www; свой домен и не-http(s) — null. */
export function referrerHost(ref: unknown, ownHosts: string[] = []): string | null {
  if (typeof ref !== "string" || !ref || ref.length > 2048) return null;
  try {
    const u = new URL(ref);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const h = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!h || ownHosts.map((x) => x.toLowerCase().replace(/^www\./, "")).includes(h)) return null;
    return /^[a-z0-9.-]{1,100}$/.test(h) ? h : null;
  } catch { return null; }
}

/** Известные домены → короткий источник для «без UTM». */
const REF_SOURCES: [RegExp, string][] = [
  [/(^|\.)t\.me$|(^|\.)telegram\.(org|me)$/, "telegram"], [/(^|\.)google\./, "google"], [/(^|\.)yandex\.|(^|\.)ya\.ru$/, "yandex"],
  [/(^|\.)vk\.(com|ru)$/, "vk"], [/(^|\.)sber(bank)?\./, "sber"], [/(^|\.)github\.com$/, "github"], [/(^|\.)vercel\.(app|com)$/, "vercel"],
];

/** Веб: метки из параметров первого визита и реферера. Без меток и реферера — source = "direct". */
export function webAttribution(input: { utm_source?: unknown; utm_medium?: unknown; utm_campaign?: unknown; referrer?: unknown } | null | undefined, ownHosts: string[] = []): Attribution {
  const ref = referrerHost(input?.referrer, ownHosts);
  const src = cleanTag(input?.utm_source);
  const fromRef = ref ? REF_SOURCES.find(([re]) => re.test(ref))?.[1] ?? "referral" : null;
  return { source: src ?? fromRef ?? "direct", medium: cleanTag(input?.utm_medium) ?? (src ? null : ref ? "referral" : null), campaign: cleanTag(input?.utm_campaign), referrerHost: ref };
}

/**
 * Payload /start бота или start_param Mini App. Формат: src_<источник>[__<канал>[__<кампания>]] или <источник>.
 * link_* (привязка аккаунта) — не источник. Пусто — "direct".
 */
export function startPayloadAttribution(payload: unknown): Attribution | null {
  const p = typeof payload === "string" ? payload.trim() : "";
  if (p.startsWith("link_")) return null;
  if (!p) return { source: "direct", medium: null, campaign: null, referrerHost: null };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(p)) return { source: "other", medium: null, campaign: null, referrerHost: null };
  // Приглашение друга (lib/referrals.ts): ref_<код>[__<кампания>]. Код не пишем — он указывает на пригласившего.
  const ref = p.match(/^ref[_-][A-Za-z0-9]{6,16}(?:__([A-Za-z0-9_-]{1,40}))?$/i);
  if (ref) return { source: "referral", medium: "invite", campaign: cleanTag(ref[1]), referrerHost: null };
  const body = p.replace(/^src[_-]/i, "");
  const [source, medium, campaign] = body.split("__");
  return { source: cleanTag(source) ?? "other", medium: cleanTag(medium), campaign: cleanTag(campaign), referrerHost: null };
}

/**
 * Сохранить первое касание (только если строки ещё нет). Отказ от статистики — не пишем. Никогда не бросает.
 * Возвращает true, если записано сейчас.
 */
export async function recordFirstTouch(userId: string, channel: SourceChannel, a: Attribution | null, q?: Queryable): Promise<boolean> {
  try {
    if (!a || !analyticsEnabled()) return false;
    const db = q ?? (await getDb());
    const r = await db.query(
      `INSERT INTO user_sources(user_id, channel, source, medium, campaign, referrer_host)
       SELECT id, $2, $3, $4, $5, $6 FROM users WHERE id=$1 AND analytics_enabled
       ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
      [userId, channel, cleanTag(a.source) ?? "other", cleanTag(a.medium), cleanTag(a.campaign), a.referrerHost]);
    return r.rows.length > 0;
  } catch (e) {
    if (process.env.NODE_ENV !== "production") console.warn("[source] record failed", (e as Error).message);
    return false;
  }
}
