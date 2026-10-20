import { assertSameOrigin, handleError, json, readJson } from "../../../../lib/api";
import { requireUserId } from "../../../../lib/session";
import { createEntryProposal } from "../../../../lib/proposals";
import { proposalFromDecision } from "../../../../lib/coach";
import { parseMinor } from "../../../../lib/engine";
import { enforce, LIMITS } from "../../../../lib/rate-limit";
import { ApiError } from "../../../../lib/util";
import { apiRoute } from "../../../../lib/service-log";
export const dynamic = "force-dynamic";
// Пилот: { type: "create_entry", entry: { direction, amountMinor, date?, description?, occurrenceId?, alreadyIncludedInBalance? } }
// или { type: "from_decision", decisionId } — «Купил — записать» под ответом «Можно?» (товар и цена — из сохранённого расчёта).
async function postHandler(req: Request) {
  try {
    assertSameOrigin(req);
    const userId = await requireUserId();
    await enforce([LIMITS.writePerUser(userId), LIMITS.writePerUserDay(userId)]);
    const body = await readJson(req);
    if (body.type === "from_decision") {
      const r = await proposalFromDecision(userId, String(body.decisionId ?? ""), "web");
      if (!r) throw new ApiError("NOT_FOUND", 404, "Расчёт не найден. Спросите «Можно?» ещё раз или напишите, например, «Купил кофе за 300».");
      return json({ proposal: r.proposal, reply: r.reply }, 201);
    }
    if (body.type !== "create_entry") throw new ApiError("UNSUPPORTED_CHANGE", 422, "Пока поддерживается только create_entry");
    const e = (body.entry ?? {}) as Record<string, unknown>;
    const p = await createEntryProposal(userId, {
      direction: e.direction as "income" | "expense",
      amountMinor: parseMinor(e.amountMinor),
      date: typeof e.date === "string" ? e.date : undefined,
      description: typeof e.description === "string" ? e.description : undefined,
      occurrenceId: typeof e.occurrenceId === "string" ? e.occurrenceId : null,
      alreadyIncludedInBalance: e.alreadyIncludedInBalance === true,
      source: "form",
    });
    return json({ proposal: p }, 201);
  } catch (e) { return handleError(e); }
}
export const POST = apiRoute("entry.create", postHandler);
