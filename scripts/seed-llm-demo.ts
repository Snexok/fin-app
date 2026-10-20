// ДЕМО-журнал стоимости LLM (ai_usage, budget_buckets) ТОЛЬКО для локальной временной БД — скриншоты карточки «LLM и бюджет».
// Запуск (после scripts/seed-analytics-demo.ts в ту же БД, чтобы были DAU):
//   MOZHNO_DB=pglite PGLITE_DIR=/tmp/pglite-llm-demo LLM_DEMO=1 npx tsx scripts/seed-llm-demo.ts
// Все строки помечены demo=true (ai_usage.demo, budget_buckets.demo), request_id начинается с «demo-». Настоящие вызовы
// модели не выполняются; токены и задержки синтетические, стоимость — по реальной таблице цен (lib/llm/prices.ts).
import { getDb } from "../lib/db";
import { budgetDay, llmConfig } from "../lib/llm/config";
import { estimateTokens, sttCostMicro, tokenCostMicro } from "../lib/llm/prices";

const dir = process.env.PGLITE_DIR ?? "";
if (process.env.LLM_DEMO !== "1" || process.env.MOZHNO_DB !== "pglite" || !dir.startsWith("/tmp/") || process.env.DATABASE_URL || process.env.POSTGRES_URL) {
  console.error("Отказ: демо-журнал LLM пишется только в локальный PGlite под /tmp (LLM_DEMO=1, MOZHNO_DB=pglite, PGLITE_DIR=/tmp/...).");
  process.exit(1);
}

let seed = 20261018;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const between = (a: number, b: number) => Math.round(a + rnd() * (b - a));
const PRIMARY = "gigachat3.5-432b-a28b", QWEN = "qwen3.5-397b-a17b", DEEPSEEK = "deepseek-v4-pro";
const LAT: Record<string, [number, number]> = { [PRIMARY]: [650, 2100], [QWEN]: [1400, 3900], [DEEPSEEK]: [1800, 5200] };
const TOK: Record<string, [number, number, number, number]> = {
  intent_parse: [620, 820, 35, 80], explain: [1150, 1500, 130, 230], compare: [1600, 2200, 160, 260], weekly_review: [2600, 3400, 380, 600],
};
const MAX_OUT: Record<string, number> = { intent_parse: 120, explain: 300, compare: 350, weekly_review: 600 };
type Row = (string | number | boolean | null | Date)[];
const COLS = "created_at, budget_day, request_id, attempt, subject, channel, purpose, provider, model, prompt_tokens, completion_tokens, audio_ms, usage_estimated, reserved_microrub, cost_microrub, price_version, latency_ms, status, error_code, fallback_from, ai_answer, internal, demo";

async function main() {
  const db = await getDb();
  const cfg = llmConfig();
  await db.query("DELETE FROM ai_usage WHERE demo");
  await db.query("DELETE FROM budget_buckets WHERE demo");
  const ev = (await db.query<{ subject: string; channel: string; t: Date; name: string }>(
    `SELECT subject, channel, occurred_at t, name FROM analytics_events
      WHERE demo AND occurred_at > now() - interval '40 days' AND name IN ('purchase_result', 'proposal_created', 'onboarding_step_unknown')
      ORDER BY occurred_at`)).rows;
  const internalSubj = new Set((await db.query<{ subject: string }>(
    "SELECT DISTINCT subject FROM analytics_events WHERE demo AND occurred_at > now() - interval '40 days' ORDER BY subject LIMIT 6")).rows.map((r) => r.subject));
  const rows: Row[] = [];
  const perUserDay = new Map<string, number>();
  let n = 0;
  const op = (purpose: string, subject: string, channel: string, t: Date) => {
    const day = budgetDay(t);
    const key = `${subject}|${day}`;
    const rid = `demo-${(++n).toString(36).padStart(6, "0")}-${Math.floor(rnd() * 1e9).toString(36)}`;
    const internal = internalSubj.has(subject);
    const userSpent = perUserDay.get(key) ?? 0;
    if (purpose === "voice_transcribe") {
      const sec = between(4, 28), cost = sttCostMicro(sec);
      if (userSpent + cost > cfg.userSoftCapMicro) { rows.push([t, day, rid, 1, subject, channel, purpose, "sber500-proxy", "whisper-1", 0, 0, null, false, 0, 0, "stt-0.61kop-s", 0, "budget_denied", "LLM_BUDGET_USER", null, false, internal, true]); return; }
      perUserDay.set(key, userSpent + cost);
      rows.push([t, day, rid, 1, subject, channel, purpose, "sber500-proxy", "whisper-1", 0, 0, sec * 1000, false, sttCostMicro(sec + 2), cost, "stt-0.61kop-s", between(900, 2600), "ok", null, null, false, internal, true]);
      return;
    }
    const [pi, pa, ci, ca] = TOK[purpose];
    const pt = between(pi, pa), ct = between(ci, ca);
    const reserve = (m: string) => tokenCostMicro(m, estimateTokens("x".repeat(pt * 3), true) + 24, MAX_OUT[purpose]);
    if (userSpent + reserve(PRIMARY) > cfg.userSoftCapMicro) {
      rows.push([t, day, rid, 1, subject, channel, purpose, "sber500-proxy", PRIMARY, 0, 0, null, false, 0, 0, "cloudru-261015", 0, "budget_denied", "LLM_BUDGET_USER", null, false, internal, true]);
      return;
    }
    // Исходы цепочки: 93 % основная, ~5 % резерв Qwen (503/таймаут основной), ~1 % DeepSeek, ~0,7 % все недоступны.
    const r = rnd();
    const chain: { model: string; status: string; code: string | null }[] =
      r < 0.93 ? [{ model: PRIMARY, status: "ok", code: null }]
      : r < 0.965 ? [{ model: PRIMARY, status: "error", code: "LLM_HTTP_503" }, { model: QWEN, status: "fallback", code: null }]
      : r < 0.983 ? [{ model: PRIMARY, status: "timeout", code: "LLM_TIMEOUT" }, { model: QWEN, status: "fallback", code: null }]
      : r < 0.993 ? [{ model: PRIMARY, status: "error", code: "LLM_HTTP_502" }, { model: QWEN, status: "error", code: "LLM_HTTP_429" }, { model: DEEPSEEK, status: "fallback", code: null }]
      : [{ model: PRIMARY, status: "timeout", code: "LLM_TIMEOUT" }, { model: QWEN, status: "error", code: "LLM_HTTP_503" }, { model: DEEPSEEK, status: "error", code: "LLM_HTTP_503" }];
    let spent = 0;
    chain.forEach((a, i) => {
      const okish = a.status === "ok" || a.status === "fallback";
      const cost = okish ? tokenCostMicro(a.model, pt, ct) : a.status === "timeout" ? tokenCostMicro(a.model, Math.round(pt * 0.9), 0) : 0;
      spent += cost;
      const lat = a.status === "timeout" ? 8000 + between(0, 40) : okish ? between(...LAT[a.model]) : between(120, 900);
      rows.push([new Date(t.getTime() + i * 3000), day, rid, i + 1, subject, channel, purpose, "sber500-proxy", a.model,
        okish ? pt : a.status === "timeout" ? Math.round(pt * 0.9) : 0, okish ? ct : 0, null, a.status === "timeout", reserve(a.model), cost,
        "cloudru-261015", lat, a.status, a.code, i ? chain[i - 1].model : null, okish && purpose !== "intent_parse", internal, true]);
    });
    perUserDay.set(key, userSpent + spent);
  };
  for (const e of ev) {
    if (e.name === "purchase_result") {
      if (rnd() < 0.42) op("intent_parse", e.subject, e.channel, e.t); // regex не уверен
      if (rnd() < 0.55) op("explain", e.subject, e.channel, new Date(e.t.getTime() + 5000)); // «почему?»
      if (rnd() < 0.12) op("compare", e.subject, e.channel, new Date(e.t.getTime() + 60_000));
      if (e.channel === "telegram" && rnd() < 0.18) op("voice_transcribe", e.subject, e.channel, new Date(e.t.getTime() - 4000));
    } else if (e.name === "proposal_created") {
      if (rnd() < 0.4) op("intent_parse", e.subject, e.channel, e.t);
      if (e.channel === "telegram" && rnd() < 0.2) op("voice_transcribe", e.subject, e.channel, new Date(e.t.getTime() - 4000));
    } else if (rnd() < 0.6) op("intent_parse", e.subject, e.channel, e.t);
  }
  // «Тяжёлый» пользователь сегодня: упирается в мягкий лимит 3 ₽ — дальше ответы шаблонные (budget_denied).
  const heavy = ev.at(-1)?.subject ?? "demo-heavy";
  for (let i = 0; i < 26; i++) op(i % 3 ? "explain" : "compare", heavy, "web", new Date(Date.now() - (26 - i) * 240_000));
  // Недельные разборы (ночью, cron) для части активных за последние 4 недели.
  const weekly = (await db.query<{ subject: string; w: Date }>(
    `SELECT DISTINCT subject, date_trunc('week', occurred_at) + interval '6 days 20 hours' w
       FROM analytics_events WHERE demo AND name = 'user_active' AND occurred_at > now() - interval '28 days' ORDER BY 1, 2`)).rows;
  for (const w of weekly) if (rnd() < 0.15 && w.w.getTime() < Date.now()) op("weekly_review", w.subject, "cron", w.w);
  rows.sort((a, b) => (a[0] as Date).getTime() - (b[0] as Date).getTime());
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    const k = chunk[0].length;
    await db.query(`INSERT INTO ai_usage(${COLS}) VALUES ${chunk.map((_, j) => `(${Array.from({ length: k }, (__, c) => `$${j * k + c + 1}`).join(",")})`).join(",")}`, chunk.flat());
  }
  // Счётчики бюджета — из журнала (как если бы их вела обёртка): день проекта, день пользователя не храним (псевдонимы), весь бюджет.
  await db.query(`INSERT INTO budget_buckets(scope_type, scope_id, period_kind, period_start, spent_microrub, demo)
    SELECT 'project', 'all', 'day', budget_day, sum(cost_microrub), true FROM ai_usage WHERE demo GROUP BY budget_day
    ON CONFLICT (scope_type, scope_id, period_kind, period_start) DO UPDATE SET spent_microrub = EXCLUDED.spent_microrub, demo = true`);
  await db.query(`INSERT INTO budget_buckets(scope_type, scope_id, period_kind, period_start, spent_microrub, demo)
    SELECT 'project', 'all', 'total', $1::date, coalesce(sum(cost_microrub), 0), true FROM ai_usage WHERE demo AND budget_day >= $1::date
    ON CONFLICT (scope_type, scope_id, period_kind, period_start) DO UPDATE SET spent_microrub = EXCLUDED.spent_microrub, demo = true`, [cfg.budgetStart]);
  // Немного «в резерве» прямо сейчас — вызовы в полёте.
  await db.query("UPDATE budget_buckets SET reserved_microrub = 412000 WHERE demo AND period_kind = 'day' AND period_start = $1::date", [budgetDay()]);
  const s = (await db.query<{ n: string; ops: string; cost: string; days: string }>(
    "SELECT count(*) n, count(DISTINCT request_id) ops, sum(cost_microrub) cost, count(DISTINCT budget_day) days FROM ai_usage WHERE demo")).rows[0];
  console.log(`ДЕМО LLM: ${s.n} попыток, ${s.ops} операций, ${(Number(s.cost) / 1e6).toFixed(2)} ₽ за ${s.days} дн. в ${dir} (бюджет с ${cfg.budgetStart})`);
  await db.close();
}
void main();
