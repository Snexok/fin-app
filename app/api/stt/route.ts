import { assertSameOrigin, errorJson, handleError, json, readBody } from "../../../lib/api";
import { requireUserId } from "../../../lib/session";
import { transcribe } from "../../../lib/ai/llm";
import { clientIp, enforce, LIMITS } from "../../../lib/rate-limit";
import { MAX_AUDIO_BYTES, sniffAudio } from "../../../lib/audio";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const uid = await requireUserId();
    await enforce([LIMITS.sttPerUser(uid), LIMITS.sttPerIp(clientIp(req.headers))]);
    // Тело читается потоком с лимитом в байтах; multipart разбирается только после проверки размера.
    const raw = await readBody(req, MAX_AUDIO_BYTES + 64 * 1024);
    let fd: FormData;
    try { fd = await new Request("http://local/", { method: "POST", headers: { "content-type": req.headers.get("content-type") ?? "" }, body: raw }).formData(); }
    catch { return errorJson("INVALID_INPUT", "Нужна форма с полем audio", 400); }
    const file = fd.get("audio");
    if (!(file instanceof Blob)) return errorJson("INVALID_INPUT", "Нужна форма с полем audio", 400);
    if (file.size > MAX_AUDIO_BYTES) return errorJson("PAYLOAD_TOO_LARGE", "Запись слишком длинная. Попробуйте покороче.", 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = sniffAudio(bytes);
    if (!kind) return errorJson("UNSUPPORTED_MEDIA", "Нужен аудиофайл", 415);
    try { return json({ text: await transcribe(new Blob([bytes], { type: kind.mime }), `voice.${kind.ext}`) }); }
    catch { return errorJson("STT_UNAVAILABLE", "Распознавание речи сейчас недоступно. Напишите текстом, пожалуйста.", 503); }
  } catch (e) { return handleError(e); }
}
