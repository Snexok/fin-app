// Хранилище: только Postgres (lib/db.ts). Старый JSON-файл удалён; перенос — отдельным скриптом (см. docs/BACKEND.md).
import { dbKind } from "./db";
export { getDb, dbReady } from "./db";

/** Совместимое значение для UI: "postgres" | "pglite" | "unavailable". */
export function storageKind(): string { return dbKind(); }
