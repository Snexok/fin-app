import { assertSameOrigin, handleError, json, readJson } from "../../../../../lib/api";
import { requireUserId } from "../../../../../lib/session";
import { simulate, userTimezone } from "../../../../../lib/finance-service";
import { assertDateWithin, localDate, parseMinor } from "../../../../../lib/engine";
import { enforce, LIMITS } from "../../../../../lib/rate-limit";
import { getDb } from "../../../../../lib/db";
import { ApiError } from "../../../../../lib/util";
import { track } from "../../../../../lib/analytics";
import { activateReferral } from "../../../../../lib/referrals";
import { apiRoute } from "../../../../../lib/service-log";
export const dynamic = "force-dynamic";
// Расчёт покупки. Не меняет финансовую версию. Суммы — строки копеек. Даты: сегодня .. +366 дней.
async function postHandler(req: Request) {
  try {
    assertSameOrigin(req);
    const userId = await requireUserId();
    await enforce([LIMITS.simPerUser(userId), LIMITS.simPerUserDay(userId)]);
    const body = await readJson(req, 16 * 1024);
    const p = body.purchase as Record<string, unknown> | undefined;
    if (!p || typeof p !== "object") throw new ApiError("INVALID_INPUT", 400, "Нужен purchase");
    const today = localDate(new Date(), await userTimezone(await getDb(), userId));
    const futureDate = (v: unknown, field: string) => (v == null ? undefined : assertDateWithin(v, today, field, { pastDays: 0 }));
    const alts = Array.isArray(body.alternatives) ? (body.alternatives as Record<string, unknown>[]).slice(0, 5) : [];
    const rec = p.recurring as { cadence?: string; everyN?: number } | undefined;
    const sv = await simulate(userId, {
      item: typeof p.description === "string" ? p.description.slice(0, 120) : "покупка",
      priceMinor: parseMinor(p.priceMinor),
      date: futureDate(p.date, "purchase.date"),
      recurring: rec && (rec.cadence === "monthly" || rec.cadence === "weekly") ? { cadence: rec.cadence, everyN: rec.everyN == null ? 1 : Number(rec.everyN) } : undefined,
      alternatives: alts.map((a, i) => ({ key: typeof a?.key === "string" ? a.key.slice(0, 40) : `alt${i}`, priceMinor: parseMinor(a?.priceMinor), date: futureDate(a?.date, "alternative.date"), afterIncome: a?.afterIncome === true })),
    }, null);
    const s = sv.simulation;
    await track(userId, "purchase_asked", {}, { channel: "web", key: sv.decisionId });
    await track(userId, "purchase_result", { verdict: s.now.assessment, engine: "api" }, { channel: "web", key: sv.decisionId });
    await activateReferral(userId, "web");
    const sc = (x: typeof s.now) => ({ key: x.key, date: x.date, assessment: x.assessment, priceMinor: x.priceMinor, freeAfterMinor: x.freeAfterMinor, safeDailyAfterMinor: x.safeDailyAfterMinor,
      firstGapDate: x.firstGapDate, gapMinor: x.gapMinor, reserveShortfallMinor: x.reserveShortfallMinor, goalImpact: x.goalImpact, horizonEnd: x.forecast.horizonEnd, limitations: x.forecast.limitations });
    return json({ decisionId: sv.decisionId, meta: sv.meta, waitIsBetter: s.waitIsBetter,
      scenarios: [s.now, ...(s.afterIncome ? [s.afterIncome] : []), ...s.alternatives].map(sc) });
  } catch (e) { return handleError(e); }
}
export const POST = apiRoute("sim.purchase", postHandler);
