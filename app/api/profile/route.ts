// Совместимый адаптер: старая форма (рубли) + новые поля в копейках. См. docs/BACKEND.md.
import { assertSameOrigin, errorJson, handleError, json, readJson } from "../../../lib/api";
import { requireUserId } from "../../../lib/session";
import { storageKind } from "../../../lib/storage";
import { llmEnabled } from "../../../lib/ai/llm";
import { forecastToSnapshot } from "../../../lib/engine";
import { getForecast, legacyProfile, legacyProfileToPlan, listDecisions, recentEntries, savePlan } from "../../../lib/finance-service";
import { identitiesOf } from "../../../lib/auth";
import { enforce, LIMITS } from "../../../lib/rate-limit";
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
  try { return json(await view(await requireUserId())); } catch (e) { return handleError(e); }
}

/** Тело: старая форма профиля + baseFinanceVersion (строка), полученная из meta.financeVersion при открытии формы. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const id = await requireUserId();
    await enforce([LIMITS.planPerUser(id)]);
    const body = await readJson(req);
    const base = body.baseFinanceVersion;
    if (base != null && !(typeof base === "string" && /^\d{1,18}$/.test(base))) return errorJson("INVALID_INPUT", "baseFinanceVersion: нужна строка с числом", 400);
    const plan = legacyProfileToPlan(body);
    await savePlan(id, plan, "form", new Date(), { baseFinanceVersion: base == null ? null : BigInt(base as string), requireBase: true });
    const v = await view(id);
    return json({ ok: true, snapshot: v.snapshot, forecast: v.forecast, meta: v.meta });
  } catch (e) { return handleError(e); }
}
