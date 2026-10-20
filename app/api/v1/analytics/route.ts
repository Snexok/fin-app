import { assertSameOrigin, errorJson, handleError, json, readJson } from "../../../../lib/api";
import { requireUserId } from "../../../../lib/session";
import { enforce, LIMITS } from "../../../../lib/rate-limit";
import { CLIENT_EVENTS, track, trackActivity, validateEvent } from "../../../../lib/analytics";
import { identitiesOf } from "../../../../lib/auth";
import { isUuid } from "../../../../lib/util";
import { apiRoute } from "../../../../lib/service-log";
export const dynamic = "force-dynamic";

const MAX_EVENTS = 20;

/**
 * Пакет клиентских событий. Только allowlist CLIENT_EVENTS (активность и просмотры экранов);
 * финансовые события клиент прислать не может. До 20 событий и 8 КБ на запрос, 60 запросов в минуту.
 */
async function postHandler(req: Request) {
  try {
    assertSameOrigin(req);
    const userId = await requireUserId();
    await enforce([LIMITS.analyticsPerUser(userId), LIMITS.analyticsPerUserDay(userId)]);
    const body = await readJson(req, 8 * 1024);
    const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : null;
    if (!events) return errorJson("INVALID_INPUT", "Нужен events[]", 400);
    // «miniapp» принимаем только у пользователя с привязанным Telegram; иначе — web.
    let channel: "web" | "miniapp" = "web";
    if (body.channel === "miniapp" && (await identitiesOf(userId)).some((i) => i.provider === "telegram")) channel = "miniapp";
    let accepted = 0, rejected = 0, activity = false;
    for (const e of events as Record<string, unknown>[]) {
      const name = typeof e?.name === "string" ? e.name : "";
      if (!(CLIENT_EVENTS as readonly string[]).includes(name)) { rejected++; continue; }
      const v = validateEvent(name, e.props);
      if (!v.ok) { rejected++; continue; }
      if (name === "session_started") { if (!activity) { activity = true; await trackActivity(userId, channel); } accepted++; continue; }
      const id = isUuid(e.id) ? e.id : null;
      if (await track(userId, name as "screen_viewed", v.props as { screen: "home" }, { channel, source: "client", key: id ? `c:${id}` : null })) accepted++;
    }
    return json({ accepted, rejected }, 202);
  } catch (e) { return handleError(e); }
}
export const POST = apiRoute("analytics.batch", postHandler);
