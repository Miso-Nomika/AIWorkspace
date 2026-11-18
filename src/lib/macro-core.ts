// 개인 홈 — 미국 소비자물가·기준금리 계산 (순수 함수, 외부 의존 없음 — node로 직접 테스트 가능)
// 받아 온 글(BLS 물가 JSON·뉴욕 연준 실효금리 JSON)을 월 단위 값으로 바꾸고, 전년비·합치기·기간 자르기·눈금·좌표를 계산한다.

/** ["YYYY-MM", 값] — 오래된 것부터 */
export type MonthSeries = [string, number][];

/** 그래프 한 점: 한쪽 값이 없는 달은 null (선이 끊긴다) */
export interface ChartRow {
  month: string;
  inflation: number | null;
  rate: number | null;
}

export type MacroRange = "5y" | "10y" | "all";
export const MACRO_RANGES: { id: MacroRange; label: string; months: number | null }[] = [
  { id: "5y", label: "5년", months: 60 },
  { id: "10y", label: "10년", months: 120 },
  { id: "all", label: "전체", months: null },
];

/** 홈을 열 때 이 시간보다 오래된 자료면 다시 받는다 (월 1회 발표되는 자료라 하루에 한 번이면 충분하다) */
export const MACRO_MAX_AGE_MS = 24 * 3600 * 1000;

/** 응답 형식이 낯설 때 (형식이 바뀐 것을 화면에 드러내려고 빈 결과가 아니라 오류로 알린다) */
export class MacroFormatError extends Error {}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new MacroFormatError(`${what} 응답을 읽을 수 없습니다.`);
  }
}

/**
 * BLS 물가 JSON(10년짜리 창 여러 개)을 월별 지수로. M01~M12만 쓰고 연평균(M13)·결측(값이 "-")은 건너뛴다.
 * 같은 달이 여러 창에 있으면 나중 창의 값을 쓴다. 결과는 오래된 순.
 */
export function parseBls(texts: string[]): MonthSeries {
  const byMonth = new Map<string, number>();
  for (const text of texts) {
    const json = parseJson(text, "물가 자료") as { status?: unknown; Results?: { series?: { data?: unknown }[] } };
    const data = json?.Results?.series?.[0]?.data;
    if (json?.status !== "REQUEST_SUCCEEDED" || !Array.isArray(data)) throw new MacroFormatError("물가 자료의 형식이 예상과 다릅니다.");
    for (const item of data as { year?: string; period?: string; value?: string }[]) {
      const m = /^M(0[1-9]|1[0-2])$/.exec(item?.period ?? "");
      const value = Number(item?.value);
      if (!m || !/^\d{4}$/.test(item?.year ?? "") || item?.value === "-" || !Number.isFinite(value)) continue;
      byMonth.set(`${item.year}-${m[1]}`, value);
    }
  }
  return [...byMonth.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

/** 뉴욕 연준 실효금리 JSON(일별)을 [날짜, 금리] 목록으로 (오래된 순) */
export function parseEffr(text: string): [string, number][] {
  const json = parseJson(text, "금리 자료") as { refRates?: { effectiveDate?: string; percentRate?: number }[] };
  if (!Array.isArray(json?.refRates)) throw new MacroFormatError("금리 자료의 형식이 예상과 다릅니다.");
  const days: [string, number][] = [];
  for (const r of json.refRates) {
    if (typeof r?.effectiveDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.effectiveDate) && typeof r.percentRate === "number" && Number.isFinite(r.percentRate)) {
      days.push([r.effectiveDate, r.percentRate]);
    }
  }
  return days.sort(([a], [b]) => (a < b ? -1 : 1));
}

/** 일별 금리를 월 평균(소수 2자리)으로. 이번 달은 지금까지의 평균 */
export function monthlyAverage(days: [string, number][]): MonthSeries {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const [date, value] of days) {
    const key = date.slice(0, 7);
    const s = sums.get(key) ?? { sum: 0, n: 0 };
    s.sum += value;
    s.n += 1;
    sums.set(key, s);
  }
  return [...sums.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, s]) => [key, Math.round((s.sum / s.n) * 100) / 100]);
}

function previousYear(month: string): string {
  return `${Number(month.slice(0, 4)) - 1}${month.slice(4)}`;
}

/** 물가 지수 → 전년 같은 달 대비 상승률(%, 소수 1자리). 12개월 전 값이 없으면 그 달은 뺀다 */
export function yearOverYear(cpi: MonthSeries): MonthSeries {
  const index = new Map(cpi);
  const out: MonthSeries = [];
  for (const [month, value] of cpi) {
    const before = index.get(previousYear(month));
    if (before === undefined || before === 0) continue;
    out.push([month, Math.round((value / before - 1) * 1000) / 10]);
  }
  return out;
}

/** 두 계열을 월 기준으로 합친다 (어느 한쪽이라도 값이 있는 달), 오래된 순 */
export function mergeMonthly(inflation: MonthSeries, rate: MonthSeries): ChartRow[] {
  const a = new Map(inflation);
  const b = new Map(rate);
  return [...new Set([...a.keys(), ...b.keys()])].sort().map((month) => ({ month, inflation: a.get(month) ?? null, rate: b.get(month) ?? null }));
}

/** 가장 늦은 달부터 거꾸로 months개월만 남긴다 (null이면 전체). 빈 달이 있어도 달력 기준으로 자른다 */
export function cutRange(rows: ChartRow[], months: number | null): ChartRow[] {
  if (months === null || rows.length === 0) return rows;
  const last = rows[rows.length - 1].month;
  const total = Number(last.slice(0, 4)) * 12 + Number(last.slice(5)) - 1;
  return rows.filter((r) => total - (Number(r.month.slice(0, 4)) * 12 + Number(r.month.slice(5)) - 1) < months);
}

/** 한쪽 계열에서 값이 있는 가장 늦은 달 (없으면 null) */
export function latestMonth(series: MonthSeries): string | null {
  return series.length ? series[series.length - 1][0] : null;
}

/** "2026-09" → "2026년 9월" */
export function monthLabel(month: string): string {
  if (!MONTH.test(month)) return month;
  return `${month.slice(0, 4)}년 ${Number(month.slice(5))}월`;
}

/** 소수 1자리 퍼센트 ("3.0%", 음수는 "-0.4%") — 로캘 함수를 쓰지 않는다 */
export function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${(Object.is(rounded, -0) ? 0 : rounded).toFixed(1)}%`;
}

/** 지금 자료가 오래돼서 다시 받아야 하는지 (한 번도 받은 적이 없으면 true) */
export function needsRefresh(fetchedAt: string | null | undefined, nowMs: number, maxAgeMs: number = MACRO_MAX_AGE_MS): boolean {
  const at = fetchedAt ? Date.parse(fetchedAt) : Number.NaN;
  return !Number.isFinite(at) || nowMs - at >= maxAgeMs || at > nowMs + 60_000;
}

export interface Ticks {
  min: number;
  max: number;
  ticks: number[];
}

/** 세로축 눈금: 0을 포함하고, 0.5·1·2·5·10·20 단위 중 칸이 6개 이하가 되는 가장 작은 단위 */
export function niceTicks(dataMin: number, dataMax: number): Ticks {
  const lowest = Math.min(0, dataMin);
  const highest = Math.max(0, dataMax);
  for (const step of [0.5, 1, 2, 5, 10, 20, 50]) {
    const min = Math.floor(lowest / step) * step;
    const max = Math.max(Math.ceil(highest / step) * step, min + step);
    const count = Math.round((max - min) / step);
    if (count <= 6) return { min, max, ticks: Array.from({ length: count + 1 }, (_, i) => Math.round((min + i * step) * 10) / 10) };
  }
  return { min: lowest, max: highest || 1, ticks: [lowest, highest || 1] };
}

/** 값 → 세로 좌표 (위가 큰 값). top~bottom 픽셀 사이 */
export function yPosition(value: number, min: number, max: number, top: number, bottom: number): number {
  return max === min ? bottom : bottom - ((value - min) / (max - min)) * (bottom - top);
}

/** 달 번호(0~count-1) → 가로 좌표. 점이 하나뿐이면 가운데 */
export function xPosition(index: number, count: number, left: number, right: number): number {
  return count <= 1 ? (left + right) / 2 : left + (index / (count - 1)) * (right - left);
}

/** 마우스 가로 좌표에서 가장 가까운 달 번호 */
export function nearestIndex(x: number, count: number, left: number, right: number): number {
  if (count <= 1 || right <= left) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(((x - left) / (right - left)) * (count - 1))));
}

/** 값이 있는 구간마다 끊어 SVG 경로("M x y L x y …")를 만든다 — null인 달에서 선이 끊긴다 */
export function linePath(points: ({ x: number; y: number } | null)[]): string {
  let d = "";
  let pen = false;
  for (const p of points) {
    if (!p) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${Math.round(p.x * 10) / 10} ${Math.round(p.y * 10) / 10}`;
    pen = true;
  }
  return d;
}

/** 이 PC에 저장해 두는 마지막 자료 (해석한 월 단위 값만 — 작게 유지) */
export interface MacroCache {
  /** 물가·금리를 마지막으로 성공해서 받은 시각 (ISO). 한 번도 없으면 null */
  cpiAt: string | null;
  rateAt: string | null;
  cpi: MonthSeries;
  rate: MonthSeries;
  /** 마지막 갱신 시도의 오류 문장 (성공하면 null) */
  error: string | null;
}

export const EMPTY_MACRO: MacroCache = { cpiAt: null, rateAt: null, cpi: [], rate: [], error: null };

function readSeries(raw: unknown): MonthSeries {
  if (!Array.isArray(raw)) return [];
  const out: MonthSeries = [];
  for (const item of raw) {
    if (Array.isArray(item) && typeof item[0] === "string" && MONTH.test(item[0]) && typeof item[1] === "number" && Number.isFinite(item[1])) out.push([item[0], item[1]]);
  }
  return out.sort(([a], [b]) => (a < b ? -1 : 1));
}

/** 저장된 값을 읽는다 — 손상·낯선 형식은 빈 값으로 (그러면 홈을 열 때 새로 받는다) */
export function normalizeMacroCache(raw: unknown): MacroCache {
  if (!raw || typeof raw !== "object") return EMPTY_MACRO;
  const o = raw as Record<string, unknown>;
  const stamp = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);
  return {
    cpiAt: stamp(o.cpiAt),
    rateAt: stamp(o.rateAt),
    cpi: readSeries(o.cpi),
    rate: readSeries(o.rate),
    error: typeof o.error === "string" && o.error ? o.error.slice(0, 300) : null,
  };
}

/** 두 자료 중 하나라도 오래됐거나 없으면 다시 받아야 한다 */
export function cacheNeedsRefresh(cache: MacroCache, nowMs: number): boolean {
  return needsRefresh(cache.cpiAt, nowMs) || needsRefresh(cache.rateAt, nowMs) || cache.cpi.length === 0 || cache.rate.length === 0;
}

/** 화면에 보여 줄 "마지막 갱신" 시각: 두 자료 중 더 오래된 쪽 (둘 다 있어야 의미가 있다) */
export function lastRefreshed(cache: MacroCache): string | null {
  if (!cache.cpiAt || !cache.rateAt) return cache.cpiAt ?? cache.rateAt;
  return cache.cpiAt < cache.rateAt ? cache.cpiAt : cache.rateAt;
}

/** 저장된 기간 설정을 읽는다 (낯선 값은 10년) */
export function pickRange(value: unknown): MacroRange {
  return MACRO_RANGES.find((r) => r.id === value)?.id ?? "10y";
}

/** 갱신 시각(ISO) → "11월 13일 15:04" (이 PC 시간대, 로캘 함수 없이) */
export function formatRefreshed(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${two(d.getHours())}:${two(d.getMinutes())}`;
}
