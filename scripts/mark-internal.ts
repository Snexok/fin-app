// Пометить пользователя как команду/тест (или снять пометку). Флаг копируется в уже записанные события и журналы.
//   DATABASE_URL=postgres://... npx tsx scripts/mark-internal.ts --telegram 123456789 [--off]
//   DATABASE_URL=postgres://... npx tsx scripts/mark-internal.ts --user <uuid> [--off]
//   DATABASE_URL=postgres://... npx tsx scripts/mark-internal.ts --sync   (все из INTERNAL_TELEGRAM_IDS / INTERNAL_USER_IDS)
//   DATABASE_URL=postgres://... npx tsx scripts/mark-internal.ts --list   (сколько помечено)
// Нужен тот же ANALYTICS_SECRET, что у приложения: по нему вычисляются псевдонимы для обновления событий.
import { getDb } from "../lib/db";
import { setInternal, syncInternalFromEnv } from "../lib/internal-users";
import { isUuid } from "../lib/util";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const db = await getDb();
  const on = !process.argv.includes("--off");
  if (process.argv.includes("--sync")) console.log(`Помечено: ${await syncInternalFromEnv()}`);
  else if (process.argv.includes("--list")) console.log(`Команда/тесты: ${(await db.query<{ n: string }>("SELECT count(*) n FROM users WHERE is_internal")).rows[0].n}`);
  else {
    let userId = arg("user");
    const tg = arg("telegram");
    if (tg) {
      if (!/^\d{1,20}$/.test(tg)) throw new Error("--telegram: нужен числовой Telegram ID");
      userId = (await db.query<{ user_id: string }>("SELECT user_id FROM identities WHERE provider='telegram' AND subject=$1", [tg])).rows[0]?.user_id;
      if (!userId) throw new Error("Пользователь с таким Telegram ID ещё не писал боту");
    }
    if (!isUuid(userId)) throw new Error("Нужен --user <uuid> или --telegram <id>");
    console.log((await setInternal(userId, on)) ? (on ? "Помечен как команда/тест" : "Пометка снята") : "Без изменений");
  }
  await db.close();
}
main().catch((e) => { console.error("mark-internal failed:", (e as Error).message); process.exit(1); });
