// Клиентская часть аналитики: только начало сессии, просмотр экрана и открытие «Плюса». Очередь с пакетной отправкой
// (до 20 событий, раз в 5 с или при скрытии вкладки). Тексты, суммы и URL не отправляются никогда.
"use client";

type ClientEvent = { name: "session_started" } | { name: "screen_viewed"; props: { screen: string } } | { name: "plus_viewed"; props: { surface: "counter" | "menu" | "exhausted" | "answer" } };
const queue: (ClientEvent & { id: string })[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

const channel = () => ((window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp?.initData ? "miniapp" : "web");
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`);

export function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!queue.length) return;
  const events = queue.splice(0, 20);
  // keepalive: доставка при закрытии вкладки; same-origin с cookie (Mini App — тоже same-origin).
  fetch("/api/v1/analytics", { method: "POST", credentials: "include", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: channel(), events }) }).catch(() => {});
  if (queue.length) flush();
}

export function trackClient(e: ClientEvent) {
  if (typeof window === "undefined") return;
  queue.push({ ...e, id: uid() });
  if (queue.length >= 20) flush();
  else if (!timer) timer = setTimeout(flush, 5000);
}

let wired = false;
/** Подключить один раз: начало сессии при открытии и при возврате на вкладку; отправка очереди при скрытии. */
export function wireAnalytics() {
  if (wired || typeof document === "undefined") return;
  wired = true;
  trackClient({ name: "session_started" });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
    else trackClient({ name: "session_started" }); // сервер склеивает в окно 30 минут
  });
}

/**
 * Первое касание для POST /api/v1/session: UTM-метки из адреса и реферер (сервер оставит только домен).
 * Код команды ?team=… передаётся один раз и сразу убирается из адресной строки.
 */
export function firstVisitBody(): { attribution: Record<string, string>; team?: string; ref?: string } {
  if (typeof window === "undefined") return { attribution: {} };
  const q = new URLSearchParams(window.location.search);
  const attribution: Record<string, string> = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign"]) { const v = q.get(k); if (v) attribution[k] = v.slice(0, 100); }
  if (document.referrer) attribution.referrer = document.referrer.slice(0, 500);
  const team = q.get("team") ?? undefined;
  const ref = pendingRef();
  if (team || q.has("ref")) {
    q.delete("team"); q.delete("ref");
    const rest = q.toString();
    window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash);
  }
  return { attribution, ...(team ? { team: team.slice(0, 128) } : {}), ...(ref ? { ref } : {}) };
}

const REF_KEY = "mozhno_ref";
/**
 * Код приглашения ?ref=<код>: переживает перезагрузку до создания сессии (sessionStorage), как UTM уходит в POST /api/v1/session.
 * Сервер засчитывает его только новому аккаунту.
 */
export function pendingRef(): string | null {
  if (typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get("ref");
  const code = v && /^[A-Za-z0-9]{6,16}$/.test(v) ? v.toLowerCase() : null;
  try {
    if (code) sessionStorage.setItem(REF_KEY, code);
    return code ?? sessionStorage.getItem(REF_KEY);
  } catch { return code; }
}
export function clearPendingRef() { try { sessionStorage.removeItem(REF_KEY); } catch {} }
