// Черновики диалога (шаг онбординга в боте, предмет покупки в ожидании цены). Не финансовые данные.
import { getDb } from "./db";

export type Channel = "web" | "telegram";

export async function getState<T = Record<string, unknown>>(userId: string, channel: Channel): Promise<T | null> {
  const db = await getDb();
  const r = await db.query<{ state: unknown }>("SELECT state FROM conversation_state WHERE user_id=$1 AND channel=$2", [userId, channel]);
  const s = r.rows[0]?.state;
  return s == null ? null : ((typeof s === "string" ? JSON.parse(s) : s) as T);
}

export async function setState(userId: string, channel: Channel, state: unknown | null): Promise<void> {
  const db = await getDb();
  if (state == null) { await db.query("DELETE FROM conversation_state WHERE user_id=$1 AND channel=$2", [userId, channel]); return; }
  await db.query(
    "INSERT INTO conversation_state(user_id, channel, state, updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (user_id, channel) DO UPDATE SET state=EXCLUDED.state, updated_at=now()",
    [userId, channel, JSON.stringify(state, (_k, x) => (typeof x === "bigint" ? x.toString() : x))]);
}
