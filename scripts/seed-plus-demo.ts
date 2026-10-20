// ДЕМО-события «Плюс и токены» ТОЛЬКО для локальной временной БД — скриншоты карточки дашборда (раздел 9).
// Запуск (после scripts/seed-analytics-demo.ts в ту же БД, чтобы были DAU):
//   MOZHNO_DB=pglite PGLITE_DIR=/tmp/pglite-plus-demo PLUS_DEMO=1 npx tsx scripts/seed-plus-demo.ts
// Все строки demo=true, dedup_key начинается с «demo-plus-». Оплат нет: только просмотры, интерес, AI-ответы и исчерпания.
import { getDb } from "../lib/db";

const dir = process.env.PGLITE_DIR ?? "";
if (process.env.PLUS_DEMO !== "1" || process.env.MOZHNO_DB !== "pglite" || !dir.startsWith("/tmp/") || process.env.DATABASE_URL || process.env.POSTGRES_URL) {
  console.error("Отказ: демо-события Плюса пишутся только в локальный PGlite под /tmp (PLUS_DEMO=1, MOZHNO_DB=pglite, PGLITE_DIR=/tmp/...).");
  process.exit(1);
}
let seed = 20261026;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = <T,>(xs: readonly T[], w: readonly number[]) => { let r = rnd() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < xs.length; i++) { r -= w[i]; if (r <= 0) return xs[i]; } return xs[xs.length - 1]; };

async function main() {
  const db = await getDb();
  await db.query("DELETE FROM analytics_events WHERE demo AND dedup_key LIKE 'demo-plus-%'");
  // День активности пользователя → немного AI-ответов, иногда «закончились», иногда открывают «Плюс».
  const act = (await db.query<{ subject: string; channel: string; t: Date; internal: boolean }>(
    `SELECT subject, channel, occurred_at t, internal FROM analytics_events WHERE demo AND name='user_active' AND occurred_at > now() - interval '45 days' ORDER BY occurred_at`)).rows;
  const rows: unknown[][] = [];
  let n = 0;
  const ev = (name: string, a: (typeof act)[number], mins: number, props: Record<string, string>) =>
    rows.push([`demo-plus-${++n}`, name, a.subject, a.channel, "server", new Date(new Date(a.t).getTime() + mins * 60_000), JSON.stringify(props), a.internal, true]);
  const viewed = new Set<string>(), interested = new Map<string, number>();
  for (const a of act) {
    const k = rnd();
    const answers = k < 0.45 ? 0 : k < 0.8 ? 1 + Math.floor(rnd() * 3) : k < 0.95 ? 4 + Math.floor(rnd() * 6) : 15;
    for (let i = 0; i < answers; i++) ev("ai_answer_consumed", a, 2 + i, { purpose: pick(["explain", "compare", "goal_chat", "weekly_review"], [62, 18, 12, 8]), plan: "beta_plus" });
    if (answers >= 15) ev("tokens_exhausted", a, 40, { plan: "beta_plus", scope: "day" });
    const pv = answers >= 15 ? 0.6 : 0.05;
    if (rnd() < pv) {
      ev("plus_viewed", a, 41, { surface: answers >= 15 ? "exhausted" : pick(["counter", "menu", "answer", "bot"], [45, 25, 15, 15]) });
      viewed.add(a.subject);
      if (rnd() < 0.34) {
        const rep = interested.has(a.subject);
        const price = pick(["299", "399", "499", "none"], [38, 34, 8, 20]);
        interested.set(a.subject, 1);
        ev("plus_interest", a, 42, { price, repeat: String(rep) });
      }
    }
  }
  const cols = "dedup_key,name,subject,channel,source,occurred_at,props,internal,demo";
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    const vals = chunk.map((_, j) => `(${Array.from({ length: 9 }, (_, c) => `$${j * 9 + c + 1}`).join(",")})`).join(",");
    await db.query(`INSERT INTO analytics_events(${cols}) VALUES ${vals} ON CONFLICT (dedup_key) DO NOTHING`, chunk.flat());
  }
  console.log(`demo plus: ${rows.length} событий, открывали ${viewed.size}, заявок ${interested.size}`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
