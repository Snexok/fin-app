// Команда и тестовые аккаунты: users.is_internal. Такие пользователи по умолчанию исключены из дашборда
// (вид analytics_events_real) и из выгрузки (флаг --include-internal возвращает их).
// Источники пометки:
//  • INTERNAL_TELEGRAM_IDS — Telegram ID через запятую (бот и Mini App помечают при первом же обращении);
//  • INTERNAL_USER_IDS — id пользователей (uuid из /api/v1/me) через запятую, например веб-тестеры;
//  • INTERNAL_INVITE_CODE — секретный код: открыть сайт с ?team=<код> один раз, и текущий веб-пользователь помечен;
//  • scripts/mark-internal.ts — вручную (в т.ч. снять пометку).
// В БД хранится только флаг; сами списки живут в env.
import { getDb, type Queryable } from "./db";
import { pseudonym } from "./analytics";
import { forgetLogMeta } from "./service-log";
import { isUuid, safeEqual } from "./util";

const list = (v: string | undefined) => (v ?? "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
export const internalTelegramIds = () => new Set(list(process.env.INTERNAL_TELEGRAM_IDS).filter((x) => /^\d{1,20}$/.test(x)));
export const internalUserIds = () => new Set(list(process.env.INTERNAL_USER_IDS).filter(isUuid).map((x) => x.toLowerCase()));
export const isInternalTelegramId = (tgId: number | string | null | undefined) => tgId != null && internalTelegramIds().has(String(tgId));

/** Код приглашения команды (≥ 12 символов), сравнение за постоянное время. */
export function checkInviteCode(given: unknown): boolean {
  const code = process.env.INTERNAL_INVITE_CODE;
  return !!code && code.length >= 12 && typeof given === "string" && given.length <= 128 && safeEqual(given, code);
}

/** Уже помеченные в этом процессе: повторная пометка на каждом апдейте не нужна. */
const done = new Set<string>();

/**
 * Пометить (или снять пометку) пользователя. Флаг копируется в уже записанные события и журналы
 * (по псевдонимам всех эпох), поэтому исключение действует и задним числом. Возвращает true, если флаг изменился.
 */
export async function setInternal(userId: string, on = true, q?: Queryable): Promise<boolean> {
  const db = q ?? (await getDb());
  const r = await db.query<{ analytics_epoch: number }>(
    "UPDATE users SET is_internal=$2 WHERE id=$1 AND is_internal IS DISTINCT FROM $2 RETURNING analytics_epoch", [userId, on]);
  forgetLogMeta(userId);
  if (on) done.add(userId); else done.delete(userId);
  if (!r.rows.length) return false;
  const epoch = Number(r.rows[0].analytics_epoch);
  const subjects = Array.from({ length: epoch + 1 }, (_, i) => pseudonym(userId, i));
  await db.query("UPDATE analytics_events SET internal=$2 WHERE subject = ANY($1::text[]) AND internal <> $2", [subjects, on]);
  await db.query("UPDATE service_calls SET internal=$2 WHERE subject = ANY($1::text[]) AND internal <> $2", [subjects, on]);
  await db.query("UPDATE service_errors SET internal=$2 WHERE subject = ANY($1::text[]) AND internal <> $2", [subjects, on]);
  await db.query("UPDATE ai_usage SET internal=$2 WHERE subject = ANY($1::text[]) AND internal <> $2", [subjects, on]);
  return true;
}

/** Пометить, если пользователь в списках env. Никогда не бросает; дешёво для повторных вызовов. */
export async function markInternalIfListed(userId: string | null | undefined, tgId?: number | string | null): Promise<boolean> {
  try {
    if (!userId || done.has(userId)) return false;
    if (!isInternalTelegramId(tgId) && !internalUserIds().has(userId.toLowerCase())) return false;
    await setInternal(userId, true);
    return true;
  } catch { return false; }
}

/** Синхронизация со списками env (cron /api/cron/cleanup): помечает всех из списков. Снимать пометку — только вручную. */
export async function syncInternalFromEnv(): Promise<number> {
  const tg = [...internalTelegramIds()], ids = [...internalUserIds()];
  if (!tg.length && !ids.length) return 0;
  const db = await getDb();
  const r = await db.query<{ id: string }>(
    `SELECT u.id FROM users u WHERE NOT u.is_internal AND (u.id::text = ANY($2::text[])
       OR EXISTS (SELECT 1 FROM identities i WHERE i.user_id = u.id AND i.provider='telegram' AND i.subject = ANY($1::text[])))`, [tg, ids]);
  let n = 0;
  for (const x of r.rows) if (await setInternal(x.id, true, db)) n++;
  return n;
}
