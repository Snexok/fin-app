// §13 "API и конкурентность": подтверждения, идемпотентность, версии, доступ к чужому.
import { describe, it, expect } from "vitest";
import { answer } from "../lib/coach";
import { confirmProposal, createEntryProposal, getProposal, rejectProposal } from "../lib/proposals";
import { getForecast, recentEntries, savePlan } from "../lib/finance-service";
import { getDb, resetDbForTests } from "../lib/db";
import { NOW, PLAN, rub, webUser } from "./helpers";

const expense = (amount: number, extra = {}) => ({ direction: "expense" as const, amountMinor: rub(amount), description: "Наушники", ...extra });

describe("proposals", () => {
  it("chat -> proposal -> confirm -> recalculated forecast (one entry)", async () => {
    const { userId } = await webUser();
    const before = (await getForecast(userId, NOW))!;
    const r = await answer(userId, "Купил наушники за 15000", { now: NOW });
    expect(r.proposal).toBeTruthy();
    expect(r.reply).toContain("Записать расход");
    // Пока не подтверждено — ничего не изменилось
    expect((await getForecast(userId, NOW))!.book.balanceMinor).toBe(before.book.balanceMinor);
    const out = await confirmProposal(userId, r.proposal!.id, { revision: 1 }, NOW);
    expect(out.status).toBe(200);
    const after = (await getForecast(userId, NOW))!;
    expect(after.book.balanceMinor).toBe(before.book.balanceMinor - rub(15000));
    expect(BigInt(after.meta.financeVersion)).toBe(BigInt(before.meta.financeVersion) + 1n);
    expect(after.forecast.dailyEnvelopeMinor).toBe(before.forecast.dailyEnvelopeMinor - rub(15000));
    expect(await recentEntries(userId)).toHaveLength(1);
  });

  it("double confirm (same key, different keys, parallel) creates one entry", async () => {
    const { userId } = await webUser();
    const p = await createEntryProposal(userId, expense(1000), NOW);
    const results = await Promise.all([
      confirmProposal(userId, p.id, { revision: 1, idempotencyKey: "k1" }, NOW),
      confirmProposal(userId, p.id, { revision: 1, idempotencyKey: "k1" }, NOW),
      confirmProposal(userId, p.id, { revision: 1, idempotencyKey: "k2" }, NOW),
      confirmProposal(userId, p.id, { revision: 1 }, NOW),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await recentEntries(userId)).toHaveLength(1);
    const v = await getForecast(userId, NOW);
    expect(v!.meta.financeVersion).toBe("3"); // 1 создание бюджета -> 2 план -> 3 одна операция
    // повтор после "потери ответа" возвращает тот же результат
    const again = await confirmProposal(userId, p.id, { revision: 1, idempotencyKey: "k1" }, NOW);
    expect(again.replayed).toBe(true);
    expect(again.body.result).toEqual(results[0].body.result);
  });

  it("same idempotency key with a different body -> 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const { userId } = await webUser();
    const a = await createEntryProposal(userId, expense(100), NOW);
    const b = await createEntryProposal(userId, expense(200), NOW);
    await confirmProposal(userId, a.id, { revision: 1, idempotencyKey: "same" }, NOW);
    await expect(confirmProposal(userId, b.id, { revision: 1, idempotencyKey: "same" }, NOW)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
  });

  it("budget changed between prepare and confirm -> 409 STALE_PROPOSAL with a new revision", async () => {
    const { userId } = await webUser();
    const p = await createEntryProposal(userId, expense(500), NOW);
    const other = await createEntryProposal(userId, expense(700), NOW);
    await confirmProposal(userId, other.id, { revision: 1 }, NOW);
    const stale = await confirmProposal(userId, p.id, { revision: 1 }, NOW);
    expect(stale.status).toBe(409);
    expect((stale.body.error as { code: string }).code).toBe("STALE_PROPOSAL");
    expect((await getProposal(userId, p.id)).revision).toBe(2);
    // старая кнопка не подтверждает новую ревизию
    const old = await confirmProposal(userId, p.id, { revision: 1, idempotencyKey: "old-button" }, NOW);
    expect((old.body.error as { code: string }).code).toBe("PROPOSAL_REVISION_MISMATCH");
    const ok = await confirmProposal(userId, p.id, { revision: 2 }, NOW);
    expect(ok.status).toBe(200);
    expect(await recentEntries(userId)).toHaveLength(2);
  });

  it("someone else's proposal is 404 (no leak)", async () => {
    const a = await webUser();
    const b = await webUser();
    const p = await createEntryProposal(a.userId, expense(100), NOW);
    await expect(confirmProposal(b.userId, p.id, { revision: 1 }, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(getProposal(b.userId, p.id)).rejects.toMatchObject({ status: 404 });
    await expect(rejectProposal(b.userId, p.id)).rejects.toMatchObject({ status: 404 });
    expect(await recentEntries(a.userId)).toHaveLength(0);
  });

  it("rejected and expired proposals are not applied", async () => {
    const { userId } = await webUser();
    const p = await createEntryProposal(userId, expense(100), NOW);
    await rejectProposal(userId, p.id);
    expect((await confirmProposal(userId, p.id, { revision: 1 }, NOW)).status).toBe(409);
    const q = await createEntryProposal(userId, expense(100), NOW);
    const later = new Date(NOW.getTime() + 13 * 3_600_000);
    const out = await confirmProposal(userId, q.id, { revision: 1 }, later);
    expect((out.body.error as { code: string }).code).toBe("PROPOSAL_EXPIRED");
    expect(await recentEntries(userId)).toHaveLength(0);
  });

  it("paying a planned payment closes it without double counting; partial pay keeps the rest", async () => {
    const { userId } = await webUser();
    const before = (await getForecast(userId, NOW))!;
    const r = await answer(userId, "Оплатил аренду 10000", { now: NOW });
    expect(r.reply).toContain("Аренда");
    await confirmProposal(userId, r.proposal!.id, { revision: 1 }, NOW);
    const mid = (await getForecast(userId, NOW))!;
    expect(mid.forecast.mandatoryMinor).toBe(rub(20000));
    expect(mid.forecast.dailyEnvelopeMinor).toBe(before.forecast.dailyEnvelopeMinor); // деньги ушли, обязательство уменьшилось — запас тот же
    const r2 = await answer(userId, "Оплатил аренду 20000", { now: NOW });
    await confirmProposal(userId, r2.proposal!.id, { revision: 1 }, NOW);
    const done = (await getForecast(userId, NOW))!;
    expect(done.forecast.mandatoryMinor).toBe(0n);
    expect(done.forecast.dailyEnvelopeMinor).toBe(before.forecast.dailyEnvelopeMinor);
  });

  it("'зарплата пришла' proposes the expected income; confirming moves the horizon", async () => {
    const { userId } = await webUser();
    const at = new Date("2026-10-25T15:00:00Z");
    const r = await answer(userId, "Зарплата пришла", { now: at });
    expect(r.proposal?.payload.amountMinor).toBe(rub(80000));
    await confirmProposal(userId, r.proposal!.id, { revision: 1 }, at);
    const v = (await getForecast(userId, at))!;
    expect(v.book.balanceMinor).toBe(rub(140000));
    expect(v.forecast.nextIncome).toBeNull();
    expect(v.forecast.horizonKind).toBe("planning_period");
  });

  it("validates amounts and dates strictly", async () => {
    const { userId } = await webUser();
    await expect(createEntryProposal(userId, expense(0), NOW)).rejects.toThrow();
    await expect(createEntryProposal(userId, { ...expense(10), date: "2026-02-31" }, NOW)).rejects.toThrow();
    await expect(createEntryProposal(userId, { ...expense(10), date: "2026-10-20" }, NOW)).rejects.toMatchObject({ code: "FUTURE_DATE" });
  });

  it("re-saving the plan resets the opening balance but keeps history", async () => {
    const { userId } = await webUser();
    const p = await createEntryProposal(userId, expense(1000), NOW);
    await confirmProposal(userId, p.id, { revision: 1 }, NOW);
    await savePlan(userId, { ...PLAN, balanceMinor: rub(55000) }, "form", NOW);
    const v = (await getForecast(userId, NOW))!;
    expect(v.book.balanceMinor).toBe(rub(55000));
    expect(await recentEntries(userId)).toHaveLength(1);
  });
});

describe("persistence", () => {
  it("data survives a restart (file-backed PGlite)", async () => {
    const dir = `/tmp/mozhno-persist-${process.pid}`;
    const prev = process.env.PGLITE_DIR;
    await resetDbForTests();
    process.env.PGLITE_DIR = dir;
    const { userId } = await webUser();
    await resetDbForTests(); // "перезапуск"
    const v = await getForecast(userId, NOW);
    expect(v?.book.balanceMinor).toBe(rub(60000));
    await resetDbForTests();
    process.env.PGLITE_DIR = prev;
    await (await getDb()).query("SELECT 1");
  });
});

describe("rate limits", () => {
  it("fixed window counter blocks after the limit", async () => {
    const { hit } = await import("../lib/rate-limit");
    const t = new Date("2026-10-15T10:00:05Z");
    for (let i = 0; i < 3; i++) expect(await hit("test:k", 3, 60, t)).toBe(true);
    expect(await hit("test:k", 3, 60, t)).toBe(false);
    expect(await hit("test:k", 3, 60, new Date("2026-10-15T10:01:05Z"))).toBe(true);
  });
});
