// Опционально: проверка атомарного резерва на НАСТОЯЩЕМ Postgres с пулом соединений (PGlite сериализует транзакции,
// поэтому там гонки нет по построению). Запуск: LLM_PG_TEST_URL=postgres://… npx vitest run tests/llm-pg.test.ts
// База должна быть пустой/одноразовой: применяются миграции.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { getDb, resetDbForTests } from "../lib/db";
import { budgetState, llmConfig, reserveBudget, settleBudget, type Reservation } from "../lib/llm";

const url = process.env.LLM_PG_TEST_URL;

describe.skipIf(!url)("llm budget on real Postgres: concurrent reservations", () => {
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", url!); vi.stubEnv("MOZHNO_AUTO_MIGRATE", "1"); vi.stubEnv("DATABASE_POOL_MAX", "24"); vi.stubEnv("DATABASE_SSL", "disable");
    await resetDbForTests();
    expect((await getDb()).kind).toBe("postgres");
  });
  afterAll(async () => { await resetDbForTests(); vi.unstubAllEnvs(); });

  it("200 parallel reservations over 24 connections never exceed the daily cap (project and user)", async () => {
    vi.stubEnv("LLM_DAILY_BUDGET_RUB", "1"); vi.stubEnv("LLM_USER_DAILY_SOFT_CAP_RUB", "0.5"); vi.stubEnv("LLM_BUDGET_START", "2031-01-01");
    const cfg = llmConfig();
    const now = new Date(Date.UTC(2031, 0, 1 + Math.floor(Math.random() * 300), 9));
    const users = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
    const rs = await Promise.all(Array.from({ length: 200 }, (_, i) => reserveBudget({ userId: users[i % 3], micro: 30_000, cfg, now })));
    const ok = rs.filter((r) => r.ok) as { ok: true; reservation: Reservation }[];
    const b = await budgetState(cfg, now);
    expect(b.reservedMicro).toBe(ok.length * 30_000);
    expect(b.reservedMicro).toBeLessThanOrEqual(1_000_000);
    expect(ok.length).toBe(33); // 1 ₽ / 0,03 ₽
    const db = await getDb();
    const per = (await db.query<{ scope_id: string; reserved_microrub: string }>("SELECT scope_id, reserved_microrub FROM budget_buckets WHERE scope_type='user' AND period_start=$1::date", [b.day])).rows;
    for (const u of per) expect(Number(u.reserved_microrub)).toBeLessThanOrEqual(500_000);
    await Promise.all(ok.map((r) => settleBudget(r.reservation, 10_000)));
    const after = await budgetState(cfg, now);
    expect(after).toMatchObject({ reservedMicro: 0, spentMicro: ok.length * 10_000 });
  });
});
