// Внутренний дашборд продуктовой аналитики: вопросы → ответы. Только агрегаты; доступ — подписанная admin-cookie.
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { ADMIN_COOKIE, adminSecret, verifyAdminToken } from "../../../lib/admin";
import { CHANNELS, dashboard, FUNNEL_ORDER, FREQ_BUCKETS, PERIODS, rate, TTV_BUCKETS, type ChannelFilter, type Dashboard } from "../../../lib/analytics-metrics";
import { CHANNEL_LABEL, dec, int, KIND_LABEL, kpis, mins, pct, pp, significantCount, STEP_LABEL, takeaways, VERDICT_LABEL, zProp, type Kpi } from "../../../lib/analytics-insights";
import { BarChart, COLOR, Donut, Funnel, HBars, Heatmap, Histogram, Legend, LineChart, NB, Ring, Sparkline, StackedWeeks } from "./charts";
import { DRILL_KEYS, funnelDrill, type Drill } from "../../../lib/analytics-drill";
import { DrillSheet } from "./drill";
import { LiveChart } from "./live";
import { opsSummary, type OpsSummary } from "../../../lib/service-metrics";
import { referralSummary, type ReferralSummary } from "../../../lib/referrals";
import { llmSummary, rubLabel, type LlmSummary } from "../../../lib/llm-metrics";
import { plusSummary, type PlusSummary } from "../../../lib/plans/metrics";
import { alignPrev, deltaText, prevDayOf } from "./live-format";
import type { FunnelSpec, Ghost, HeatSpec, LineSeries, Sig } from "./live-spec";
import "./analytics.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Аналитика · Можно?", robots: { index: false, follow: false } };

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const RU_MONTH = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const human = (iso: string) => { const d = new Date(iso); return `${d.getUTCDate()}${NB}${RU_MONTH[d.getUTCMonth()]}`; };
const lastDay = (iso: string) => human(new Date(new Date(iso).getTime() - 86_400_000).toISOString());

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<SP> }) {
  if (!adminSecret()) notFound();
  const sp = await searchParams;
  if (!verifyAdminToken((await cookies()).get(ADMIN_COOKIE)?.value)) return <Login error={one(sp.e) ?? null} />;
  const days = (PERIODS as readonly number[]).includes(Number(one(sp.d))) ? Number(one(sp.d)) : 30;
  const ch = (CHANNELS as readonly string[]).includes(one(sp.ch) ?? "") ? (one(sp.ch) as ChannelFilter) : null;
  const cmp = one(sp.cmp) !== "0";
  const step = (DRILL_KEYS as readonly string[]).includes(one(sp.step) ?? "") ? one(sp.step)! : null;
  const inc = one(sp.int) === "1"; // команда и тесты: по умолчанию исключены
  const now = new Date();
  const [d, drill] = await Promise.all([dashboard(now, days, ch, undefined, { includeInternal: inc }), step ? funnelDrill(now, days, ch, step, undefined, { includeInternal: inc }) : Promise.resolve(null)]);
  const ops = await opsSummary(new Date(d.cur.from), new Date(d.cur.to), ch, undefined, { includeInternal: inc }).catch(() => null);
  const refs = await referralSummary(new Date(d.cur.from), new Date(d.cur.to), { includeInternal: inc, minCohort: d.minCohort }).catch(() => null);
  const llm = await llmSummary(new Date(d.cur.from), new Date(d.cur.to), now, ch, undefined, { includeInternal: inc }).catch(() => null);
  const plus = await plusSummary(new Date(d.cur.from), new Date(d.cur.to), ch, undefined, { includeInternal: inc, minCohort: d.minCohort }).catch(() => null);
  return <View d={d} cmp={cmp} drill={drill} ops={ops} refs={refs} llm={llm} plus={plus} />;
}

const SECTIONS = ["Первый прогноз", "Аудитория", "Возвраты", "«Можно?»", "Напоминания", "Каналы", "Сервис и привлечение", "Модели и расходы", "Плюс и AI-ответы"];

function href(d: Dashboard, cmp: boolean, patch: Partial<{ d: number; ch: string | null; cmp: boolean; step: string; int: boolean }>) {
  const p = { d: d.days, ch: d.channel as string | null, cmp, int: d.includeInternal, ...patch };
  const q = new URLSearchParams();
  if (p.d !== 30) q.set("d", String(p.d));
  if (p.ch) q.set("ch", p.ch);
  if (!p.cmp) q.set("cmp", "0");
  if (p.int) q.set("int", "1");
  if (p.step) q.set("step", p.step);
  const s = q.toString();
  return s ? `?${s}` : "?";
}

/** «Что считается»: доступно с клавиатуры (focus) и наведением. */
function Def({ children }: { children: React.ReactNode }) {
  return <span className="ia-def" tabIndex={0} role="note" aria-label="Что считается"><span aria-hidden="true">?</span><span className="pop">{children}</span></span>;
}
function N({ n, min, label = "n" }: { n: number; min: number; label?: string }) {
  return <span className={"ia-n" + (n < min ? " low" : "")} data-tip={n < min ? `Меньше ${min} — выводы ненадёжны` : undefined}>{label}{NB}={NB}{int(n)}{n < min ? " · мало данных" : ""}</span>;
}
function Card({ title, take, def, n, span = "ia-s6", children, min = 30 }: { title: string; take?: string; def: React.ReactNode; n?: number; span?: string; children: React.ReactNode; min?: number }) {
  return (
    <div className={`ia-card ${span}`}>
      <div className="ia-ch"><h3>{title}</h3><span className="ia-meta">{n != null && <N n={n} min={min} />}<Def>{def}</Def></span></div>
      {take && <p className="ia-take">{take}</p>}
      {children}
    </div>
  );
}

function KpiCard({ k, cmp }: { k: Kpi; cmp: boolean }) {
  const tone = k.trend === "noise" ? "noise" : k.good == null ? "neutral" : k.good ? "good" : "bad";
  return (
    <article className={`ia-card ia-kpi2 t-${tone}`}>
      <div className="ia-ch"><h3>{k.label}</h3><Def>{k.definition}</Def></div>
      <div className="ia-kv">
        <span className="v">{k.value}</span>
        {cmp && k.delta && <Delta k={k} />}
      </div>
      <Sparkline values={k.spark} label={k.id} color={tone === "bad" ? COLOR.amber : tone === "good" ? COLOR.mint : COLOR.aqua} />
      <div className="ia-kmeta">
        <span>{cmp ? <>было {k.prevLabel}</> : null}</span><span className={k.n < 30 ? "warn" : undefined}>{k.nLabel}</span>
      </div>
      <p className="ia-insight">{k.insight}</p>
    </article>
  );
}

function View({ d, cmp, drill, ops, refs, llm, plus }: { d: Dashboard; cmp: boolean; drill: Drill | null; ops: OpsSummary | null; refs?: ReferralSummary | null; llm?: LlmSummary | null; plus?: PlusSummary | null }) {
  const ks = kpis(d), t = takeaways(d);
  const c = d.cur, p = d.prev;
  const labels = d.series.map((x) => x.day);
  // Выравнивание по ожидаемой дате (день − длина периода), а не по индексу: пропуск в данных не сдвинет остальные точки.
  const prevByDay = new Map(d.prevSeries.map((x) => [x.day, x]));
  const prevDay = (iso: string) => prevDayOf(iso, d.days);
  const prevAligned = <K extends keyof Dashboard["series"][number]>(key: K) => alignPrev(d.series, d.prevSeries, d.days, (x) => Number(x[key]));
  const tg = d.channel === null || d.channel === "telegram";
  const ttvTotal = c.activation.matured;
  const e = c.reminders.effect;
  const hero = ks.find((k) => k.id === "activation")!;
  const rest = ks.filter((k) => k.id !== "activation");
  const last = d.series.at(-1);
  const leader = d.channels.length ? d.channels.reduce((x, y) => (y.active > x.active ? y : x)) : null;
  const verdictTotal = Object.values(c.verdicts).reduce((s, x) => s + x, 0);
  const topVerdict = Object.entries(c.verdicts).sort((x, y) => y[1] - x[1])[0];
  // Прошлый период «призраком»: тот же номер дня от начала периода. Шум — правило Пуассона для дневных счётчиков;
  // для WAU не оцениваем (скользящие 7-дневные окна перекрываются, соседние дни зависимы).
  type CountKey = "dau" | "wau" | "asks" | "web" | "telegram" | "miniapp";
  const ghost = (key: CountKey, noise = true): Ghost | undefined => {
    if (!cmp) return undefined;
    const values = prevAligned(key);
    const sig = (a: number, b: number): Sig => (a + b < d.minSample ? "few" : significantCount(a, b));
    return { values, sig: noise ? d.series.map((x, i) => (values[i] == null ? null : sig(x[key], values[i]!))) : undefined };
  };
  const prevLabels = cmp ? d.series.map((x) => prevDay(x.day)) : undefined;
  /** Серверный SVG-фолбэк рисует те же призраки пунктиром (позади текущих линий). */
  // Пунктир поверх заливок (контраст ≥ 3:1), как и в ECharts-слое.
  const withGhosts = (ls: LineSeries[]) => [...ls, ...ls.flatMap((l) => (l.prev ? [{ name: `${l.name} прошл.`, color: ghostColor(l.color), values: l.prev.values, dashed: true }] : []))];
  const dauLines: LineSeries[] = [
    { name: "WAU", color: COLOR.sky, values: d.series.map((x) => x.wau), area: true, prev: ghost("wau", false) },
    { name: "DAU", color: COLOR.mint, values: d.series.map((x) => x.dau), area: true, prev: ghost("dau") },
  ];
  const chLines: LineSeries[] = CHANNELS.filter((x) => !d.channel || d.channel === x).map((x) => ({ name: CHANNEL_LABEL[x], color: COLOR[x], values: d.series.map((s) => s[x]), prev: ghost(x) }));
  const asksGhost = ghost("asks", false);
  const prevAt = (key: CountKey) => (cmp && last ? prevByDay.get(prevDay(last.day))?.[key] : undefined);
  const cmpLegend = cmp ? <CmpLegend range={`${human(p.from)} – ${lastDay(p.to)}`} /> : null;
  const retLines = [
    { name: "D7", color: COLOR.aqua, values: d.cohorts.map((r) => r.cells[1].rate), area: true },
    { name: "D1", color: COLOR.mint, values: d.cohorts.map((r) => r.cells[0].rate) },
  ];
  const worstStage = c.funnel.stages.filter((s) => s.dropRate != null && s.drop > 0).reduce<(typeof c.funnel.stages)[number] | null>((a, b) => (!a || (b.dropRate ?? 0) > (a.dropRate ?? 0) ? b : a), null);
  const funnelSpec: FunnelSpec = { kind: "funnel", label: "Как проходят знакомство", stages: c.funnel.stages.map((s) => {
    const ps = cmp ? p.funnel.stages.find((x) => x.key === s.key) : undefined;
    const z = ps ? zProp(s.n, c.funnel.attempts, ps.n, p.funnel.attempts) : null;
    return { name: STEP_LABEL[s.key], href: s.key === "started" ? undefined : href(d, cmp, { step: s.key }), n: s.n, ofStart: s.ofStart, drop: s.drop, dropRate: s.dropRate, worst: s === worstStage, unknown: s.unknownShare != null && s.unknownShare >= 0.2 ? s.unknownShare : null,
      prev: ps ? { ofStart: ps.ofStart, n: ps.n, sig: z == null ? "few" : Math.abs(z) >= 1.96 } : undefined };
  }) };
  const heatSpec: HeatSpec = { kind: "heat", label: "Удержание по недельным когортам", weeks: d.cohorts.map((r) => r.week), sizes: d.cohorts.map((r) => r.size), cols: ["D1", "D7", "D14", "D30"], cells: d.cohorts.map((r) => r.cells.map((x) => ({ rate: x.rate, matured: x.matured }))), minCohort: d.minCohort };
  const kinds = c.reminders.kinds.filter((k) => k.sent > 0).sort((a, b) => (b.ctr ?? 0) - (a.ctr ?? 0));
  return (
    <>
    <main className="ia ia2 ia3">
      <header className="ia-head">
        <div>
          <span className="ia-eyebrow">Продуктовая аналитика{d.demo && <b className="ia-demo-tag">ДЕМО</b>}</span>
          <h1>Как дела у <span className="grad">«Можно?»</span></h1>
          <p className="ia-sub">{human(c.from)} – {lastDay(c.to)} · полные дни UTC{cmp && <><br className="m-only" /><span className="d-only"> · </span>сравнение с {human(p.from)} – {lastDay(p.to)}</>}</p>
        </div>
        <form method="post" action="/internal/analytics/logout" className="ia-out"><button className="ia-btn ghost" type="submit">Выйти</button></form>
      </header>
      {d.demo && <p className="ia-demo" role="note"><b>ДЕМО</b> Синтетические данные из локальной временной БД — не реальные пользователи.</p>}

      <div className="ia-bar" role="group" aria-label="Фильтры">
        <div className="row">
          <nav className="ia-seg per" aria-label="Период">{PERIODS.map((x) => <a key={x} href={href(d, cmp, { d: x })} aria-current={x === d.days ? "page" : undefined}>{x}{NB}дн.</a>)}</nav>
          <a className={"ia-cmp" + (cmp ? " on" : "")} href={href(d, cmp, { cmp: !cmp })} aria-pressed={cmp} aria-label={cmp ? "Сравнение с прошлым периодом включено" : "Сравнение с прошлым периодом выключено"}><span className="sw" aria-hidden="true" />Сравнение</a>
        </div>
        <nav className="ia-seg ch" aria-label="Канал">
          <a href={href(d, cmp, { ch: null })} aria-current={!d.channel ? "page" : undefined}>Все</a>
          {CHANNELS.map((x) => <a key={x} href={href(d, cmp, { ch: x })} aria-current={d.channel === x ? "page" : undefined}><i className="dot" style={{ background: COLOR[x], color: COLOR[x] }} />{CHANNEL_LABEL[x]}</a>)}
        </nav>
      </div>

      <section className="ia-hero" aria-label="Главное">
        <div className="ring">
          <Ring value={hero.raw} prev={cmp ? p.activation.rate : null} label={hero.label} />
          <div className="num"><b>{hero.raw == null ? "—" : Math.round(hero.raw * 100)}<small>%</small></b><span>за первые 24 ч</span></div>
        </div>
        <div className="txt">
          <span className="kicker">Главное за {d.days}{NB}дн.</span>
          <h2>{hero.raw == null ? "Мало данных о новых" : <>{pct(hero.raw)} новых увидели прогноз или ответ за первые 24 ч</>}</h2>
          <p className="meta">{cmp && hero.delta && <Delta k={hero} />}<span>{hero.nLabel}{cmp && <> · было {hero.prevLabel}</>}</span><Def>{hero.definition}</Def></p>
          <ul className="ia-facts">
            <li className="warn">{hero.insight}</li>
            <li className="good">{t.retention}</li>
            <li className="info">{t.activity}</li>
          </ul>
        </div>
      </section>

      <div className="ia-kpi-head m-only"><span>Ещё показатели</span><span className="hint">листайте →</span></div>
      <section className="ia-kpis" aria-label="Главные показатели">{rest.map((k) => <KpiCard key={k.id} k={k} cmp={cmp} />)}</section>

      <nav className="ia-toc" aria-label="Разделы">{SECTIONS.map((q, i) => <a key={q} href={`#q${i + 1}`}><b>{String(i + 1).padStart(2, "0")}</b>{q}</a>)}</nav>

      <Section n={1} q="Видят ли новые первый прогноз?" lead={t.funnel} answer={{ v: pct(c.activation.rate), s: "за первые 24 ч" }}>
        <Card span="ia-s7" title="Как проходят знакомство" n={c.funnel.attempts} take="Ширина — сколько дошло до шага; янтарным — главная потеря. Нажмите на шаг — откроется разбор, почему там уходят."
          def={<>Первичные проходы знакомства, начатые в периоде. Шаг засчитан, если этот же проход прошёл все предыдущие и на шаг дан ответ, «не знаю» или пропуск — пропуск тоже засчитывается. «Показан прогноз» — показана карточка первого прогноза. «Завершили» — пользователь закончил знакомство.</>}>
          <LiveChart spec={funnelSpec}><Funnel stages={c.funnel.stages} hrefs={Object.fromEntries(c.funnel.stages.filter((s) => s.key !== "started").map((s) => [s.key, `${href(d, cmp, { step: s.key })}#drill`]))} cmp={cmp ? funnelSpec.stages.map((s) => (s.prev ? deltaText(s.ofStart, s.prev.ofStart, "pct", s.prev.sig).text : null)) : undefined} prev={cmp ? funnelSpec.stages.map((s) => s.prev?.ofStart ?? null) : undefined} /></LiveChart>
        </Card>
        <Card span="ia-s5" title="Как быстро получают первый прогноз" n={ttvTotal} take={t.ttv}
          def={<>От первого начала знакомства до первого прогноза или ответа «Можно?». Только начавшие больше суток назад, поэтому доли складываются в 100 %. «Не за сутки» — за 24 часа пользы не было (в том числе получившие её позже). Медиана — среди всех получивших.</>}>
          <Histogram labels={[...TTV_BUCKETS.slice(0, 5), "не за сутки"]} values={[...c.activation.buckets.slice(0, 5), c.activation.never]} highlight={5} warnLabel="без пользы за 24 ч" />
          <div className="ia-stats ia-stats-after">
            <div className="ia-stat"><span>Медиана среди получивших</span><b>{mins(c.activation.p50Min)}</b><small>{cmp ? <>было {mins(p.activation.p50Min)}</> : NB}</small></div>
            <div className="ia-stat"><span>Без пользы за сутки</span><b className={(rate(c.activation.never, c.activation.matured) ?? 0) >= 0.2 ? "warn" : undefined}>{pct(rate(c.activation.never, c.activation.matured))}</b><small>{int(c.activation.never)} из {int(c.activation.matured)}</small></div>
          </div>
        </Card>
      </Section>

      <Section n={2} q="Растёт ли аудитория?" lead={t.activity} answer={{ v: int(c.wauEnd), s: "активны за 7 дней", d: cmp ? ks.find((k) => k.id === "wau")?.delta ?? undefined : undefined }}>
        <Card span="ia-s8" title="Сколько людей заходит каждый день" n={c.active} take={cmp ? "Пунктир — прошлый период того же размера, день к дню. Нажмите на день: сейчас, было и разница." : "Нажмите на день, чтобы увидеть значения."}
          def={<>DAU — уникальные пользователи с любым действием за UTC-день. WAU — за 7 дней, заканчивающихся этим днём. Сегодняшний неполный день не показан.</>}>
          {last && <Readout items={[{ label: "DAU вчера", value: int(last.dau), color: COLOR.mint, was: prevAt("dau") }, { label: "WAU", value: int(last.wau), color: COLOR.sky, was: prevAt("wau") }]} />}
          {cmpLegend}
          <LiveChart spec={{ kind: "line", label: "DAU и WAU по дням", labels, prevLabels, fmt: "int", series: dauLines }}><Duo m={<LineChart label="DAU и WAU" W={360} h={230} labels={labels} lines={withGhosts(dauLines)} />} d={<LineChart label="DAU и WAU" h={250} labels={labels} lines={withGhosts(dauLines)} />} /></LiveChart>
          <Legend items={[{ color: COLOR.mint, label: "DAU — за день", line: true }, { color: COLOR.sky, label: "WAU — за 7 дней", line: true }]} />
        </Card>
        <Card span="ia-s4" title="Сколько спрашивают «Можно?» в день" n={c.asks.total} take={`Всего ${int(c.asks.total)} вопросов${cmp ? `, было ${int(p.asks.total)}` : ""}. Выходные бледнее, линия — среднее за 7 дней.`}
          def={<>Каждый вопрос о покупке, получивший расчёт (чат, бот, API). Черта — тот же день прошлого периода. Вопросы из Mini App пока считаются как веб.</>}>
          {last && <Readout items={[{ label: "вчера", value: int(last.asks), color: COLOR.mint, was: prevAt("asks") }, { label: "в среднем", value: int(d.series.slice(-7).reduce((s, x) => s + x.asks, 0) / 7), color: "#d9fff4" }]} />}
          {cmpLegend}
          <LiveChart spec={{ kind: "bar", label: "Вопросы «Можно?» в день", labels, prevLabels, values: d.series.map((x) => x.asks), prev: asksGhost, color: COLOR.mint }}><BarChart label="Вопросы в день" labels={labels} values={d.series.map((x) => x.asks)} prev={asksGhost?.values} W={360} h={230} /></LiveChart>
          <Legend items={[{ color: COLOR.mint, label: "за день" }, { color: "#d9fff4", label: "среднее за 7 дней", line: true }]} />
        </Card>
      </Section>

      <Section n={3} q="Возвращаются ли?" lead={t.retention} answer={{ v: pct(c.retention.d7.rate), s: "возвращаются на 2-й неделе" }}>
        <Card span="ia-s8" title="Сколько новых возвращается через день, неделю, месяц" n={d.cohorts.reduce((s, r) => s + (r.size ?? 0), 0)} take="Чем светлее ячейка, тем больше вернулось. Точка — окно ещё не закончилось."
          def={<>Когорта — неделя первого визита. D1 — активен на следующий день. D7, D14, D30 — активен хотя бы в один из дней N…N+6 (в любом канале). Группы меньше {d.minCohort} скрыты.</>}>
          <LiveChart spec={heatSpec}><Heatmap rows={d.cohorts} minCohort={d.minCohort} /></LiveChart>
        </Card>
        <Card span="ia-s4" title="Удержание за период" n={c.retention.d7.n} take={cmp ? (["d1", "d7"] as const).map((k) => `${k.toUpperCase()} ${c.retention[k].rate != null && p.retention[k].rate != null ? pp(c.retention[k].rate! - p.retention[k].rate!) : "— нет сравнения"}`).join(", ") + " к прошлому периоду." : undefined}
          def={<>Пользователи, у которых окно D1 (день 1) или D7 (дни 7–13) закончилось внутри периода.</>}>
          <div className="ia-stats">
            {(["d1", "d7"] as const).map((k) => (
              <div key={k} className="ia-stat"><span>{k === "d1" ? "D1 · на следующий день" : "D7 · на второй неделе"}</span>
                <b>{pct(c.retention[k].rate)}</b>
                <small>{cmp ? <>было {pct(p.retention[k].rate)} · </> : null}n{NB}={NB}{int(c.retention[k].n)}</small></div>
            ))}
          </div>
          <h4 className="ia-h4">D1 и D7 по неделям прихода</h4>
          <LiveChart spec={{ kind: "line", label: "D1 и D7 по неделям прихода", labels: d.cohorts.map((r) => r.week), fmt: "pct", series: retLines }}>
          <LineChart label="D1 и D7 по когортам" W={360} h={200} fmt={(v) => pct(v)} labels={d.cohorts.map((r) => r.week)} lines={retLines} />
          </LiveChart>
          <Legend items={[{ color: COLOR.mint, label: "D1", line: true }, { color: COLOR.aqua, label: "D7", line: true }]} />
        </Card>
      </Section>

      <Section n={4} q="Пользуются ли «Можно?»?" lead={t.usage} answer={{ v: dec(c.asks.perActiveWeek), s: "вопроса на активного в неделю" }}>
        <Card span="ia-s5" title="Сколько раз спрашивает активный пользователь" n={c.active} take={`Повторно спрашивают ${pct(c.asks.repeatShare)} из спросивших.`}
          def={<>Все активные за период пользователи, распределённые по числу вопросов «Можно?» за период.</>}>
          <Histogram labels={FREQ_BUCKETS.map((b) => `${b}`)} values={c.asks.freq} highlight={0} color={COLOR.aqua} warnLabel="не спросили ни разу" />
          <p className="ia-foot2">вопросов за {d.days}{NB}дн. · янтарным — не спросили ни разу</p>
        </Card>
        <Card span="ia-s7" title="Что отвечает «Можно?»" n={verdictTotal} take={t.verdicts}
          def={<>Вердикт детерминированного расчёта на каждый вопрос. Недели — ISO, с понедельника; первая и последняя могут быть неполными (видно по n).</>}>
          <div className="ia-verdict">
            <Donut size={156} center={topVerdict && verdictTotal ? pct(topVerdict[1] / verdictTotal) : "—"} sub={topVerdict ? VERDICT_LABEL[topVerdict[0]].toLowerCase() : ""}
              parts={Object.entries(VERDICT_LABEL).map(([k, v]) => ({ key: k, label: v, value: c.verdicts[k] ?? 0, color: COLOR[k as keyof typeof COLOR] }))} />
            <ul className="ia-vlist">{Object.entries(VERDICT_LABEL).map(([k, v]) => (
              <li key={k}><i style={{ background: COLOR[k as keyof typeof COLOR], color: COLOR[k as keyof typeof COLOR] }} />{v}<b>{pct(rate(c.verdicts[k] ?? 0, verdictTotal))}</b></li>
            ))}</ul>
          </div>
          <h4 className="ia-h4">По неделям</h4>
          <StackedWeeks weeks={d.verdictWeeks} />
        </Card>
      </Section>

      <Section n={5} q="Работают ли напоминания?" lead={`${t.reminders} ${t.effect}`} answer={tg && e?.lift != null ? { v: pp(e.lift), s: "к визитам за сутки после" } : undefined}>
        {tg ? <>
          <Card span="ia-s7" title="На какие напоминания нажимают и какие выключают" n={c.reminders.sent} take="CTR — только полезные кнопки. Янтарным — виды, которые выключают чаще 5 % получателей."
            def={<>CTR — отправки, по которым в течение 24 ч нажали полезную кнопку того же вида («позже», «реже», «выключить» не считаются), к отправкам старше суток; клик засчитывается последней отправке. Выключили — уникальные получатели вида, отключившие его в периоде.</>}>
            <ul className="ia-kinds">{kinds.map((k) => (
              <li key={k.kind} className={(k.disableRate ?? 0) >= 0.05 ? "warn" : undefined}>
                <span className="nm">{KIND_LABEL[k.kind]}<small>{int(k.sent)} отправок{k.sent < 30 ? " · мало" : ""}</small></span>
                <b className="ctr">{pct(k.ctr)}</b>
                <span className="bar"><i style={{ width: `${Math.min(1, (k.ctr ?? 0) / 0.6) * 100}%` }} /></span>
                <span className="off">выключили {pct(k.disableRate, 1)}</span>
              </li>
            ))}</ul>
            <p className="ia-foot2">Выключили все напоминания: {int(c.reminders.disabledAll)} · заблокировали бота: {int(c.reminders.blocked)}</p>
          </Card>
          <Card span="ia-s5" title="Заходят ли в течение суток после напоминания" n={e?.remindedDays ?? 0} take={t.effect}
            def={<>Только получатели напоминаний, дни после их первого визита. День с напоминанием засчитан, если в течение 24 ч после отправки была новая сессия (визит до отправки не считается); остальные дни — любая активность. Напоминания приходят в «особые» дни (платёж, доход), поэтому это связь, а не доказанный эффект; честная проверка — holdout-группа.</>}>
            {e && <div className="ia-vs">
              <div className="col hi"><b>{pct(rate(e.remindedActive, e.remindedDays))}</b><span>после напоминания</span><i style={{ height: `${(rate(e.remindedActive, e.remindedDays) ?? 0) * 100}%` }} /></div>
              <div className="col"><b>{pct(rate(e.otherActive, e.otherDays))}</b><span>в обычный день</span><i style={{ height: `${(rate(e.otherActive, e.otherDays) ?? 0) * 100}%` }} /></div>
            </div>}
            {e?.lift != null && <p className="ia-big">{pp(e.lift)}<small>разница в доле дней с визитом · {int(e.remindedDays)} и {int(e.otherDays)} дн.</small></p>}
          </Card>
        </> : <p className="ia-empty">Напоминания приходят только в Telegram — переключите фильтр канала на «Все» или «Бот».</p>}
      </Section>

      <Section n={6} q="Какой канал работает лучше?" lead={t.channels} answer={leader ? { v: CHANNEL_LABEL[leader.channel], s: `${pct(leader.share)} активных` } : undefined}>
        <Card span="ia-s5" title="DAU по каналам" n={c.active} take="Нажмите на день, чтобы увидеть значения."
          def={<>Уникальные пользователи за день в каждом канале. Сумма по каналам может быть больше общего DAU.</>}>
          {last && <Readout items={CHANNELS.filter((x) => !d.channel || d.channel === x).map((x) => ({ label: CHANNEL_LABEL[x], value: int(last[x]), color: COLOR[x], was: prevAt(x) }))} />}
          {cmpLegend}
          <LiveChart spec={{ kind: "line", label: "DAU по каналам", labels, prevLabels, fmt: "int", series: chLines }}><LineChart label="DAU по каналам" W={360} h={220} labels={labels} lines={withGhosts(chLines)} /></LiveChart>
          <Legend items={chLines.map((l) => ({ color: l.color, label: l.name, line: true }))} />
        </Card>
        <Card span="ia-s7" title="Веб, бот и Mini App по главным метрикам" n={c.active} take="Цвет канала одинаков на всех графиках. Бледные строки — меньше 30 человек."
          def={<>Активные — с действием в канале (человек в двух каналах есть в обоих). Активация — по каналу начала знакомства. D7 — по каналу первого визита, возврат в любом канале.</>}>
          <div className="ia-mult">
            {([
              ["Активных", (r: Dashboard["channels"][number]) => r.active, (v: number) => int(v)],
              ["Активация за сутки", (r: Dashboard["channels"][number]) => r.activation, (v: number) => pct(v)],
              ["D7", (r: Dashboard["channels"][number]) => r.d7, (v: number) => pct(v)],
              ["Вопросов на активного/нед.", (r: Dashboard["channels"][number]) => r.asksPerActiveWeek, (v: number) => dec(v)],
            ] as const).map(([title, get, fmt]) => (
              <div key={title}><h4>{title}</h4>
                <HBars fmt={fmt} max={title === "Активация за сутки" || title === "D7" ? 1 : undefined} rows={d.channels.map((r) => ({ label: CHANNEL_LABEL[r.channel], value: title.startsWith("Вопросов") && r.channel === "miniapp" ? null : get(r), color: COLOR[r.channel as "web"], muted: r.starters < 30 && title !== "Активных", note: title === "D7" ? `n${NB}=${NB}${int(r.d7n)}` : title === "Активация за сутки" ? `n${NB}=${NB}${int(r.starters)}` : title.startsWith("Вопросов") && r.channel === "miniapp" ? "считаются как веб" : undefined }))} />
              </div>
            ))}
          </div>
        </Card>
      </Section>

      <Section n={7} q="Сервис работает без сбоев и откуда приходят?" lead={opsLead(ops)} answer={ops ? { v: pct(ops.calls.errorRate, 1), s: "вызовов с ошибкой" } : undefined}>
        {ops ? <>
          <ErrorsCard o={ops} channel={d.channel} />
          <SourcesCard o={ops} d={d} cmp={cmp} />
        </> : <p className="ia-empty">Журналы вызовов ещё не подключены: примените миграцию 007.</p>}
        {refs ? <ReferralsCard r={refs} /> : null}
      </Section>

      <Section n={8} q="Укладываемся ли в бюджет на модели?" lead={llmLead(llm ?? null)} answer={llm && llm.period.costPerDauMicro != null ? { v: rubLabel(llm.period.costPerDauMicro), s: "на активного/день" } : undefined}>
        {llm ? <LlmCard l={llm} /> : <p className="ia-empty">Журнал стоимости LLM ещё не подключён: примените миграцию 009.</p>}
      </Section>

      <Section n={9} q="Нужен ли людям Плюс и хватает ли AI-ответов?" lead={plusLead(plus ?? null)} answer={plus && plus.conversion != null ? { v: pct(plus.conversion), s: "открывших «Плюс» оставили заявку" } : undefined}>
        {plus ? <PlusCard p={plus} /> : <p className="ia-empty">Тарифы ещё не подключены: примените миграцию 010.</p>}
      </Section>

      <details className="ia-foot">
        <summary>Как читать и что с приватностью</summary>
        <p><b>Как читать.</b> ▲/▼ — значимое изменение к прошлому периоду (z-тест, 95%); «≈ шум» — разница в пределах случайности; «мало данных» — меньше {d.minSample} наблюдений.
        Ценность MVP: подтверждено записей из разговора {pct(c.value.completion)} ({int(c.value.proposalsConfirmed)} из {int(c.value.proposalsCreated)}), исправлений в знакомстве {int(c.value.corrections)}, «не понял» {int(c.value.notUnderstood)}. Стоимость LLM — из журнала ai_usage (раздел 8).</p>
        <p><b>Приватность.</b> Только события из закрытого списка и перечисления, без текстов, сумм и имён; псевдонимы HMAC; хранение 180{NB}дней; группы меньше {d.minCohort} скрыты.</p>
      </details>
    </main>
    {drill && <DrillSheet d={drill} cmp={cmp} idx={FUNNEL_ORDER.indexOf(drill.key as (typeof FUNNEL_ORDER)[number])} closeHref={`${href(d, cmp, {})}#q1`} range={`${human(p.from)} – ${lastDay(p.to)}`} />}
    </>
  );
}

/** Мобильный и десктопный варианты одного графика (своя геометрия, чтобы подписи были читаемы). */
function Duo({ m, d }: { m: React.ReactNode; d: React.ReactNode }) {
  return <><div className="m-only">{m}</div><div className="d-only">{d}</div></>;
}
/** Крупные текущие значения над графиком — видны без касания. */
function Readout({ items }: { items: { label: string; value: string; color: string; was?: number }[] }) {
  return <div className="ia-read">{items.map((x) => <span key={x.label}><i style={{ background: x.color, color: x.color }} /><em>{x.label}</em><b>{x.value}</b>{x.was != null && <small className="was">было {int(x.was)}</small>}</span>)}</div>;
}
/** Тонкая легенда сравнения над графиком: сплошная — сейчас, пунктир — прошлый период того же размера. */
function CmpLegend({ range }: { range: string }) {
  return <p className="ia-cmpleg"><span><i className="now" aria-hidden="true" />сейчас</span><span><i className="was" aria-hidden="true" />прошлый период<small>{range}</small></span></p>;
}
/** Призрак — тот же цвет серии, но приглушённый. */
function ghostColor(c: string) {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) return c;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},0.72)`;
}
function Delta({ k }: { k: Kpi }) {
  const tone = k.trend === "noise" ? "noise" : k.good == null ? "neutral" : k.good ? "good" : "bad";
  const arrow = k.trend === "up" ? "▲" : k.trend === "down" ? "▼" : "≈";
  return <span className={`ia-delta ${tone}`} tabIndex={0} data-tip={k.trend === "noise" ? "Разница статистически не значима" : k.trend === "na" ? "Мало данных для сравнения" : "Значимое изменение к прошлому периоду"}>{arrow} {k.delta}{k.trend === "noise" ? " · шум" : ""}</span>;
}

function Section({ q, lead, n, answer, children }: { q: string; lead: string; n: number; answer?: { v: string; s: string; d?: string }; children: React.ReactNode }) {
  return (
    <section className="ia-sec" aria-label={q} id={`q${n}`}>
      <header>
        <span className="num">{String(n).padStart(2, "0")}</span>
        <h2>{q}</h2>
        {answer && <p className="ans"><b>{answer.v}</b><span>{answer.s}{answer.d && <em> · {answer.d}</em>}</span></p>}
        <p className="lead">{lead}</p>
      </header>
      <div className="ia-grid">{children}</div>
    </section>
  );
}
function Login({ error }: { error: string | null }) {
  return (
    <main className="ia">
      <form className="ia-card ia-login" method="post" action="/internal/analytics/login">
        <h1>Аналитика</h1>
        <p className="ia-sub">Внутренний раздел. Введите ключ администратора.</p>
        <input type="password" name="secret" autoComplete="current-password" aria-label="Ключ администратора" required />
        {error && <p className="ia-err" role="alert">{error === "limit" ? "Слишком много попыток. Подождите 15 минут." : "Ключ не подошёл."}</p>}
        <button className="ia-btn" type="submit">Войти</button>
      </form>
    </main>
  );
}

const LOG_CH_LABEL: Record<string, string> = { ...CHANNEL_LABEL, cron: "Cron", system: "Система" };
const SOURCE_LABEL: Record<string, string> = { direct: "Прямой заход", referral: "Другие сайты", telegram: "Telegram", google: "Google", yandex: "Яндекс", vk: "VK", sber: "Сбер", other: "Другое" };
// source=referral объединяет два случая (lib/traffic-source.ts): medium=invite — приглашение друга, medium=referral — переход с другого сайта.
const srcLabel = (s: string, m: string | null) => (s === "referral" && m === "invite" ? "Приглашения друзей" : s === "referral" && (m === "referral" || !m) ? SOURCE_LABEL.referral : `${SOURCE_LABEL[s] ?? s}${m ? ` · ${m}` : ""}`);

function opsLead(o: OpsSummary | null): string {
  if (!o) return "Нет данных журналов.";
  if (!o.calls.total) return "За период нет вызовов в журнале.";
  const top = o.errors.codes[0];
  return `${int(o.calls.total)} вызовов, с ошибкой ${pct(o.calls.errorRate, 1)}${top ? `, чаще всего ${top.code}` : ""}. Активных без команды ${int(o.users.real)}: команда и тесты не считаются.`;
}

/** Ошибки сервиса: доля, частые коды, по дням. Компактно для 390 px. */
function ErrorsCard({ o, channel }: { o: OpsSummary; channel: string | null }) {
  const maxN = Math.max(1, ...o.errors.codes.map((c) => c.n));
  const hot = (o.calls.errorRate ?? 0) >= 0.02;
  return (
    <Card span="ia-s6" title="Ошибки и вызовы" n={o.calls.total} take={o.errors.total ? `5xx: ${int(o.errors.s5xx)} · 4xx: ${int(o.errors.s4xx)}${o.errors.other ? ` · бот и фоновые: ${int(o.errors.other)}` : ""}.` : "Ошибок за период нет."}
      def={<>Вызов — один вызов ключевого компонента (вопрос «Можно?», ход знакомства, расчёт, запись, голос, напоминание и служебные вызовы API). Ошибка — ответ 4xx/5xx, исключение бота или cron, сбой отправки. Ожидаемые 401 считаются в доле ошибок, но не в журнале. «Вызовов на активного/день» — только вызовы ядра продукта (вопрос, знакомство, расчёт, запись, голос) / сумма DAU по дням; cron и фоновые не входят. p95 — 95 % вызовов быстрее этого времени. {channel ? "Фильтр канала скрывает cron." : ""}</>}>
      <div className="ia-stats">
        <div className="ia-stat"><span>Вызовы с ошибкой</span><b className={hot ? "warn" : undefined}>{pct(o.calls.errorRate, 1)}</b><small>{int(o.calls.errors)} из {int(o.calls.total)}</small></div>
        <div className="ia-stat"><span>Вызовов на активного/день</span><b>{dec(o.calls.corePerDau)}</b><small>p50 {o.calls.p50 == null ? "—" : `${int(o.calls.p50)}${NB}мс`} · p95 {o.calls.p95 == null ? "—" : `${int(o.calls.p95)}${NB}мс`}</small></div>
      </div>
      <h4 className="ia-h4">Ошибки по дням</h4>
      <Sparkline values={o.errors.daily.map((x) => x.errors)} label="errors" color={hot ? COLOR.amber : COLOR.aqua} />
      {o.errors.codes.length > 0 && <ul className="ia-kinds ia-codes">{o.errors.codes.map((c) => (
        <li key={c.code} className={c.status != null && c.status >= 500 ? "warn" : undefined}>
          <span className="nm"><code>{c.code}</code><small>{c.route}{c.status ? ` · ${c.status}` : ""}</small></span>
          <b className="ctr">{int(c.n)}</b>
          <span className="bar"><i style={{ width: `${(c.n / maxN) * 100}%` }} /></span>
          <span className="off">{pct(c.n / Math.max(1, o.errors.total))} ошибок</span>
        </li>
      ))}</ul>}
      {o.errors.byChannel.length > 0 && <p className="ia-foot2">По каналам: {o.errors.byChannel.map((x) => `${LOG_CH_LABEL[x.channel] ?? x.channel} ${int(x.n)}`).join(" · ")}</p>}
    </Card>
  );
}

/** Источники первого касания и реальные пользователи (без команды и тестов). */
function SourcesCard({ o, d, cmp }: { o: OpsSummary; d: Dashboard; cmp: boolean }) {
  return (
    <Card span="ia-s6" title="Откуда приходят пользователи" n={o.sources.total} min={d.minCohort}
      take={o.sources.rows[0] ? `Больше всего — ${srcLabel(o.sources.rows[0].source, o.sources.rows[0].medium)}: ${pct(o.sources.rows[0].share)} новых.` : "Источников за период нет."}
      def={<>Первое касание пользователя: UTM-метки и домен реферера при первом визите в веб, payload ссылки бота (?start=src_…) или startapp Mini App. Одна запись на пользователя. «Другие сайты» — переход по ссылке с другого сайта (определено по домену реферера); «Приглашения друзей» — ссылка ref_. «Активных без команды» — активные за период без команды и тестовых аккаунтов. Группы меньше {d.minCohort} показаны как «&lt;{d.minCohort}».</>}>
      <div className="ia-stats">
        <div className="ia-stat"><span>Активных без команды</span><b>{int(o.users.real)}</b><small>активны за период</small></div>
        <div className="ia-stat"><span>Новых аккаунтов</span><b>{int(o.users.newReal)}</b><small>{o.includeInternal ? "вместе с командой" : `без команды и тестов (${int(o.users.internal)})`}</small></div>
      </div>
      {o.sources.rows.length > 0 && <HBars fmt={(v) => pct(v)} rows={o.sources.rows.map((r) => ({ label: srcLabel(r.source, r.medium), value: r.small ? null : r.share, color: COLOR.mint, muted: r.small, note: r.small ? `<${d.minCohort}` : `n${NB}=${NB}${int(r.n)}` }))} />}
      {o.sources.byChannel.length > 0 && <p className="ia-foot2">Первый канал: {o.sources.byChannel.map((x) => `${LOG_CH_LABEL[x.channel] ?? x.channel} ${int(x.n)}`).join(" · ")}</p>}
      <p className="ia-foot2"><a className="ia-link" href={`${href(d, cmp, { int: !o.includeInternal })}#q7`}>{o.includeInternal ? "Исключить команду и тесты" : "Показать вместе с командой и тестами"}</a></p>
    </Card>
  );
}

const REF_CH_LABEL: Record<string, string> = { web: "Веб", bot: "Бот", miniapp: "Mini App" };
/** Рефералы: приглашения, регистрации по ним, активация, K-фактор и топ пригласивших (псевдонимы, малые группы скрыты). */
function ReferralsCard({ r }: { r: ReferralSummary }) {
  const small = (n: number) => n > 0 && n < r.minCohort;
  const v = (n: number) => (small(n) ? `<${r.minCohort}` : int(n));
  return (
    <Card span="ia-s6" title="Приглашения друзей" n={r.signups} min={r.minCohort}
      take={r.signups ? `По приглашениям пришло ${v(r.signups)}, начали пользоваться ${v(r.activated)}${r.activationRate != null && !small(r.signups) ? ` (${pct(r.activationRate)})` : ""}.` : "Регистраций по приглашениям за период нет."}
      def={<>«Нажали «пригласить»» — нажатия «Отправить / Скопировать / Поделиться» в вебе и Mini App и запросы ссылки в боте (/invite); это не число доставленных приглашений. Пришли — новые аккаунты с атрибуцией по ссылке ref_ (первое касание; самоприглашения, команда и уже существующие аккаунты не считаются). Начали пользоваться — друг завершил знакомство или получил первый ответ «Можно?». «Пришедших на активного» — пришедшие по приглашениям / активные за период; это не классический K-фактор. «На ручной проверке» — всплеск по одному коду, ждёт проверки (не путать с 48 ч до бонуса). Бонусы {r.rewards.enabled ? "включены" : "выключены флагом"}. Группы меньше {r.minCohort} показаны как «&lt;{r.minCohort}».</>}>
      <div className="ia-stats">
        <div className="ia-stat"><span>Нажали «пригласить»</span><b>{int(r.invitesShared)}</b><small>делились: {v(r.sharers)} · открыли: {v(r.opened)}</small></div>
        <div className="ia-stat"><span>Пришедших на активного</span><b>{r.kFactor == null ? "—" : dec(r.kFactor, 2)}</b><small>на {int(r.activeUsers)} активных</small></div>
      </div>
      <div className="ia-stats">
        <div className="ia-stat"><span>Пришли по ссылке</span><b>{v(r.signups)}</b><small>{r.held ? `на ручной проверке: ${v(r.held)}` : "на ручной проверке нет"}</small></div>
        <div className="ia-stat"><span>Начали пользоваться</span><b>{v(r.activated)}</b><small>{r.activationRate == null || small(r.signups) ? "—" : pct(r.activationRate)} от пришедших</small></div>
      </div>
      {r.top.length > 0 && <>
        <h4 className="ia-h4">Кто приглашает</h4>
        <HBars fmt={(x) => int(x)} rows={r.top.map((t, i) => ({ label: t.subject ? `#${t.subject}` : `скрыт · ${i + 1}`, value: t.small ? null : t.signups, color: COLOR.mint, muted: t.small, note: t.small ? `<${r.minCohort}` : `активны ${int(t.activated)}` }))} />
      </>}
      <p className="ia-foot2">{r.byChannel.length ? `По каналам: ${r.byChannel.map((x) => `${REF_CH_LABEL[x.channel] ?? x.channel} ${v(x.n)}`).join(" · ")} · ` : ""}Бонусы: {r.rewards.enabled ? `ждут ${int(r.rewards.pending)} · сверх лимита ${int(r.rewards.limited)}` : "выключены (REFERRAL_REWARDS_ENABLED)"}</p>
    </Card>
  );
}

function llmLead(l: LlmSummary | null): string {
  if (!l) return "Нет данных журнала ai_usage.";
  const empty = !l.period.operations && !l.today.spentMicro;
  const setup = l.setup.killed ? "LLM выключена (LLM_ENABLED=0), ответы шаблонные." : !l.setup.configured ? `Ключ LLM не задан: работают regex и шаблоны${empty ? ", расход нулевой" : ", новых вызовов нет; ниже записанные ранее"}.` : "";
  if (empty) return `${setup ? setup + " " : ""}За период вызовов модели нет.`;
  return `${setup ? setup + " " : ""}За период ${rubLabel(l.period.spentMicro)} на ${int(l.period.operations)} вызовов; сегодня ${pct(l.today.share, 1)} дневного потолка. Числа в ответах всё равно считает движок.`;
}

const shortModel = (m: string) => m.replace(/-(\d+b)-a[\d.]+b$/i, " $1").replace(/^gigachat/i, "GigaChat ").replace(/^qwen/i, "Qwen ").replace(/^deepseek-/i, "DeepSeek ");
const tokens = (n: number) => (n >= 1_000_000 ? `${dec(n / 1_000_000, 1)}${NB}млн` : n >= 1000 ? `${int(n / 1000)}${NB}тыс.` : int(n));

/** Полоса «потрачено из лимита» с отметкой расширенного бюджета (75 тыс.). */
function Meter({ label, value, cap, sub, mark }: { label: string; value: number; cap: number; sub: string; mark?: { at: number; label: string } }) {
  const share = cap > 0 ? value / cap : 0;
  const tone = share >= 0.9 ? " hot" : share >= 0.7 ? " warn" : "";
  return (
    <div className={"ia-meter" + tone}>
      <div className="row"><span>{label}</span><b>{rubLabel(value)} <small>из {rubLabel(cap)}</small></b></div>
      <div className="track" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={value} aria-label={label}>
        <i style={{ width: `${Math.min(1, share) * 100}%` }} />
        {mark && mark.at > 0 && mark.at < 1 && <em style={{ left: `${mark.at * 100}%` }} title={mark.label} />}
      </div>
      <small className="sub">{sub}</small>
    </div>
  );
}

/** «LLM и бюджет»: расход сегодня к дневному потолку, весь бюджет акселератора, ₽ на DAU, токены, модели, резерв, отказы, p95. */
function LlmCard({ l }: { l: LlmSummary }) {
  const p = l.period, t = l.today;
  const maxModel = Math.max(1, ...l.models.map((m) => m.calls));
  const fbHot = (p.fallbackRate ?? 0) >= 0.1;
  return (
    <Card span="ia-s12 ia-llm" title="Модели и расходы" n={p.operations} min={30}
      take={`Сегодня ${rubLabel(Math.max(t.spentMicro, t.bucketSpentMicro))} из ${rubLabel(t.capMicro)} дневного потолка. ${p.dauDays ? `На активного ≈ ${rubLabel(p.costPerDauMicro ?? 0)} в день.` : "DAU за период нет."}`}
      def={<>Каждая попытка вызова модели пишется в <code>ai_usage</code>: модель, токены из <code>usage</code> ответа (или оценка), стоимость по прайсу Cloud.ru с НДС (<code>lib/llm/prices.ts</code>), задержка, итог. Дневной потолок проекта и мягкий лимит пользователя ({rubLabel(t.userCapMicro)} в день) — атомарный резерв до вызова и сверка после; при отказе ответ уходит шаблоном с теми же числами движка. «Сегодня» — день по Москве. «Забронировано» — деньги, отложенные на идущие сейчас вызовы, ещё не списаны. «₽ на активного/день» — расход за полные дни периода / сумма DAU по дням. «Ответы запасной модели» — доля успешных ответов, которые дала не основная модель. «Польз.-дни» — сумма DAU по дням: один человек, активный 3 дня, = 3. Команда и тесты {l.includeInternal ? "включены" : "исключены"}; весь бюджет и счётчик потолка считают все деньги, включая их.</>}>
      <div className="ia-llm-grid">
        <div>
          <Meter label="Сегодня, день МСК" value={Math.max(t.spentMicro, t.bucketSpentMicro)} cap={t.capMicro}
            sub={`в журнале ${rubLabel(t.spentMicro)}${l.includeInternal ? "" : " без команды"} · забронировано на текущие вызовы ${rubLabel(t.bucketReservedMicro)}`} />
          <Meter label="Бюджет акселератора" value={l.total.spentMicro} cap={l.total.budgetMicro}
            mark={l.total.budgetMaxMicro > l.total.budgetMicro ? { at: l.total.budgetMicro / l.total.budgetMaxMicro, label: "расширенный" } : undefined}
            sub={`${pct(l.total.share, 1)} · расширенный до ${rubLabel(l.total.budgetMaxMicro)}${l.total.budgetStart > "2000-01-01" ? ` · с ${l.total.budgetStart}` : ""}`} />
          <div className="ia-stats">
            <div className="ia-stat"><span>За период</span><b>{rubLabel(p.spentMicro)}</b><small>{int(p.operations)} вызовов · {int(p.dauDays)} польз.-дни</small></div>
            <div className="ia-stat"><span>₽ на активного/день</span><b>{p.costPerDauMicro == null ? "—" : rubLabel(p.costPerDauMicro)}</b><small>оценка в LLM-COST.md: 1,29–1,80{NB}₽</small></div>
          </div>
          <div className="ia-stats">
            <div className="ia-stat"><span>Ответы запасной модели</span><b className={fbHot ? "warn" : undefined}>{pct(p.fallbackRate, 1)}</b><small>{int(p.fallbackOps)} из {int(p.okOps)} ответов{p.timeouts ? ` · таймаутов ${int(p.timeouts)}` : ""}</small></div>
            <div className="ia-stat"><span>Отказы по бюджету</span><b className={p.deniedOps ? "warn" : undefined}>{int(p.deniedOps)}</b><small>дни с отказом: {int(p.deniedUserDays)} польз.-дни · сбоев {int(p.failedOps)}</small></div>
          </div>
        </div>
        <div>
          <div className="ia-stats">
            <div className="ia-stat"><span>Токены модели</span><b>{tokens(p.promptTokens + p.completionTokens)}</b><small>вход {tokens(p.promptTokens)} · выход {tokens(p.completionTokens)}{p.audioSec ? ` · голос ${int(p.audioSec / 60)}${NB}мин` : ""}</small></div>
            <div className="ia-stat"><span>p95 ответа модели</span><b>{p.p95 == null ? "—" : `${dec(p.p95 / 1000, 1)}${NB}с`}</b><small>p50 {p.p50 == null ? "—" : `${dec(p.p50 / 1000, 1)}${NB}с`} · попыток {int(p.attempts)}</small></div>
          </div>
          {l.models.length > 0 && <>
            <h4 className="ia-h4">Вызовы по моделям</h4>
            <HBars fmt={(v) => int(v)} max={maxModel} rows={l.models.map((m, i) => ({ label: shortModel(m.model), value: m.calls, color: i === 0 ? COLOR.mint : i === 1 ? COLOR.amber : COLOR.sky, note: rubLabel(m.costMicro) }))} />
          </>}
          <h4 className="ia-h4">Расход по дням</h4>
          <Sparkline values={l.daily.map((x) => x.costMicro / 1_000_000)} label="llm-cost" color={COLOR.aqua} />
        </div>
      </div>
      <p className="ia-foot2">{l.setup.killed ? "Выключено: LLM_ENABLED=0 · " : !l.setup.configured ? "Ключ не задан · " : ""}{l.setup.provider} · {[l.setup.primary, ...l.setup.fallbacks].map(shortModel).join(" → ")}{p.aiAnswers ? ` · AI-ответов ${int(p.aiAnswers)}` : ""}</p>
    </Card>
  );
}

function plusLead(p: PlusSummary | null): string {
  if (!p) return "Нет данных о тарифах.";
  const mode = p.mode === "beta" ? "Сейчас бета: у всех Бета-Плюс, оплаты нет — считаем только интерес." : "Тарифы включены (PLANS_MODE=live), оплаты нет.";
  if (!p.views && !p.consumed) return `${mode} За период «Плюс» не открывали и AI-ответов не было.`;
  return `${mode} «Плюс» открыли ${int(p.viewers)} чел., заявку оставили ${int(p.interested)}. AI-ответов ${int(p.consumed)}${p.perDau != null ? ` (${dec(p.perDau, 2)} на активного в день)` : ""}; лимита достигли ${pct(p.exhaustedShare)} активных.`;
}

const SURFACE_LABEL: Record<string, string> = { counter: "Счётчик у чата", menu: "Профиль", exhausted: "AI-ответы закончились", answer: "Под ответом", bot: "Бот /plus" };
const PURPOSE_LABEL: Record<string, string> = { explain: "«Почему так?»", compare: "Сравнения", goal_chat: "Разговор о цели", weekly_review: "Разборы" };

function PlusCard({ p }: { p: PlusSummary }) {
  const maxS = Math.max(1, ...p.surfaces.map((x) => x.views));
  const known = p.prices.filter((x) => x.users != null).reduce((a, x) => a + (x.users ?? 0), 0);
  return (
    <Card span="ia-s12 ia-llm" title="Плюс и AI-ответы" n={p.viewers} min={30}
      take={`Цена после беты ${int(p.priceRub)}${NB}₽ за 30 дней. Заявок ${int(p.interested)} из ${int(p.viewers)} открывших${p.conversion != null ? ` (${pct(p.conversion)})` : ""}. AI-ответов на активного/день: ${p.perDau == null ? "—" : dec(p.perDau, 2)}.`}
      def={<>События <code>plus_viewed</code> (где открыли), <code>plus_interest</code> (последний выбор цены на человека; «none» — «не знаю»), <code>ai_answer_consumed</code> (1 списанный AI-ответ; разбор фразы, голос и сбои не считаются), <code>tokens_exhausted</code> (не больше 1 на человека в день и лимит). Конверсия — оставившие заявку / открывшие «Плюс»; заявка — не покупка. На активного/день — AI-ответы / сумма DAU по дням. «Достигли лимита AI-ответов» — упёршиеся / активные за период. Цены с группой меньше {p.minCohort} скрыты. Команда и тесты {p.includeInternal ? "включены" : "исключены"}. Платежей нет (этап 1).</>}>
      <div className="ia-llm-grid">
        <div>
          <div className="ia-stats">
            <div className="ia-stat"><span>Открыли «Плюс»</span><b>{int(p.viewers)}</b><small>{int(p.views)} просмотров</small></div>
            <div className="ia-stat"><span>Оставили заявку</span><b>{int(p.interested)}</b><small>конверсия {pct(p.conversion)}{p.repeats ? ` · меняли цену ${int(p.repeats)}` : ""}</small></div>
          </div>
          <h4 className="ia-h4">Последний выбор цены</h4>
          {p.prices.length ? <HBars fmt={(v) => int(v)} max={Math.max(1, known)} rows={p.prices.map((x) => ({ label: x.price === "none" ? "Не знаю" : `${x.price}${NB}₽`, value: x.users, color: Number(x.price) === p.priceRub ? COLOR.mint : COLOR.sky, muted: x.users == null, note: x.users == null ? `<${p.minCohort}` : undefined }))} /> : <p className="ia-empty">Заявок пока нет.</p>}
          <h4 className="ia-h4">Где открывают</h4>
          {p.surfaces.length ? <HBars fmt={(v) => int(v)} max={maxS} rows={p.surfaces.map((x) => ({ label: SURFACE_LABEL[x.surface] ?? x.surface, value: x.views, color: COLOR.aqua }))} /> : <p className="ia-empty">—</p>}
        </div>
        <div>
          <div className="ia-stats">
            <div className="ia-stat"><span>AI-ответов</span><b>{int(p.consumed)}</b><small>{int(p.dauDays)} польз.-дни · {p.perDau == null ? "—" : dec(p.perDau, 2)} на активного/день</small></div>
            <div className="ia-stat"><span>Достигли лимита AI-ответов</span><b className={(p.exhaustedShare ?? 0) >= 0.2 ? "warn" : undefined}>{pct(p.exhaustedShare)}</b><small>{int(p.exhaustedUsers)} из {int(p.activeUsers)} активных · {int(p.exhaustedUserDays)} польз.-дни</small></div>
          </div>
          {p.byPurpose.length > 0 && <>
            <h4 className="ia-h4">На что уходят AI-ответы</h4>
            <HBars fmt={(v) => int(v)} max={Math.max(1, ...p.byPurpose.map((x) => x.n))} rows={p.byPurpose.map((x) => ({ label: PURPOSE_LABEL[x.purpose] ?? x.purpose, value: x.n, color: COLOR.emerald }))} />
          </>}
          <h4 className="ia-h4">AI-ответы по дням</h4>
          <Sparkline values={p.daily.map((x) => x.consumed)} label="ai-answers" color={COLOR.mint} />
        </div>
      </div>
      <p className="ia-foot2">{p.mode === "beta" ? "PLANS_MODE=beta · Бета-Плюс у всех" : "PLANS_MODE=live"} · варианты цены {p.options.map((o) => `${o}${NB}₽`).join(" / ")}{p.demo ? " · демо-данные" : ""}</p>
    </Card>
  );
}
