// Аккаунт, сессии и безопасная привязка Telegram (ARCHITECTURE.md §8.1, §8.3).
// Токены хранятся только как sha256-хеши. Знание чужого ID ничего не даёт.
import { getDb, type Queryable } from "./db";
import { ApiError, isUuid, randomToken, sha256hex, uuid } from "./util";

/** Скользящая сессия: 30 дней с последней активности, но не дольше 180 дней от входа. */
export const SESSION_TTL_DAYS = 30;
export const SESSION_MAX_AGE_DAYS = 180;
export const LINK_TTL_MINUTES = 10;
const TG_ISSUER = "telegram";

async function createUser(q: Queryable, timezone?: string): Promise<string> {
  const id = uuid();
  await q.query("INSERT INTO users(id, timezone) VALUES ($1, COALESCE($2, 'Europe/Moscow'))", [id, timezone ?? null]);
  return id;
}

/** Новый анонимный веб-аккаунт с сессией. Возвращает сырой токен для HttpOnly-cookie. */
export async function createAnonymousSession(now = new Date()): Promise<{ userId: string; token: string; expiresAt: Date }> {
  const db = await getDb();
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 86_400_000);
  const userId = await db.tx(async (q) => {
    const userId = await createUser(q);
    const identityId = uuid();
    await q.query("INSERT INTO identities(id, user_id, provider, issuer, subject, verified_at) VALUES ($1,$2,'anonymous','web',$3,$4)", [identityId, userId, uuid(), now]);
    await insertSession(q, userId, identityId, token, expiresAt);
    return userId;
  });
  return { userId, token, expiresAt };
}

async function insertSession(q: Queryable, userId: string, identityId: string, token: string, expiresAt: Date) {
  await q.query("INSERT INTO sessions(id, user_id, identity_id, token_hash, expires_at) VALUES ($1,$2,$3,decode($4,'hex'),$5)", [uuid(), userId, identityId, sha256hex(token), expiresAt]);
}

export interface IssuedSession { userId: string; token: string; expiresAt: Date }

/** Продлевает сессию, если прошла половина TTL (и не превышен абсолютный срок). Возвращает новый срок или null. */
export async function touchSession(token: string | undefined | null, now = new Date()): Promise<Date | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const db = await getDb();
  const next = new Date(now.getTime() + SESSION_TTL_DAYS * 86_400_000);
  const r = await db.query<{ expires_at: Date }>(
    `UPDATE sessions SET expires_at=LEAST($2::timestamptz, created_at + make_interval(days => ${SESSION_MAX_AGE_DAYS})) WHERE token_hash=decode($1,'hex') AND revoked_at IS NULL AND expires_at > $3
       AND expires_at < $4 AND created_at > $5 RETURNING expires_at`,
    [sha256hex(token), next, now, new Date(now.getTime() + (SESSION_TTL_DAYS / 2) * 86_400_000), new Date(now.getTime() - SESSION_MAX_AGE_DAYS * 86_400_000)]);
  return r.rows[0] ? new Date(r.rows[0].expires_at) : null;
}

/** Ротация после смены привилегий (привязка Telegram): старый токен отзывается, выдаётся новый для того же identity. */
export async function rotateSession(oldToken: string | undefined | null, now = new Date()): Promise<IssuedSession | null> {
  if (!oldToken) return null;
  const db = await getDb();
  return db.tx(async (q) => {
    const r = await q.query<{ user_id: string; identity_id: string }>(
      "UPDATE sessions SET revoked_at=$2 WHERE token_hash=decode($1,'hex') AND revoked_at IS NULL AND expires_at > $2 RETURNING user_id, identity_id", [sha256hex(oldToken), now]);
    const s = r.rows[0];
    if (!s) return null;
    const token = randomToken(32);
    const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 86_400_000);
    await insertSession(q, s.user_id, s.identity_id, token, expiresAt);
    return { userId: s.user_id, token, expiresAt };
  });
}

/** Сессия для пользователя Telegram (Mini App после проверки initData). */
export async function telegramSession(tgId: number | string, now = new Date()): Promise<IssuedSession> {
  const userId = await telegramUserId(tgId);
  if (!userId) throw new ApiError("IN_PROGRESS", 409, "Повторите вход");
  const db = await getDb();
  const idr = await db.query<{ id: string }>("SELECT id FROM identities WHERE provider='telegram' AND issuer=$1 AND subject=$2 AND user_id=$3", [TG_ISSUER, String(tgId), userId]);
  if (!idr.rows[0]) throw new ApiError("IN_PROGRESS", 409, "Повторите вход");
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 86_400_000);
  await insertSession(db, userId, idr.rows[0].id, token, expiresAt);
  return { userId, token, expiresAt };
}

export async function userIdForSessionToken(token: string | undefined | null, now = new Date()): Promise<string | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const db = await getDb();
  const r = await db.query<{ user_id: string }>(
    "SELECT s.user_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = decode($1,'hex') AND s.revoked_at IS NULL AND s.expires_at > $2 AND s.created_at > $3 AND u.deleted_at IS NULL",
    [sha256hex(token), now, new Date(now.getTime() - SESSION_MAX_AGE_DAYS * 86_400_000)],
  );
  return r.rows[0]?.user_id ?? null;
}

export async function revokeSession(token: string) {
  const db = await getDb();
  await db.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = decode($1,'hex')", [sha256hex(token)]);
}

/** Пользователь для подтверждённого Telegram-отправителя (ctx.from.id из апдейта, а не из текста). */
export async function telegramUserId(tgId: number | string, create = true): Promise<string | null> {
  const db = await getDb();
  const subject = String(tgId);
  const found = await db.query<{ user_id: string }>("SELECT user_id FROM identities WHERE provider='telegram' AND issuer=$1 AND subject=$2", [TG_ISSUER, subject]);
  if (found.rows[0]) return found.rows[0].user_id;
  if (!create) return null;
  // Гонка первых апдейтов: UPSERT по уникальной identity; проигравший откатывает своего пользователя.
  const created = await db.tx(async (q) => {
    const userId = await createUser(q);
    const ins = await q.query("INSERT INTO identities(id, user_id, provider, issuer, subject, delivery_address, verified_at) VALUES ($1,$2,'telegram',$3,$4,$4,now()) ON CONFLICT (provider, issuer, subject) DO NOTHING RETURNING user_id", [uuid(), userId, TG_ISSUER, subject]);
    if (!ins.rows.length) { await q.query("DELETE FROM users WHERE id=$1", [userId]); return null; }
    return userId;
  });
  if (created) return created;
  const winner = await db.query<{ user_id: string }>("SELECT user_id FROM identities WHERE provider='telegram' AND issuer=$1 AND subject=$2", [TG_ISSUER, subject]);
  return winner.rows[0]?.user_id ?? null;
}

export async function identitiesOf(userId: string): Promise<{ provider: string; subject: string }[]> {
  const db = await getDb();
  return (await db.query<{ provider: string; subject: string }>("SELECT provider, subject FROM identities WHERE user_id=$1 ORDER BY provider", [userId])).rows;
}

// ---------- Привязка Telegram к веб-аккаунту ----------

export interface LinkStart { id: string; code: string; browserSecret: string; expiresAt: Date; deepLink: string | null }

/** Шаг 1 (веб, есть сессия): одноразовый код. browserSecret кладётся в HttpOnly-cookie исходного браузера. */
export interface LinkContext { device?: string }

/** Грубое описание устройства для подтверждения в боте ("Chrome, macOS"). Полный User-Agent не храним. */
export function deviceSummary(ua: string | null | undefined): string | undefined {
  if (!ua) return undefined;
  const browser = /YaBrowser/.test(ua) ? "Яндекс Браузер" : /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "браузер";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser}, ${os}` : browser;
}

export async function startLink(userId: string, now = new Date(), context: LinkContext = {}): Promise<LinkStart> {
  const db = await getDb();
  const id = uuid();
  const code = randomToken(12); // 96 бит, base64url: годится для t.me/<bot>?start=link_<code>
  const browserSecret = randomToken(32);
  const expiresAt = new Date(now.getTime() + LINK_TTL_MINUTES * 60_000);
  await db.tx(async (q) => {
    await q.query("UPDATE auth_challenges SET status='cancelled' WHERE target_user_id=$1 AND purpose='link' AND status IN ('pending','approved')", [userId]);
    await q.query(
      "INSERT INTO auth_challenges(id, purpose, target_user_id, token_hash, browser_secret_hash, expires_at, context, created_at) VALUES ($1,'link',$2,decode($3,'hex'),decode($4,'hex'),$5,$6,$7)",
      [id, userId, sha256hex(code), sha256hex(browserSecret), expiresAt, JSON.stringify({ device: context.device?.slice(0, 60) }), now],
    );
  });
  const bot = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "");
  return { id, code, browserSecret, expiresAt, deepLink: bot ? `https://t.me/${bot}?start=link_${code}` : null };
}

export type ApproveResult = "approved" | "invalid" | "expired" | "already_used";

export type LinkPreview =
  | { status: "ok"; id: string; createdAt: Date; expiresAt: Date; device: string | null; telegramHasPlan: boolean }
  | { status: Exclude<ApproveResult, "approved"> };

/**
 * Шаг 2а (бот, deep link или /link): код проверяется и запоминается отправитель, но НИЧЕГО не одобряется.
 * Бот показывает контекст и кнопки «Разрешить» / «Отклонить» — защита от фишинговой ссылки.
 */
export async function previewLink(code: string, tgId: number | string, now = new Date()): Promise<LinkPreview> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(code)) return { status: "invalid" };
  const db = await getDb();
  return db.tx(async (q) => {
    const r = await q.query<{ id: string; status: string; expires_at: Date; created_at: Date; context: unknown }>(
      "SELECT id, status, expires_at, created_at, context FROM auth_challenges WHERE token_hash=decode($1,'hex') AND purpose='link' FOR UPDATE", [sha256hex(code)]);
    const c = r.rows[0];
    if (!c) return { status: "invalid" as const };
    if (c.status !== "pending") return { status: "already_used" as const };
    if (new Date(c.expires_at) <= now) return { status: "expired" as const };
    await q.query("UPDATE auth_challenges SET previewed_subject=$2 WHERE id=$1", [c.id, String(tgId)]);
    const ctx = (typeof c.context === "string" ? JSON.parse(c.context) : c.context) as LinkContext | null;
    const tgUser = await q.query("SELECT 1 FROM identities i JOIN books b ON b.user_id=i.user_id WHERE i.provider='telegram' AND i.issuer=$1 AND i.subject=$2", [TG_ISSUER, String(tgId)]);
    return { status: "ok" as const, id: c.id, createdAt: new Date(c.created_at), expiresAt: new Date(c.expires_at), device: ctx?.device ?? null, telegramHasPlan: tgUser.rows.length > 0 };
  });
}

/** Шаг 2б (бот, кнопка «Разрешить»): одобрить может только тот, кому бот показал запрос. Связь ещё не создаётся. */
export async function approveLink(id: string, tgId: number | string, now = new Date()): Promise<ApproveResult> {
  if (!isUuid(id)) return "invalid";
  const db = await getDb();
  return db.tx(async (q) => {
    const r = await q.query<{ status: string; expires_at: Date; previewed_subject: string | null; candidate_subject: string | null }>(
      "SELECT status, expires_at, previewed_subject, candidate_subject FROM auth_challenges WHERE id=$1 AND purpose='link' FOR UPDATE", [id]);
    const c = r.rows[0];
    if (!c || c.previewed_subject !== String(tgId)) return "invalid";
    if (c.status === "approved" && c.candidate_subject === String(tgId)) return "approved"; // повторное нажатие
    if (c.status !== "pending") return "already_used";
    if (new Date(c.expires_at) <= now) return "expired";
    await q.query("UPDATE auth_challenges SET status='approved', candidate_issuer=$2, candidate_subject=$3 WHERE id=$1", [id, TG_ISSUER, String(tgId)]);
    return "approved";
  });
}

/** Кнопка «Отклонить»: запрос отменяется, браузер не получит доступ. */
export async function denyLink(id: string, tgId: number | string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const db = await getDb();
  const r = await db.query("UPDATE auth_challenges SET status='cancelled' WHERE id=$1 AND purpose='link' AND previewed_subject=$2 AND status IN ('pending','approved') RETURNING id", [id, String(tgId)]);
  return r.rows.length > 0;
}

export async function linkStatus(userId: string, id: string): Promise<{ id: string; status: string; expiresAt: Date }> {
  if (!isUuid(id)) throw new ApiError("NOT_FOUND", 404, "Запрос привязки не найден");
  const db = await getDb();
  const r = await db.query<{ id: string; status: string; expires_at: Date }>("SELECT id, status, expires_at FROM auth_challenges WHERE id=$1 AND target_user_id=$2 AND purpose='link'", [id, userId]);
  if (!r.rows[0]) throw new ApiError("NOT_FOUND", 404, "Запрос привязки не найден");
  return { id, status: r.rows[0].status, expiresAt: r.rows[0].expires_at };
}

export interface LinkResult { linked: true; userId: string; mergedInto: "web" | "telegram" }

/**
 * Шаг 3 (исходная веб-сессия + её browserSecret): атомарно потребляет код и привязывает Telegram.
 * Если у обоих аккаунтов уже есть бюджеты, автоматическое объединение запрещено (409).
 * Если данные есть только в Telegram, веб-сессия переходит в Telegram-аккаунт.
 */
export async function confirmLink(userId: string, id: string, browserSecret: string | undefined, now = new Date()): Promise<LinkResult> {
  if (!isUuid(id)) throw new ApiError("NOT_FOUND", 404, "Запрос привязки не найден");
  const db = await getDb();
  return db.tx(async (q) => {
    const r = await q.query<{ status: string; expires_at: Date; candidate_subject: string | null; ok: boolean }>(
      "SELECT status, expires_at, candidate_subject, browser_secret_hash = decode($3,'hex') AS ok FROM auth_challenges WHERE id=$1 AND target_user_id=$2 AND purpose='link' FOR UPDATE",
      [id, userId, sha256hex(browserSecret ?? "")]);
    const c = r.rows[0];
    if (!c) throw new ApiError("NOT_FOUND", 404, "Запрос привязки не найден");
    if (!c.ok) throw new ApiError("LINK_FORBIDDEN", 403, "Подтвердите привязку в том же браузере, где её начали");
    if (c.status === "consumed" || c.status === "cancelled") throw new ApiError("LINK_USED", 409, "Этот код уже использован. Создайте новый.");
    if (new Date(c.expires_at) <= now) throw new ApiError("LINK_EXPIRED", 409, "Код устарел. Создайте новый.");
    if (c.status !== "approved" || !c.candidate_subject) throw new ApiError("LINK_NOT_APPROVED", 409, "Сначала разрешите доступ в Telegram-боте");
    const subject = c.candidate_subject;

    let ex = await q.query<{ id: string; user_id: string }>("SELECT id, user_id FROM identities WHERE provider='telegram' AND issuer=$1 AND subject=$2", [TG_ISSUER, subject]);
    // Блокируем оба аккаунта в стабильном порядке (savePlan блокирует ту же строку users),
    // затем перечитываем identity: между проверкой и удалением никто не создаст бюджет.
    const lockIds = [userId, ex.rows[0]?.user_id].filter((x): x is string => !!x).sort();
    await q.query("SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [lockIds]);
    ex = await q.query<{ id: string; user_id: string }>("SELECT id, user_id FROM identities WHERE provider='telegram' AND issuer=$1 AND subject=$2 FOR UPDATE", [TG_ISSUER, subject]);
    const existing = ex.rows[0];
    if (existing && !lockIds.includes(existing.user_id)) throw new ApiError("IN_PROGRESS", 409, "Привязка изменилась, повторите ещё раз");
    let result: LinkResult = { linked: true, userId, mergedInto: "web" };
    if (!existing) {
      await q.query("INSERT INTO identities(id, user_id, provider, issuer, subject, delivery_address, verified_at) VALUES ($1,$2,'telegram',$3,$4,$4,$5)", [uuid(), userId, TG_ISSUER, subject, now]);
    } else if (existing.user_id !== userId) {
      const hasBook = async (u: string) => (await q.query("SELECT 1 FROM books WHERE user_id=$1", [u])).rows.length > 0;
      const webHas = await hasBook(userId), tgHas = await hasBook(existing.user_id);
      if (webHas && tgHas) throw new ApiError("LINK_CONFLICT", 409, "В Telegram уже есть другой план. Автоматически объединять их мы не будем, чтобы ничего не потерять.");
      if (webHas || !tgHas) {
        // Данные только в вебе (или нигде): переносим Telegram-identity сюда, пустой аккаунт удаляем.
        await q.query("UPDATE identities SET user_id=$1 WHERE id=$2", [userId, existing.id]);
        await q.query("DELETE FROM users u WHERE u.id=$1 AND NOT EXISTS (SELECT 1 FROM identities i WHERE i.user_id=u.id)", [existing.user_id]);
      } else {
        // Данные только в Telegram: веб-identity и сессии переходят к Telegram-аккаунту.
        await q.query("UPDATE identities SET user_id=$1 WHERE user_id=$2", [existing.user_id, userId]);
        await q.query("UPDATE auth_challenges SET target_user_id=$1 WHERE target_user_id=$2", [existing.user_id, userId]);
        await q.query("DELETE FROM conversation_state WHERE user_id=$1", [userId]);
        await q.query("DELETE FROM idempotency_keys WHERE user_id=$1", [userId]);
        await q.query("DELETE FROM users WHERE id=$1", [userId]);
        result = { linked: true, userId: existing.user_id, mergedInto: "telegram" };
      }
    }
    await q.query("UPDATE auth_challenges SET status='consumed', consumed_at=$2 WHERE id=$1", [id, now]);
    return result;
  });
}
