// Детерминированные выводы для дашборда: шаблоны с порогами, без генеративных моделей.
// Правила против «шумных» выводов:
//  • при выборке меньше MIN_SAMPLE — только «мало данных»;
//  • сравнение долей — двухвыборочный z-тест (|z| ≥ 1,96), иначе «в пределах шума»;
//  • сравнение счётчиков — пуассоновское приближение (|Δ| > 2·√(a+b)).
import { CHANNELS, FUNNEL_STEPS, MIN_SAMPLE, rate, type Dashboard, type DayPoint } from "./analytics-metrics";

const NB = "\u00a0";
export const pct = (x: number | null | undefined, d = 0) => (x == null ? "—" : `${(x * 100).toFixed(d).replace(".", ",")}${NB}%`);
export const pp = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(x * 100).toFixed(1).replace(".", ",").replace(/,0$/, "")}${NB}п.п.`;
export const rel = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(Math.round(x * 100))}${NB}%`;
export const int = (n: number) => Math.round(n).toLocaleString("ru-RU").replace(/\s/g, NB);
export const dec = (x: number | null, d = 1) => (x == null ? "—" : x.toFixed(d).replace(".", ","));
export const mins = (m: number | null) => (m == null ? "—" : m < 1 ? `<1${NB}мин` : m < 60 ? `${Math.round(m)}${NB}мин` : m < 1440 ? `${dec(m / 60)}${NB}ч` : `${dec(m / 1440)}${NB}дн`);

export const STEP_LABEL: Record<string, string> = {
  started: "Начали", balance: "Деньги на карте", income: "Доход", preview: "Показан прогноз", payments: "Платежи", reserve: "Резерв",
  essentialDaily: "Еда и транспорт", goal: "Цель", completed: "Завершили",
};
export const VERDICT_LABEL: Record<string, string> = { fits_plan: "Вписывается", reduces_daily_margin: "В день меньше половины", touches_protected_money: "Задевает резерв или цель", cash_gap: "Не хватит на обязательное", insufficient_data: "Мало данных" };
export const KIND_LABEL: Record<string, string> = { payment_due: "Платёж завтра", payday: "День дохода", onboarding: "Продолжить знакомство", log_nudge: "Записать траты", weekly: "План недели", morning: "Утро" };
export const CHANNEL_LABEL: Record<string, string> = { web: "Веб", telegram: "Бот", miniapp: "Mini App" };
const WEEKDAY = ["воскресеньям", "понедельникам", "вторникам", "средам", "четвергам", "пятницам", "субботам"];

/** z-статистика разницы двух долей; null — если выборка мала. */
export function zProp(a: number, n1: number, b: number, n2: number): number | null {
  if (n1 < MIN_SAMPLE || n2 < MIN_SAMPLE) return null;
  // нормальное приближение годится, только если в каждой группе ≥ 5 «успехов» и «неуспехов»
  if (Math.min(a, n1 - a, b, n2 - b) < 5) return null;
  const p = (a + b) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se === 0 ? 0 : (a / n1 - b / n2) / se;
}
export const significantCount = (cur: number, prev: number) => Math.abs(cur - prev) > 2 * Math.sqrt(cur + prev) && cur + prev >= MIN_SAMPLE;

export type Trend = "up" | "down" | "flat" | "noise" | "na";
export interface Kpi {
  id: "activation" | "d7" | "wau" | "asks" | "reminders";
  label: string; value: string; raw: number | null; prevLabel: string; delta: string | null; trend: Trend; good: boolean | null;
  n: number; nLabel: string; spark: (number | null)[]; insight: string; definition: string;
}

function rateDelta(a: number, n1: number, b: number, n2: number): { delta: string | null; trend: Trend } {
  const r1 = rate(a, n1), r2 = rate(b, n2);
  if (r1 == null || r2 == null) return { delta: null, trend: "na" };
  const z = zProp(a, n1, b, n2);
  const d = r1 - r2;
  if (z == null) return { delta: pp(d), trend: "na" };
  return { delta: pp(d), trend: Math.abs(z) < 1.96 ? "noise" : d > 0 ? "up" : "down" };
}

/** Скользящая доля за 7 дней: Σчисл / Σзнам. */
export function rolling(series: DayPoint[], numKey: keyof DayPoint, denKey: keyof DayPoint, minDen = 1): (number | null)[] {
  return series.map((_, i) => {
    const w = series.slice(Math.max(0, i - 6), i + 1);
    const n = w.reduce((a, p) => a + Number(p[numKey]), 0), d = w.reduce((a, p) => a + Number(p[denKey]), 0);
    return d >= minDen ? n / d : null;
  });
}

/** Самая большая потеря в воронке (по доле от дошедших до этапа). */
export function biggestDrop(d: Dashboard["cur"]["funnel"]) {
  const s = d.stages.filter((x) => x.key !== "started" && x.dropRate != null);
  if (!s.length || d.attempts < MIN_SAMPLE) return null;
  return s.reduce((a, b) => ((b.dropRate ?? 0) > (a.dropRate ?? 0) ? b : a));
}

/** День недели с максимальным средним DAU (если разница с минимальным ≥ 15 % и есть ≥ 2 недели). */
export function weekdayPeak(series: DayPoint[]): { peak: number; low: number; ratio: number } | null {
  if (series.length < 14) return null;
  const sum = Array(7).fill(0), cnt = Array(7).fill(0);
  for (const p of series) { const w = new Date(`${p.day}T00:00:00Z`).getUTCDay(); sum[w] += p.dau; cnt[w]++; }
  const avg = sum.map((s, i) => (cnt[i] ? s / cnt[i] : 0));
  const peak = avg.indexOf(Math.max(...avg)), low = avg.indexOf(Math.min(...avg));
  if (avg[low] <= 0 || avg[peak] / avg[low] < 1.15) return null;
  return { peak, low, ratio: avg[peak] / avg[low] };
}

export function kpis(d: Dashboard): Kpi[] {
  const { cur, prev } = d;
  const small = (n: number) => n < MIN_SAMPLE;
  const out: Kpi[] = [];

  // 1. Активация
  {
    const a = cur.activation, b = prev.activation;
    const { delta, trend } = rateDelta(a.activated, a.matured, b.activated, b.matured);
    const drop = biggestDrop(cur.funnel);
    out.push({
      id: "activation", label: "Увидели прогноз или ответ за первые 24 ч", value: pct(a.rate), raw: a.rate, prevLabel: pct(b.rate), delta, trend, good: trend === "up" ? true : trend === "down" ? false : null,
      n: a.matured, nLabel: `n${NB}=${NB}${int(a.matured)} начавших`, spark: rolling(d.series, "activated", "matured", 5),
      insight: small(a.matured) ? `Мало данных: ${int(a.matured)} начавших — выводы рано.`
        : drop ? `Больше всего теряем на шаге «${STEP_LABEL[drop.key]}»: −${pct(drop.dropRate)} дошедших.` : `Медиана до первого прогноза — ${mins(a.p50Min)}.`,
      definition: "Доля начавших знакомство в периоде, кому за первые 24 часа показали первый прогноз или дали ответ «Можно?». Учитываются только начавшие больше 24 часов назад.",
    });
  }
  // 2. D7
  {
    const a = cur.retention.d7, b = prev.retention.d7;
    const { delta, trend } = rateDelta(a.returned, a.n, b.returned, b.n);
    const ch = d.channels.filter((c) => c.d7 != null && c.d7n >= MIN_SAMPLE);
    let insight = small(a.n) ? `Мало данных: ${int(a.n)} человек с закрытым окном D7.` : `Из ${int(a.n)} новых вернулись на второй неделе ${int(a.returned)}.`;
    if (!small(a.n) && ch.length >= 2) {
      const best = ch.reduce((x, y) => ((y.d7 ?? 0) > (x.d7 ?? 0) ? y : x)), worst = ch.reduce((x, y) => ((y.d7 ?? 1) < (x.d7 ?? 1) ? y : x));
      const z = zProp(Math.round((best.d7 ?? 0) * best.d7n), best.d7n, Math.round((worst.d7 ?? 0) * worst.d7n), worst.d7n);
      if (best !== worst && z != null && Math.abs(z) >= 1.96) insight = `${CHANNEL_LABEL[best.channel]} удерживает лучше: ${pct(best.d7)} против ${pct(worst.d7)} (${CHANNEL_LABEL[worst.channel].toLowerCase()}).`;
    }
    out.push({
      id: "d7", label: "Возвращаются на второй неделе", value: pct(a.rate), raw: a.rate, prevLabel: pct(b.rate), delta, trend, good: trend === "up" ? true : trend === "down" ? false : null,
      n: a.n, nLabel: `n${NB}=${NB}${int(a.n)} новых`, spark: d.cohorts.map((c) => c.cells.find((x) => x.day === 7)?.rate ?? null),
      insight, definition: "Новые пользователи, у которых в периоде закрылось окно «дни 7–13» после первого визита; доля тех, кто был активен хотя бы в один из этих дней (в любом канале).",
    });
  }
  // 3. WAU
  {
    const a = cur.wauEnd, b = prev.wauEnd;
    const sig = significantCount(a, b);
    const r = b > 0 ? (a - b) / b : null;
    const peak = weekdayPeak(d.series);
    out.push({
      id: "wau", label: "Активны за последние 7 дней", value: int(a), raw: a, prevLabel: int(b), delta: r == null ? null : rel(r),
      trend: r == null ? "na" : !sig ? "noise" : r > 0 ? "up" : "down", good: !sig || r == null ? null : r > 0,
      n: a, nLabel: `новых аккаунтов: ${int(cur.newUsers)}`, spark: d.series.map((p) => p.wau),
      insight: small(a) ? "Мало активных пользователей для выводов." : peak ? `Пик — по ${WEEKDAY[peak.peak]}: в ${dec(peak.ratio)} раза больше, чем по ${WEEKDAY[peak.low]}.`
        : `DAU/WAU — ${pct(rate(d.series.slice(-7).reduce((s, p) => s + p.dau, 0) / 7, a))}: заходят в среднем ${dec((d.series.slice(-7).reduce((s, p) => s + p.dau, 0)) / Math.max(1, a))} дня в неделю.`,
      definition: "Уникальные пользователи с любым действием за последние 7 полных дней периода. Пользователь в двух каналах считается один раз.",
    });
  }
  // 4. «Можно?»
  {
    const a = cur.asks.perActiveWeek, b = prev.asks.perActiveWeek;
    const r = a != null && b != null && b > 0 ? (a - b) / b : null;
    const ok = cur.activeUserWeeks >= MIN_SAMPLE && prev.activeUserWeeks >= MIN_SAMPLE;
    const sig = significantCount(cur.asks.total, prev.asks.total * (cur.activeUserWeeks / Math.max(1, prev.activeUserWeeks)));
    const zero = rate(cur.asks.freq[0], cur.active);
    out.push({
      id: "asks", label: "Вопросов «Можно?» на активного в неделю", value: dec(a), raw: a, prevLabel: dec(b), delta: r == null ? null : rel(r),
      trend: r == null || !ok ? "na" : Math.abs(r) < 0.1 || !sig ? "noise" : r > 0 ? "up" : "down", good: r == null || !ok || Math.abs(r) < 0.1 || !sig ? null : r > 0,
      n: cur.asks.total, nLabel: `${int(cur.asks.total)} вопросов`, spark: d.series.map((_, i) => {
        const w = d.series.slice(Math.max(0, i - 6), i + 1); const wau = d.series[i].wau;
        return i >= 6 && wau >= 5 ? w.reduce((s, p) => s + p.asks, 0) / wau : null; // только полные 7-дневные окна
      }),
      insight: small(cur.active) ? "Мало активных пользователей для выводов." : zero != null && zero >= 0.4 ? `${pct(zero)} активных ни разу не спросили «Можно?» — главный резерв.`
        : `Повторно спрашивают ${pct(cur.asks.repeatShare)} из спросивших.`,
      definition: "Вопросы о покупке, по которым был расчёт (чат, бот, API), делённые на число пар «пользователь × неделя» с любой активностью.",
    });
  }
  // 5. Напоминания
  if (d.channel === null || d.channel === "telegram") {
    const a = cur.reminders, b = prev.reminders;
    const { delta, trend } = rateDelta(a.clicked, a.sent, b.clicked, b.sent);
    const eligible = a.kinds.filter((k) => k.sent >= MIN_SAMPLE);
    const best = eligible.length ? eligible.reduce((x, y) => ((y.ctr ?? 0) > (x.ctr ?? 0) ? y : x)) : null;
    const worst = eligible.length ? eligible.reduce((x, y) => ((y.ctr ?? 1) < (x.ctr ?? 1) ? y : x)) : null;
    out.push({
      id: "reminders", label: "Нажали кнопку в напоминании (CTR)", value: pct(a.ctr, 1), raw: a.ctr, prevLabel: pct(b.ctr, 1), delta, trend, good: trend === "up" ? true : trend === "down" ? false : null,
      n: a.sent, nLabel: `${int(a.sent)} отправок`, spark: rolling(d.series, "remClicked", "remSent", 10),
      insight: small(a.sent) ? `Мало отправок (${int(a.sent)}) для выводов.` : best && worst && best !== worst
        ? `Лучше всего — «${KIND_LABEL[best.kind]}» (${pct(best.ctr)}), хуже — «${KIND_LABEL[worst.kind]}» (${pct(worst.ctr)}).` : `CTR ${pct(a.ctr, 1)} при ${int(a.sent)} отправках.`,
      definition: "Доля отправок старше 24 часов, после которых в первые 24 часа нажали полезную кнопку того же вида («оплатил», «записать», «продолжить» и т. п.; «позже», «реже» и «выключить» не считаются). Клик засчитывается последней отправке этого вида перед ним.",
    });
  }
  return out;
}

export interface Takeaways { funnel: string; ttv: string; retention: string; usage: string; verdicts: string; reminders: string; effect: string; channels: string; activity: string }

export function takeaways(d: Dashboard): Takeaways {
  const { cur } = d;
  const t = {} as Takeaways;
  // Воронка
  const drop = biggestDrop(cur.funnel);
  const unknown = cur.funnel.stages.filter((s) => s.unknownShare != null && s.n >= MIN_SAMPLE).sort((a, b) => (b.unknownShare ?? 0) - (a.unknownShare ?? 0))[0];
  t.funnel = cur.funnel.attempts < MIN_SAMPLE ? `Мало данных: ${int(cur.funnel.attempts)} проходов.`
    : `Доходят до конца ${pct(cur.funnel.completion)}. Больше всего теряем на шаге «${STEP_LABEL[drop!.key]}» (−${pct(drop!.dropRate)})`
      + (unknown && (unknown.unknownShare ?? 0) >= 0.3 ? `; на «${STEP_LABEL[unknown.key]}» ${pct(unknown.unknownShare)} отвечают «не знаю».` : ".");
  // Время до пользы
  const a = cur.activation;
  const fast = a.buckets.slice(0, 3).reduce((s, x) => s + x, 0);
  t.ttv = a.matured < MIN_SAMPLE ? "Мало данных." : `${pct(rate(fast, a.matured))} получают прогноз быстрее 10 минут, ${pct(rate(a.never, a.matured))} не получают его за сутки. Медиана среди получивших — ${mins(a.p50Min)}.`;
  // Удержание
  const d7 = d.cohorts.map((c) => c.cells.find((x) => x.day === 7)?.rate).filter((x): x is number => x != null);
  if (d7.length >= 4) {
    const early = (d7[0] + d7[1]) / 2, late = (d7[d7.length - 1] + d7[d7.length - 2]) / 2;
    const diff = late - early;
    t.retention = Math.abs(diff) < 0.03 ? `D7 стабилен: около ${pct(late)} у последних когорт.` : `D7 у последних когорт ${diff > 0 ? "вырос" : "упал"} до ${pct(late)} (было ${pct(early)}).`;
  } else t.retention = "Пока мало созревших когорт для тренда.";
  // Использование
  const f = cur.asks.freq, act = Math.max(1, cur.active);
  t.usage = cur.active < MIN_SAMPLE ? "Мало данных." : `${pct(f[0] / act)} активных не спрашивали; ${pct((f[2] + f[3] + f[4]) / act)} спросили 2 раза и больше.`;
  // Вердикты
  const vw = d.verdictWeeks.filter((w) => w.total >= MIN_SAMPLE);
  const tot = Object.values(cur.verdicts).reduce((s, x) => s + x, 0);
  if (tot < MIN_SAMPLE) t.verdicts = "Мало вопросов для выводов.";
  else {
    const top = Object.entries(cur.verdicts).sort((x, y) => y[1] - x[1])[0];
    let s = `Чаще всего — «${VERDICT_LABEL[top[0]]}» (${pct(top[1] / tot)}).`;
    if (vw.length >= 2) {
      const x = vw[0], y = vw[vw.length - 1];
      const z = zProp(y.counts.cash_gap, y.total, x.counts.cash_gap, x.total);
      if (z != null && Math.abs(z) >= 1.96) s += ` Доля «${VERDICT_LABEL.cash_gap}» ${z > 0 ? "растёт" : "снижается"}: ${pct(x.counts.cash_gap / x.total)} → ${pct(y.counts.cash_gap / y.total)}.`;
    }
    t.verdicts = s;
  }
  // Напоминания
  const r = cur.reminders;
  const dis = r.kinds.filter((k) => k.recipients >= MIN_SAMPLE && k.disableRate != null).sort((x, y) => (y.disableRate ?? 0) - (x.disableRate ?? 0))[0];
  t.reminders = d.channel && d.channel !== "telegram" ? "Напоминания приходят только в Telegram." : r.sent < MIN_SAMPLE ? "Мало отправок для выводов."
    : `CTR ${pct(r.ctr, 1)}` + (dis && (dis.disableRate ?? 0) > 0 ? `; чаще всего выключают «${KIND_LABEL[dis.kind]}» (${pct(dis.disableRate, 1)} получателей).` : ".");
  const e = r.effect;
  if (!e || e.remindedDays < MIN_SAMPLE || e.otherDays < MIN_SAMPLE) t.effect = "Мало данных для сравнения дней с напоминанием и без.";
  else {
    const z = zProp(e.remindedActive, e.remindedDays, e.otherActive, e.otherDays)!;
    t.effect = Math.abs(z) < 1.96 ? "Разница между днями с напоминанием и без — в пределах шума."
      : `За сутки после напоминания заходят ${pct(e.remindedActive / e.remindedDays)} получателей, в обычные дни — ${pct(e.otherActive / e.otherDays)} (${pp(e.lift!)}). Это наблюдаемая связь, не доказанный эффект.`;
  }
  // Каналы
  const ch = d.channels.filter((c) => c.starters >= MIN_SAMPLE && c.activation != null);
  if (d.channel) t.channels = `Фильтр: только ${CHANNEL_LABEL[d.channel]}.`;
  else if (ch.length < 2) t.channels = "Мало данных для сравнения каналов.";
  else {
    const best = ch.reduce((x, y) => ((y.activation ?? 0) > (x.activation ?? 0) ? y : x)), worst = ch.reduce((x, y) => ((y.activation ?? 1) < (x.activation ?? 1) ? y : x));
    const big = d.channels.reduce((x, y) => (y.active > x.active ? y : x));
    const z = zProp(Math.round((best.activation ?? 0) * best.starters), best.starters, Math.round((worst.activation ?? 0) * worst.starters), worst.starters);
    t.channels = `Больше всего активных — ${CHANNEL_LABEL[big.channel].toLowerCase()} (${pct(big.share)}). ` + (best !== worst && z != null && Math.abs(z) >= 1.96
      ? `Активация выше в канале «${CHANNEL_LABEL[best.channel]}»: ${pct(best.activation)} против ${pct(worst.activation)}.`
      : `Активация по каналам различается в пределах шума (${pct(worst.activation)}–${pct(best.activation)}).`);
  }
  const missing = CHANNELS.filter((c) => (d.channels.find((x) => x.channel === c)?.starters ?? 0) < MIN_SAMPLE && !d.channel);
  if (missing.length && ch.length >= 2) t.channels += ` По ${missing.map((m) => CHANNEL_LABEL[m]).join(", ")} мало данных.`;
  // Активность
  const peak = weekdayPeak(d.series);
  const s = d.series, half = Math.floor(s.length / 2);
  const avg = (xs: DayPoint[]) => xs.reduce((q, p) => q + p.dau, 0) / Math.max(1, xs.length);
  const g = half >= 3 ? (avg(s.slice(half)) - avg(s.slice(0, half))) / Math.max(1, avg(s.slice(0, half))) : 0;
  t.activity = s.length < 7 ? "Короткий период — смотрите 30 или 90 дней." : `DAU ${Math.abs(g) < 0.05 ? "стабилен" : g > 0 ? `растёт (${rel(g)} во второй половине периода)` : `снижается (${rel(g)} во второй половине)`}` + (peak ? `; пик по ${WEEKDAY[peak.peak]}.` : ".");
  return t;
}

export const FUNNEL_KEYS = ["started", "balance", "income", "preview", ...FUNNEL_STEPS.slice(2), "completed"];
