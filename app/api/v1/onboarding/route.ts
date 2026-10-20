// Онбординг-чат: открыть (новая сессия / «Продолжим?» / правка одного слота) и получить ленту.
import { assertSameOrigin, errorJson, handleError, json, readJson } from "../../../../lib/api";
import { requireUserId } from "../../../../lib/session";
import { listMessages } from "../../../../lib/onboarding/session";
import { factsView, onboardingState, openOnboarding, progressOf } from "../../../../lib/onboarding/orchestrator";
import { SLOT_KEYS, type SlotKey } from "../../../../lib/onboarding/protocol";
import { enforce, LIMITS } from "../../../../lib/rate-limit";
import { apiRoute } from "../../../../lib/service-log";
export const dynamic = "force-dynamic";

async function getHandler() {
  try {
    const id = await requireUserId();
    const state = await onboardingState(id);
    return json({ state, messages: state ? await listMessages(id) : [] });
  } catch (e) { return handleError(e); }
}

/** Тело: { mode?: "initial" | "edit", slot?: SlotKey }. */
async function postHandler(req: Request) {
  try {
    assertSameOrigin(req);
    const id = await requireUserId();
    await enforce([LIMITS.chatPerUser(id)]);
    const body = await readJson(req, 4 * 1024);
    const mode = body.mode === "edit" ? "edit" : "initial";
    const slot = typeof body.slot === "string" && (SLOT_KEYS as string[]).includes(body.slot) ? (body.slot as SlotKey) : undefined;
    if (mode === "edit" && !slot) return errorJson("INVALID_INPUT", "Нужен slot", 400);
    const r = await openOnboarding(id, "web", { mode, slot });
    return json({ skip: !!r.skip, messages: r.history, progress: progressOf(r.session), facts: factsView(r.session), phase: r.session.phase, mode: r.session.mode, revision: r.session.revision });
  } catch (e) {
    if ((e as { code?: string }).code === "NO_PLAN") return errorJson("NO_PLAN", "Сначала нужен план", 409);
    return handleError(e);
  }
}
export const GET = apiRoute("onboarding.open", getHandler);
export const POST = apiRoute("onboarding.open", postHandler);
