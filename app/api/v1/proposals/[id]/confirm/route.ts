import { assertSameOrigin, handleError, json, readJson } from "../../../../../../lib/api";
import { requireUserId } from "../../../../../../lib/session";
import { confirmProposal } from "../../../../../../lib/proposals";
import { getForecast } from "../../../../../../lib/finance-service";
import { forecastToSnapshot } from "../../../../../../lib/engine";
import { enforce, LIMITS } from "../../../../../../lib/rate-limit";
import { ApiError } from "../../../../../../lib/util";
export const dynamic = "force-dynamic";
// Тело: { revision }. Заголовок Idempotency-Key обязателен: один на намерение, повторяется при retry (8-200 символов [A-Za-z0-9_:.-]).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const userId = await requireUserId();
    const key = req.headers.get("idempotency-key")?.trim() ?? "";
    if (!/^[A-Za-z0-9_:.-]{8,200}$/.test(key)) throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", 400, "Нужен заголовок Idempotency-Key (8-200 символов)");
    await enforce([LIMITS.writePerUser(userId), LIMITS.writePerUserDay(userId)]);
    const body = await readJson(req);
    const out = await confirmProposal(userId, (await ctx.params).id, { revision: Number(body.revision), idempotencyKey: key });
    // Результат команды (out.body) отделён от текущего состояния (current), которое считается заново и при replay.
    const v = await getForecast(userId);
    const current = { forecast: v?.forecast ?? null, meta: v?.meta ?? null, snapshot: v ? forecastToSnapshot(v.forecast) : null };
    const error = out.body.error as Record<string, unknown> | undefined;
    const bodyOut = error ? { ...out.body, error: { ...error, requestId: crypto.randomUUID() } } : out.body;
    return json({ ...bodyOut, replayed: out.replayed, current, ...current }, out.status);
  } catch (e) { return handleError(e); }
}
