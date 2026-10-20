// ДЕМО-данные аналитики ТОЛЬКО для локальной временной БД (скриншоты дашборда).
// Запуск: MOZHNO_DB=pglite PGLITE_DIR=/tmp/pglite-analytics-demo ANALYTICS_DEMO=1 npx tsx scripts/seed-analytics-demo.ts
// Все строки помечены demo=true; псевдонимы случайные, пользователей в users не создаёт.
// Сценарий (180 дней): рост притока, недельная сезонность (выходные тише, пик в понедельник), заметная потеря на шаге «Доход»
// (после «релиза» 21 день назад — меньше), бот удерживает лучше веба, напоминания повышают шанс зайти в тот же день,
// «Кассовый разрыв» чаще в конце месяца.
import { randomBytes } from "node:crypto";
import { getDb } from "../lib/db";

const dir = process.env.PGLITE_DIR ?? "";
if (process.env.ANALYTICS_DEMO !== "1" || process.env.MOZHNO_DB !== "pglite" || !dir.startsWith("/tmp/") || process.env.DATABASE_URL || process.env.POSTGRES_URL) {
  console.error("Отказ: демо-данные пишутся только в локальный PGlite под /tmp (ANALYTICS_DEMO=1, MOZHNO_DB=pglite, PGLITE_DIR=/tmp/...).");
  process.exit(1);
}

let seed = 20261017;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = <T,>(xs: [T, number][]): T => { let x = rnd() * xs.reduce((a, [, w]) => a + w, 0); for (const [v, w] of xs) { if ((x -= w) <= 0) return v; } return xs[0][0]; };
const poisson = (l: number) => { let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= rnd(); } while (p > L); return k - 1; };
const hex = (n: number) => randomBytes(n).toString("hex");
const MIN = 60_000, DAY = 86_400_000, HISTORY = 180;
const WEEKDAY = [0.72, 1.18, 1.08, 1.04, 1.0, 0.95, 0.68]; // вс..сб

type Row = [string, string, string, string | null, string, string, Date, string];
const rows: Row[] = [];
const now = Date.now();
const today0 = Math.floor(now / DAY) * DAY;
const add = (name: string, subject: string, channel: string, t: number, props: Record<string, string> = {}, attempt: string | null = null, source = "server") => {
  if (t >= now) return;
  rows.push([hex(20), name, subject, attempt, channel, source, new Date(Math.floor(t / MIN) * MIN), JSON.stringify(props)]);
};
const wd = (t: number) => new Date(t).getUTCDay();
const hourOf = () => (8 + pick<number>([[0, 2], [1, 3], [2, 2], [4, 2], [6, 2], [9, 3], [11, 4], [12, 3], [13, 2]]) + rnd()) * 60 * MIN;

const VERDICT = (t: number): [string, number][] => {
  const late = new Date(t).getUTCDate() >= 20;
  return [["fits_plan", late ? 42 : 56], ["reduces_daily_margin", 23], ["touches_protected_money", late ? 13 : 9], ["cash_gap", late ? 15 : 6], ["insufficient_data", 6]];
};
const CLICK: Record<string, number> = { payment_due: 0.41, payday: 0.48, onboarding: 0.24, log_nudge: 0.14, weekly: 0.11, morning: 0.06 };
const ACTION: Record<string, string> = { payment_due: "paid", payday: "inc", onboarding: "ob", log_nudge: "log", weekly: "log", morning: "log" };
const DISABLE: Record<string, number> = { payment_due: 0.006, payday: 0.008, onboarding: 0.03, log_nudge: 0.03, weekly: 0.025, morning: 0.06 };

let users = 0;
for (let k = HISTORY; k >= 1; k--) {
  const day0 = today0 - k * DAY;
  // Приток: рост от ~5 до ~30 в день + сезонность + шум.
  const growth = 5 + 25 * Math.pow((HISTORY - k) / HISTORY, 1.4);
  const n = poisson(growth * WEEKDAY[wd(day0)]);
  for (let u = 0; u < n; u++) simulate(day0 + hourOf(), k <= 21);
}

function simulate(start: number, improved: boolean) {
  users++;
  const subject = hex(16);
  const channel = pick([["web", 44], ["telegram", 44], ["miniapp", 12]]);
  const attempt = hex(12);
  let t = start;
  add("session_started", subject, channel, t); add("user_active", subject, channel, t);
  add("onboarding_started", subject, channel, t, { mode: "initial" }, attempt);
  const input = () => pick([["text", 60], ["choice", 40]]);
  const step = (s: string, p: number, mix: [string, number][]): boolean => {
    t += (8 + rnd() * 30) * 1000;
    add("onboarding_step_shown", subject, channel, t, { step: s }, attempt);
    if (rnd() < (s === "income" ? 0.32 : 0.12)) { t += 20_000; add("onboarding_not_understood", subject, channel, t, { step: s, input: rnd() < 0.85 ? "text" : "choice" }, attempt); }
    if (rnd() > p) return false;
    if (rnd() < 0.03) t += DAY * (0.4 + rnd());
    t += (12 + rnd() * (s === "income" ? 140 : 45)) * 1000;
    const o = pick(mix);
    if (o === "answered") add("onboarding_step_answered", subject, channel, t, { step: s, input: input(), answer_kind: s === "payments" && rnd() < 0.2 ? "none" : "value" }, attempt);
    else add(`onboarding_step_${o}`, subject, channel, t, { step: s, input: "choice" }, attempt);
    return true;
  };
  let completed = false, valued = false;
  flow: {
    if (!step("balance", 0.93, [["answered", 97], ["unknown", 3]])) break flow;
    // Заметная потеря на «Доходе»; после релиза (последние 21 день) — меньше.
    // В боте на «Доходе» теряем больше (длинный вопрос без кнопок-вариантов).
    if (!step("income", (improved ? 0.84 : 0.7) - (channel === "telegram" ? 0.12 : 0), [["answered", 70], ["unknown", 25], ["skipped", 5]])) break flow;
    if (rnd() < 0.22 && !step("planningDays", 0.95, [["answered", 100]])) break flow;
    t += 4000; add("onboarding_preview_shown", subject, channel, t, { preliminary: "true" }, attempt); valued = true;
    if (!step("payments", 0.9, [["answered", 75], ["unknown", 15], ["skipped", 10]])) break flow;
    if (!step("reserve", 0.94, [["answered", 46], ["unknown", 44], ["skipped", 10]])) break flow;
    if (!step("essentialDaily", 0.95, [["answered", 58], ["unknown", 32], ["skipped", 10]])) break flow;
    if (!step("goal", 0.97, [["answered", 30], ["skipped", 70]])) break flow;
    if (rnd() < 0.16) { t += 30_000; add("onboarding_corrected", subject, channel, t, { step: pick([["balance", 50], ["income", 25], ["payments", 25]]), input: "text" }, attempt); }
    t += 20_000; add("onboarding_preview_shown", subject, channel, t, { preliminary: "false" }, attempt);
    if (rnd() < 0.94) { add("onboarding_completed", subject, channel, t + 5000, { mode: "initial", duration: t - start < 3 * MIN ? "1_3m" : t - start < 10 * MIN ? "3_10m" : "10_60m" }, attempt); completed = true; }
  }
  const tgUser = channel !== "web" || rnd() < 0.2;
  // Склонность к возврату: бот удерживает лучше; завершившие — гораздо лучше.
  const loyalty = (completed ? 1 : valued ? 0.35 : 0.08) * (channel === "telegram" ? 1.25 : channel === "miniapp" ? 1.1 : 0.85) * (0.5 + rnd());
  const halfLife = 2.5 + rnd() * 5;
  const plateau = 0.025 + rnd() * 0.07;
  let remindersOff = false;
  for (let k = 0; ; k++) {
    const dayStart = Math.floor(start / DAY) * DAY + k * DAY;
    if (dayStart >= now) break;
    let reminded = false, kind = "";
    if (tgUser && !remindersOff && k > 0 && rnd() < 0.22) {
      kind = completed ? pick([["payment_due", 30], ["payday", 22], ["log_nudge", 18], ["weekly", 16], ["morning", 14]]) : k <= 3 ? "onboarding" : "";
      if (kind) {
        const ts = dayStart + 7 * 60 * MIN;
        add("reminder_sent", subject, "telegram", ts, { kind }); reminded = true;
        if (rnd() < CLICK[kind]) { const tc = ts + (3 + rnd() * 200) * MIN; add("reminder_clicked", subject, "telegram", tc, { kind, action: (kind === "weekly" || kind === "morning") && rnd() < 0.3 ? "less" : ACTION[kind] }); add("session_started", subject, "telegram", tc); add("user_active", subject, "telegram", tc); }
        if (rnd() < DISABLE[kind]) { add("reminder_disabled", subject, "telegram", ts + 40 * MIN, { scope: "kind", kind, reason: "user" }); if (rnd() < 0.3) remindersOff = true; }
      }
    }
    if (k === 0) { activeDay(subject, channel, start + 15 * MIN, completed || valued, true); continue; }
    const p = Math.min(0.9, loyalty * (0.42 * Math.exp(-k / halfLife) + plateau) * WEEKDAY[wd(dayStart)] + (reminded ? 0.08 : 0));
    if (rnd() < p) {
      const ch = tgUser && rnd() < 0.18 ? (channel === "telegram" ? "miniapp" : "telegram") : channel;
      const tt = dayStart + hourOf();
      add("session_started", subject, ch, tt); add("user_active", subject, ch, tt);
      activeDay(subject, ch, tt, completed || valued, false);
    }
    if (loyalty < 0.05 && k > 20) break;
  }
}

function activeDay(subject: string, ch: string, tt: number, engaged: boolean, first: boolean) {
  if (ch !== "telegram") add("screen_viewed", subject, ch, tt + MIN, { screen: pick([["home", 60], ["plan", 15], ["payments", 10], ["history", 10], ["assistant", 5]]) }, null, "client");
  if (!engaged) return;
  const asks = poisson(first ? 0.9 : 0.55 * (rnd() < 0.25 ? 3 : 1));
  const c = ch === "telegram" ? "telegram" : "web";
  for (let i = 0; i < asks; i++) {
    const ta = tt + (2 + i * 3) * MIN;
    add("purchase_asked", subject, c, ta);
    add("purchase_result", subject, c, ta, { verdict: pick(VERDICT(ta)), engine: pick([["llm", 70], ["fallback", 25], ["api", 5]]) });
  }
  for (let i = 0, n = poisson(0.45); i < n; i++) {
    const tp = tt + (10 + i * 2) * MIN; const kind = rnd() < 0.85 ? "expense" : "income";
    add("proposal_created", subject, c, tp, { kind, origin: "chat" });
    const r = rnd();
    if (r < 0.79) { add("proposal_confirmed", subject, c, tp + MIN, { kind }); if (kind === "expense") add("expense_logged", subject, c, tp + MIN, { origin: rnd() < 0.2 ? "manual" : "chat" }); }
    else if (r < 0.91) add("proposal_rejected", subject, c, tp + MIN, { kind });
  }
}

async function main() {
  const db = await getDb();
  await db.query("DELETE FROM analytics_events WHERE demo");
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const vals = chunk.map((_, j) => `($${j * 8 + 1},$${j * 8 + 2},$${j * 8 + 3},$${j * 8 + 4},$${j * 8 + 5},$${j * 8 + 6},$${j * 8 + 7},$${j * 8 + 8}::jsonb,true)`).join(",");
    await db.query(`INSERT INTO analytics_events(dedup_key,name,subject,attempt,channel,source,occurred_at,props,demo) VALUES ${vals} ON CONFLICT (dedup_key) DO NOTHING`, chunk.flat());
  }
  // user_active: один раз в UTC-день на канал (как dedup в track()).
  await db.query(`DELETE FROM analytics_events a USING analytics_events b WHERE a.demo AND b.demo AND a.name='user_active' AND b.name='user_active'
    AND a.subject=b.subject AND a.channel=b.channel AND (a.occurred_at AT TIME ZONE 'UTC')::date = (b.occurred_at AT TIME ZONE 'UTC')::date AND a.id > b.id`);
  await seedServiceLogs(db);
  const c = await db.query<{ n: string }>("SELECT count(*) n FROM analytics_events WHERE demo");
  console.log(`ДЕМО: ${c.rows[0].n} событий, ${users} синтетических псевдонимов за ${HISTORY} дней в ${dir}`);
  await db.close();
}

/**
 * Журналы обращений/ошибок и источники (миграция 007) из тех же синтетических событий: одно обращение на вопрос,
 * ход знакомства, запись и напоминание; ~2 % ошибок с реалистичными кодами; источники первого касания с UTM.
 * Пользователи для user_sources создаются как демо-строки users (только в временной БД под /tmp).
 */
async function seedServiceLogs(db: Awaited<ReturnType<typeof getDb>>) {
  await db.query("DELETE FROM service_calls WHERE demo");
  await db.query("DELETE FROM service_errors WHERE demo");
  await db.query("DELETE FROM users WHERE id IN (SELECT user_id FROM user_sources WHERE demo)");
  await db.query(`INSERT INTO service_calls(occurred_at, subject, channel, call_type, result, code, http_status, latency_ms, demo)
    SELECT occurred_at + (random() * interval '50 seconds'), subject, CASE WHEN name = 'reminder_sent' THEN 'cron' ELSE channel END,
           CASE name WHEN 'purchase_result' THEN CASE WHEN props->>'engine' = 'api' THEN 'sim.purchase' ELSE 'chat.question' END
                     WHEN 'reminder_sent' THEN 'reminder.send' WHEN 'proposal_confirmed' THEN 'proposal.confirm'
                     WHEN 'proposal_created' THEN 'chat.message' WHEN 'screen_viewed' THEN 'plan.view' ELSE 'onboarding.turn' END,
           'ok', NULL, CASE WHEN name = 'reminder_sent' OR channel = 'telegram' THEN NULL ELSE 200 END,
           CASE WHEN name = 'purchase_result' AND props->>'engine' = 'llm' THEN 900 + (random() * 1600)::int
                WHEN name = 'screen_viewed' THEN 40 + (random() * 120)::int ELSE 120 + (random() * 380)::int END, true
      FROM analytics_events WHERE demo AND name IN ('purchase_result', 'onboarding_step_answered', 'onboarding_step_unknown', 'proposal_created', 'proposal_confirmed', 'reminder_sent', 'screen_viewed')`);
  // Ошибки: часть обращений помечаем ошибкой и пишем в service_errors с тем же временем, каналом и кодом.
  await db.query(`WITH e AS (
      UPDATE service_calls SET result = 'error',
             code = CASE WHEN call_type = 'reminder.send' THEN (ARRAY['TG_403','TG_429','SEND_UNCERTAIN'])[1 + floor(random() * 3)::int]
                         WHEN random() < 0.45 THEN 'RATE_LIMITED' WHEN random() < 0.5 THEN 'INVALID_INPUT' WHEN random() < 0.6 THEN 'INTERNAL' ELSE 'DB_UNAVAILABLE' END
       WHERE demo AND random() < CASE WHEN occurred_at > now() - interval '9 days' AND occurred_at < now() - interval '7 days' THEN 0.06 ELSE 0.015 END
       RETURNING occurred_at, subject, channel, call_type, code)
    INSERT INTO service_errors(occurred_at, subject, channel, route, code, http_status, message, demo)
    SELECT occurred_at, subject, channel, call_type, code,
           CASE code WHEN 'RATE_LIMITED' THEN 429 WHEN 'INVALID_INPUT' THEN 422 WHEN 'INTERNAL' THEN 500 WHEN 'DB_UNAVAILABLE' THEN 503 WHEN 'TG_403' THEN 403 WHEN 'TG_429' THEN 429 ELSE NULL END,
           CASE code WHEN 'INTERNAL' THEN 'TypeError' WHEN 'DB_UNAVAILABLE' THEN 'Хранилище временно недоступно' WHEN 'RATE_LIMITED' THEN 'Слишком много запросов' ELSE NULL END, true FROM e`);
  await db.query(`UPDATE service_calls SET http_status = CASE code WHEN 'RATE_LIMITED' THEN 429 WHEN 'INVALID_INPUT' THEN 422 WHEN 'INTERNAL' THEN 500 WHEN 'DB_UNAVAILABLE' THEN 503 ELSE http_status END WHERE demo AND result = 'error' AND channel <> 'cron'`);
  // Первое касание: по одному на синтетический псевдоним с первым визитом за последние 120 дней.
  await db.query(`WITH f AS (
      SELECT DISTINCT ON (subject) subject, channel, occurred_at FROM analytics_events WHERE demo AND name = 'user_active' ORDER BY subject, occurred_at),
    u AS (INSERT INTO users(id, created_at) SELECT gen_random_uuid(), occurred_at FROM f WHERE occurred_at > now() - interval '120 days' RETURNING id, created_at),
    p AS (SELECT u.id, f.channel, u.created_at, random() r FROM u JOIN f ON f.occurred_at = u.created_at)
    INSERT INTO user_sources(user_id, channel, source, medium, campaign, referrer_host, first_seen_at, demo)
    SELECT DISTINCT ON (id) id, channel,
           CASE WHEN channel = 'web' THEN (CASE WHEN r < 0.34 THEN 'direct' WHEN r < 0.55 THEN 'sber500' WHEN r < 0.72 THEN 'telegram' WHEN r < 0.86 THEN 'vk' ELSE 'google' END)
                ELSE (CASE WHEN r < 0.42 THEN 'direct' WHEN r < 0.70 THEN 'sber500' WHEN r < 0.88 THEN 'tg_channel' ELSE 'friends' END) END,
           CASE WHEN channel <> 'web' AND r < 0.42 THEN NULL WHEN r BETWEEN 0.34 AND 0.55 THEN 'demo_day' WHEN r BETWEEN 0.72 AND 0.86 THEN 'post' WHEN r >= 0.86 AND channel = 'web' THEN 'organic' ELSE NULL END,
           CASE WHEN channel <> 'web' AND r < 0.42 THEN NULL WHEN r BETWEEN 0.34 AND 0.70 THEN 'disrupt_2026' ELSE NULL END,
           CASE WHEN channel = 'web' AND r >= 0.55 AND r < 0.72 THEN 't.me' WHEN channel = 'web' AND r >= 0.86 THEN 'google.com' ELSE NULL END,
           created_at, true FROM p`);
  // Команда и тесты: несколько демо-пользователей помечены is_internal (на дашборде исключены).
  await db.query("UPDATE users SET is_internal = true WHERE id IN (SELECT user_id FROM user_sources WHERE demo ORDER BY first_seen_at DESC LIMIT 5)");
  const n = await db.query<{ c: string; e: string; s: string }>("SELECT (SELECT count(*) FROM service_calls WHERE demo) c, (SELECT count(*) FROM service_errors WHERE demo) e, (SELECT count(*) FROM user_sources WHERE demo) s");
  console.log(`ДЕМО журналы: ${n.rows[0].c} обращений, ${n.rows[0].e} ошибок, ${n.rows[0].s} источников`);
}
void main();
