import { json } from "../../../lib/api";
import { dbReady } from "../../../lib/db";
export const dynamic = "force-dynamic";
// Публичный readiness: только { ok }. Детали конфигурации не раскрываются. 503, если БД недоступна.
export async function GET() {
  const db = await dbReady();
  return json({ ok: db.ok }, db.ok ? 200 : 503);
}
