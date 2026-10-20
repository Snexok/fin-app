// v25: LLM-слой — единый клиент, цены, цепочка моделей, таймауты, атомарные бюджеты, журнал ai_usage, деградация в шаблоны.
// Настоящий прокси акселератора не вызывается: фейковый OpenAI-совместимый сервер (tests/fake-llm.ts).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { getDb } from "../lib/db";
import { pseudonym } from "../lib/analytics";
import { forgetLogMeta, withCall } from "../lib/service-log";
import {
  budgetDay, budgetState, estimateTokens, llmCall, llmConfig, llmEnabled, parseIntentLLMResult, priceOf, reserveBudget, setLlmHooks,
  settleBudget, sttCostMicro, tokenCostMicro, transcribeAudio, type Reservation,
} from "../lib/llm";
import { answer, regexUnsure } from "../lib/coach";
import { parseIntentRegex } from "../lib/parse";
import { llmSummary, rubLabel } from "../lib/llm-metrics";
import { setInternal } from "../lib/internal-users";
import { runRetention } from "../lib/retention";
import { startFakeLlm, type FakeLlm } from "./fake-llm";
import { NOW, webUser } from "./helpers";

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await (await getDb()).query<T>(sql, p)).rows;
type Usage = { request_id: string; attempt: number; purpose: string; model: string; status: string; error_code: string | null; fallback_from: string | null; prompt_tokens: number; completion_tokens: number; cost_microrub: string; cost_kopecks: string; reserved_microrub: string; usage_estimated: boolean; subject: string | null; channel: string; budget_day: string; ai_answer: boolean; internal: boolean; audio_ms: number | null; provider: string; price_version: string };
const usageOf = (rid: string | null) => q<Usage>("SELECT *, budget_day::text budget_day FROM ai_usage WHERE request_id=$1 ORDER BY attempt", [rid]);

let fake: FakeLlm;
// Каждый тест — свой «день» бюджета (и своё начало общего бюджета), чтобы счётчики не пересекались.
let dayN = 0;
function freshDay(): Date {
  const d = new Date(Date.UTC(2027, 0, 1 + ++dayN, 9, 0, 0));
  vi.stubEnv("LLM_BUDGET_START", budgetDay(d));
  return d;
}
const intentOk = (content = '{"intent":"purchase","item":"ноутбук","priceText":"50к"}') => () => ({ content });

beforeAll(async () => { fake = await startFakeLlm(); });
afterAll(async () => { await fake.close(); });
beforeEach(() => {
  vi.stubEnv("LLM_API_KEY", "accelerator-test-key");
  vi.stubEnv("LLM_BASE_URL", fake.url);
  vi.stubEnv("LLM_TIMEOUT_MS", "2000");
  fake.calls.length = 0;
  fake.handler = intentOk();
});
afterEach(() => { vi.unstubAllEnvs(); setLlmHooks({}); forgetLogMeta(); });

describe("llm: prices and cost (kopecks per 1M tokens, VAT incl.)", () => {
  it("computes cost from the price table in micro-roubles; ai_usage exposes fractional kopecks", async () => {
    // Разбор намерения по LLM-COST.md: 700 вход / 60 выход на GigaChat 3.5 Ultra = 0,08467 ₽.
    expect(tokenCostMicro("gigachat3.5-432b-a28b", 700, 60)).toBe(84_670);
    expect(tokenCostMicro("ai-sage/GigaChat3.5-432B-A28B", 700, 60)).toBe(84_670); // id Cloud.ru нормализуется
    expect(tokenCostMicro("qwen3.5-397b-a17b", 1_000_000, 0)).toBe(915_000_000); // 915 ₽ за 1 млн входа
    expect(tokenCostMicro("deepseek-v4-pro", 0, 1_000_000)).toBe(732_000_000);
    expect(priceOf("some-new-model")).toMatchObject({ known: false, inKop: 91_500 }); // неизвестная — по самой дорогой
    expect(sttCostMicro(15)).toBe(91_500); // 15 с × 0,0061 ₽
    expect(rubLabel(84_670)).toBe("0,08\u00a0₽");
    expect(rubLabel(4_000)).toBe("<0,01\u00a0₽");
    vi.stubEnv("LLM_PRICES", JSON.stringify({ "gigachat3.5-432b-a28b": [10_000, 30_000], custom: { in: 100, out: 100 } }));
    expect(tokenCostMicro("gigachat3.5-432b-a28b", 100, 100)).toBe(40_000);
    expect(priceOf("custom")).toMatchObject({ inKop: 100, version: "env", known: true });
    vi.stubEnv("LLM_PRICES", "not json");
    vi.stubEnv("LLM_PRICE_MARKUP", "1.1");
    expect(tokenCostMicro("gigachat3.5-432b-a28b", 700, 60)).toBe(93_137);
    expect(priceOf("gigachat3.5-432b-a28b").version).toBe("cloudru-261015x1.1");
    expect(estimateTokens("абвгде")).toBe(2);
    expect(estimateTokens("абвгде", true)).toBe(3);

    vi.unstubAllEnvs(); vi.stubEnv("LLM_API_KEY", "k"); vi.stubEnv("LLM_BASE_URL", fake.url);
    const now = freshDay();
    const r = await llmCall({ purpose: "intent_parse", messages: [{ role: "user", content: "x" }], now });
    expect(r.ok).toBe(true);
    const [row] = await usageOf(r.requestId);
    expect(row).toMatchObject({ status: "ok", model: "gigachat3.5-432b-a28b", prompt_tokens: 700, completion_tokens: 60, usage_estimated: false, provider: "local", price_version: "cloudru-261015", budget_day: budgetDay(now) });
    expect(Number(row.cost_microrub)).toBe(84_670);
    expect(Number(row.cost_kopecks)).toBeCloseTo(8.467, 4);
    // Резерв — по оценке входа (длина текста) + max_tokens; фейк сообщает больше токенов, чем в «x» — факт всё равно списан.
    expect(Number(row.reserved_microrub)).toBe(tokenCostMicro("gigachat3.5-432b-a28b", estimateTokens("x", true) + 16, 120));
  });

  it("config: accelerator defaults behind a gateway, legacy OpenAI model without one, env overrides", () => {
    expect(llmConfig()).toMatchObject({ enabled: true, primary: "gigachat3.5-432b-a28b", fallbacks: ["qwen3.5-397b-a17b", "deepseek-v4-pro"], dailyCapMicro: 2_850_000_000, userSoftCapMicro: 3_000_000, totalBudgetMicro: 50_000_000_000, totalBudgetMaxMicro: 75_000_000_000 });
    vi.stubEnv("LLM_BASE_URL", "https://shared1.multitool.works:4000/v1/");
    expect(llmConfig()).toMatchObject({ provider: "sber500-proxy", baseUrl: "https://shared1.multitool.works:4000/v1" });
    vi.stubEnv("LLM_BASE_URL", "");
    expect(llmConfig()).toMatchObject({ primary: "gpt-4o-mini", fallbacks: [], provider: "openai" });
    vi.stubEnv("LLM_MODEL", "old-model"); // прежнее имя переменной работает
    expect(llmConfig().primary).toBe("old-model");
    vi.stubEnv("LLM_MODEL_PRIMARY", "a"); vi.stubEnv("LLM_MODEL_FALLBACKS", "b, c,a");
    vi.stubEnv("LLM_DAILY_BUDGET_RUB", "100"); vi.stubEnv("LLM_USER_DAILY_SOFT_CAP_RUB", "0,5"); vi.stubEnv("LLM_TOTAL_BUDGET_RUB", "75000");
    expect(llmConfig()).toMatchObject({ primary: "a", fallbacks: ["b", "c"], dailyCapMicro: 100_000_000, userSoftCapMicro: 500_000, totalBudgetMicro: 75_000_000_000, totalBudgetMaxMicro: 75_000_000_000 });
    // Москва: 21:30 UTC — уже следующий день бюджета.
    expect(budgetDay(new Date("2026-10-15T20:59:59Z"))).toBe("2026-10-15");
    expect(budgetDay(new Date("2026-10-15T21:00:00Z"))).toBe("2026-10-16");
  });
});

describe("llm: fallback chain, timeouts, usage", () => {
  it("primary 5xx → fallback 429 → third model answers; each attempt is one ai_usage row, one service_calls row per operation", async () => {
    const s = await webUser();
    const now = freshDay();
    fake.handler = ({ model }) => (model.startsWith("gigachat") ? { status: 503 } : model.startsWith("qwen") ? { status: 429 } : { content: '{"intent":"snapshot"}', usage: { prompt_tokens: 500, completion_tokens: 20 } });
    const r = await withCall({ type: "chat.message", channel: "telegram", userId: s.userId }, () => parseIntentLLMResult("как дела с деньгами", { now }));
    expect(r).toMatchObject({ ok: true, model: "deepseek-v4-pro", fallback: true, attempts: 3, value: { intent: "snapshot" } });
    expect(fake.calls.map((c) => c.model)).toEqual(["gigachat3.5-432b-a28b", "qwen3.5-397b-a17b", "deepseek-v4-pro"]);
    expect(fake.calls[0].body).toMatchObject({ max_tokens: 120, response_format: { type: "json_object" }, temperature: 0 });
    const rows = await usageOf(r.requestId);
    expect(rows.map((x) => [x.attempt, x.model, x.status, x.error_code, x.fallback_from])).toEqual([
      [1, "gigachat3.5-432b-a28b", "error", "LLM_HTTP_503", null],
      [2, "qwen3.5-397b-a17b", "error", "LLM_HTTP_429", "gigachat3.5-432b-a28b"],
      [3, "deepseek-v4-pro", "fallback", null, "qwen3.5-397b-a17b"],
    ]);
    expect(rows.map((x) => Number(x.cost_microrub))).toEqual([0, 0, tokenCostMicro("deepseek-v4-pro", 500, 20)]);
    const subj = pseudonym(s.userId, 0);
    expect(rows.every((x) => x.subject === subj && x.channel === "telegram" && !x.ai_answer)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(s.userId);
    const calls = await q<{ call_type: string; result: string; code: string | null }>("SELECT call_type, result, code FROM service_calls WHERE subject=$1 AND call_type LIKE 'llm.%'", [subj]);
    expect(calls).toEqual([{ call_type: "llm.intent", result: "ok", code: null }]);
    // Резервы сняты, в счётчике дня — только факт.
    const b = await budgetState(llmConfig(), now);
    expect(b).toMatchObject({ reservedMicro: 0, spentMicro: tokenCostMicro("deepseek-v4-pro", 500, 20) });
  });

  it("per-attempt timeout moves to the next model; all timing out → typed timeout failure, service_errors gets LLM_TIMEOUT", async () => {
    vi.stubEnv("LLM_TIMEOUT_MS", "150");
    const now = freshDay();
    fake.handler = ({ model }) => (model.startsWith("gigachat") ? { delayMs: 600 } : {});
    const t0 = Date.now();
    const r = await llmCall({ purpose: "explain", messages: [{ role: "user", content: "почему" }], now });
    expect(r).toMatchObject({ ok: true, model: "qwen3.5-397b-a17b", fallback: true });
    expect(Date.now() - t0).toBeLessThan(1500);
    const rows = await usageOf(r.requestId);
    expect(rows.map((x) => [x.status, x.error_code, x.usage_estimated])).toEqual([["timeout", "LLM_TIMEOUT", true], ["fallback", null, false]]);
    expect(rows[1].ai_answer).toBe(true); // успешное объяснение — будущий AI-ответ квоты
    expect(Number(rows[0].cost_microrub)).toBeGreaterThan(0); // таймаут: списываем оценку входа (консервативно)

    fake.handler = () => ({ delayMs: 600 });
    const all = await llmCall({ purpose: "explain", messages: [{ role: "user", content: "почему" }], now });
    expect(all).toMatchObject({ ok: false, reason: "timeout", code: "LLM_TIMEOUT", attempts: 3 });
    expect((await usageOf(all.requestId)).map((x) => x.status)).toEqual(["timeout", "timeout", "timeout"]);
    expect((await q("SELECT 1 FROM service_errors WHERE route='llm.explain' AND code='LLM_TIMEOUT'")).length).toBeGreaterThan(0);
    // Общий дедлайн операции ограничивает цепочку.
    vi.stubEnv("LLM_TOTAL_TIMEOUT_MS", "250");
    const t1 = Date.now();
    const dl = await llmCall({ purpose: "explain", messages: [{ role: "user", content: "почему" }], now });
    expect(dl).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - t1).toBeLessThan(900);
    expect((await budgetState(llmConfig(), now)).reservedMicro).toBe(0);
  });

  it("4xx (not 429) and invalid output do not fall back; missing usage is estimated", async () => {
    const now = freshDay();
    fake.handler = () => ({ status: 400 });
    const bad = await llmCall({ purpose: "intent_parse", messages: [{ role: "user", content: "x" }], now });
    expect(bad).toMatchObject({ ok: false, reason: "error", code: "LLM_HTTP_400", attempts: 1 });
    expect(fake.calls).toHaveLength(1);

    fake.handler = () => ({ content: "я не JSON" });
    const out = await parseIntentLLMResult("что-то", { now });
    expect(out).toMatchObject({ ok: false, reason: "bad_output", code: "LLM_BAD_OUTPUT" });
    const [row] = await usageOf(out.requestId);
    expect(row).toMatchObject({ status: "error", error_code: "LLM_BAD_OUTPUT" });
    expect(Number(row.cost_microrub)).toBeGreaterThan(0); // невалидный ответ всё равно оплачен

    fake.handler = () => ({ content: "Объяснение готовых чисел.", usage: null });
    const est = await llmCall({ purpose: "explain", messages: [{ role: "system", content: "s" }, { role: "user", content: "a".repeat(300) }], now });
    expect(est).toMatchObject({ ok: true, usageEstimated: true });
    const [e] = await usageOf(est.requestId);
    expect(e.usage_estimated).toBe(true);
    expect(e.prompt_tokens).toBeGreaterThan(90);
    expect(e.completion_tokens).toBe(estimateTokens("Объяснение готовых чисел."));
    // Потолок токенов вызова не превышает LLM_MAX_OUTPUT_TOKENS.
    vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "50");
    await llmCall({ purpose: "weekly_review", maxTokens: 5000, messages: [{ role: "user", content: "x" }], now });
    expect(fake.calls.at(-1)!.body.max_tokens).toBe(50);
  });
});

describe("llm: budgets (atomic reserve → settle, Moscow day)", () => {
  it("concurrent reservations never exceed the project hard cap", async () => {
    const now = freshDay();
    const cap = 1_000_000; // 1 ₽
    vi.stubEnv("LLM_DAILY_BUDGET_RUB", "1");
    const cfg = llmConfig();
    expect(cfg.dailyCapMicro).toBe(cap);
    const results = await Promise.all(Array.from({ length: 40 }, () => reserveBudget({ userId: null, micro: 70_000, cfg, now })));
    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(Math.floor(cap / 70_000)); // 14 × 0,07 ₽ ≤ 1 ₽
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.scope === "project")).toBe(true);
    let b = await budgetState(cfg, now);
    expect(b.reservedMicro + b.spentMicro).toBeLessThanOrEqual(cap);
    // Сверка: часть потрачена фактически меньше резерва, часть освобождена; повторная сверка не меняет счётчик.
    await Promise.all(ok.map((r, i) => settleBudget((r as { reservation: Reservation }).reservation, i % 2 ? 0 : 50_000)));
    await settleBudget((ok[0] as { reservation: Reservation }).reservation, 999_999);
    b = await budgetState(cfg, now);
    expect(b).toMatchObject({ reservedMicro: 0, spentMicro: 7 * 50_000 });
    // Освобождённое снова доступно.
    expect((await reserveBudget({ userId: null, micro: 600_000, cfg, now })).ok).toBe(true);
    expect((await reserveBudget({ userId: null, micro: 100_000, cfg, now })).ok).toBe(false);
  });

  it("concurrent full LLM calls through the wrapper cannot overspend the daily cap either", async () => {
    const now = freshDay();
    // Резерв на вызов ≈ (оценка входа + 120 выход) по GigaChat; лимит — на ~3 вызова.
    const per = tokenCostMicro("gigachat3.5-432b-a28b", estimateTokens("system\nпривет", true) + 8 * 1 + 8, 120);
    vi.stubEnv("LLM_DAILY_BUDGET_RUB", String((per * 3 + per / 2) / 1_000_000));
    fake.handler = () => ({ delayMs: 20, usage: { prompt_tokens: 5, completion_tokens: 5 }, content: '{"intent":"other"}' });
    const rs = await Promise.all(Array.from({ length: 12 }, () => llmCall({ purpose: "intent_parse", messages: [{ role: "user", content: "system\nпривет" }], now })));
    const okN = rs.filter((r) => r.ok).length;
    expect(okN).toBeGreaterThanOrEqual(3); // фактический расход меньше резерва — освободившееся место переиспользуется
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "budget" && r.code === "LLM_BUDGET_PROJECT")).toBe(true);
    const b = await budgetState(llmConfig(), now);
    expect(b.reservedMicro).toBe(0);
    expect(b.spentMicro).toBeLessThanOrEqual(llmConfig().dailyCapMicro);
    const denied = await q<{ n: string }>("SELECT count(*) n FROM ai_usage WHERE status='budget_denied' AND budget_day=$1::date", [budgetDay(now)]);
    expect(Number(denied[0].n)).toBe(12 - okN);
    // Отказ бюджета — не ошибка сервиса: service_calls ok + код, без service_errors.
    expect((await q("SELECT 1 FROM service_errors WHERE code='LLM_BUDGET_PROJECT'")).length).toBe(0);
  });

  it("per-user soft cap: after it the chat degrades to the regex/template path with the same engine numbers; others unaffected", async () => {
    const a = await webUser(), other = await webUser();
    const now = new Date(NOW);
    vi.stubEnv("LLM_BUDGET_START", budgetDay(now));
    // Мягкий лимит пользователя ~ на один разбор намерения (факт 700/60 токенов + резерв второго не влезают).
    const per = tokenCostMicro("gigachat3.5-432b-a28b", 700, 60);
    vi.stubEnv("LLM_USER_DAILY_SOFT_CAP_RUB", String((per * 1.5) / 1_000_000));
    const text = "хочу новый ноут, 50к норм?";
    expect(parseIntentRegex(text).intent).toBe("other");
    expect(regexUnsure(parseIntentRegex(text), text)).toBe(true);

    const first = await answer(a.userId, text, { now });
    expect(first.mode).toBe("llm");
    expect(first.simulation?.now.priceMinor).toBe(5_000_000n); // сумма — из исходного текста, посчитана движком
    const second = await answer(a.userId, text, { now });
    expect(second.mode).toBe("fallback"); // лимит пользователя исчерпан — LLM не вызывается, regex-ответ
    expect(second.reply).toContain("Например");
    expect(second.snapshot).toEqual(first.snapshot); // те же числа движка
    const denied = await q<Usage>("SELECT * FROM ai_usage WHERE subject=$1 AND status='budget_denied'", [pseudonym(a.userId, 0)]);
    expect(denied.map((x) => x.error_code)).toEqual(["LLM_BUDGET_USER"]);
    const forOther = await answer(other.userId, text, { now });
    expect(forOther.mode).toBe("llm");
  });

  it("regex first: a confident regex parse never calls the LLM", async () => {
    const s = await webUser();
    const r = await answer(s.userId, "Можно купить наушники за 3000?", { now: NOW });
    expect(r.mode).toBe("fallback");
    expect(r.impact?.verdict).toBe("yes");
    expect(await answer(s.userId, "Потратил 500 на кофе", { now: NOW })).toMatchObject({ mode: "fallback" });
    expect(fake.calls).toHaveLength(0);
    expect(regexUnsure(parseIntentRegex("???"), "???")).toBe(false);
  });

  it("project total budget (accelerator) is enforced too", async () => {
    const now = freshDay();
    vi.stubEnv("LLM_TOTAL_BUDGET_RUB", "0.1");
    const cfg = llmConfig();
    expect((await reserveBudget({ userId: null, micro: 90_000, cfg, now })).ok).toBe(true);
    expect(await reserveBudget({ userId: null, micro: 20_000, cfg, now })).toEqual({ ok: false, scope: "total" });
  });
});

describe("llm: kill switch, hooks, logging never throws", () => {
  it("LLM_ENABLED=0: no network, no ledger rows, chat works on regex", async () => {
    vi.stubEnv("LLM_ENABLED", "0");
    expect(llmEnabled()).toBe(false);
    const before = await q<{ n: string }>("SELECT count(*) n FROM ai_usage");
    const r = await llmCall({ purpose: "explain", messages: [{ role: "user", content: "x" }] });
    expect(r).toMatchObject({ ok: false, reason: "disabled", code: "LLM_DISABLED" });
    const s = await webUser();
    expect((await answer(s.userId, "хочу новый ноут, 50к норм?", { now: NOW })).mode).toBe("fallback");
    expect((await transcribeAudio(new Blob([new Uint8Array(100)]))).ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect((await q<{ n: string }>("SELECT count(*) n FROM ai_usage"))[0].n).toBe(before[0].n);
    vi.stubEnv("LLM_ENABLED", "1"); vi.stubEnv("LLM_API_KEY", ""); vi.stubEnv("OPENAI_API_KEY", "");
    expect(await llmCall({ purpose: "explain", messages: [{ role: "user", content: "x" }] })).toMatchObject({ ok: false, reason: "not_configured" });
  });

  it("quota hooks: allow=false → typed refusal; onAnswer only for successful user-facing answers", async () => {
    const now = freshDay();
    const seen: string[] = [];
    setLlmHooks({ allow: ({ purpose }) => purpose !== "goal_chat", onAnswer: ({ purpose }) => { seen.push(purpose); } });
    expect(await llmCall({ purpose: "goal_chat", messages: [{ role: "user", content: "x" }], now })).toMatchObject({ ok: false, reason: "quota" });
    await llmCall({ purpose: "intent_parse", messages: [{ role: "user", content: "x" }], now });
    await llmCall({ purpose: "explain", messages: [{ role: "user", content: "x" }], now });
    fake.handler = () => ({ status: 500 });
    await llmCall({ purpose: "compare", messages: [{ role: "user", content: "x" }], now });
    expect(seen).toEqual(["explain"]); // разбор намерения и сбой квоту не тратят
    setLlmHooks({ allow: () => { throw new Error("boom"); }, onAnswer: () => { throw new Error("boom"); } });
    fake.handler = () => ({});
    expect((await llmCall({ purpose: "explain", messages: [{ role: "user", content: "x" }], now })).ok).toBe(true);
  });

  it("a broken ledger or log table never breaks the call", async () => {
    const now = freshDay();
    const db = await getDb();
    await db.query("ALTER TABLE ai_usage RENAME TO ai_usage_off");
    await db.query("ALTER TABLE service_calls RENAME TO service_calls_off");
    try {
      const r = await llmCall({ purpose: "explain", messages: [{ role: "user", content: "x" }], now });
      expect(r.ok).toBe(true);
      fake.handler = () => ({ status: 502 });
      expect((await llmCall({ purpose: "explain", messages: [{ role: "user", content: "x" }], now })).ok).toBe(false);
    } finally {
      await db.query("ALTER TABLE ai_usage_off RENAME TO ai_usage");
      await db.query("ALTER TABLE service_calls_off RENAME TO service_calls");
    }
    // Счётчики бюджета недоступны → отказ (fail closed), без исключения.
    await db.query("ALTER TABLE budget_buckets RENAME TO budget_buckets_off");
    try {
      fake.handler = () => ({});
      expect(await llmCall({ purpose: "explain", messages: [{ role: "user", content: "x" }], now })).toMatchObject({ ok: false, reason: "budget", code: "LLM_BUDGET_UNAVAILABLE" });
    } finally { await db.query("ALTER TABLE budget_buckets_off RENAME TO budget_buckets"); }
  });
});

describe("llm: voice, metrics, privacy", () => {
  it("STT goes through the ledger: cost per second, budget denial is typed", async () => {
    const s = await webUser();
    const now = freshDay();
    vi.stubEnv("STT_API_KEY", ""); vi.stubEnv("OPENAI_API_KEY", "");
    fake.handler = ({ path }) => (path === "/audio/transcriptions" ? { json: { text: "потратил 500 на кофе", duration: 15 } } : {});
    const r = await transcribeAudio(new Blob([new Uint8Array(4000)], { type: "audio/ogg" }), { userId: s.userId, channel: "telegram", durationSec: 16, now });
    expect(r).toMatchObject({ ok: true, text: "потратил 500 на кофе", seconds: 15, costMicro: 91_500 });
    expect(fake.calls[0]).toMatchObject({ path: "/audio/transcriptions", model: "whisper-1" });
    const [row] = await usageOf(r.requestId);
    expect(row).toMatchObject({ purpose: "voice_transcribe", status: "ok", audio_ms: 15_000, ai_answer: false, channel: "telegram" });
    expect(Number(row.reserved_microrub)).toBe(sttCostMicro(16));
    vi.stubEnv("LLM_USER_DAILY_SOFT_CAP_RUB", "0.1");
    const denied = await transcribeAudio(new Blob([new Uint8Array(4000)]), { userId: s.userId, durationSec: 60, now });
    expect(denied).toMatchObject({ ok: false, reason: "budget", code: "LLM_BUDGET_USER" });
  });

  it("dashboard summary: spend vs caps, cost per DAU, models, fallback rate, denials, p95; internal excluded by default", async () => {
    const now = freshDay();
    const from = new Date(`${budgetDay(now)}T00:00:00Z`), to = new Date(from.getTime() + 86_400_000); // ровно день теста
    const team = await webUser(), real = await webUser();
    await setInternal(team.userId, true);
    fake.handler = ({ model }) => (model.startsWith("gigachat") ? { status: 503 } : {});
    await llmCall({ purpose: "explain", userId: real.userId, messages: [{ role: "user", content: "x" }], now });
    fake.handler = () => ({});
    await llmCall({ purpose: "intent_parse", userId: real.userId, messages: [{ role: "user", content: "x" }], now });
    await llmCall({ purpose: "explain", userId: team.userId, messages: [{ role: "user", content: "x" }], now });
    const sum = await llmSummary(from, to, now, null, undefined, {});
    const rows = await q<{ cost: string; n: string }>("SELECT sum(cost_microrub) cost, count(DISTINCT request_id) n FROM ai_usage WHERE budget_day=$1::date AND NOT internal", [budgetDay(now)]);
    expect(sum.period.operations).toBe(Number(rows[0].n));
    expect(sum.period.spentMicro).toBe(Number(rows[0].cost));
    expect(sum.period.fallbackOps).toBe(1);
    expect(sum.period.fallbackRate).toBeCloseTo(0.5);
    expect(sum.models.map((m) => m.model)).toEqual(expect.arrayContaining(["qwen3.5-397b-a17b", "gigachat3.5-432b-a28b"]));
    expect(sum.period.p95).not.toBeNull();
    expect(sum.today.capMicro).toBe(2_850_000_000);
    expect(sum.total.budgetMicro).toBe(50_000_000_000);
    const withTeam = await llmSummary(from, to, now, null, undefined, { includeInternal: true });
    expect(withTeam.period.operations).toBe(sum.period.operations + 1);
    // Весь бюджет и счётчик потолка — все деньги, включая команду.
    expect(sum.total.spentMicro).toBe(withTeam.total.spentMicro);
    expect(sum.today.bucketSpentMicro).toBeGreaterThanOrEqual(withTeam.period.spentMicro);
  });

  it("retention prunes old ledger rows and day buckets; opt-out unlinks the pseudonym", async () => {
    const { setAnalyticsConsent } = await import("../lib/analytics");
    const s = await webUser();
    const now = freshDay();
    const r = await llmCall({ purpose: "explain", userId: s.userId, messages: [{ role: "user", content: "x" }], now });
    await setAnalyticsConsent(s.userId, false);
    expect((await usageOf(r.requestId))[0].subject).toBeNull();
    expect(await q("SELECT 1 FROM budget_buckets WHERE scope_type='user' AND scope_id=$1", [s.userId])).toHaveLength(0);
    const out = await runRetention(new Date("2100-01-01T00:00:00Z"));
    expect(out.aiUsage).toBeGreaterThan(0);
    expect(out.budgetBuckets).toBeGreaterThan(0);
    expect((await q("SELECT 1 FROM budget_buckets WHERE period_kind='total'")).length).toBeGreaterThan(0); // накопительный не удаляется
  });
});
