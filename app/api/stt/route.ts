import { assertSameOrigin, errorJson, handleError, json, readBody } from "../../../lib/api";
import { requireUserId } from "../../../lib/session";
import { transcribeAudio } from "../../../lib/llm";
import { clientIp, enforce, LIMITS } from "../../../lib/rate-limit";
import { MAX_AUDIO_BYTES, sniffAudio } from "../../../lib/audio";
import { apiRoute } from "../../../lib/service-log";
import { recordVoice, voiceLeft } from "../../../lib/plans";
export const dynamic = "force-dynamic";
async function postHandler(req: Request) {
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
    // Минуты голоса по тарифу (lib/plans): AI-ответы не тратятся; закончились — «напишите текстом», расчёты работают как обычно.
    if ((await voiceLeft(uid)) === 0) return errorJson("VOICE_QUOTA", "Голосовые минуты пока закончились. Напишите текстом — посчитаю так же.", 429);
    // Учёт и бюджет — в lib/llm/stt.ts (ai_usage, purpose=voice_transcribe). Отказ бюджета — тоже «напишите текстом».
    const r = await transcribeAudio(new Blob([bytes], { type: kind.mime }), { filename: `voice.${kind.ext}`, userId: uid });
    if (r.ok) { await recordVoice(uid, r.seconds); return json({ text: r.text }); }
    if (r.reason === "budget") return errorJson("STT_BUDGET", "Голосовой ввод на сегодня исчерпан. Напишите текстом, пожалуйста.", 503);
    return errorJson("STT_UNAVAILABLE", "Распознавание речи сейчас недоступно. Напишите текстом, пожалуйста.", 503);
  } catch (e) { return handleError(e); }
}
export const POST = apiRoute("stt", postHandler);
