import { assertSameOrigin, handleError, json } from "../../../lib/api";
import { currentUserId } from "../../../lib/session";
import { transcribe } from "../../../lib/ai/llm";
import { clientIp, enforce, LIMITS } from "../../../lib/rate-limit";
export const dynamic = "force-dynamic";
const MAX_BYTES = 10 * 1024 * 1024;
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const uid = await currentUserId();
    if (!uid) return json({ error: "Сессия не найдена. Обновите страницу." }, 401);
    await enforce([LIMITS.sttPerUser(uid), LIMITS.sttPerIp(clientIp(req.headers))]);
    const len = Number(req.headers.get("content-length") || 0);
    if (len > MAX_BYTES + 64 * 1024) return json({ error: "Запись слишком длинная. Попробуйте покороче." }, 413);
    const fd = await req.formData();
    const file = fd.get("audio");
    if (!(file instanceof Blob)) return json({ error: "audio required" }, 400);
    if (file.size > MAX_BYTES) return json({ error: "Запись слишком длинная. Попробуйте покороче." }, 413);
    if (file.type && !/^(audio|video)\//.test(file.type)) return json({ error: "Нужен аудиофайл" }, 415);
    try { return json({ text: await transcribe(file, (file as File).name || "voice.webm") }); }
    catch { return json({ error: "Распознавание речи сейчас недоступно. Напишите текстом, пожалуйста." }, 503); }
  } catch (e) { return handleError(e); }
}
