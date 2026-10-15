// Сессии и безопасная привязка Telegram (§8.1, §8.3, §13).
import { describe, it, expect } from "vitest";
import { approveLink, confirmLink, denyLink, previewLink, rotateSession, touchSession, createAnonymousSession, revokeSession, startLink, telegramUserId, userIdForSessionToken, identitiesOf } from "../lib/auth";
import { getForecast } from "../lib/finance-service";
import { getDb } from "../lib/db";
import { NOW, PLAN, rub, tgUser, webUser } from "./helpers";
import { savePlan } from "../lib/finance-service";

/** Как в боте: deep link показывает запрос (preview), одобрение — только кнопкой (approveLink по id). */
async function botApprove(code: string, tgId: number, now = NOW) {
  const p = await previewLink(code, tgId, now);
  if (p.status !== "ok") return p.status;
  return approveLink(p.id, tgId, now);
}

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
    expect(await userIdForSessionToken(s.token, new Date(NOW.getTime() + 31 * 86_400_000))).toBeNull();
  });
});

describe("telegram link", () => {
  it("full flow: web code -> bot approves -> same browser confirms; data shared", async () => {
    const web = await webUser();
    const link = await startLink(web.userId, NOW);
    expect(link.deepLink).toBe(`https://t.me/mozhno_test_bot?start=link_${link.code}`);
    expect(await botApprove(link.code, 555001, NOW)).toBe("approved");
    const r = await confirmLink(web.userId, link.id, link.browserSecret, NOW);
    expect(r).toMatchObject({ linked: true, userId: web.userId });
    expect(await telegramUserId(555001, false)).toBe(web.userId);
    expect((await identitiesOf(web.userId)).map((i) => i.provider).sort()).toEqual(["anonymous", "telegram"]);
  });

  it("knowing someone's user id or a guessed code does not allow linking", async () => {
    const victim = await webUser();
    expect(await botApprove(victim.userId.replace(/-/g, "").slice(0, 20), 666001, NOW)).toBe("invalid");
    expect(await botApprove("not a code!", 666001, NOW)).toBe("invalid");
    expect(await telegramUserId(666001, false)).toBeNull();
  });

  it("confirmation requires the original browser secret", async () => {
    const web = await webUser();
    const link = await startLink(web.userId, NOW);
    await botApprove(link.code, 777001, NOW);
    await expect(confirmLink(web.userId, link.id, "wrong", NOW)).rejects.toMatchObject({ code: "LINK_FORBIDDEN" });
    const other = await webUser();
    await expect(confirmLink(other.userId, link.id, link.browserSecret, NOW)).rejects.toMatchObject({ status: 404 });
  });

  it("used and expired codes are rejected", async () => {
    const web = await webUser();
    const link = await startLink(web.userId, NOW);
    await botApprove(link.code, 888001, NOW);
    await confirmLink(web.userId, link.id, link.browserSecret, NOW);
    expect(await botApprove(link.code, 888002, NOW)).toBe("already_used");
    await expect(confirmLink(web.userId, link.id, link.browserSecret, NOW)).rejects.toMatchObject({ code: "LINK_USED" });
    const l2 = await startLink(web.userId, NOW);
    expect(await botApprove(l2.code, 888003, new Date(NOW.getTime() + 11 * 60_000))).toBe("expired");
  });

  it("approval by a different Telegram account after approval is refused", async () => {
    const web = await webUser();
    const link = await startLink(web.userId, NOW);
    expect(await botApprove(link.code, 999001, NOW)).toBe("approved");
    expect(await botApprove(link.code, 999002, NOW)).toBe("already_used");
  });

  it("both accounts have budgets -> 409, no automatic merge", async () => {
    const web = await webUser();
    const tg = await tgUser({ ...PLAN, balanceMinor: rub(1) });
    const link = await startLink(web.userId, NOW);
    await botApprove(link.code, tg.tgId, NOW);
    await expect(confirmLink(web.userId, link.id, link.browserSecret, NOW)).rejects.toMatchObject({ code: "LINK_CONFLICT", status: 409 });
    expect((await getForecast(tg.userId, NOW))!.book.balanceMinor).toBe(rub(1));
  });

  it("data only in Telegram -> web session moves to the Telegram account", async () => {
    const web = await webUser(null);
    const tg = await tgUser({ ...PLAN, balanceMinor: rub(4242) });
    const link = await startLink(web.userId, NOW);
    await botApprove(link.code, tg.tgId, NOW);
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
    await botApprove(link.code, tgId, NOW);
    await confirmLink(web.userId, link.id, link.browserSecret, NOW);
    expect(await telegramUserId(tgId, false)).toBe(web.userId);
    expect((await (await getDb()).query("SELECT 1 FROM users WHERE id=$1", [empty])).rows).toHaveLength(0);
    await savePlan(web.userId, PLAN, "form", NOW);
  });
});

describe("telegram link phishing protection (High #1)", () => {
  it("deep link alone never approves: preview only, approval needs the button", async () => {
    const attacker = await webUser(null);
    const victim = await tgUser({ ...PLAN, balanceMinor: rub(777) });
    const link = await startLink(attacker.userId, NOW, { device: "Chrome, macOS" });
    const p = await previewLink(link.code, victim.tgId, NOW); // жертва нажала Start по ссылке атакующего
    expect(p).toMatchObject({ status: "ok", device: "Chrome, macOS", telegramHasPlan: true });
    await expect(confirmLink(attacker.userId, link.id, link.browserSecret, NOW)).rejects.toMatchObject({ code: "LINK_NOT_APPROVED" });
    expect(await telegramUserId(victim.tgId, false)).toBe(victim.userId);
  });

  it("deny cancels the request; approval afterwards is impossible", async () => {
    const web = await webUser(null);
    const link = await startLink(web.userId, NOW);
    const p = await previewLink(link.code, 424201, NOW);
    if (p.status !== "ok") throw new Error("preview");
    expect(await denyLink(p.id, 424201)).toBe(true);
    expect(await approveLink(p.id, 424201, NOW)).toBe("already_used");
    await expect(confirmLink(web.userId, link.id, link.browserSecret, NOW)).rejects.toMatchObject({ code: "LINK_USED" });
  });

  it("only the Telegram user who was shown the request can approve it", async () => {
    const web = await webUser(null);
    const link = await startLink(web.userId, NOW);
    const p = await previewLink(link.code, 424301, NOW);
    if (p.status !== "ok") throw new Error("preview");
    expect(await approveLink(p.id, 424302, NOW)).toBe("invalid");
    expect(await denyLink(p.id, 424302)).toBe(false);
    expect(await approveLink(p.id, 424301, NOW)).toBe("approved");
    expect(await approveLink(p.id, 424301, NOW)).toBe("approved"); // повторное нажатие
  });
});

describe("session lifetime (Medium #13)", () => {
  it("rotation revokes the old token; sliding renewal extends only after half of TTL", async () => {
    const s = await createAnonymousSession(NOW);
    expect(await touchSession(s.token, NOW)).toBeNull();
    const later = new Date(NOW.getTime() + 20 * 86_400_000);
    const ext = await touchSession(s.token, later);
    expect(ext!.getTime()).toBe(later.getTime() + 30 * 86_400_000);
    const r = await rotateSession(s.token, later);
    expect(r!.userId).toBe(s.userId);
    expect(await userIdForSessionToken(s.token, later)).toBeNull();
    expect(await userIdForSessionToken(r!.token, later)).toBe(s.userId);
  });
});
