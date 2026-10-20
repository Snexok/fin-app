import { assertSameOrigin, errorJson, handleError, json, readJson } from "../../../lib/api";
import { requireUserId } from "../../../lib/session";
import { answer } from "../../../lib/coach";
import { enforce, LIMITS } from "../../../lib/rate-limit";
import { apiRoute } from "../../../lib/service-log";
export const dynamic = "force-dynamic";
// Дата "сегодня" определяется сервером в зоне пользователя; поле today от клиента игнорируется.
async function postHandler(req: Request) {
  try {
    assertSameOrigin(req);
    const id = await requireUserId();
    const { message } = await readJson(req, 16 * 1024);
    if (!message || typeof message !== "string" || !message.trim()) return errorJson("INVALID_INPUT", "Нужен текст сообщения", 400);
    await enforce([LIMITS.chatPerUser(id), LIMITS.chatPerUserDay(id)]);
    return json(await answer(id, message, { channel: "web" }));
  } catch (e) { return handleError(e); }
}
export const POST = apiRoute("chat.message", postHandler);
