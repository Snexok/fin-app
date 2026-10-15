// Совместимый адаптер: старая форма (рубли) + новые поля в копейках. См. docs/BACKEND.md.
import { assertSameOrigin, handleError, json, readJson } from "../../../lib/api";
import { webUserId } from "../../../lib/session";
import { storageKind } from "../../../lib/storage";
import { llmEnabled } from "../../../lib/ai/llm";
import { forecastToSnapshot } from "../../../lib/engine";
import { getForecast, legacyProfile, legacyProfileToPlan, listDecisions, recentEntries, savePlan } from "../../../lib/finance-service";
import { identitiesOf } from "../../../lib/auth";
export const dynamic = "force-dynamic";

async function view(id: string) {
  const v = await getForecast(id);
  const ids = await identitiesOf(id);
  return {
    id,
    profile: v ? legacyProfile(v) : null,
    history: await listDecisions(id),
    snapshot: v ? forecastToSnapshot(v.forecast) : null,
    llm: llmEnabled(),
    storage: storageKind(),
    // --- новые поля ---
    forecast: v?.forecast ?? null,
    meta: v?.meta ?? null,
    entries: v ? await recentEntries(id) : [],
    account: { telegramLinked: ids.some((i) => i.provider === "telegram") },
  };
}

export async function GET() {
  try { return json(await view(await webUserId())); } catch (e) { return handleError(e); }
}

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const id = await webUserId();
    let plan;
    try { plan = legacyProfileToPlan(await readJson(req)); }
    catch (e) { return json({ errors: [(e as Error).message] }, 400); }
    try { await savePlan(id, plan, "form"); }
    catch (e) { const c = (e as { code?: string }).code; if (c === "INVALID_AMOUNT" || c === "INVALID_DATE" || c === "INVALID_INPUT") return json({ errors: [(e as Error).message] }, 400); throw e; }
    const v = await view(id);
    return json({ ok: true, snapshot: v.snapshot, forecast: v.forecast, meta: v.meta });
  } catch (e) { return handleError(e); }
}
