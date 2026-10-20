/* global __ENV */
// Нагрузочный сценарий «Можно?» для k6 (https://k6.io). Только для ЛОКАЛЬНОЙ production-сборки.
// Не запускайте против https://mozhno-mvp.vercel.app: скрипт создаёт сотни анонимных пользователей.
//
// Сервер (см. docs/LOAD-TEST.md):
//   NODE_ENV=production DATABASE_URL=postgres://...local... MOZHNO_AUTO_MIGRATE=1 \
//   APP_ORIGIN=http://localhost:3100 TRUST_PROXY=1 ANALYTICS_SECRET=<любая строка ≥16 символов> \
//   NEXT_DIST_DIR=.next-loadtest npx next start -p 3100
//
// Запуск:
//   k6 run -e MODE=steady   -e RPS=10  scripts/load/k6-mozhno.js   # смешанный трафик, 10 RPS, 3 мин
//   k6 run -e MODE=isolated -e TARGET=chat -e RPS=10 scripts/load/k6-mozhno.js   # один сервис, 10 RPS, 1 мин
//   k6 run -e MODE=stress   scripts/load/k6-mozhno.js   # ступени 10→25→50→75→100→150 RPS
//   k6 run -e MODE=stress -e STEPS=200,300,400,500,600 -e HOLD=45s -e POOL=3000 scripts/load/k6-mozhno.js   # поиск предела
//
// Авторизация — штатный механизм приложения: POST /api/v1/session (анонимная сессия, cookie mozhno_sid)
// и POST /api/profile (план). Лимит создания сессий — 30/ч на IP, поэтому каждому виртуальному клиенту
// выдаётся свой адрес в X-Forwarded-For, а сервер запущен с TRUST_PROXY=1 (адрес берётся из последнего хопа).
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";
import exec from "k6/execution";

const BASE = __ENV.BASE_URL || "http://localhost:3100";
if (/vercel\.app|mozhno\.app/.test(BASE) && __ENV.I_KNOW_THIS_IS_NOT_PROD !== "1") throw new Error("Нагрузочный тест против production запрещён");
const ORIGIN = __ENV.ORIGIN || BASE;
const MODE = __ENV.MODE || "steady";
const RPS = Number(__ENV.RPS || 10);
const POOL = Number(__ENV.POOL || 600);
const DURATION = __ENV.DURATION || (MODE === "steady" ? "3m" : "1m");

// Доли запросов в смешанном трафике (сумма = 1). Онбординг: 1 итерация = 3 запроса (сессия, открыть, ход).
const MIX = { page: 0.1, health: 0.1, chat: 0.3, sim: 0.15, analytics: 0.15, onboarding: 0.2 };
const REQ_PER_ITER = { page: 1, health: 1, chat: 1, sim: 1, analytics: 1, onboarding: 3 };
const EXEC = { page: "page", health: "health", chat: "chat", sim: "sim", analytics: "analytics", onboarding: "onboarding" };

const unexpected = new Counter("unexpected_status");

function scenarioFor(name, share) {
  const per = REQ_PER_ITER[name];
  const base = { exec: EXEC[name], preAllocatedVUs: 20, maxVUs: 600, timeUnit: "1s", tags: { flow: name } };
  if (MODE === "stress") {
    const r = (total) => Math.max(1, Math.round((total * share) / per));
    // STEPS — ступени суммарного RPS, HOLD — удержание каждой ступени (по умолчанию 10→150 RPS, 60 с).
    const steps = (__ENV.STEPS || "10,25,50,75,100,150").split(",").map(Number);
    const hold = __ENV.HOLD || "60s";
    const stages = [];
    for (const s of steps) { stages.push({ target: r(s), duration: "20s" }); stages.push({ target: r(s), duration: hold }); }
    return { ...base, executor: "ramping-arrival-rate", startRate: r(steps[0]), stages };
  }
  return { ...base, executor: "constant-arrival-rate", rate: Math.max(1, Math.round((RPS * share) / per * 100)), timeUnit: "100s", duration: DURATION };
}

function buildScenarios() {
  if (MODE === "isolated") {
    const t = __ENV.TARGET || "chat";
    return { [t]: scenarioFor(t, 1) };
  }
  return Object.fromEntries(Object.entries(MIX).map(([k, v]) => [k, scenarioFor(k, v)]));
}

export const options = {
  setupTimeout: "10m",
  discardResponseBodies: false,
  scenarios: buildScenarios(),
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  thresholds: {
    // Цели для 10 RPS (steady/isolated). В stress пороги информативные: тест не прерывается.
    "http_req_failed": [{ threshold: "rate<0.01", abortOnFail: false }],
    "http_req_duration{flow:chat}": ["p(95)<500"],
    "http_req_duration{flow:sim}": ["p(95)<500"],
    "http_req_duration{flow:onboarding}": ["p(95)<500"],
    "http_req_duration{flow:analytics}": ["p(95)<300"],
    "http_req_duration{flow:health}": ["p(95)<200"],
    "http_req_duration{flow:page}": ["p(95)<200"],
  },
};

// Уникальный «клиентский» IP: n → 10.x.y.z
function ipFor(n) { return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`; }
const json = (cookie, ip) => ({ headers: { "content-type": "application/json", Origin: ORIGIN, "X-Forwarded-For": ip, ...(cookie ? { Cookie: `mozhno_sid=${cookie}` } : {}) } });

function newSession(ip, tags) {
  const r = http.post(`${BASE}/api/v1/session`, null, { headers: { Origin: ORIGIN, "X-Forwarded-For": ip }, tags });
  const sid = r.cookies.mozhno_sid && r.cookies.mozhno_sid[0] && r.cookies.mozhno_sid[0].value;
  if (r.status !== 201 || !sid) { unexpected.add(1, { endpoint: "session" }); return null; }
  return sid;
}

function isoInDays(d) { const t = new Date(Date.now() + d * 86400000); return t.toISOString().slice(0, 10); }

export function setup() {
  // Пул пользователей с готовым планом: сессия + POST /api/profile. Параллельно пачками по 50.
  const users = [];
  const plan = (i) => JSON.stringify({
    balance: 40000 + (i % 50) * 1000, reserve: 5000,
    nextIncome: { date: isoInDays(5 + (i % 20)), amount: 70000 + (i % 7) * 5000 },
    payments: [{ name: "Аренда", amount: 25000, date: isoInDays(3 + (i % 10)) }, { name: "Связь", amount: 600, date: isoInDays(2 + (i % 15)) }],
  });
  for (let start = 0; start < POOL; start += 50) {
    const n = Math.min(50, POOL - start);
    const reqs = [];
    for (let i = 0; i < n; i++) reqs.push(["POST", `${BASE}/api/v1/session`, null, { headers: { Origin: ORIGIN, "X-Forwarded-For": ipFor(1_000_000 + start + i) }, tags: { flow: "setup" } }]);
    const rs = http.batch(reqs);
    const sids = rs.map((r) => (r.cookies.mozhno_sid && r.cookies.mozhno_sid[0] ? r.cookies.mozhno_sid[0].value : null));
    const preqs = [];
    sids.forEach((sid, i) => { if (sid) preqs.push(["POST", `${BASE}/api/profile`, plan(start + i), { ...json(sid, ipFor(1_000_000 + start + i)), tags: { flow: "setup" } }]); });
    const ps = http.batch(preqs);
    ps.forEach((p, i) => { if (p.status === 200) users.push({ sid: sids[i], ip: ipFor(1_000_000 + start + i) }); });
  }
  if (users.length < POOL * 0.95) throw new Error(`setup: создано ${users.length} из ${POOL}`);
  return { users };
}

const pick = (data) => data.users[Math.floor(Math.random() * data.users.length)];
const QUESTIONS = ["Можно купить наушники за 15 000?", "Могу ли я сейчас купить телефон за 60 000 рублей?", "Можно кроссовки за 8 тыс?", "Можно куплю кофемашину за 23 500?", "Можно купить ужин за 3000?"];

export function page() {
  const r = http.get(`${BASE}/`, { tags: { endpoint: "GET /" } });
  if (!check(r, { "page 200": (x) => x.status === 200 })) unexpected.add(1, { endpoint: "page" });
}

export function health() {
  const r = http.get(`${BASE}/api/health`, { tags: { endpoint: "GET /api/health" } });
  if (!check(r, { "health 200": (x) => x.status === 200 })) unexpected.add(1, { endpoint: "health" });
}

export function chat(data) {
  const u = pick(data);
  const q = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
  const r = http.post(`${BASE}/api/chat`, JSON.stringify({ message: q }), { ...json(u.sid, u.ip), tags: { endpoint: "POST /api/chat" } });
  if (!check(r, { "chat 200 + verdict": (x) => x.status === 200 && !!x.json("decisionId") })) unexpected.add(1, { endpoint: "chat", status: String(r.status) });
}

export function sim(data) {
  const u = pick(data);
  const price = String((5000 + Math.floor(Math.random() * 60000)) * 100);
  const body = JSON.stringify({ purchase: { description: "покупка", priceMinor: price }, alternatives: [{ key: "after", priceMinor: price, afterIncome: true }] });
  const r = http.post(`${BASE}/api/v1/finance/simulations`, body, { ...json(u.sid, u.ip), tags: { endpoint: "POST /api/v1/finance/simulations" } });
  if (!check(r, { "sim 200": (x) => x.status === 200 })) unexpected.add(1, { endpoint: "sim", status: String(r.status) });
}

export function analytics(data) {
  const u = pick(data);
  const body = JSON.stringify({ events: [{ name: "session_started" }, { name: "screen_viewed", props: { screen: "home" } }, { name: "screen_viewed", props: { screen: "assistant" } }] });
  const r = http.post(`${BASE}/api/v1/analytics`, body, { ...json(u.sid, u.ip), tags: { endpoint: "POST /api/v1/analytics" } });
  if (!check(r, { "analytics 202": (x) => x.status === 202 })) unexpected.add(1, { endpoint: "analytics", status: String(r.status) });
}

export function onboarding() {
  // Новый пользователь проходит первые шаги чата-знакомства: сессия → открыть → ответ про остаток.
  const ip = ipFor((exec.vu.idInTest << 12) + (exec.vu.iterationInScenario % 4096));
  const sid = newSession(ip, { endpoint: "POST /api/v1/session" });
  if (!sid) return;
  const o = http.post(`${BASE}/api/v1/onboarding`, "{}", { ...json(sid, ip), tags: { endpoint: "POST /api/v1/onboarding" } });
  if (!check(o, { "onboarding open 200": (x) => x.status === 200 })) { unexpected.add(1, { endpoint: "onboarding_open", status: String(o.status) }); return; }
  const t = http.post(`${BASE}/api/v1/onboarding/turn`, JSON.stringify({ clientMessageId: `lt-${exec.vu.idInTest}-${exec.vu.iterationInScenario}`, text: "45 000" }), { ...json(sid, ip), tags: { endpoint: "POST /api/v1/onboarding/turn" } });
  if (!check(t, { "onboarding turn 200": (x) => x.status === 200 })) unexpected.add(1, { endpoint: "onboarding_turn", status: String(t.status) });
}
