// Настройки мягких напоминаний (веб). Сами напоминания приходят в Telegram.
import { assertSameOrigin, handleError, json, readJson } from "../../../../lib/api";
import { requireUserId } from "../../../../lib/session";
import { getDb } from "../../../../lib/db";
import { getSettings, KIND_LABEL, REMINDER_KINDS, updateSettings, validatePatch } from "../../../../lib/reminders";
import { apiRoute } from "../../../../lib/service-log";
export const dynamic = "force-dynamic";

async function view(id: string) {
  const s = await getSettings(id);
  const tg = await (await getDb()).query("SELECT 1 FROM identities WHERE user_id=$1 AND provider='telegram' LIMIT 1", [id]);
  return { settings: s, telegramLinked: tg.rows.length > 0, kinds: REMINDER_KINDS.map((k) => ({ id: k, label: KIND_LABEL[k] })) };
}

async function getHandler() {
  try { return json(await view(await requireUserId())); } catch (e) { return handleError(e); }
}

async function putHandler(req: Request) {
  try {
    assertSameOrigin(req);
    const id = await requireUserId();
    const body = await readJson(req, 4 * 1024);
    const patch = validatePatch(body);
    // Включение из веба снимает «заблокирован»: пользователь явно хочет получать сообщения.
    await updateSettings(id, patch.enabled === true ? { ...patch, blocked: false } : patch, "web");
    return json(await view(id));
  } catch (e) { return handleError(e); }
}
export const GET = apiRoute("reminders.settings", getHandler);
export const PUT = apiRoute("reminders.settings", putHandler);
