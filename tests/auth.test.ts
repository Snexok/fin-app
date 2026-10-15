// Сессии и безопасная привязка Telegram (§8.1, §8.3, §13).
import { describe, it, expect } from "vitest";
import { approveLink, confirmLink, createAnonymousSession, revokeSession, startLink, telegramUserId, userIdForSessionToken, identitiesOf } from "../lib/auth";
import { getForecast } from "../lib/finance-service";
import { getDb } from "../lib/db";
import { NOW, PLAN, rub, tgUser, webUser } from "./helpers";
import { savePlan } from "../lib/finance-service";

describe("sessions", () => {
  it("token is random, only its hash is stored, revocation works", async () => {
    const s = await createAnonymousSession(NOW);
    expect(s.token.length).toBeGreaterThanOrEqual(40);
    expect(await userIdForSessionToken(s.token, NOW)).toBe(s.userId);
    const rows = (await (await getDb()).query<{ n: string }>("SELECT count(*)::text AS n FROM sessions WHERE encode(token_hash,'escape') = $1", [s.token])).rows;
    expect(rows[0].n).toBe("0");
    expect(await userIdForSessionToken("forged-token-forged-token-forged", NOW)).toBeNull();
    expect(await userIdForSessionToken(s.userId, NOW)).toBeNull(); // знание userId — не сессия
    await revokeSession(s.token);
    expect(await userIdForSessionToken(s.token, NOW)).toBeNull();
  });
  it("expired session is rejected", async () => {
    const s = await createAnonymousSession(NOW);
    expect(await userIdForSessionToken(s.token, new Date(NOW.getTime() + 181 * 86_400_000))).toBeNull();
  });
});

describe("telegram link", () => {
  it("full flow: web code -> bot approves -> same browser confirms; data shared", async () => {
    const web = await webUser();
    const link = await startLink(web.userId, NOW);
    expect(link.deepLink).toBe(`https://t.me/mozhno_test_bot?start=link_${link.code}`);
    expect(await approveLink(link.code, 555001, NOW)).toBe("approved");
    const r = await confirmLink(web.userId, link.id, link.browserSecret, NOW);
    expect(r).toMatchObject({ linked: true, userId: web.userId });
    expect(await telegramUserId(555001, false)).toBe(web.userId);
    expect((await identitiesOf(web.userId)).map((i) => i.provider).sort()).toEqual(["anonymous", "telegram"]);
  });

  it("knowing someone's user id or a guessed code does not allow linking", async () => {
    const victim = await webUser();
    expect(await approveLink(victim.userId.replace(/-/g, "").slice(0, 20), 666001, NOW)).toBe("invalid");
    expect(await approveLink("not a code!", 666001, NOW)).toBe("invalid");
    expect(await telegramUserId(666001, false)).toBeNull();
  });

  it("confirmation requires the original browser secret", async () => {
    const web = await webUser();
    const link = await startLink(web.userId, NOW);
    await approveLink(link.code, 777001, NOW);
    await expect(confirmLink(web.userId, link.id, "wrong", NOW)).rejects.toMatchObject({ code: "LINK_FORBIDDEN" });
    const other = await webUser();
    await expect(confirmLink(other.userId, link.id, link.browserSecret, NOW)).rejects.toMatchObject({ status: 404 });
  });

  it("used and expired codes are rejected", async () => {
    const web = await webUser();
    const link = await startLink(web.userId, NOW);
    await approveLink(link.code, 888001, NOW);
    await confirmLink(web.userId, link.id, link.browserSecret, NOW);
    expect(await approveLink(link.code, 888002, NOW)).toBe("already_used");
    await expect(confirmLink(web.userId, link.id, link.browserSecret, NOW)).rejects.toMatchObject({ code: "LINK_USED" });
    const l2 = await startLink(web.userId, NOW);
    expect(await approveLink(l2.code, 888003, new Date(NOW.getTime() + 11 * 60_000))).toBe("expired");
  });

  it("approval by a different Telegram account after approval is refused", async () => {
    const web = await webUser();
    const link = await startLink(web.userId, NOW);
    expect(await approveLink(link.code, 999001, NOW)).toBe("approved");
    expect(await approveLink(link.code, 999002, NOW)).toBe("already_used");
  });

  it("both accounts have budgets -> 409, no automatic merge", async () => {
    const web = await webUser();
    const tg = await tgUser({ ...PLAN, balanceMinor: rub(1) });
    const link = await startLink(web.userId, NOW);
    await approveLink(link.code, tg.tgId, NOW);
    await expect(confirmLink(web.userId, link.id, link.browserSecret, NOW)).rejects.toMatchObject({ code: "LINK_CONFLICT", status: 409 });
    expect((await getForecast(tg.userId, NOW))!.book.balanceMinor).toBe(rub(1));
  });

  it("data only in Telegram -> web session moves to the Telegram account", async () => {
    const web = await webUser(null);
    const tg = await tgUser({ ...PLAN, balanceMinor: rub(4242) });
    const link = await startLink(web.userId, NOW);
    await approveLink(link.code, tg.tgId, NOW);
    const r = await confirmLink(web.userId, link.id, link.browserSecret, NOW);
    expect(r).toMatchObject({ userId: tg.userId, mergedInto: "telegram" });
    expect(await userIdForSessionToken(web.token, NOW)).toBe(tg.userId);
    expect((await getForecast(tg.userId, NOW))!.book.balanceMinor).toBe(rub(4242));
  });

  it("web plan + empty telegram user: identity moves to web", async () => {
    const web = await webUser();
    const tgId = 121212;
    const empty = (await telegramUserId(tgId))!;
    const link = await startLink(web.userId, NOW);
    await approveLink(link.code, tgId, NOW);
    await confirmLink(web.userId, link.id, link.browserSecret, NOW);
    expect(await telegramUserId(tgId, false)).toBe(web.userId);
    expect((await (await getDb()).query("SELECT 1 FROM users WHERE id=$1", [empty])).rows).toHaveLength(0);
    await savePlan(web.userId, PLAN, "form", NOW);
  });
});
