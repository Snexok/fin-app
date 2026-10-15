import { assertSameOrigin, handleError, json, readJson } from "../../../../lib/api";
import { requireUserId } from "../../../../lib/session";
import { createEntryProposal } from "../../../../lib/proposals";
import { parseMinor } from "../../../../lib/engine";
import { enforce, LIMITS } from "../../../../lib/rate-limit";
import { ApiError } from "../../../../lib/util";
export const dynamic = "force-dynamic";
// Пилот: только { type: "create_entry", entry: { direction, amountMinor, date?, description?, occurrenceId?, alreadyIncludedInBalance? } }.
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const userId = await requireUserId();
    await enforce([LIMITS.writePerUser(userId), LIMITS.writePerUserDay(userId)]);
    const body = await readJson(req);
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
