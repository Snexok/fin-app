// npm run db:migrate — применяет db/migrations/*.sql к DATABASE_URL (или к локальному PGlite).
import { getDb, migrate } from "../lib/db";
const db = await getDb();
const applied = await migrate(db);
console.log(applied.length ? `Применено: ${applied.join(", ")}` : "Миграции уже применены");
await db.close();
