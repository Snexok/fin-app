// Лёгкие SVG/CSS-графики для внутреннего дашборда: серверные компоненты, без JS-библиотек и без клиентского JS.
// Подсказки — HTML-оверлей с :hover/:focus (без нативного <title>); цвета каналов и вердиктов едины по всей странице.
import type { CSSProperties } from "react";
import type { CohortRow, FunnelStage } from "../../../lib/analytics-metrics";
import { int, pct, STEP_LABEL, VERDICT_LABEL } from "../../../lib/analytics-insights";

/** Палитра: изумруд / мята / аква + тёплый янтарь для предупреждений. */
export const COLOR = {
  emerald: "#34d399", mint: "#6ee7b7", aqua: "#5eead4", sky: "#67d4f0", amber: "#fbbf24",
  web: "#6ee7b7", telegram: "#67d4f0", miniapp: "#b8a8ff",
  all: "#a7f3d0", accent: "#6ee7b7", prev: "rgb(214 245 230 / 46%)",
  fits_plan: "#34d399", reduces_daily_margin: "#c8e98a", touches_protected_money: "#fbbf24", cash_gap: "#fb8b6b", insufficient_data: "#7f978d",
  drop: "#fbbf24", good: "#6ee7b7", bad: "#fbbf24",
} as const;
const NB = "\u00a0";
const RU_M = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const day = (iso: string) => { const [, m, d] = iso.split("-"); return `${Number(d)}.${m}`; };
const dayLong = (iso: string) => { const [, m, d] = iso.split("-"); const wd = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"][new Date(`${iso}T00:00:00Z`).getUTCDay()]; return `${wd}, ${Number(d)}${NB}${RU_M[Number(m) - 1]}`; };
/** Детерминированный id для <defs> (несколько графиков на странице). */
const uid = (s: string) => "ia" + [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7).toString(36);
const f1 = (v: number) => v.toFixed(1);

/** Монотонная кубическая интерполяция (без «перелётов» над данными), разрывы на null. */
export function smoothPath(pts: [number, number][]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${f1(pts[0][0])},${f1(pts[0][1])}`;
  const dx: number[] = [], m: number[] = [], t: number[] = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0] || 1e-9; m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
  let d = `M${f1(pts[0][0])},${f1(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], h = dx[i] / 3;
    d += `C${f1(x0 + h)},${f1(y0 + t[i] * h)},${f1(x1 - h)},${f1(y1 - t[i + 1] * h)},${f1(x1)},${f1(y1)}`;
  }
  return d;
}
function segments(vs: (number | null)[], x: (i: number) => number, y: (v: number) => number) {
  const out: [number, number][][] = [];
  let cur: [number, number][] = [];
  vs.forEach((v, i) => { if (v == null) { if (cur.length) out.push(cur); cur = []; } else cur.push([x(i), y(v)]); });
  if (cur.length) out.push(cur);
  return out;
}

export function Sparkline({ values, color = COLOR.mint, label = "" }: { values: (number | null)[]; color?: string; label?: string }) {
  const w = 220, h = 46;
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null);
  if (pts.length < 2) return <svg className="ia-spark" viewBox={`0 0 ${w} ${h}`} aria-hidden="true"><line x1="2" x2={w - 2} y1={h - 4} y2={h - 4} className="none" /></svg>;
  const xs = values.length - 1 || 1;
  const vals = pts.map((p) => p[1]);
  const min = Math.min(...vals), max = Math.max(...vals);
  const x = (i: number) => 4 + (i / xs) * (w - 8);
  const y = (v: number) => (max === min ? h / 2 : 5 + (h - 12) * (1 - (v - min) / (max - min)));
  const segs = segments(values, x, y);
  const id = uid("sp" + label + color);
  const [li, lv] = pts[pts.length - 1];
  return (
    <svg className="ia-spark" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.34" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient>
        <filter id={`${id}g`} x="-10%" y="-60%" width="120%" height="220%"><feGaussianBlur stdDeviation="2.6" /></filter>
      </defs>
      {segs.map((s, k) => <path key={"a" + k} className="fade" d={`${smoothPath(s)}L${f1(s[s.length - 1][0])},${h}L${f1(s[0][0])},${h}Z`} fill={`url(#${id}f)`} />)}
      {segs.map((s, k) => <path key={"g" + k} className="draw" pathLength={1} d={smoothPath(s)} fill="none" stroke={color} strokeWidth={4} opacity={0.45} filter={`url(#${id}g)`} />)}
      {segs.map((s, k) => <path key={"l" + k} className="draw" pathLength={1} d={smoothPath(s)} fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" />)}
      <circle className="fade" cx={x(li)} cy={y(lv)} r={6} fill={color} opacity={0.22} />
      <circle className="fade" cx={x(li)} cy={y(lv)} r={2.8} fill={color} />
    </svg>
  );
}

function ticks(max: number) { return [0, 0.5, 1].map((f) => max * f); }

type Tip = { label: string; color: string; value: string; dashed?: boolean };
/** Невидимые колонки поверх графика: наведение/фокус → направляющая, точки и подсказка. */
function Hover({ n, pos, box, rows, dots }: { n: number; pos: (i: number) => number; box: { l: number; r: number; t: number; b: number; W: number; H: number }; rows: (i: number) => { title: string; items: Tip[] }; dots?: (i: number) => { top: number; color: string }[] }) {
  const pw = box.W - box.l - box.r, ph = box.H - box.t - box.b;
  const cw = pw / Math.max(1, n);
  return (
    <div className="ia-hov" style={{ left: `${(box.l / box.W) * 100}%`, right: `${(box.r / box.W) * 100}%`, top: `${(box.t / box.H) * 100}%`, bottom: `${(box.b / box.H) * 100}%` }}>
      {Array.from({ length: n }, (_, i) => {
        const r = rows(i);
        const left = ((pos(i) - box.l - cw / 2) / pw) * 100;
        return (
          <span key={i} tabIndex={0} aria-label={`${r.title}: ${r.items.map((it) => `${it.label} ${it.value}`).join(", ")}`} className={"c" + (i >= n * 0.5 ? " r" : "")} style={{ left: `${left}%`, width: `${(cw / pw) * 100}%` }}>
            {dots?.(i).map((d, k) => <i key={k} className="pt" style={{ top: `${((d.top - box.t) / ph) * 100}%`, background: d.color }} />)}
            <span className="tip" role="tooltip">
              <b>{r.title}</b>
              {r.items.map((it) => <span key={it.label} className="tr"><i style={it.dashed ? { background: "none", border: `1.5px dashed ${it.color}` } : { background: it.color }} />{it.label}<em>{it.value}</em></span>)}
            </span>
          </span>
        );
      })}
    </div>
  );
}

type Line = { name: string; color: string; values: (number | null)[]; dashed?: boolean; area?: boolean };
/** Линейный график по дням: плавные линии с мягким свечением, градиентная заливка, минимальная сетка. */
export function LineChart({ labels, lines, fmt = (v: number) => int(v), h = 210, label, W = 760 }: { labels: string[]; lines: Line[]; fmt?: (v: number) => string; h?: number; label: string; W?: number }) {
  const P = { l: 40, r: 14, t: 14, b: 26 };
  const all = lines.flatMap((l) => l.values.filter((v): v is number => v != null));
  const max = niceMax(Math.max(1e-9, ...all));
  const n = labels.length;
  const x = (i: number) => P.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - P.l - P.r));
  const y = (v: number) => P.t + (h - P.t - P.b) * (1 - v / max);
  const step = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(W / 105))));
  const id = uid(label + W);
  return (
    <div className="ia-plot">
      <svg className={"ia-chart" + (W < 500 ? " sm" : "")} viewBox={`0 0 ${W} ${h}`} role="img" aria-label={label}>
        <defs>
          {lines.map((l, k) => l.area && <linearGradient key={k} id={`${id}a${k}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={l.color} stopOpacity="0.30" /><stop offset="0.7" stopColor={l.color} stopOpacity="0.06" /><stop offset="1" stopColor={l.color} stopOpacity="0" /></linearGradient>)}
          <filter id={`${id}g`} x="-5%" y="-40%" width="110%" height="180%"><feGaussianBlur stdDeviation="4" /></filter>
        </defs>
        {ticks(max).map((v, k) => <g key={k}><line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} className={k === 0 ? "base" : "grid"} /><text x={P.l - 10} y={y(v) + 4} textAnchor="end">{fmt(v)}</text></g>)}
        {labels.map((l, i) => (i % step === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= step / 2) && <text key={l} x={x(i)} y={h - 7} textAnchor="middle">{day(l)}</text>)}
        {lines.map((l, k) => l.area && segments(l.values, x, y).map((s, j) => <path key={`a${k}${j}`} className="fade" d={`${smoothPath(s)}L${f1(s[s.length - 1][0])},${y(0)}L${f1(s[0][0])},${y(0)}Z`} fill={`url(#${id}a${k})`} />))}
        {lines.map((l, k) => segments(l.values, x, y).map((s, j) => l.dashed
          ? <path key={`d${k}${j}`} className="fade" d={smoothPath(s)} fill="none" stroke={l.color} strokeWidth={1.5} strokeDasharray="4 5" strokeLinecap="round" />
          : <g key={`l${k}${j}`}>
              <path className="draw" pathLength={1} d={smoothPath(s)} fill="none" stroke={l.color} strokeWidth={5} opacity={0.35} filter={`url(#${id}g)`} />
              <path className="draw" pathLength={1} d={smoothPath(s)} fill="none" stroke={l.color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
            </g>))}
        {lines.filter((l) => !l.dashed).map((l) => { const i = lastIdx(l.values); return i < 0 ? null : <g key={"e" + l.name} className="fade"><circle cx={x(i)} cy={y(l.values[i]!)} r={7} fill={l.color} opacity={0.18} /><circle cx={x(i)} cy={y(l.values[i]!)} r={3.4} fill={l.color} stroke="#06261a" strokeWidth={1.5} /></g>; })}
      </svg>
      <Hover n={n} pos={x} box={{ ...P, W, H: h }}
        rows={(i) => ({ title: dayLong(labels[i]), items: lines.map((l) => ({ label: l.name, color: l.color, dashed: l.dashed, value: l.values[i] == null ? "—" : fmt(l.values[i]!) })) })}
        dots={(i) => lines.filter((l) => l.values[i] != null && !l.dashed).map((l) => ({ top: y(l.values[i]!), color: l.color }))} />
    </div>
  );
}
const lastIdx = (vs: (number | null)[]) => { for (let i = vs.length - 1; i >= 0; i--) if (vs[i] != null) return i; return -1; };

/** Столбики по дням со скруглёнными верхушками, линия среднего за 7 дней и метка прошлого периода. */
export function BarChart({ labels, values, prev, color = COLOR.mint, h = 230, label, fmt = (v: number) => int(v), avgLabel = "среднее за 7 дней", W = 760 }: { labels: string[]; values: number[]; prev?: (number | null)[]; color?: string; h?: number; label: string; fmt?: (v: number) => string; avgLabel?: string; W?: number }) {
  const P = { l: 40, r: 10, t: 14, b: 26 };
  const avg = values.map((_, i) => (i < 6 ? null : values.slice(i - 6, i + 1).reduce((a, b) => a + b, 0) / 7));
  const max = niceMax(Math.max(1, ...values, ...(prev ?? []).map((v) => v ?? 0)));
  const n = labels.length, bw = (W - P.l - P.r) / n;
  const y = (v: number) => P.t + (h - P.t - P.b) * (1 - v / max);
  const cx = (i: number) => P.l + i * bw + bw / 2;
  const step = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(W / 105))));
  const wk = labels.map((l) => new Date(`${l}T00:00:00Z`).getUTCDay());
  const id = uid(label + W);
  const gap = Math.min(bw * 0.32, 6), w = Math.max(1.5, bw - gap);
  return (
    <div className="ia-plot">
      <svg className={"ia-chart" + (W < 500 ? " sm" : "")} viewBox={`0 0 ${W} ${h}`} role="img" aria-label={label}>
        <defs>
          <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.95" /><stop offset="1" stopColor={color} stopOpacity="0.28" /></linearGradient>
          <filter id={`${id}g`} x="-5%" y="-40%" width="110%" height="180%"><feGaussianBlur stdDeviation="3.5" /></filter>
        </defs>
        {ticks(max).map((v, k) => <g key={k}><line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} className={k === 0 ? "base" : "grid"} /><text x={P.l - 10} y={y(v) + 4} textAnchor="end">{fmt(v)}</text></g>)}
        {values.map((v, i) => v > 0 && <path key={labels[i]} className="grow" style={{ animationDelay: `${Math.min(600, i * 9)}ms` }} d={barPath(cx(i) - w / 2, y(v), w, y(0) - y(v), Math.min(4, w / 2))} fill={`url(#${id}b)`} opacity={wk[i] === 0 || wk[i] === 6 ? 0.55 : 1} />)}
        {prev && prev.map((v, i) => v != null && <line key={"p" + i} className="fade" x1={cx(i) - w / 2} x2={cx(i) + w / 2} y1={y(v)} y2={y(v)} stroke={COLOR.prev} strokeWidth={1.6} strokeLinecap="round" />)}
        {segments(avg, cx, y).map((s, j) => <g key={"avg" + j}>
          <path className="draw" pathLength={1} d={smoothPath(s)} fill="none" stroke={COLOR.aqua} strokeWidth={5} opacity={0.4} filter={`url(#${id}g)`} />
          <path className="draw" pathLength={1} d={smoothPath(s)} fill="none" stroke="#d9fff4" strokeWidth={2} strokeLinecap="round" />
        </g>)}
        {labels.map((l, i) => (i % step === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= step / 2) && <text key={"x" + l} x={cx(i)} y={h - 7} textAnchor="middle">{day(l)}</text>)}
      </svg>
      <Hover n={n} pos={cx} box={{ ...P, W, H: h }}
        rows={(i) => ({ title: dayLong(labels[i]), items: [
          { label: "за день", color, value: fmt(values[i]) },
          ...(avg[i] != null ? [{ label: avgLabel, color: "#d9fff4", value: fmt(Math.round(avg[i]!)) }] : []),
          ...(prev ? [{ label: "прошлый период", color: COLOR.prev, value: prev[i] == null ? "—" : fmt(prev[i]!) }] : []),
        ] })} />
    </div>
  );
}
/** Прямоугольник со скруглёнными только верхними углами. */
export function barPath(x: number, y: number, w: number, h: number, r: number) {
  if (h <= 0) return "";
  const rr = Math.min(r, h, w / 2);
  return `M${f1(x)},${f1(y + h)}V${f1(y + rr)}Q${f1(x)},${f1(y)} ${f1(x + rr)},${f1(y)}H${f1(x + w - rr)}Q${f1(x + w)},${f1(y)} ${f1(x + w)},${f1(y + rr)}V${f1(y + h)}Z`;
}

/** Воронка: зелёная часть — дошли (доля от начавших), янтарная штриховка — сколько потеряли на этом шаге. */
/** cmp[i] — готовая подпись разницы с прошлым периодом (та же, что в ECharts-подсказке), prev[i] — прошлая доля. */
export function Funnel({ stages, cmp, prev, hrefs }: { stages: FunnelStage[]; cmp?: (string | null)[]; prev?: (number | null)[]; hrefs?: Record<string, string> }) {
  const worst = stages.filter((s) => s.dropRate != null && s.drop > 0).reduce<FunnelStage | null>((a, b) => (!a || (b.dropRate ?? 0) > (a.dropRate ?? 0) ? b : a), null);
  return (
    <ol className="ia-funnel3">
      {stages.map((s, i) => {
        const prevOf = i === 0 ? s.ofStart ?? 0 : stages[i - 1].ofStart ?? 0;
        const kept = s.ofStart ?? 0;
        const isW = s === worst;
        return (
          <li key={s.key} className={isW ? "is-worst" : undefined} style={{ "--i": i } as CSSProperties} tabIndex={0}
            data-tip={`${STEP_LABEL[s.key]}: дошли ${int(s.n)} (${pct(kept)} начавших)${s.key !== "started" ? ` · ушли ${int(s.drop)} (${pct(s.dropRate)} дошедших до прошлого шага)` : ""}${s.unknownShare != null ? ` · «не знаю» ${pct(s.unknownShare)}` : ""}${i > 0 && cmp?.[i] ? ` · прошлый период ${pct(prev?.[i] ?? null)}: ${cmp[i]}` : ""}`}>
            <span className="name"><span className="k">{String(i + 1).padStart(2, "0")}</span>{hrefs?.[s.key] ? <a className="go" href={hrefs[s.key]} data-step={s.key} aria-label={`${STEP_LABEL[s.key]}: почему уходят на этом шаге`}>{STEP_LABEL[s.key]}</a> : STEP_LABEL[s.key]}</span>
            <span className="track">
              <i className="kept" style={{ width: `${kept * 100}%` }} />
              {prevOf - kept > 0.0005 && <i className="lost" style={{ left: `${kept * 100}%`, width: `${(prevOf - kept) * 100}%` }} />}
              {s.unknownShare != null && s.unknownShare >= 0.2 && (prevOf <= 0.76
                ? <em className="unk" style={{ left: `calc(${prevOf * 100}% + 8px)` }}>«не знаю» {pct(s.unknownShare)}</em>
                : <em className="unk in" style={{ right: `calc(${(1 - kept) * 100}% + 6px)` }}>«не знаю» {pct(s.unknownShare)}</em>)}
            </span>
            <span className="val"><b>{pct(kept)}</b><small>{int(s.n)}</small>{i > 0 && cmp?.[i] && <span className="ia-sr">Прошлый период: {pct(prev?.[i] ?? null)}, {cmp[i]}</span>}</span>
            <span className="drop">{s.key === "started" ? "" : s.drop > 0 ? <>−{(s.dropRate ?? 0) < 0.005 ? "<1 %" : pct(s.dropRate)}{isW && <span className="w">главная потеря</span>}</> : "без потерь"}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** `small`: ячейки 0 < n < small не раскрываются ни числом, ни долей, ни точной геометрией (подпись «<small»). */
const hid = (v: number, small?: number) => small != null && v > 0 && v < small;
export function Histogram({ labels, values, highlight, color = COLOR.mint, unit = "", warnLabel, small }: { labels: readonly string[]; values: number[]; highlight?: number; color?: string; unit?: string; warnLabel?: string; small?: number }) {
  const geo = values.map((v) => (hid(v, small) ? small! / 2 : v));
  const max = Math.max(1, ...geo), tot = Math.max(1, values.reduce((a, b) => a + b, 0));
  const share = (v: number) => (hid(v, small) ? `<${small}` : pct(v / tot));
  return (
    <div className="ia-hist" role="img" aria-label={`Распределение: ${labels.map((l, i) => `${l} — ${share(values[i])}`).join(", ")}`}>
      {values.map((v, i) => (
        <div key={labels[i]} className={"col" + (i === highlight ? " hl" : "")} tabIndex={0} data-tip={`${labels[i]}: ${hid(v, small) ? `<${small}` : `${int(v)}${unit} · ${pct(v / tot)}`}${i === highlight && warnLabel ? ` · ${warnLabel}` : ""}`}>
          <span className="v">{share(v)}</span>
          <span className="b"><i style={{ height: `${Math.max(v > 0 ? 2 : 0, (geo[i] / max) * 100)}%`, "--c": color, animationDelay: `${i * 50}ms` } as CSSProperties} /></span>
          <span className="l">{labels[i]}</span>
        </div>
      ))}
    </div>
  );
}

/** Цвет ячейки удержания: от глубокого изумруда к светлой мяте. */
const lin = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
export function heatColor(rate: number, cap = 0.5) {
  const a = Math.max(0, Math.min(1, rate / cap));
  const lerp = (x: number[], y: number[], t: number) => x.map((f, k) => Math.round(f + (y[k] - f) * t));
  const c = a < 0.5 ? lerp([13, 70, 57], [31, 180, 135], a / 0.5) : lerp([31, 180, 135], [196, 251, 227], (a - 0.5) / 0.5);
  const L = 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  return { bg: `rgb(${c.join(" ")})`, dark: L > 0.19 };
}

const RET_HEAD = [["D1", "день 1"], ["D7", "дни 7–13"], ["D14", "дни 14–20"], ["D30", "дни 30–36"]] as const;
/** Тепловая карта удержания: строка — недельная когорта, столбцы D1/D7/D14/D30. */
export function Heatmap({ rows, minCohort }: { rows: CohortRow[]; minCohort: number }) {
  const maxSize = Math.max(1, ...rows.map((r) => r.size ?? 0));
  return (
    <div className="ia-heatwrap">
      <table className="ia-heat">
        <thead><tr><th>Неделя прихода</th><th className="sz">Новых</th>{RET_HEAD.map(([h, w]) => <th key={h}>{h}<small>{w}</small></th>)}</tr></thead>
        <tbody>{rows.map((r, ri) => (
          <tr key={r.week}>
            <td className="wk">{day(r.week)}</td>
            <td className="sz"><span><i style={{ width: `${((r.size ?? 0) / maxSize) * 100}%` }} /></span><b>{r.size == null ? `<${minCohort}` : int(r.size)}</b></td>
            {r.cells.map((c, ci) => {
              if (c.rate == null) return <td key={c.day} className="na" tabIndex={0} data-tip={c.matured === 0 ? `D${c.day}: окно ещё не закончилось` : `D${c.day}: созрело ${int(c.matured)} — меньше ${minCohort}, скрыто`}>{c.matured === 0 ? "·" : "мало"}</td>;
              const hc = heatColor(c.rate);
              return <td key={c.day} className={"c" + (hc.dark ? " dk" : "")} tabIndex={0} style={{ background: hc.bg, animationDelay: `${(ri * 4 + ci) * 18}ms` }} data-tip={`D${c.day}: вернулись ${pct(c.rate)} из ${int(c.matured)}`}>{pct(c.rate)}</td>;
            })}
          </tr>
        ))}</tbody>
      </table>
      <div className="ia-scale" aria-hidden="true"><span>0 %</span><i style={{ background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((f) => heatColor(f * 0.5).bg).join(", ")})` }} /><span>50 %+</span><span className="na">· — окно не закончилось</span></div>
    </div>
  );
}

/** 100 %-столбцы по неделям (структура вердиктов). */
export function StackedWeeks({ weeks }: { weeks: { week: string; counts: Record<string, number>; total: number }[] }) {
  const keys = Object.keys(VERDICT_LABEL);
  return (
    <div className="ia-stackw">
      {weeks.map((w, wi) => (
        <div key={w.week} className={"col" + (w.total < 30 ? " low" : "")} tabIndex={0}
          data-tip={`Неделя с ${day(w.week)} · ${int(w.total)} вопросов${w.total < 30 ? " (мало)" : ""} · ${keys.filter((k) => w.counts[k]).map((k) => `${VERDICT_LABEL[k]} ${pct(w.counts[k] / Math.max(1, w.total))}`).join(" · ")}`}>
          <span className="stack" style={{ animationDelay: `${wi * 40}ms` }}>{keys.map((k) => w.counts[k] ? <i key={k} style={{ flexGrow: w.counts[k], background: COLOR[k as keyof typeof COLOR] }} /> : null)}</span>
          <span className="l">{day(w.week)}</span>
          <span className="n">{w.total < 30 ? `n=${w.total}` : int(w.total)}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { color: string; label: string; dashed?: boolean; line?: boolean }[] }) {
  return <div className="ia-legend">{items.map((i) => <span key={i.label}><i className={i.dashed ? "dash" : i.line ? "line" : undefined} style={i.dashed ? { borderColor: i.color } : { background: i.color }} />{i.label}</span>)}</div>;
}

/** Горизонтальные столбики с подписью значения (для сравнения видов/каналов). */
export function HBars({ rows, fmt = (v: number) => pct(v), max }: { rows: { label: string; value: number | null; color: string; note?: string; muted?: boolean }[]; fmt?: (v: number) => string; max?: number }) {
  const m = max ?? Math.max(1e-9, ...rows.map((r) => r.value ?? 0));
  return (
    <div className="ia-hbars">
      {rows.map((r, i) => (
        <div key={r.label} className={"r" + (r.muted ? " muted" : "")}>
          <span className="l">{r.label}</span>
          <span className="b"><i style={{ width: `${((r.value ?? 0) / m) * 100}%`, "--c": r.color, animationDelay: `${i * 60}ms` } as CSSProperties} /></span>
          <span className="v">{r.value == null ? "—" : fmt(r.value)}{r.note && <small>{r.note}</small>}</span>
        </div>
      ))}
    </div>
  );
}

export function niceMax(v: number) {
  if (v <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / e;
  // чётные «круглые» верхушки, чтобы середина шкалы тоже была целой
  return ([1, 2, 4, 5, 6, 8, 10].find((x) => f <= x) ?? 10) * e;
}
export { NB };

/** Кольцо-индикатор доли: градиентная дуга со свечением и «огоньком» на конце. */
export function Ring({ value, prev, size = 168, label }: { value: number | null; prev?: number | null; size?: number; label: string }) {
  const r = size / 2 - 14, c = 2 * Math.PI * r, v = Math.max(0, Math.min(1, value ?? 0));
  const id = uid("ring" + label);
  const ang = -Math.PI / 2 + v * 2 * Math.PI;
  const ex = size / 2 + r * Math.cos(ang), ey = size / 2 + r * Math.sin(ang);
  const pa = prev == null ? null : -Math.PI / 2 + Math.max(0, Math.min(1, prev)) * 2 * Math.PI;
  return (
    <svg className="ia-ring" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label}: ${pct(value)}`}>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a7f3d0" /><stop offset="0.55" stopColor="#34d399" /><stop offset="1" stopColor="#5eead4" /></linearGradient>
        <filter id={`${id}b`} x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6" /></filter>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(214 255 234 / 8%)" strokeWidth={12} />
      {[...Array(40)].map((_, i) => { const a = (i / 40) * 2 * Math.PI; return <line key={i} x1={size / 2 + (r - 14) * Math.cos(a)} y1={size / 2 + (r - 14) * Math.sin(a)} x2={size / 2 + (r - 10) * Math.cos(a)} y2={size / 2 + (r - 10) * Math.sin(a)} stroke="rgb(214 255 234 / 14%)" strokeWidth={1.2} />; })}
      <circle className="ring-arc" cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#${id}g)`} strokeWidth={14} strokeLinecap="round" opacity={0.55} filter={`url(#${id}b)`}
        strokeDasharray={`${c * v} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ "--l": c * v } as CSSProperties} />
      <circle className="ring-arc" cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#${id}g)`} strokeWidth={12} strokeLinecap="round"
        strokeDasharray={`${c * v} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ "--l": c * v } as CSSProperties} />
      {pa != null && <line className="fade" x1={size / 2 + (r - 9) * Math.cos(pa)} y1={size / 2 + (r - 9) * Math.sin(pa)} x2={size / 2 + (r + 9) * Math.cos(pa)} y2={size / 2 + (r + 9) * Math.sin(pa)} stroke="#f2fff8" strokeWidth={2.5} strokeLinecap="round" opacity={0.75} />}
      {v > 0 && <g className="fade"><circle cx={ex} cy={ey} r={11} fill="#a7f3d0" opacity={0.25} /><circle cx={ex} cy={ey} r={5} fill="#f2fff8" /></g>}
    </svg>
  );
}

/** Кольцевая диаграмма структуры (вердикты): сегменты с зазорами и подписью в центре. */
export function Donut({ parts: raw, size = 150, center, sub, small }: { parts: { key: string; value: number; color: string; label: string }[]; size?: number; center: string; sub: string; small?: number }) {
  const parts = raw.map((p) => ({ ...p, hidden: hid(p.value, small), value: hid(p.value, small) ? small! / 2 : p.value }));
  const tot = parts.reduce((a, p) => a + p.value, 0) || 1;
  const r = size / 2 - 12, c = 2 * Math.PI * r, gap = 3;
  let acc = 0;
  return (
    <svg className="ia-donut" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={parts.map((p) => `${p.label} ${p.hidden ? `<${small}` : pct(p.value / tot)}`).join(", ")}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(214 255 234 / 7%)" strokeWidth={14} />
      {parts.filter((p) => p.value > 0).map((p) => {
        const len = (p.value / tot) * c, off = acc; acc += len;
        return <circle key={p.key} className="seg" cx={size / 2} cy={size / 2} r={r} fill="none" stroke={p.color} strokeWidth={14}
          strokeDasharray={`${Math.max(0.5, len - gap)} ${c}`} strokeDashoffset={-off} transform={`rotate(-90 ${size / 2} ${size / 2})`} />;
      })}
      <text x={size / 2} y={size / 2 + 2} textAnchor="middle" className="c">{center}</text>
      <text x={size / 2} y={size / 2 + 20} textAnchor="middle" className="s">{sub}</text>
    </svg>
  );
}
