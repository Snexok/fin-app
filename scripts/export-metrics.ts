// Выгрузка агрегированных метрик в CSV (DAU, обращения на DAU, ошибки фоновых задач).
// Только агрегаты: псевдонимы, user_id и тексты в файлы не попадают.
//
//   DATABASE_URL=postgres://... npx tsx scripts/export-metrics.ts [--days 30] [--out ./metrics-export] [--include-demo]
//   (без DATABASE_URL локально читается PGlite из .data/pglite, как у приложения)
//
// Файлы:
//   daily_activity.csv   — день, канал, DAU, сессии
//   daily_calls.csv      — день, DAU, обращения к компонентам (движок, LLM, бот, напоминания, онбординг) и на 1 DAU
//   events_by_name.csv   — день, событие, канал, количество
//   background_jobs.csv  — день, вид напоминания, статус (sent/failed/skipped/claimed), количество
//   telegram_inbox.csv   — день, обработано / с ошибкой / в ожидании, код ошибки
//   api_calls_recent.csv — час, вид лимита (chat/sim/write/an/...), число запросов (из rate_limits, хранится ~1–2 суток)
//   calls_daily.csv      — день, канал, тип обращения, обращений, ошибок, доля ошибок, p50/p95 задержки, DAU, обращений на DAU (service_calls)
//   errors_daily.csv     — день, канал, маршрут/тип, код ошибки, HTTP-статус, количество (service_errors)
//   sources.csv          — день первого касания, канал, source, medium, campaign, домен реферера, пользователей (user_sources)
//   users_summary.csv    — всего пользователей, реальных, команды/тестов, с источником, пришедших по приглашению (одна строка)
//   referrals.csv        — день приглашения, канал (web/bot/miniapp), статус, пришло, начали пользоваться, награда (миграция 008)
//   llm_daily.csv        — день бюджета (МСК), канал, назначение, модель: операций, попыток, ok/резерв/ошибки/таймауты/отказы бюджета,
//                          токены, секунды голоса, стоимость (₽ и коп.), p50/p95, DAU, ₽ на DAU (ai_usage, миграция 009)
//   plus_interest.csv    — день заявки (МСК), канал, показанная цена, вариант, выбранная цена (пусто — «не знаю»): заявок, меняли выбор
//                          (plus_interest, миграция 010; оплат нет — этап 1)
//   tokens_daily.csv     — день (МСК), тариф, назначение: AI-ответов списано / возвращено (сбой), пользователей; DAU дня,
//                          AI-ответов на DAU, упёрлись в лимит (ai_token_ledger + события tokens_exhausted, миграция 010)
//   с --raw дополнительно построчные журналы с псевдонимами (без user_id, текстов и сумм):
//   calls_log.csv        — время, псевдоним, канал, тип, итог, код, HTTP-статус, задержка
//   errors_log.csv       — время, псевдоним, канал, маршрут, код, HTTP-статус, короткое сообщение
//   sources_log.csv      — время первого касания, псевдоним, канал, source, medium, campaign, домен реферера
//   referrals_log.csv    — время, псевдонимы пригласившего и приглашённого, канал, статус, риск, активация, награда
//                          + признаки referred / referral_reward_received для строгого конкурсного отчёта
//   ai_usage_log.csv     — каждая попытка вызова LLM: время, день бюджета, request_id, попытка, псевдоним, канал, назначение,
//                          провайдер, модель, токены, аудио, стоимость (µ₽ и коп.), резерв, версия цены, задержка, итог, код, fallback_from
//
// Команда и тестовые аккаунты (users.is_internal) исключены; --include-internal — включить. --include-demo — синтетика.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDb, type Queryable } from "../lib/db";
import { pseudonym } from "../lib/analytics";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const days = Math.max(1, Math.min(400, Number(arg("days", "30")) || 30));
const outDir = path.resolve(arg("out", "./metrics-export"));
const includeDemo = process.argv.includes("--include-demo");
const includeInternal = process.argv.includes("--include-internal");
const raw = process.argv.includes("--raw");

const cell = (v: unknown) => {
  if (v == null) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function toCsv(rows: Record<string, unknown>[], cols: string[]): string {
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}
async function dump(db: Queryable, file: string, sql: string, params: unknown[]) {
  const r = await db.query<Record<string, unknown>>(sql, params);
  // Заголовок пишем и для пустой выборки: pg и PGlite возвращают fields.
  const fields = (r as { fields?: { name: string }[] }).fields;
  const cols = fields?.length ? fields.map((f) => f.name) : r.rows.length ? Object.keys(r.rows[0]) : [];
  await writeFile(path.join(outDir, file), toCsv(r.rows, cols));
  console.log(`${file}: ${r.rows.length} строк`);
}

async function main() {
  const db = await getDb();
  await mkdir(outDir, { recursive: true });
  const from = new Date(Date.now() - days * 86_400_000);
  // Фильтры: синтетика (demo) и команда/тесты (internal) — по умолчанию исключены.
  const demo = (includeDemo ? "" : "AND NOT demo") + (includeInternal ? "" : " AND NOT internal");
  const userFilter = includeInternal ? "" : "AND NOT u.is_internal";

  // DAU = уникальные псевдонимы с user_active за UTC-день (событие пишется 1 раз в день на канал).
  await dump(db, "daily_activity.csv", `
    SELECT to_char(date_trunc('day', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, channel,
           count(DISTINCT subject) FILTER (WHERE name = 'user_active') AS dau,
           count(*) FILTER (WHERE name = 'session_started') AS sessions
      FROM analytics_events WHERE occurred_at >= $1 ${demo}
     GROUP BY 1, 2 ORDER BY 1, 2`, [from]);

  // Обращения к компонентам на DAU. purchase_result.engine: llm — разбор намерения через LLM, fallback — regex, api — прямой вызов движка.
  await dump(db, "daily_calls.csv", `
    WITH d AS (
      SELECT date_trunc('day', occurred_at AT TIME ZONE 'UTC') AS day,
             count(DISTINCT subject) FILTER (WHERE name = 'user_active') AS dau,
             count(*) FILTER (WHERE name = 'purchase_result') AS engine_purchase_checks,
             count(*) FILTER (WHERE name = 'purchase_result' AND props->>'engine' = 'llm') AS llm_intent_calls,
             count(*) FILTER (WHERE name = 'purchase_result' AND props->>'engine' = 'fallback') AS fallback_parser_calls,
             count(*) FILTER (WHERE name = 'purchase_result' AND props->>'engine' = 'api') AS api_simulations,
             count(*) FILTER (WHERE name LIKE 'onboarding_step_%' OR name IN ('onboarding_corrected', 'onboarding_not_understood')) AS onboarding_turn_events,
             count(*) FILTER (WHERE name LIKE 'proposal_%' OR name = 'expense_logged') AS ledger_events,
             count(*) FILTER (WHERE channel = 'telegram') AS bot_events,
             count(*) FILTER (WHERE name = 'reminder_sent') AS reminders_sent,
             count(*) AS all_events
        FROM analytics_events WHERE occurred_at >= $1 ${demo}
       GROUP BY 1)
    SELECT to_char(day, 'YYYY-MM-DD') AS day, dau, engine_purchase_checks, llm_intent_calls, fallback_parser_calls, api_simulations,
           onboarding_turn_events, ledger_events, bot_events, reminders_sent, all_events,
           round(engine_purchase_checks::numeric / NULLIF(dau, 0), 2) AS engine_checks_per_dau,
           round(llm_intent_calls::numeric / NULLIF(dau, 0), 2) AS llm_calls_per_dau,
           round(all_events::numeric / NULLIF(dau, 0), 2) AS events_per_dau
      FROM d ORDER BY day`, [from]);

  await dump(db, "events_by_name.csv", `
    SELECT to_char(date_trunc('day', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, name, channel, count(*) AS n
      FROM analytics_events WHERE occurred_at >= $1 ${demo}
     GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [from]);

  // Фоновые задачи: журнал напоминаний (cron /api/cron/reminders), статус failed = ошибка отправки.
  await dump(db, "background_jobs.csv", `
    SELECT to_char(local_day, 'YYYY-MM-DD') AS day, kind, status, count(*) AS n
      FROM reminder_log WHERE created_at >= $1
     GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [from]);

  // Вебхук Telegram: inbox хранит попытки и код ошибки (без текста сообщения в выгрузке). Хранение 7–14 дней.
  await dump(db, "telegram_inbox.csv", `
    SELECT to_char(date_trunc('day', received_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
           count(*) FILTER (WHERE processed_at IS NOT NULL AND last_error IS NULL) AS processed_ok,
           count(*) FILTER (WHERE last_error IS NOT NULL) AS processed_with_error,
           count(*) FILTER (WHERE processed_at IS NULL) AS pending,
           coalesce(string_agg(DISTINCT last_error, ';') FILTER (WHERE last_error IS NOT NULL), '') AS error_codes,
           round(avg(attempts), 2) AS avg_attempts
      FROM inbox WHERE received_at >= $1
     GROUP BY 1 ORDER BY 1`, [from]);

  // Счётчики лимитов — косвенный журнал вызовов API за последние ~1–2 суток (ключ «вид:u:<id>» → только вид).
  await dump(db, "api_calls_recent.csv", `
    SELECT to_char(date_trunc('hour', window_start AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:00"Z"') AS hour,
           split_part(key, ':', 1) AS kind, sum(count) AS requests
      FROM rate_limits WHERE key LIKE '%:u:%'
     GROUP BY 1, 2 ORDER BY 1, 2`, []);

  // Журнал обращений: тип, итог, задержка; DAU — из user_active того же дня и канала.
  await dump(db, "calls_daily.csv", `
    WITH c AS (
      SELECT date_trunc('day', occurred_at AT TIME ZONE 'UTC') AS day, channel, call_type,
             count(*) AS calls, count(*) FILTER (WHERE result = 'error') AS errors,
             round(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::numeric) AS p50_ms,
             round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::numeric) AS p95_ms
        FROM service_calls WHERE occurred_at >= $1 ${demo}
       GROUP BY 1, 2, 3),
    d AS (
      SELECT date_trunc('day', occurred_at AT TIME ZONE 'UTC') AS day, channel, count(DISTINCT subject) AS dau
        FROM analytics_events WHERE name = 'user_active' AND occurred_at >= $1 ${demo}
       GROUP BY 1, 2)
    SELECT to_char(c.day, 'YYYY-MM-DD') AS day, c.channel, c.call_type, c.calls, c.errors,
           round(c.errors::numeric / NULLIF(c.calls, 0), 4) AS error_rate, c.p50_ms, c.p95_ms,
           d.dau, round(c.calls::numeric / NULLIF(d.dau, 0), 2) AS calls_per_dau
      FROM c LEFT JOIN d ON d.day = c.day AND d.channel = c.channel
     ORDER BY 1, 2, 3`, [from]);

  await dump(db, "errors_daily.csv", `
    SELECT to_char(date_trunc('day', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, channel, route, code, http_status, count(*) AS n
      FROM service_errors WHERE occurred_at >= $1 ${demo}
     GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 6 DESC`, [from]);

  await dump(db, "sources.csv", `
    SELECT to_char(date_trunc('day', s.first_seen_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, s.channel, s.source,
           coalesce(s.medium, '') AS medium, coalesce(s.campaign, '') AS campaign, coalesce(s.referrer_host, '') AS referrer_host, count(*) AS users
      FROM user_sources s JOIN users u ON u.id = s.user_id
     WHERE s.first_seen_at >= $1 ${includeDemo ? "" : "AND NOT s.demo"} ${userFilter}
     GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1, 7 DESC`, [from]);

  // Реальные пользователи: без команды/тестов (users.is_internal) и удалённых. Бот-аккаунты Telegram в users не попадают.
  await dump(db, "users_summary.csv", `
    SELECT count(*) AS users_total,
           count(*) FILTER (WHERE NOT u.is_internal) AS users_real,
           count(*) FILTER (WHERE u.is_internal) AS users_internal,
           count(*) FILTER (WHERE NOT u.is_internal AND u.created_at >= $1) AS users_real_new_in_period,
           count(s.user_id) FILTER (WHERE NOT u.is_internal) AS users_real_with_source,
           count(*) FILTER (WHERE NOT u.is_internal AND f.referred) AS users_real_referred,
           count(*) FILTER (WHERE NOT u.is_internal AND f.referral_reward_received) AS users_real_referral_reward_received
      FROM users u LEFT JOIN user_sources s ON s.user_id = u.id LEFT JOIN user_referral_flags f ON f.user_id = u.id
     WHERE u.deleted_at IS NULL`, [from]);

  // Приглашения друзей (миграция 008): атрибуция только новым аккаунтам; команда/тесты исключены с обеих сторон.
  const refFilter = (includeDemo ? "" : "AND NOT r.demo") + (includeInternal ? "" : " AND NOT a.is_internal AND NOT b.is_internal");
  await dump(db, "referrals.csv", `
    SELECT to_char(date_trunc('day', r.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, r.channel, r.status,
           count(*) AS signups, count(*) FILTER (WHERE r.activated_at IS NOT NULL) AS activated,
           count(*) FILTER (WHERE r.reward_status = 'pending') AS reward_pending,
           count(*) FILTER (WHERE r.reward_status = 'limit') AS reward_limited,
           count(DISTINCT r.referrer_user_id) AS referrers
      FROM referrals r JOIN users a ON a.id = r.referrer_user_id JOIN users b ON b.id = r.referee_user_id
     WHERE r.created_at >= $1 ${refFilter}
     GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [from]);

  // Стоимость LLM (миграция 009): по дню бюджета (Москва). DAU — уникальные user_active за UTC-день того же числа и канала.
  await dump(db, "llm_daily.csv", `
    WITH a AS (
      SELECT budget_day AS day, channel, purpose, model,
             count(DISTINCT request_id) AS operations,
             count(*) FILTER (WHERE status <> 'budget_denied') AS attempts,
             count(*) FILTER (WHERE status = 'ok') AS ok, count(*) FILTER (WHERE status = 'fallback') AS fallback,
             count(*) FILTER (WHERE status = 'error') AS errors, count(*) FILTER (WHERE status = 'timeout') AS timeouts,
             count(*) FILTER (WHERE status = 'budget_denied') AS budget_denied,
             sum(prompt_tokens) AS prompt_tokens, sum(completion_tokens) AS completion_tokens,
             round(coalesce(sum(audio_ms), 0) / 1000.0, 1) AS audio_sec,
             sum(cost_microrub) AS cost_microrub,
             count(*) FILTER (WHERE usage_estimated) AS estimated_rows,
             round(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status IN ('ok', 'fallback'))::numeric) AS p50_ms,
             round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status IN ('ok', 'fallback'))::numeric) AS p95_ms
        FROM ai_usage WHERE created_at >= $1 ${demo}
       GROUP BY 1, 2, 3, 4),
    d AS (
      SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day, channel, count(DISTINCT subject) AS dau
        FROM analytics_events WHERE name = 'user_active' AND occurred_at >= $1 ${demo}
       GROUP BY 1, 2),
    t AS (SELECT day, channel, sum(cost_microrub) AS day_cost FROM a GROUP BY 1, 2)
    SELECT to_char(a.day, 'YYYY-MM-DD') AS day, a.channel, a.purpose, a.model, a.operations, a.attempts, a.ok, a.fallback, a.errors, a.timeouts,
           a.budget_denied, a.prompt_tokens, a.completion_tokens, a.audio_sec, a.estimated_rows,
           round(a.cost_microrub / 1000000.0, 4) AS cost_rub, round(a.cost_microrub / 10000.0, 2) AS cost_kopecks,
           a.p50_ms, a.p95_ms, d.dau,
           round(t.day_cost / 1000000.0 / NULLIF(d.dau, 0), 4) AS channel_day_cost_per_dau_rub
      FROM a LEFT JOIN d ON d.day = a.day AND d.channel = a.channel LEFT JOIN t ON t.day = a.day AND t.channel = a.channel
     ORDER BY 1, 2, 3, 4`, [from]);

  // Тарифы (миграция 010): только интерес к Плюсу, без оплат. Пользовательские поля не выгружаются.
  const plusFilter = (includeDemo ? "" : "AND NOT p.demo") + " " + userFilter;
  await dump(db, "plus_interest.csv", `
    SELECT to_char((p.created_at AT TIME ZONE 'Europe/Moscow')::date, 'YYYY-MM-DD') AS day, p.channel, p.offered_price, p.variant,
           p.price_choice, count(*) AS users, count(*) FILTER (WHERE p.updates > 0) AS changed
      FROM plus_interest p JOIN users u ON u.id = p.user_id
     WHERE p.created_at >= $1 ${plusFilter}
     GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 5`, [from]);
  await dump(db, "tokens_daily.csv", `
    WITH l AS (
      SELECT t.day, t.plan, t.purpose, count(*) FILTER (WHERE t.status = 'consumed') AS consumed,
             count(*) FILTER (WHERE t.status = 'released') AS released, count(DISTINCT t.user_id) FILTER (WHERE t.status = 'consumed') AS users
        FROM ai_token_ledger t JOIN users u ON u.id = t.user_id
       WHERE t.created_at >= $1 ${includeDemo ? "" : "AND NOT t.demo"} ${userFilter}
       GROUP BY 1, 2, 3),
    d AS (SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day, count(DISTINCT subject) FILTER (WHERE name = 'user_active') AS dau,
                 count(DISTINCT subject) FILTER (WHERE name = 'tokens_exhausted') AS exhausted_users
            FROM analytics_events WHERE name IN ('user_active', 'tokens_exhausted') AND occurred_at >= $1 ${demo} GROUP BY 1),
    t AS (SELECT day, sum(consumed) AS day_consumed FROM l GROUP BY 1)
    SELECT to_char(l.day, 'YYYY-MM-DD') AS day, l.plan, l.purpose, l.consumed, l.released, l.users, d.dau,
           round(t.day_consumed::numeric / NULLIF(d.dau, 0), 3) AS day_ai_answers_per_dau, d.exhausted_users
      FROM l LEFT JOIN d ON d.day = l.day LEFT JOIN t ON t.day = l.day
     ORDER BY 1, 2, 3`, [from]);

  if (raw) {
    await dump(db, "ai_usage_log.csv", `
      SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts, to_char(budget_day, 'YYYY-MM-DD') AS budget_day,
             request_id, attempt, coalesce(subject, '') AS subject, channel, purpose, provider, model, prompt_tokens, completion_tokens,
             audio_ms, usage_estimated, cost_microrub, cost_kopecks, reserved_microrub, price_version, latency_ms, status,
             coalesce(error_code, '') AS error_code, coalesce(fallback_from, '') AS fallback_from, ai_answer
        FROM ai_usage WHERE created_at >= $1 ${demo} ORDER BY created_at, id`, [from]);
    await dump(db, "calls_log.csv", `
      SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts, coalesce(subject, '') AS subject, channel, call_type,
             result, coalesce(code, '') AS code, http_status, latency_ms
        FROM service_calls WHERE occurred_at >= $1 ${demo} ORDER BY occurred_at, id`, [from]);
    await dump(db, "errors_log.csv", `
      SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts, coalesce(subject, '') AS subject, channel, route,
             code, http_status, coalesce(message, '') AS message
        FROM service_errors WHERE occurred_at >= $1 ${demo} ORDER BY occurred_at, id`, [from]);
    // Псевдоним источника считается тем же HMAC (ANALYTICS_SECRET), что и в событиях: user_id в файл не попадает.
    const src = await db.query<{ user_id: string; epoch: number; enabled: boolean; ts: string; channel: string; source: string; medium: string | null; campaign: string | null; referrer_host: string | null }>(`
      SELECT s.user_id, u.analytics_epoch AS epoch, u.analytics_enabled AS enabled,
             to_char(s.first_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts, s.channel, s.source, s.medium, s.campaign, s.referrer_host
        FROM user_sources s JOIN users u ON u.id = s.user_id
       WHERE s.first_seen_at >= $1 ${includeDemo ? "" : "AND NOT s.demo"} ${userFilter} ORDER BY s.first_seen_at`, [from]);
    const rows = src.rows.map((r) => ({ ts: r.ts, subject: r.enabled ? pseudonym(r.user_id, Number(r.epoch)) : "", channel: r.channel, source: r.source, medium: r.medium, campaign: r.campaign, referrer_host: r.referrer_host }));
    await writeFile(path.join(outDir, "sources_log.csv"), toCsv(rows, ["ts", "subject", "channel", "source", "medium", "campaign", "referrer_host"]));
    console.log(`sources_log.csv: ${rows.length} строк`);

    const refs = await db.query<{ ts: string; a: string; ae: number; aon: boolean; b: string; be: number; bon: boolean; channel: string; status: string; risk: string[] | string; activated: string | null; reward_status: string | null; reward_received: boolean }>(`
      SELECT to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts,
             a.id AS a, a.analytics_epoch AS ae, a.analytics_enabled AS aon, b.id AS b, b.analytics_epoch AS be, b.analytics_enabled AS bon,
             r.channel, r.status, r.risk_reasons AS risk,
             to_char(r.activated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS activated, r.reward_status,
             coalesce(fa.referral_reward_received, false) AS reward_received
        FROM referrals r JOIN users a ON a.id = r.referrer_user_id JOIN users b ON b.id = r.referee_user_id
        LEFT JOIN user_referral_flags fa ON fa.user_id = a.id
       WHERE r.created_at >= $1 ${refFilter} ORDER BY r.created_at`, [from]);
    const rrows = refs.rows.map((r) => ({
      ts: r.ts, referrer: r.aon ? pseudonym(r.a, Number(r.ae)) : "", referee: r.bon ? pseudonym(r.b, Number(r.be)) : "",
      channel: r.channel, status: r.status, risk: Array.isArray(r.risk) ? r.risk.join(";") : String(r.risk ?? "").replace(/[{}]/g, ""),
      activated_at: r.activated, reward_status: r.reward_status, referee_referred: true, referrer_referral_reward_received: r.reward_received,
    }));
    await writeFile(path.join(outDir, "referrals_log.csv"), toCsv(rrows, ["ts", "referrer", "referee", "channel", "status", "risk", "activated_at", "reward_status", "referee_referred", "referrer_referral_reward_received"]));
    console.log(`referrals_log.csv: ${rrows.length} строк`);
  }

  await db.close();
  console.log(`Готово: ${outDir}`);
}

main().catch((e) => { console.error("export failed", (e as Error).message); process.exit(1); });
