import { assertSameOrigin, handleError, json, readJson } from "../../../../../lib/api";
import { webUserId } from "../../../../../lib/session";
import { simulate } from "../../../../../lib/finance-service";
import { assertDate, parseMinor } from "../../../../../lib/engine";
import { ApiError } from "../../../../../lib/util";
export const dynamic = "force-dynamic";
// Расчёт покупки. Не меняет финансовую версию. Суммы — строки копеек.
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const body = await readJson(req);
    const p = body.purchase as Record<string, unknown> | undefined;
    if (!p) throw new ApiError("INVALID_INPUT", 400, "Нужен purchase");
    const alts = Array.isArray(body.alternatives) ? (body.alternatives as Record<string, unknown>[]).slice(0, 5) : [];
    const rec = p.recurring as { cadence?: string; everyN?: number } | undefined;
    const sv = await simulate(await webUserId(), {
      item: typeof p.description === "string" ? p.description.slice(0, 120) : "покупка",
      priceMinor: parseMinor(p.priceMinor),
      date: p.date == null ? undefined : assertDate(p.date, "purchase.date"),
      recurring: rec && (rec.cadence === "monthly" || rec.cadence === "weekly") ? { cadence: rec.cadence, everyN: rec.everyN == null ? 1 : Number(rec.everyN) } : undefined,
      alternatives: alts.map((a, i) => ({ key: typeof a.key === "string" ? a.key.slice(0, 40) : `alt${i}`, priceMinor: parseMinor(a.priceMinor), date: a.date == null ? undefined : assertDate(a.date, "alternative.date"), afterIncome: a.afterIncome === true })),
    }, null);
    const s = sv.simulation;
    const sc = (x: typeof s.now) => ({ key: x.key, date: x.date, assessment: x.assessment, priceMinor: x.priceMinor, freeAfterMinor: x.freeAfterMinor, safeDailyAfterMinor: x.safeDailyAfterMinor,
      firstGapDate: x.firstGapDate, gapMinor: x.gapMinor, reserveShortfallMinor: x.reserveShortfallMinor, goalImpact: x.goalImpact, horizonEnd: x.forecast.horizonEnd, limitations: x.forecast.limitations });
    return json({ decisionId: sv.decisionId, meta: sv.meta, waitIsBetter: s.waitIsBetter,
      scenarios: [s.now, ...(s.afterIncome ? [s.afterIncome] : []), ...s.alternatives].map(sc) });
  } catch (e) { return handleError(e); }
}
