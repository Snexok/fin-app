// Сериализуемые описания интерактивных графиков: сервер готовит данные, клиент строит ECharts-опции.
export type Fmt = "int" | "pct";
/** Прошлый период, выровненный по смещению дня: prev[i] — тот же номер дня от начала прошлого периода.
 *  sig[i]: true — разница вне шума, false — в пределах шума, "few" — мало данных для оценки,
 *  null/нет массива — оценка шума неприменима (WAU: окна перекрываются; вопросы: серии одного человека зависимы). */
export type Sig = boolean | "few" | null;
export interface Ghost { values: (number | null)[]; sig?: Sig[] }
export interface LineSeries { name: string; color: string; values: (number | null)[]; area?: boolean; dashed?: boolean; prev?: Ghost }
export interface LineSpec { kind: "line"; label: string; labels: string[]; prevLabels?: string[]; fmt: Fmt; series: LineSeries[] }
export interface BarSpec { kind: "bar"; label: string; labels: string[]; prevLabels?: string[]; values: number[]; prev?: Ghost; color: string }
export interface FunnelStageSpec { name: string; n: number; ofStart: number | null; drop: number; dropRate: number | null; worst: boolean; unknown: number | null; href?: string; prev?: { ofStart: number | null; n: number; sig: Sig } }
export interface FunnelSpec { kind: "funnel"; label: string; stages: FunnelStageSpec[] }
export interface HeatSpec { kind: "heat"; label: string; weeks: string[]; sizes: (number | null)[]; cols: string[]; cells: { rate: number | null; matured: number }[][]; minCohort: number }
export type ChartSpec = LineSpec | BarSpec | FunnelSpec | HeatSpec;
