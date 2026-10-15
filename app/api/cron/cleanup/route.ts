import { errorJson, json } from "../../../../lib/api";
import { runRetention } from "../../../../lib/retention";
import { safeEqual } from "../../../../lib/util";
export const dynamic = "force-dynamic";
// Vercel Cron: Authorization: Bearer $CRON_SECRET. Без CRON_SECRET эндпоинт выключен.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return errorJson("NOT_CONFIGURED", "Не настроено", 503);
  if (!safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) return errorJson("FORBIDDEN", "Нет доступа", 403);
  try { return json({ ok: true, deleted: await runRetention() }); }
  catch (e) { console.error("retention error", (e as Error)?.name); return errorJson("INTERNAL", "Ошибка очистки", 500); }
}
