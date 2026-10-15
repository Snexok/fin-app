// Дедупликация внешних событий (Telegram update_id). Полноценный inbox + jobs — шаг 9.
import { getDb } from "./db";

/** true — событие новое и захвачено; false — повтор, обрабатывать не нужно. */
export async function claimInboxEvent(source: string, eventId: string, payload: unknown = {}): Promise<boolean> {
  const db = await getDb();
  const r = await db.query("INSERT INTO inbox(source, source_event_id, payload) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING source", [source, eventId, JSON.stringify(payload)]);
  return r.rows.length > 0;
}
export async function markInboxProcessed(source: string, eventId: string) {
  await (await getDb()).query("UPDATE inbox SET processed_at=now() WHERE source=$1 AND source_event_id=$2", [source, eventId]);
}
/** Обработка упала: снимаем захват, чтобы повтор Telegram обработался заново. */
export async function releaseInboxEvent(source: string, eventId: string) {
  await (await getDb()).query("DELETE FROM inbox WHERE source=$1 AND source_event_id=$2 AND processed_at IS NULL", [source, eventId]);
}
