// 홈 위젯의 chart 블록 계산 (순수 함수 — node로 직접 테스트 가능).
// 정의의 series(points 또는 x·y)를 한 줄의 가로 눈금(xs)에 맞춘 값 목록으로 바꾸고, 기간 자르기·세로 눈금·가로 눈금 표시를 계산한다.
import { CHART_COLORS, MAX_POINTS, resolveValue, type ChartColor } from "./home-widget-core.ts";

export type ChartAxis = "left" | "right";
export interface ChartSeries {
  label: string;
  color: ChartColor;
  axis: ChartAxis;
  kind: "line" | "bar";
  unit: string;
  digits: number;
  /** xs와 같은 길이, 값이 없는 칸은 null (gap이 interpolate면 앞뒤 값 사이의 빈 칸은 계산해 채운 값) */
  values: (number | null)[];
  /** 계산해 채운 칸이면 true (실측이 아님을 표시하는 데 쓴다) */
  filled: boolean[];
}
export interface ChartData {
  /** 가로 눈금 값 — 날짜면 'YYYY-MM-DD' 오름차순 */
  xs: string[];
  dated: boolean;
  series: ChartSeries[];
}

const DATE = /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 숫자로 읽히는 값(CSV의 글 "324.8" 포함)만 숫자로, 나머지(빈 글·"."·글자)는 null */
export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 계열 하나의 (x 글, y 값) 쌍. x가 없는 칸은 null */
function readPairs(spec: Record<string, unknown>, data: unknown): { x: string | null; y: number | null }[] {
  if (spec.points !== undefined) {
    const p = resolveValue(spec.points, data);
    if (!Array.isArray(p)) return [];
    return p.slice(0, MAX_POINTS).map((item) => (isObject(item) ? { x: item.x === undefined || item.x === null ? null : String(item.x), y: toNumber(item.y) } : { x: null, y: toNumber(item) }));
  }
  const ys = resolveValue(spec.y, data);
  if (!Array.isArray(ys)) return [];
  const xsRaw = spec.x === undefined ? undefined : resolveValue(spec.x, data);
  const xs = Array.isArray(xsRaw) ? xsRaw : null;
  return ys.slice(0, MAX_POINTS).map((y, i) => ({ x: xs && xs[i] !== undefined && xs[i] !== null && xs[i] !== "" ? String(xs[i]) : null, y: toNumber(y) }));
}

/** 'YYYY-MM' → 'YYYY-MM-01'로 맞춘다 (날짜 글이 아니면 그대로) */
const fullDate = (x: string) => (/^\d{4}-\d{2}$/.test(x) ? `${x}-01` : x);

/**
 * 앞뒤에 실제 값이 있는 빈 칸(null)을 두 값 사이 직선으로 채운다. 맨 앞·맨 뒤의 빈 칸은 채우지 않는다.
 * positions는 칸마다의 가로 위치(날짜면 시각, 아니면 번호)라서 달 간격이 고르지 않아도 거리에 비례해 채운다.
 */
export function fillGaps(values: (number | null)[], positions: number[]): { values: (number | null)[]; filled: boolean[] } {
  const out = [...values];
  const filled = values.map(() => false);
  let prev = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === null) continue;
    if (prev >= 0 && i - prev > 1) {
      const a = values[prev] as number;
      const b = values[i] as number;
      for (let k = prev + 1; k < i; k++) {
        const span = positions[i] - positions[prev];
        out[k] = span > 0 ? a + ((b - a) * (positions[k] - positions[prev])) / span : a;
        filled[k] = true;
      }
    }
    prev = i;
  }
  return { values: out, filled };
}

/** 블록 정의와 받은 자료로 그래프에 그릴 값을 만든다. 날짜 x는 같은 날짜끼리 합쳐 오름차순으로, 아니면 처음 나온 순서대로 */
export function buildChart(block: Record<string, unknown>, data: unknown): ChartData {
  const specs = (Array.isArray(block.series) ? block.series : []).filter(isObject);
  const pairs = specs.map((s) => readPairs(s, data));
  // 한 계열이라도 날짜가 아닌 x가 있으면 날짜축이 아니다 (x가 없는 칸은 번호로 채운다)
  const dated = pairs.some((list) => list.some((p) => p.x !== null)) && pairs.every((list) => list.every((p) => p.x === null || DATE.test(p.x)));
  const keyOf = (x: string | null, i: number) => (x === null ? String(i + 1) : dated ? fullDate(x) : x);
  const maps = pairs.map((list) => {
    const m = new Map<string, number | null>();
    list.forEach((p, i) => m.set(keyOf(p.x, i), p.y));
    return m;
  });
  const seen = new Set<string>();
  for (const m of maps) for (const k of m.keys()) seen.add(k);
  let xs = [...seen];
  if (dated) xs.sort();
  else if (xs.every((k) => /^\d+$/.test(k))) xs.sort((a, b) => Number(a) - Number(b));
  xs = xs.slice(-MAX_POINTS);
  // 날짜는 달 단위 위치(일은 달의 몇 분의 몇)로 — 월별 자료는 달 간격이 같게 채워진다
  const positions = xs.map((x, i) => (dated ? Number(x.slice(0, 4)) * 12 + Number(x.slice(5, 7)) + (Number(x.slice(8, 10)) - 1) / 31 : i));
  const series: ChartSeries[] = specs.map((s, i) => {
    const kind = s.kind === "bar" ? "bar" : "line";
    const raw = xs.map((x) => maps[i].get(x) ?? null);
    // interpolate는 선에만 적용한다 (막대는 없는 값을 지어내지 않는다)
    const { values, filled } = block.gap === "interpolate" && kind === "line" ? fillGaps(raw, positions) : { values: raw, filled: raw.map(() => false) };
    return {
      label: String(s.label ?? ""),
      color: CHART_COLORS.includes(s.color as ChartColor) ? (s.color as ChartColor) : CHART_COLORS[i % CHART_COLORS.length],
      axis: s.axis === "right" ? "right" : "left",
      kind,
      unit: typeof s.unit === "string" ? s.unit : "",
      digits: Number.isInteger(s.digits) ? (s.digits as number) : 1,
      values,
      filled,
    };
  });
  return { xs, dated, series };
}

/** 가장 늦은 날짜부터 거꾸로 months개월만 남긴다 (null이면 전체). 날짜축이 아니면 그대로 */
export function cutMonths(chart: ChartData, months: number | null): ChartData {
  if (months === null || !chart.dated || chart.xs.length === 0) return chart;
  const monthIndex = (x: string) => Number(x.slice(0, 4)) * 12 + Number(x.slice(5, 7)) - 1;
  const last = monthIndex(chart.xs[chart.xs.length - 1]);
  const keep = chart.xs.map((x) => last - monthIndex(x) < months);
  return { ...chart, xs: chart.xs.filter((_, i) => keep[i]), series: chart.series.map((s) => ({ ...s, values: s.values.filter((_, i) => keep[i]), filled: s.filled.filter((_, i) => keep[i]) })) };
}

/** 기간 버튼 이름: 12의 배수는 "N년", 아니면 "N개월" */
export function rangeLabel(months: number): string {
  return months % 12 === 0 ? `${months / 12}년` : `${months}개월`;
}

export interface AxisTicks {
  min: number;
  max: number;
  ticks: number[];
}

/**
 * 세로 눈금: 1·2·5×10ⁿ 단위로 칸이 6개 이하가 되는 가장 작은 단위. 막대가 있거나 값이 0 근처에서 시작하면 0을 포함한다
 * (물가지수처럼 300대 값이 0부터 그려져 납작해지지 않게 하려는 것).
 */
export function axisTicks(dataMin: number, dataMax: number, includeZero: boolean): AxisTicks {
  let lo = dataMin;
  let hi = dataMax;
  if (includeZero || (lo >= 0 && lo < 0.35 * hi) || (hi <= 0 && hi > 0.35 * lo)) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  if (!(hi > lo)) {
    const pad = Math.abs(hi) * 0.1 || 1;
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const mult of [1, 2, 5, 10]) {
    const step = mult * pow;
    const min = Math.floor(lo / step + 1e-9) * step;
    const max = Math.max(Math.ceil(hi / step - 1e-9) * step, min + step);
    const count = Math.round((max - min) / step);
    if (count <= 6) {
      const round = (v: number) => Math.round(v / (step / 1000)) * (step / 1000);
      return { min: round(min), max: round(max), ticks: Array.from({ length: count + 1 }, (_, i) => round(min + i * step)) };
    }
  }
  return { min: lo, max: hi, ticks: [lo, hi] };
}

/** 가로 눈금: 날짜축이 24개월 이상이면 해마다 1월(좁으면 건너뜀), 아니면 고르게 나눈 몇 곳. [위치 번호, 글] 목록 */
export function xTicks(chart: ChartData, pixelsPerPoint: number): { i: number; text: string }[] {
  const { xs, dated } = chart;
  if (xs.length === 0) return [];
  if (dated && xs.length >= 2 && (Number(xs[xs.length - 1].slice(0, 4)) * 12 + Number(xs[xs.length - 1].slice(5, 7))) - (Number(xs[0].slice(0, 4)) * 12 + Number(xs[0].slice(5, 7))) >= 24) {
    const years = xs.flatMap((x, i) => (x.slice(5, 7) === "01" ? [{ i, text: x.slice(0, 4) }] : []));
    const skip = Math.max(1, Math.ceil(46 / Math.max(1, pixelsPerPoint * 12)));
    return years.filter((_, n) => n % skip === 0);
  }
  const count = Math.min(xs.length, 5);
  const label = (x: string) => (dated ? x.slice(0, 7) : x);
  return Array.from({ length: count }, (_, k) => {
    const i = count === 1 ? 0 : Math.round((k / (count - 1)) * (xs.length - 1));
    return { i, text: label(xs[i]) };
  });
}

/** 값 하나를 "3.1%" 같은 글로 (단위 붙임, 자릿수 고정) */
export function formatChartValue(value: number | null, series: Pick<ChartSeries, "digits" | "unit">): string {
  if (value === null) return "자료 없음";
  const fixed = value.toFixed(series.digits);
  return `${Number(fixed) === 0 ? (0).toFixed(series.digits) : fixed}${series.unit}`;
}

/** 마우스 위치에 보여 줄 글: 날짜는 "2026년 9월", 아니면 x 글 그대로 */
export function xLabel(x: string, dated: boolean): string {
  if (!dated) return x;
  const day = x.length > 7 && x.slice(8, 10) !== "01" ? ` ${Number(x.slice(8, 10))}일` : "";
  return `${x.slice(0, 4)}년 ${Number(x.slice(5, 7))}월${day}`;
}
