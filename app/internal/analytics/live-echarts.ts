// Лениво загружаемый модуль: только нужные части ECharts (tree-shaking) + построение опций.
// Импортируется динамически из live.tsx, поэтому не попадает ни в общий бандл, ни в другие маршруты.
import * as echarts from "echarts/core";
import { BarChart, EffectScatterChart, FunnelChart, LineChart, ScatterChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { deltaText } from "./live-format";
import type { BarSpec, ChartSpec, Fmt, FunnelSpec, Ghost, HeatSpec, LineSpec } from "./live-spec";

echarts.use([LineChart, BarChart, FunnelChart, ScatterChart, EffectScatterChart, GridComponent, TooltipComponent, CanvasRenderer]);

type Opt = echarts.EChartsCoreOption;
interface Ctx { W: number; H: number; narrow: boolean; reduced: boolean; font: string; still?: boolean }

const NB = "\u00a0", NNB = "\u202f";
const INK = "#e9fff6", DIM = "#a3cbbb", GRID = "rgba(214,245,230,0.08)", BG = "#06201a";
const RU_M = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const day = (iso: string) => { const [, m, d] = iso.split("-"); return `${Number(d)}.${m}`; };
const dayLong = (iso: string) => { const [, m, d] = iso.split("-"); return `${WD[new Date(`${iso}T00:00:00Z`).getUTCDay()]}, ${Number(d)}${NB}${RU_M[Number(m) - 1]}`; };
const weekend = (iso: string) => [0, 6].includes(new Date(`${iso}T00:00:00Z`).getUTCDay());
const int = (v: number) => Math.round(v).toLocaleString("ru-RU");
const pct = (v: number) => `${Math.round(v * 100)}${NNB}%`;
const pctN = (v: number | null) => (v == null ? "—" : pct(v));
const fmtOf = (f: Fmt) => (f === "pct" ? pct : int);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** #rrggbb или rgb(r g b / a%) → rgba() с заданной прозрачностью (zrender не понимает CSS4-синтаксис). */
export function rgba(c: string, a?: number) {
  let r = 0, g = 0, b = 0, al = 1;
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  const fn = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[/,]\s*([\d.]+)(%?))?\s*\)$/i.exec(c);
  if (hex) { const n = parseInt(hex[1], 16); r = n >> 16; g = (n >> 8) & 255; b = n & 255; }
  else if (fn) { r = +fn[1]; g = +fn[2]; b = +fn[3]; if (fn[4]) al = fn[5] ? +fn[4] / 100 : +fn[4]; }
  else return c;
  return `rgba(${r},${g},${b},${a ?? al})`;
}
const vgrad = (top: string, bottom: string) => new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: top }, { offset: 1, color: bottom }]);
const hgrad = (l: string, r: string) => new echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: l }, { offset: 1, color: r }]);

function base(x: Ctx): Opt {
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: x.font, color: INK },
    animation: !x.reduced && !x.still, animationDuration: 1300, animationEasing: "cubicOut", animationDurationUpdate: 500,
    tooltip: {
      confine: true, triggerOn: "mousemove|click", enterable: false, transitionDuration: 0.18,
      backgroundColor: "rgba(5,26,21,0.9)", borderColor: "rgba(110,231,183,0.38)", borderWidth: 1, padding: [10, 12],
      textStyle: { color: INK, fontSize: 13, fontFamily: x.font },
      extraCssText: "border-radius:14px;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 14px 36px rgba(0,0,0,.5),0 0 24px rgba(52,211,153,.18);font-variant-numeric:tabular-nums;min-width:150px;",
    },
  };
}
const row = (color: string, name: string, value: string, dashed = false) =>
  `<div style="display:flex;align-items:center;gap:8px;margin-top:5px"><i style="width:10px;height:${dashed ? 2 : 10}px;border-radius:5px;background:${color};box-shadow:0 0 8px ${color}"></i><span style="flex:1;color:${DIM}">${esc(name)}</span><b style="font-weight:650">${value}</b></div>`;
const TONE = { up: "#6ee7b7", down: "#fcd34d", neutral: "#cfe9dc", flat: DIM, noise: DIM, na: DIM } as const;
const cmpRow = (color: string, name: string, cur: string, prev: string | null, dt: ReturnType<typeof deltaText>) =>
  row(color, name, cur) +
  `<div style="display:flex;gap:8px;margin:2px 0 0 18px;font-size:12px;color:${DIM}"><span style="flex:1">${prev == null ? "" : `было${NB}${prev}`}</span><b style="font-weight:650;color:${TONE[dt.tone]}">${esc(dt.text)}</b></div>`;
const subtitle = (s: string) => `<div style="font-size:11.5px;color:${DIM};margin-top:2px">${esc(s)}</div>`;
const ghostLine = (g: Ghost, color: string, name: string, x: Ctx, fill: boolean, step = false) => ({
  type: "line", name: `${name} · прошлый`, data: g.values, smooth: step ? false : 0.35, step: step ? "middle" : false, smoothMonotone: "x", connectNulls: false,
  // z: 4 — пунктир поверх заливок текущих рядов (иначе контраст в яркой заливке < 3:1), но тоньше и без свечения.
  showSymbol: false, silent: true, z: 4, tooltip: { show: false }, emphasis: { disabled: true },
  lineStyle: { width: 1.4, color: rgba(color, 0.72), type: [3, 4], cap: "round" },
  areaStyle: step || !fill ? undefined : { color: vgrad(rgba(color, 0.07), rgba(color, 0)), origin: "start" },
  animationDuration: x.still ? 0 : 1200, animationDelay: 200,
});
const title = (s: string) => `<div style="font-weight:650;letter-spacing:.01em">${esc(s)}</div>`;

function axes(x: Ctx, labels: string[], fmt: (v: number) => string, gap: boolean, right: number) {
  return {
    grid: { left: 4, right, top: 18, bottom: 4, outerBoundsMode: "same", outerBoundsContain: "axisLabel" },
    xAxis: {
      type: "category", data: labels, boundaryGap: gap,
      axisLine: { lineStyle: { color: "rgba(214,245,230,0.16)" } }, axisTick: { show: false },
      axisLabel: { color: DIM, fontSize: x.narrow ? 11.5 : 12, hideOverlap: true, interval: Math.max(0, Math.ceil(labels.length / (x.narrow ? 4 : 8)) - 1), formatter: (v: string) => (/^\d{4}-/.test(v) ? day(v) : v), margin: 10 },
      axisPointer: { type: gap ? "shadow" : "line", lineStyle: { color: "rgba(167,243,208,0.55)", width: 1 }, shadowStyle: { color: "rgba(110,231,183,0.08)" }, label: { show: false } },
    },
    yAxis: {
      type: "value", splitNumber: 3, min: 0,
      axisLabel: { color: DIM, fontSize: x.narrow ? 11.5 : 12, formatter: (v: number) => fmt(v) },
      splitLine: { lineStyle: { color: GRID, type: [3, 5] } }, axisLine: { show: false }, axisTick: { show: false },
    },
  };
}

function line(s: LineSpec, x: Ctx): Opt {
  const fmt = fmtOf(s.fmt);
  const solid = s.series.filter((l) => !l.dashed);
  const focus = solid.at(-1);
  const lastI = focus ? focus.values.findLastIndex((v) => v != null) : -1;
  return {
    ...base(x), ...axes(x, s.labels, fmt, false, focus ? (x.narrow ? 40 : 52) : 10),
    tooltip: {
      ...(base(x).tooltip as object), trigger: "axis",
      formatter: (ps: { dataIndex: number; seriesName: string; value: number | null; color: string; seriesType: string }[]) => {
        const i = ps[0]?.dataIndex ?? 0;
        const lab = s.labels[i], pl = s.prevLabels?.[i];
        return title(/^\d{4}-/.test(lab) ? (s.fmt === "pct" ? `неделя с ${day(lab)}` : dayLong(lab)) : lab) +
          (s.series.some((l) => l.prev) && pl ? subtitle(`прошлый период: ${dayLong(pl)}`) : "") +
          s.series.slice().reverse().map((l) => {
            if (l.values[i] == null) return "";
            if (!l.prev) return row(rgba(l.color), l.name, fmt(l.values[i]!), l.dashed);
            const pv = l.prev.values[i] ?? null;
            return cmpRow(rgba(l.color), l.name, fmt(l.values[i]!), pv == null ? null : fmt(pv), deltaText(l.values[i], pv, s.fmt, l.prev.sig?.[i]));
          }).join("");
      },
    },
    series: [
      ...s.series.flatMap((l) => (l.prev ? [ghostLine(l.prev, l.color, l.name, x, !!l.area)] : [])),
      ...s.series.map((l) => ({
        type: "line", name: l.name, data: l.values, smooth: 0.35, smoothMonotone: "x", connectNulls: false,
        showSymbol: false, symbol: "circle", symbolSize: 10, z: l.dashed ? 1 : 3,
        lineStyle: l.dashed ? { width: 1.6, color: rgba(l.color), type: [4, 4] } : { width: x.narrow ? 2.6 : 2.8, color: rgba(l.color), shadowBlur: 14, shadowColor: rgba(l.color, 0.6), cap: "round" },
        itemStyle: { color: rgba(l.color), borderColor: BG, borderWidth: 2, shadowBlur: 14, shadowColor: rgba(l.color, 0.9) },
        areaStyle: l.area && !l.dashed ? { color: vgrad(rgba(l.color, 0.34), rgba(l.color, 0)), origin: "start" } : undefined,
        emphasis: { disabled: false, scale: 1.5, focus: "none", lineStyle: { width: 3 } },
        endLabel: !l.dashed ? { show: true, formatter: (p: { value: number | null }) => (p.value == null ? "" : fmt(p.value)), color: rgba(l.color), fontWeight: 700, fontSize: 12.5, distance: 6 } : undefined,
        animationDuration: 1500, animationDelay: l.dashed ? 300 : 0,
      })),
      ...(focus && lastI >= 0 ? [{
        type: x.reduced ? "scatter" : "effectScatter", data: [[lastI, focus.values[lastI]]], symbolSize: 9, z: 5, silent: true, tooltip: { show: false },
        itemStyle: { color: rgba(focus.color), shadowBlur: 16, shadowColor: rgba(focus.color) },
        rippleEffect: { brushType: "stroke", scale: 3.2, period: 3.2, number: 2 }, animationDelay: 1300,
      }] : []),
    ],
  };
}

function bars(s: BarSpec, x: Ctx): Opt {
  const avg = s.values.map((_, i) => (i < 6 ? null : s.values.slice(i - 6, i + 1).reduce((a, b) => a + b, 0) / 7));
  const top = rgba(s.color), soft = rgba(s.color, 0.16);
  const r = x.narrow && s.values.length > 40 ? 2 : 5;
  return {
    ...base(x), ...axes(x, s.labels, int, true, 10),
    tooltip: {
      ...(base(x).tooltip as object), trigger: "axis",
      formatter: (ps: { dataIndex: number }[]) => {
        const i = ps[0]?.dataIndex ?? 0;
        const pv = s.prev?.values[i] ?? null, pl = s.prevLabels?.[i];
        return title(dayLong(s.labels[i])) + (s.prev && pl ? subtitle(`прошлый период: ${dayLong(pl)}`) : "") +
          (s.prev ? cmpRow(top, "вопросов", int(s.values[i]), pv == null ? null : int(pv), deltaText(s.values[i], pv, "int", s.prev.sig?.[i])) : row(top, "вопросов", int(s.values[i]))) +
          (avg[i] != null ? row("#d9fff4", "среднее за 7 дн.", int(avg[i]!)) : "");
      },
    },
    series: [
      // Призрачные столбики прошлого периода — ровно за текущими (barGap −100 %), пунктирный контур.
      ...(s.prev ? [{
        type: "bar", name: "прошлый", data: s.prev.values, barCategoryGap: "28%", barGap: "-100%", silent: true, z: 1, tooltip: { show: false },
        itemStyle: { color: "rgba(214,245,230,0.11)", borderColor: "rgba(214,245,230,0.62)", borderWidth: 1, borderType: [2, 2], borderRadius: [r, r, 1, 1] },
        emphasis: { disabled: true }, animationDuration: x.still ? 0 : 600,
      }] : []),
      {
        type: "bar", name: "вопросов", barCategoryGap: "28%", barGap: "-100%", z: 2,
        data: s.values.map((v, i) => ({ value: v, itemStyle: { opacity: weekend(s.labels[i]) ? 0.5 : 1 } })),
        itemStyle: { color: vgrad(top, soft), borderRadius: [r, r, 1, 1], shadowBlur: 10, shadowColor: rgba(s.color, 0.28) },
        emphasis: { itemStyle: { color: vgrad("#d9fff4", rgba(s.color, 0.4)), shadowBlur: 18, shadowColor: rgba(s.color, 0.8) } },
        animationDelay: (i: number) => i * (x.reduced ? 0 : 900 / s.values.length), animationDuration: 700,
      },
      { type: "line", name: "среднее", data: avg, smooth: 0.4, showSymbol: false, z: 5, lineStyle: { width: 2.4, color: "#d9fff4", shadowBlur: 12, shadowColor: "rgba(217,255,244,0.7)", cap: "round" }, animationDelay: 600, animationDuration: 1400 },
    ],
  };
}

function funnel(s: FunnelSpec, x: Ctx): Opt {
  const first = Math.max(1, s.stages[0]?.n ?? 1);
  const n = s.stages.length;
  return {
    ...base(x),
    tooltip: {
      ...(base(x).tooltip as object), trigger: "item",
      formatter: (p: { dataIndex: number }) => {
        const st = s.stages[p.dataIndex];
        return title(`${String(p.dataIndex + 1).padStart(2, "0")} · ${st.name}`) + row(st.worst ? "#fbbf24" : "#6ee7b7", "дошли", `${int(st.n)} · ${pctN(st.ofStart)}`) +
          (st.prev && p.dataIndex > 0 ? (() => { const dt = deltaText(st.ofStart, st.prev.ofStart, "pct", st.prev.sig); return `<div style="display:flex;gap:8px;margin:5px 0 0 18px;font-size:12px;color:${DIM}"><span style="flex:1">${st.prev.ofStart == null ? "прошлый период" : `было${NB}${pct(st.prev.ofStart)} в прошлом периоде`}</span><b style="font-weight:650;color:${TONE[dt.tone]}">${esc(dt.text)}</b></div>`; })() : "") +
          (p.dataIndex > 0 ? row("#fbbf24", "ушли на шаге", `${int(st.drop)}${st.dropRate != null ? ` · ${pct(st.dropRate)}` : ""}`) : "") +
          (st.unknown != null ? row("#b8a8ff", "«не знаю»", pct(st.unknown)) : "") +
          (st.worst ? `<div style="margin-top:7px;color:#fbbf24;font-weight:650">Главная потеря</div>` : "");
      },
    },
    series: [{
      type: "funnel", sort: "none", left: 0, top: 6, bottom: 6, width: x.narrow ? "52%" : "62%", funnelAlign: "left",
      min: 0, max: first, minSize: "8%", maxSize: "100%", gap: x.narrow ? 4 : 5,
      label: {
        show: true, position: "right", distance: 12, align: "left", lineHeight: 17,
        formatter: (p: { dataIndex: number }) => {
          const st = s.stages[p.dataIndex];
          const d = p.dataIndex === 0 ? "{m|100 %}" : `{${st.worst ? "w" : "m"}|${st.drop > 0 && st.dropRate != null ? (st.dropRate < 0.005 ? "−<1 %" : `−${pct(st.dropRate)}`) : "без потерь"}}`;
          return `{t|${st.name}}\n{v|${pctN(st.ofStart)}}{s| }{n|${int(st.n)}}${p.dataIndex === 0 ? "" : `{s|  }${d}`}`;
        },
        rich: {
          s: { fontSize: 11, width: 5 },
          // Тёмная обводка букв: подписи читаются и поверх яркого края воронки.
          t: { color: INK, textBorderColor: "rgba(2,16,13,0.85)", textBorderWidth: 3, fontSize: x.narrow ? 12.5 : 13, fontWeight: 600, fontFamily: x.font },
          v: { color: "#a7f3d0", textBorderColor: "rgba(2,16,13,0.85)", textBorderWidth: 3, fontSize: x.narrow ? 13.5 : 14.5, fontWeight: 750, fontFamily: x.font },
          n: { color: DIM, textBorderColor: "rgba(2,16,13,0.85)", textBorderWidth: 3, fontSize: 11.5, fontFamily: x.font },
          m: { color: DIM, textBorderColor: "rgba(2,16,13,0.85)", textBorderWidth: 3, fontSize: 11.5, fontFamily: x.font },
          w: { color: "#1a1204", backgroundColor: "#fbbf24", borderRadius: 6, padding: [2, 5], fontSize: 11.5, fontWeight: 700, fontFamily: x.font },
        },
      },
      labelLine: { show: true, length: 6, lineStyle: { color: "rgba(214,245,230,0.18)", width: 1 } },
      itemStyle: { borderWidth: 0 },
      emphasis: { label: { show: true }, itemStyle: { shadowBlur: 24, shadowColor: "rgba(110,231,183,0.7)" } },
      animationDuration: 1100, animationDelay: (i: number) => i * 70,
      data: s.stages.map((st, i) => {
        const t = i / Math.max(1, n - 1);
        const a = st.worst ? ["#f59e0b", "#fcd34d"] : [mix("#10b981", "#22d3ee", t), mix("#6ee7b7", "#a5f3fc", t)];
        return { name: st.name, value: st.n, itemStyle: { color: hgrad(a[0], a[1]), shadowBlur: st.worst ? 20 : 12, shadowColor: st.worst ? "rgba(251,191,36,0.55)" : "rgba(52,211,153,0.35)" } };
      }),
    }],
  };
}
function mix(a: string, b: string, t: number) {
  const pa = rgba(a).match(/\d+/g)!.map(Number), pb = rgba(b).match(/\d+/g)!.map(Number);
  return `rgb(${[0, 1, 2].map((k) => Math.round(pa[k] + (pb[k] - pa[k]) * t)).join(",")})`;
}

/** Та же шкала, что и у серверного heatColor: глубокий изумруд → светлая мята. */
function heat(rate: number, cap = 0.5) {
  const a = Math.max(0, Math.min(1, rate / cap));
  const c = a < 0.5 ? mix("#0d4639", "#1fb487", a / 0.5) : mix("#1fb487", "#c4fbe3", (a - 0.5) / 0.5);
  // Цвет текста — тот, что даёт больший контраст с заливкой (белый или почти чёрный).
  const L = lum(c);
  return { c, dark: (L + 0.05) / 0.0545 > 1.05 / (L + 0.05), a };
}

function lum(c: string) {
  const [r, g, b] = rgba(c).match(/\d+/g)!.slice(0, 3).map((v) => { const x = Number(v) / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function heatmap(s: HeatSpec, x: Ctx): Opt {
  const left = x.narrow ? 62 : 92, top = 44, right = 4, bottom = 4;
  const rows = s.weeks.length, cols = s.cols.length;
  const cw = (x.W - left - right) / cols, ch = (x.H - top - bottom) / Math.max(1, rows);
  const g = x.narrow ? 4 : 5;
  const data = s.cells.flatMap((r, ri) => r.map((c, ci) => {
    const h = c.rate == null ? null : heat(c.rate);
    return {
      value: [ci, ri, c.rate ?? 0], cell: c,
      symbolSize: [Math.max(8, cw - g), Math.max(8, ch - g)],
      itemStyle: h ? { color: vgrad(h.c, mix(h.c, "#0b3b30", 0.08)), shadowBlur: 6 + h.a * 14, shadowColor: rgba(h.c, 0.25 + h.a * 0.3) } : { color: "rgba(214,245,230,0.045)", borderColor: "rgba(214,245,230,0.10)", borderWidth: 1, borderType: [3, 3] },
      label: { color: h ? (h.dark ? "#00110c" : "#ffffff") : DIM, fontWeight: h ? 700 : 500, fontSize: x.narrow ? 12.5 : 13.5, formatter: () => (c.rate != null ? pct(c.rate) : c.matured === 0 ? "·" : "мало") },
    };
  }));
  return {
    ...base(x),
    grid: { left, right, top, bottom },
    xAxis: { type: "category", data: s.cols, position: "top", axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
      axisLabel: { interval: 0, color: INK, fontWeight: 700, fontSize: 13, margin: 8, formatter: (v: string, i: number) => `${v}\n{s|${["день 1", "дни 7–13", "дни 14–20", "дни 30–36"][i] ?? ""}}`, rich: { s: { color: DIM, fontSize: 10.5, fontWeight: 400, fontFamily: x.font, padding: [3, 0, 0, 0] } } } },
    yAxis: { type: "category", data: s.weeks, inverse: true, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
      axisLabel: { interval: 0, align: "left", margin: left - 2, color: INK, fontSize: 12.5, fontWeight: 600, lineHeight: 16,
        formatter: (v: string, i: number) => `${day(v)}\n{n|${s.sizes[i] == null ? `<${s.minCohort}` : int(s.sizes[i]!)} нов.}`, rich: { n: { color: DIM, fontSize: 11, fontWeight: 400, fontFamily: x.font } } } },
    tooltip: {
      ...(base(x).tooltip as object), trigger: "item",
      formatter: (p: { data: { value: number[]; cell: HeatSpec["cells"][number][number] } }) => {
        const [ci, ri] = p.data.value, c = p.data.cell;
        const head = title(`Неделя с ${day(s.weeks[ri])} · ${s.cols[ci]}`);
        if (c.rate == null) return head + `<div style="margin-top:5px;color:${DIM}">${c.matured === 0 ? "окно ещё не закончилось" : `созрело ${int(c.matured)} — меньше ${s.minCohort}, скрыто`}</div>`;
        return head + row(heat(c.rate).c, "вернулись", pct(c.rate)) + row("rgba(214,245,230,.4)", "из созревших", int(c.matured));
      },
    },
    series: [{
      type: "scatter", symbol: "roundRect", data, label: { show: true, position: "inside" },
      emphasis: { scale: 1.06, itemStyle: { shadowBlur: 22, shadowColor: "rgba(167,243,208,0.8)" } },
      animationDuration: 600, animationEasing: "backOut", animationDelay: (i: number) => (i % cols) * 90 + Math.floor(i / cols) * 40,
    }],
  };
}

function build(spec: ChartSpec, x: Ctx): Opt {
  switch (spec.kind) {
    case "line": return line(spec, x);
    case "bar": return bars(spec, x);
    case "funnel": return funnel(spec, x);
    case "heat": return heatmap(spec, x);
  }
}

/** Создаёт график в el; возвращает функцию очистки. onReady — после первой отрисовки (прячем SVG-фолбэк). */
export function mount(el: HTMLElement, spec: ChartSpec, onReady: () => void, onNav?: (href: string) => void): () => void {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  const chart = echarts.init(el, null, { renderer: "canvas", useCoarsePointer: window.matchMedia("(pointer: coarse)").matches, pointerSize: 44 });
  const cleanups: (() => void)[] = [() => chart.dispose()];
  const dispose = () => { while (cleanups.length) cleanups.pop()!(); };
  try {
    const font = getComputedStyle(el).fontFamily || "system-ui, sans-serif";
    const ctx = (still = false): Ctx => ({ W: el.clientWidth, H: el.clientHeight, narrow: el.clientWidth < 520, reduced: mq.matches, font, still });
    chart.setOption(build(spec, ctx()));
    const raf = requestAnimationFrame(onReady);
    // Нажатие на этап воронки открывает drill-down (?step=…); на «Начали» — нечего объяснять.
    if (spec.kind === "funnel" && onNav) chart.on("click", (p) => { const h = spec.stages[(p as { dataIndex: number }).dataIndex]?.href; if (h) { chart.dispatchAction({ type: "hideTip" }); onNav(h); } });
    cleanups.push(() => cancelAnimationFrame(raf));
    let w = el.clientWidth, h = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w && el.clientHeight === h) return;
      w = el.clientWidth; h = el.clientHeight;
      chart.resize();
      chart.setOption(build(spec, ctx(true)), { notMerge: true, lazyUpdate: true });
    });
    ro.observe(el);
    cleanups.push(() => ro.disconnect());
    const motion = () => chart.setOption(build(spec, ctx(true)), { notMerge: true });
    mq.addEventListener("change", motion);
    cleanups.push(() => mq.removeEventListener("change", motion));
    // Подсказка закрывается касанием вне графика и клавишей Escape.
    const hide = () => chart.dispatchAction({ type: "hideTip" });
    const away = (e: PointerEvent) => { if (!el.contains(e.target as Node)) hide(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    document.addEventListener("pointerdown", away, { passive: true });
    document.addEventListener("keydown", esc);
    cleanups.push(() => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); });
  } catch (e) {
    dispose();
    throw e;
  }
  return dispose;
}
