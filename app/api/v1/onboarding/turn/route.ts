// Ход пользователя в онбординг-чате: текст из поля ввода или выбор варианта (selection).
import { assertSameOrigin, errorJson, handleError, json, readJson } from "../../../../../lib/api";
import { requireUserId } from "../../../../../lib/session";
import { handleTurn } from "../../../../../lib/onboarding/orchestrator";
import { enforce, LIMITS } from "../../../../../lib/rate-limit";
import { apiRoute } from "../../../../../lib/service-log";
export const dynamic = "force-dynamic";

async function postHandler(req: Request) {
  try {
    assertSameOrigin(req);
    const id = await requireUserId();
    const b = await readJson(req, 16 * 1024);
    const clientMessageId = typeof b.clientMessageId === "string" && /^[\w-]{1,100}$/.test(b.clientMessageId) ? b.clientMessageId : null;
    if (!clientMessageId) return errorJson("INVALID_INPUT", "Нужен clientMessageId", 400);
    const text = typeof b.text === "string" ? b.text.slice(0, 2000) : "";
    const sel = b.selection as Record<string, unknown> | undefined;
    const selection = sel && typeof sel.assistantMessageId === "string" && typeof sel.choiceId === "string" && Number.isInteger(sel.revision)
      ? { assistantMessageId: sel.assistantMessageId, choiceId: sel.choiceId, revision: Number(sel.revision) } : undefined;
    if (!selection && !text.trim()) return errorJson("INVALID_INPUT", "Нужен текст или выбор варианта", 400);
    await enforce([LIMITS.chatPerUser(id), LIMITS.chatPerUserDay(id)]);
    const r = await handleTurn(id, { clientMessageId: `web:${clientMessageId}`, text, selection }, "web");
    return json({ messages: r.messages, progress: r.progress, facts: r.facts, done: r.done, phase: r.session.phase, mode: r.session.mode, revision: r.session.revision });
  } catch (e) {
    if ((e as { code?: string }).code === "ONBOARDING_NOT_ACTIVE") return errorJson("ONBOARDING_NOT_ACTIVE", "Онбординг уже завершён", 409);
    return handleError(e);
  }
}
export const POST = apiRoute("onboarding.turn", postHandler);
