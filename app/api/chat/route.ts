import { assertSameOrigin, handleError, json, readJson } from "../../../lib/api";
import { webUserId } from "../../../lib/session";
import { answer } from "../../../lib/coach";
import { enforce, LIMITS } from "../../../lib/rate-limit";
export const dynamic = "force-dynamic";
// Дата "сегодня" определяется сервером в зоне пользователя; поле today от клиента игнорируется.
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const { message } = await readJson(req);
    if (!message || typeof message !== "string" || !message.trim()) return json({ error: "message required" }, 400);
    const id = await webUserId();
    await enforce([LIMITS.chatPerUser(id), LIMITS.chatPerUserDay(id)]);
    return json(await answer(id, message, { channel: "web" }));
  } catch (e) { return handleError(e); }
}
