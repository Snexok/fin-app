// Inbox внешних событий (Telegram update_id): идемпотентность в Postgres, аренда (lease) и ограниченные повторы.
import { getDb } from "./db";

export const INBOX_LEASE_SEC = 120; // больше maxDuration функции: живой обработчик не перехватят
export const INBOX_MAX_ATTEMPTS = 3;

/** Сохраняет событие целиком (если новое). Повторная доставка того же update_id не создаёт второй записи. */
export async function recordInboxEvent(source: string, eventId: string, payload: unknown): Promise<void> {
  const db = await getDb();
  await db.query("INSERT INTO inbox(source, source_event_id, payload) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [source, eventId, JSON.stringify(payload)]);
}

/**
 * Захват события на обработку: только если оно не обработано, не арендовано другим обработчиком
 * и не исчерпало попытки. Возвращает сохранённый апдейт или null.
 */
export async function leaseInboxEvent(source: string, eventId: string, now = new Date()): Promise<unknown | null> {
  const db = await getDb();
  const r = await db.query<{ payload: unknown }>(
    `UPDATE inbox SET locked_until=$3, attempts=attempts+1
      WHERE source=$1 AND source_event_id=$2 AND processed_at IS NULL AND attempts < $4 AND (locked_until IS NULL OR locked_until < $5)
      RETURNING payload`,
    [source, eventId, new Date(now.getTime() + INBOX_LEASE_SEC * 1000), INBOX_MAX_ATTEMPTS, now]);
  const p = r.rows[0]?.payload;
  return p == null ? null : typeof p === "string" ? JSON.parse(p) : p;
}

export async function markInboxProcessed(source: string, eventId: string, errorCode: string | null = null) {
  await (await getDb()).query("UPDATE inbox SET processed_at=now(), locked_until=NULL, last_error=$3 WHERE source=$1 AND source_event_id=$2", [source, eventId, errorCode]);
}

/** Обработка упала: снимаем аренду (повтор возможен), сохраняем только код ошибки (без текста пользователя). */
export async function releaseInboxEvent(source: string, eventId: string, errorCode: string) {
  await (await getDb()).query("UPDATE inbox SET locked_until=NULL, last_error=$3 WHERE source=$1 AND source_event_id=$2 AND processed_at IS NULL", [source, eventId, errorCode.slice(0, 100)]);
}

/** Необработанные события с истёкшей арендой (для повторов): старые первыми. */
export async function pendingInboxEvents(source: string, limit = 3, now = new Date()): Promise<string[]> {
  const r = await (await getDb()).query<{ id: string }>(
    `SELECT source_event_id AS id FROM inbox WHERE source=$1 AND processed_at IS NULL AND attempts < $2 AND (locked_until IS NULL OR locked_until < $3)
      AND received_at > $4 ORDER BY received_at LIMIT $5`,
    [source, INBOX_MAX_ATTEMPTS, now, new Date(now.getTime() - 3600_000), limit]);
  return r.rows.map((x) => x.id);
}
