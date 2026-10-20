// Drill-down шага воронки: ПОЧЕМУ уходят на этапе. Только агрегаты из allowlist-событий онбординга
// (шаг, исход, способ ввода, время с точностью до минуты); тексты ответов не собираются и не читаются.
import { getDb, type Queryable } from "./db";
import { ATTEMPT_HORIZON_DAYS, CHANNELS, FUNNEL_ORDER, FUNNEL_STEPS, MIN_COHORT, MIN_SAMPLE, loadFunnelAttempts, rate, scopedDb, type ChannelFilter, type FunnelAttempt } from "./analytics-metrics";
import { pct, STEP_LABEL, zProp } from "./analytics-insights";

const DAY = 86_400_000, MIN = 60_000;
/** Через сколько после последнего действия можно считать, что человек «больше не появлялся» (иначе — «рано судить»). */
export const GONE_AFTER_DAYS = 3;
/** Возврат позже: событие того же псевдонима через ≥ 30 минут после последнего действия в проходе. */
const LATER_GAP = 30 * MIN;
/** Интервал «от показа до последнего зарегистрированного события» (не время до ухода!). */
export const DWELL_BUCKETS = ["событий после показа нет", "та же минута", "1–3 мин", "4–10 мин", "> 10 мин"] as const;
/** Порог |z| для «худшего канала»: поправка Бонферрони на 3 сравнения (α = 0,05/3). */
export const Z_CHANNEL = 2.39;
export const DRILL_KEYS = FUNNEL_ORDER.filter((k) => k !== "started");
export type DrillKey = (typeof DRILL_KEYS)[number];
export type Sig = boolean | "few" | null;
/** Что считаем «человек сам вернулся»: только действия пользователя (не рассылки, не ответы системы). */
export const USER_ACTIONS = new Set([
  "session_started", "user_active", "screen_viewed", "onboarding_started", "onboarding_step_answered", "onboarding_step_skipped",
  "onboarding_step_unknown", "onboarding_corrected", "onboarding_not_understood", "onboarding_completed", "purchase_asked",
  "proposal_confirmed", "proposal_rejected", "expense_logged", "reminder_clicked",
]);
const PROGRESS = new Set(["onboarding_step_answered", "onboarding_step_skipped", "onboarding_step_unknown", "onboarding_completed"]);
export interface LaterEvent { name: string; t: number; attempt?: string | null }

/** prevRate/sig — сравнение «созревших» проходов (старше горизонта) с прошлым периодом. */
export interface DrillChannel { channel: string; base: number; dropped: number; rate: number | null; small: boolean; matureRate: number | null; prevRate: number | null; sig: Sig }
export interface Drill {
  key: string; label: string; prevLabel: string; isStep: boolean;
  base: number; dropped: number; passed: number; rate: number | null;
  channels: DrillChannel[];
  /** Наблюдаемые признаки у ушедших (взаимоисключающе, по приоритету): показ не записан → бот не понял → исправляли прошлый ответ → событий после показа нет. */
  did: { notShown: number; notUnderstood: number; wentBack: number; other: number; nothing: number };
  /** Как писали те, кого бот не понял (поле input у not_understood; старые события без него — unknown). */
  failedInput: { text: number; choice: number; voice: number; unknown: number };
  dwell: { buckets: number[]; median: number | null; n: number };
  passDwell: { median: number | null; n: number };
  after: { resumed: number; restarted: number; cameBack: number; gone: number; recent: number };
  passMix: { answered: number; unknown: number; skipped: number; text: number; choice: number; voice: number } | null;
  /** Сравнение с прошлым периодом — только по созревшим проходам (за ними наблюдали полные ATTEMPT_HORIZON_DAYS дней). */
  prev: { base: number; dropped: number; rate: number | null; sig: Sig; matureBase: number; matureRate: number | null };
  takeaway: { text: string; tone: "warn" | "good" | "info" };
  untracked: string[];
}

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const sigOf = (a: number, n1: number, b: number, n2: number): Sig => { const z = zProp(a, n1, b, n2); return z == null ? "few" : Math.abs(z) >= 1.96; };
const isStep = (k: string) => (FUNNEL_STEPS as readonly string[]).includes(k) || k === "planningDays";
const OUTCOME = new Set(["onboarding_step_answered", "onboarding_step_unknown", "onboarding_step_skipped"]);

/** Момент входа на этап K: показ вопроса (для шагов) или событие, которым завершён предыдущий этап. */
function entryOf(a: FunnelAttempt, key: string, prevKey: string): number | null {
  if (isStep(key)) return a.events.find((e) => e.name === "onboarding_step_shown" && e.step === key)?.t ?? null;
  if (prevKey === "preview") return a.events.find((e) => e.name === "onboarding_preview_shown")?.t ?? null;
  return a.events.find((e) => OUTCOME.has(e.name) && e.step === prevKey)?.t ?? null;
}
const ratioWord = (r: number) => (r >= 2.8 && r < 3.3 ? "втрое" : r >= 1.85 && r < 2.25 ? "вдвое" : `в ${r.toFixed(1).replace(".", ",")} раза`);
const HINT: Record<string, string> = { telegram: "проверить клавиатуру и кнопки бота", web: "проверить форму шага в вебе", miniapp: "проверить экран шага в Mini App" };
const CH_IN: Record<string, string> = { telegram: "В боте", web: "В вебе", miniapp: "В Mini App" };

/** Чистый расчёт (тестируется): проходы текущего и прошлого периода + последующие события ушедших. */
export function drillFrom(key: string, cur: FunnelAttempt[], prev: FunnelAttempt[], later: Map<string, LaterEvent[]>, now: number, ch: ChannelFilter): Drill {
  const idx = FUNNEL_ORDER.indexOf(key as (typeof FUNNEL_ORDER)[number]);
  if (idx <= 0) throw new Error(`bad funnel key ${key}`);
  const prevKey = FUNNEL_ORDER[idx - 1];
  const split = (as: FunnelAttempt[]) => { const base = as.filter((a) => a.k >= idx); return { base, dropped: base.filter((a) => a.k === idx), passed: base.filter((a) => a.k > idx) }; };
  const c = split(cur), p = split(prev);
  // Проходы последних дней ещё «не созрели»: человек мог ответить позже. Для сравнения с прошлым периодом берём только созревшие.
  const mature = (a: FunnelAttempt) => (a.events[0]?.t ?? now) + ATTEMPT_HORIZON_DAYS * DAY <= now;
  const m = split(cur.filter(mature));
  const channels: DrillChannel[] = CHANNELS.filter((x) => !ch || ch === x).map((x) => {
    const b = c.base.filter((a) => a.channel === x), dr = b.filter((a) => a.k === idx);
    const pb = p.base.filter((a) => a.channel === x), pdr = pb.filter((a) => a.k === idx);
    const mb = m.base.filter((a) => a.channel === x), mdr = mb.filter((a) => a.k === idx);
    return { channel: x, base: b.length, dropped: dr.length, rate: rate(dr.length, b.length), small: b.length < MIN_SAMPLE, matureRate: rate(mdr.length, mb.length), prevRate: rate(pdr.length, pb.length), sig: sigOf(mdr.length, mb.length, pdr.length, pb.length) };
  });
  const did = { notShown: 0, notUnderstood: 0, wentBack: 0, other: 0, nothing: 0 };
  const failedInput = { text: 0, choice: 0, voice: 0, unknown: 0 };
  const dwellMin: number[] = [];
  const after = { resumed: 0, restarted: 0, cameBack: 0, gone: 0, recent: 0 };
  for (const a of c.dropped) {
    const entry = entryOf(a, key, prevKey);
    const last = a.events.reduce((m, e) => Math.max(m, e.t), 0);
    if (entry == null) { if (isStep(key)) did.notShown++; else did.nothing++; }
    else {
      // Время с точностью до минуты: всё, что в ту же минуту относится к другим шагам, могло быть и до показа — не считаем.
      const evs = a.events.filter((e) => e.t >= entry && !(e.name === "onboarding_step_shown" && e.step === key) && !(e.t === entry && e.step !== key));
      const nu = evs.filter((e) => e.name === "onboarding_not_understood" && (!isStep(key) || e.step === key));
      if (nu.length) { did.notUnderstood++; const inp = nu.at(-1)!.input; if (inp === "text" || inp === "choice" || inp === "voice") failedInput[inp]++; else failedInput.unknown++; }
      else if (evs.some((e) => e.name === "onboarding_corrected" || (e.step != null && e.step !== key && e.step !== "summary"))) did.wentBack++;
      else if (evs.length) did.other++;
      else did.nothing++;
      dwellMin.push(evs.length ? Math.round((last - entry) / MIN) : -1);
    }
    const l = (later.get(a.subject) ?? []).filter((e) => e.t > last + LATER_GAP && USER_ACTIONS.has(e.name));
    if (l.some((e) => e.attempt === a.attempt && PROGRESS.has(e.name))) after.resumed++;
    else if (l.some((e) => e.name === "onboarding_started")) after.restarted++;
    else if (l.length) after.cameBack++;
    else if (now - last >= GONE_AFTER_DAYS * DAY) after.gone++;
    else after.recent++;
  }
  const buckets = [0, 0, 0, 0, 0];
  for (const m of dwellMin) buckets[m < 0 ? 0 : m < 1 ? 1 : m <= 3 ? 2 : m <= 10 ? 3 : 4]++;
  const timed = dwellMin.filter((m) => m >= 0);
  const passTimes: number[] = [];
  let passMix: Drill["passMix"] = null;
  if (isStep(key)) {
    passMix = { answered: 0, unknown: 0, skipped: 0, text: 0, choice: 0, voice: 0 };
    for (const a of c.passed) {
      const o = a.x.outcome.get(key); if (o) passMix[o]++;
      const inp = a.x.input.get(key); if (inp === "text" || inp === "choice" || inp === "voice") passMix[inp]++;
      const en = entryOf(a, key, prevKey), out = a.events.find((e) => OUTCOME.has(e.name) && e.step === key)?.t;
      if (en != null && out != null && out >= en) passTimes.push(Math.round((out - en) / MIN));
    }
  }
  const r = rate(c.dropped.length, c.base.length), pr = rate(p.dropped.length, p.base.length);
  const mr = rate(m.dropped.length, m.base.length);
  const prevSig = sigOf(m.dropped.length, m.base.length, p.dropped.length, p.base.length);
  const d: Drill = {
    key, label: STEP_LABEL[key] ?? key, prevLabel: STEP_LABEL[prevKey] ?? prevKey, isStep: isStep(key),
    base: c.base.length, dropped: c.dropped.length, passed: c.passed.length, rate: r,
    channels, did, failedInput, dwell: { buckets, median: median(timed), n: dwellMin.length }, passDwell: { median: median(passTimes), n: passTimes.length },
    after, passMix, prev: { base: p.base.length, dropped: p.dropped.length, rate: pr, sig: prevSig, matureBase: m.base.length, matureRate: mr },
    takeaway: { text: "", tone: "info" },
    untracked: [
      "Момент ухода: события «закрыл» нет — показываем интервал от показа до последнего зарегистрированного события, с точностью до минуты.",
      "Отсутствие событий не значит «вышел из приложения»: человек мог читать, отвлечься или закрыть вкладку.",
      `Сравнение с прошлым периодом — только по проходам старше ${ATTEMPT_HORIZON_DAYS} дн.: у более свежих ответ ещё может прийти.`,
      "«Вернулись позже» — только собственные действия человека; рассылки и ответы системы не считаются.",
      "Что именно писали: тексты ответов не собираются по построению.",
      ...(did.notUnderstood && failedInput.unknown ? ["Способ ввода у «бот не понял» пишется с v22 — у более ранних событий он неизвестен."] : []),
    ],
  };
  d.takeaway = takeaway(d);
  return d;
}

/** Один детерминированный вывод — по приоритету правил. */
export function takeaway(d: Drill): Drill["takeaway"] {
  if (d.base < MIN_SAMPLE || d.dropped < MIN_COHORT) return { text: `Мало данных: до шага дошли ${d.base}, ушли ${d.dropped} — выводы делать рано.`, tone: "info" };
  const ok = d.channels.filter((c) => !c.small && c.rate != null);
  if (ok.length >= 2) {
    const worst = ok.reduce((a, b) => (b.rate! > a.rate! ? b : a));
    const rest = ok.filter((c) => c !== worst);
    const rb = rest.reduce((s, c) => s + c.base, 0), rd = rest.reduce((s, c) => s + c.dropped, 0);
    const rr = rate(rd, rb);
    const z = zProp(worst.dropped, worst.base, rd, rb);
    if (rr != null && rr > 0 && worst.rate! / rr >= 1.5 && z != null && Math.abs(z) >= Z_CHANNEL)
      return { text: `${CH_IN[worst.channel]} теряем ${ratioWord(worst.rate! / rr)} больше (${pct(worst.rate)} против ${pct(rr)}). Гипотеза — ${HINT[worst.channel]}.`, tone: "warn" };
  }
  const nu = rate(d.did.notUnderstood, d.dropped) ?? 0;
  if (nu >= 0.25) {
    const typed = rate(d.failedInput.text + d.failedInput.voice, d.failedInput.text + d.failedInput.voice + d.failedInput.choice);
    return { text: `${pct(nu)} ушедших перед уходом получили «не понял»${typed != null && typed >= 0.8 ? " (писали своими словами)" : ""}. Гипотеза — помогут кнопки-варианты и пример ответа.`, tone: "warn" };
  }
  const nothing = rate(d.did.nothing, d.dropped) ?? 0;
  if (nothing >= 0.6) return d.isStep
    ? { text: `У ${pct(nothing)} ушедших после показа вопроса нет ни одного события. Гипотеза — вопрос сложный с порога: упростить или сразу предложить «не знаю».`, tone: "warn" }
    : { text: `У ${pct(nothing)} ушедших после «${d.prevLabel}» нет ни одного события. Гипотеза — переход к «${d.label}» неочевиден или долгий: проверить, что экран открывается сразу.`, tone: "warn" };
  const mr = d.prev.matureRate;
  if (d.prev.sig === true && mr != null && d.prev.rate != null)
    return mr > d.prev.rate
      ? { text: `Потери на шаге выросли: ${pct(mr)} против ${pct(d.prev.rate)} в прошлом периоде.`, tone: "warn" }
      : { text: `Потери на шаге снизились: ${pct(mr)} против ${pct(d.prev.rate)} в прошлом периоде.`, tone: "good" };
  return { text: "Явной причины в данных нет: по каналам и наблюдаемым событиям ушедшие похожи.", tone: "info" };
}

/** Drill-down этапа `key` за последние `days` полных UTC-дней (те же границы, что у дашборда). */
export async function funnelDrill(now: Date, days: number, ch: ChannelFilter, key: string, q?: Queryable, opts: { includeInternal?: boolean } = {}): Promise<Drill> {
  const db = scopedDb(q ?? (await getDb()), opts.includeInternal);
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - days * DAY), pfrom = new Date(from.getTime() - days * DAY);
  const [cur, prev] = [await loadFunnelAttempts(db, from, to, ch), await loadFunnelAttempts(db, pfrom, from, ch)];
  const idx = FUNNEL_ORDER.indexOf(key as (typeof FUNNEL_ORDER)[number]);
  const dropped = cur.filter((a) => a.k === idx);
  const later = new Map<string, LaterEvent[]>();
  if (dropped.length) {
    const minLast = Math.min(...dropped.map((a) => a.events.reduce((m, e) => Math.max(m, e.t), 0)));
    const r = await db.query<{ subject: string; name: string; attempt: string | null; t: Date | string }>(
      "SELECT subject, name, attempt, occurred_at t FROM analytics_events WHERE subject = ANY($1::text[]) AND name = ANY($4::text[]) AND occurred_at > $2::timestamptz AND occurred_at <= $3::timestamptz",
      [[...new Set(dropped.map((a) => a.subject))], new Date(minLast), now, [...USER_ACTIONS]]);
    for (const x of r.rows) (later.get(x.subject) ?? later.set(x.subject, []).get(x.subject)!).push({ name: x.name, attempt: x.attempt, t: new Date(x.t).getTime() });
  }
  return drillFrom(key, cur, prev, later, now.getTime(), ch);
}
