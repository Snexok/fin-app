// Доступ к Postgres. Production: только настоящий Postgres (DATABASE_URL / POSTGRES_URL), без fallback.
// Локально и в тестах: PGlite (Postgres в WASM) — данные в .data/pglite или в памяти.
import { promises as fs } from "fs";
import path from "path";

export interface QueryResult<T> { rows: T[]; rowCount?: number | null }
export interface Queryable { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> }
export interface Db extends Queryable {
  kind: "postgres" | "pglite";
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Скрипт из нескольких выражений без параметров (миграции). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export class DbUnavailableError extends Error {
  code = "DB_UNAVAILABLE";
}

export function dbUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || undefined;
}

/** Какой драйвер будет выбран при текущих переменных окружения. */
export function dbKind(): "postgres" | "pglite" | "unavailable" {
  if (dbUrl()) return "postgres";
  if (process.env.MOZHNO_DB === "pglite") return "pglite";
  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) return "pglite";
  return "unavailable";
}

const toParam = (v: unknown) => (typeof v === "bigint" ? v.toString() : v);

async function createPg(url: string): Promise<Db> {
  const { Pool } = await import("pg");
  const local = /localhost|127\.0\.0\.1|::1/.test(url);
  const sslMode = process.env.DATABASE_SSL; // "disable" | "require" (по умолчанию: проверка сертификата)
  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX || 5),
    ssl: sslMode === "disable" || (local && sslMode !== "require") ? false : { rejectUnauthorized: true },
  });
  return {
    kind: "postgres",
    async query(sql, params = []) { return (params.length ? pool.query(sql, params.map(toParam)) : pool.query(sql)) as never; },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const q: Queryable = { query: (sql, params = []) => (params.length ? client.query(sql, params.map(toParam)) : client.query(sql)) as never };
        const r = await fn(q);
        await client.query("COMMIT");
        return r;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally { client.release(); }
    },
    async exec(sql) {
      // Скрипт целиком на одном клиенте: ROLLBACK при ошибке уходит в то же соединение.
      const client = await pool.connect();
      try { await client.query(sql); }
      catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
      finally { client.release(); }
    },
    close: () => pool.end(),
  };
}

async function createPglite(dir: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (!dir.startsWith("memory://")) await fs.mkdir(dir, { recursive: true });
  const pg = new PGlite(dir);
  await pg.waitReady;
  // PGlite — одно соединение: сериализуем транзакции, чтобы они не перемешались.
  let chain: Promise<unknown> = Promise.resolve();
  const lock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  const raw: Queryable = { query: async (sql, params = []) => (await pg.query(sql, params.map(toParam))) as never };
  return {
    kind: "pglite",
    query: (sql, params) => lock(() => raw.query(sql, params)),
    tx: (fn) => lock(async () => {
      await raw.query("BEGIN");
      try { const r = await fn(raw); await raw.query("COMMIT"); return r; }
      catch (e) { await raw.query("ROLLBACK").catch(() => {}); throw e; }
    }),
    exec: (sql) => lock(async () => { await pg.exec(sql); }),
    close: () => pg.close(),
  };
}

export async function migrate(db: Db): Promise<string[]> {
  const dir = path.join(process.cwd(), "db", "migrations");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  if (db.kind === "postgres") {
    // Один мигратор одновременно: advisory lock на всё время применения.
    return db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(727274)");
      await q.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const done = new Set((await q.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
      const applied: string[] = [];
      for (const f of files) {
        if (done.has(f)) continue;
        await q.query(await fs.readFile(path.join(dir, f), "utf8"));
        await q.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
        applied.push(f);
      }
      return applied;
    });
  }
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await fs.readFile(path.join(dir, f), "utf8");
    if (!/^[\w.-]+$/.test(f)) throw new Error(`Bad migration name ${f}`);
    try { await db.exec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations(name) VALUES ('${f}');\nCOMMIT;`); }
    catch (e) { await db.exec("ROLLBACK").catch(() => {}); throw e; }
    applied.push(f);
  }
  return applied;
}

const g = globalThis as unknown as { __mozhnoDb?: Promise<Db> };

/** Общий пул. PGlite мигрирует автоматически; Postgres — через `npm run db:migrate` (или MOZHNO_AUTO_MIGRATE=1). */
export function getDb(): Promise<Db> {
  if (g.__mozhnoDb) return g.__mozhnoDb;
  const p = (async () => {
    const kind = dbKind();
    if (kind === "unavailable") throw new DbUnavailableError("Postgres не настроен: задайте DATABASE_URL");
    const db = kind === "postgres" ? await createPg(dbUrl()!) : await createPglite(process.env.PGLITE_DIR || path.join(process.cwd(), ".data", "pglite"));
    if (kind === "pglite" || process.env.MOZHNO_AUTO_MIGRATE === "1") await migrate(db);
    return db;
  })();
  g.__mozhnoDb = p;
  p.catch(() => { if (g.__mozhnoDb === p) g.__mozhnoDb = undefined; });
  return p;
}

/** Только для тестов: сбросить синглтон. */
export async function resetDbForTests(): Promise<void> {
  const p = g.__mozhnoDb; g.__mozhnoDb = undefined;
  if (p) await (await p).close().catch(() => {});
}

export async function dbReady(): Promise<{ ok: boolean; kind: string; error?: string }> {
  try { const db = await getDb(); await db.query("SELECT 1"); return { ok: true, kind: db.kind }; }
  catch (e) { return { ok: false, kind: dbKind(), error: (e as { code?: string }).code ?? "DB_ERROR" }; }
}
