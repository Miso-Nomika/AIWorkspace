// 홈 위젯 정의·저장 형식·검증 (순수 함수, 외부 의존 없음 — node로 직접 테스트 가능).
// 위젯은 코드가 아니라 선언형 JSON 정의(앱이 제공하는 블록의 조합)이고, 임의 코드·HTML은 받지 않는다.
// 새 블록 종류: 이 파일의 BLOCK_SPECS에 항목 하나 + src/components/home/blocks/registry.ts에 Component 한 줄.

export const HOME_MAX_ITEMS = 30;
export const WIDGET_SCHEMA = 2;
export const MAX_BLOCKS = 50;
export const MAX_TEXT = 2000;
export const MAX_ROWS = 200;
export const MAX_POINTS = 1000;
export const SIZES = [1, 2, 3] as const;
export type Size = (typeof SIZES)[number];

export type Block = { type: string; [key: string]: unknown };
export interface WidgetDef {
  schema: number;
  title: string;
  sources?: SourceDef[];
  blocks: Block[];
}
export const SOURCE_FORMATS = ["json", "csv", "text", "xml"] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];
/** 외부 자료 한 줄: 키가 필요 없는 공개 주소(https, GET)를 받아 transform으로 다듬는다. 블록에서는 {{id.경로}}로 쓴다 */
export interface SourceDef {
  id: string;
  url: string;
  query?: Record<string, string | number>;
  format?: SourceFormat;
  /** 다시 받는 간격(분, 15 이상, 기본 30) */
  refreshMin?: number;
  transform?: unknown[];
}
export const DEFAULT_REFRESH_MIN = 30;
/** def는 파일에 적힌 그대로 두고 그릴 때 검증한다 — 깨진 정의가 그 칸만 오류 카드가 되게 하려는 것 */
export interface HomeItem {
  id: string;
  size: Size;
  hidden: boolean;
  def?: unknown;
  /** 마지막으로 바꾼 시각 (ISO) — 여러 PC의 홈을 합칠 때 위젯마다 최신을 고르는 기준 (src/lib/home-merge.ts). 없던 옛 파일은 비어 있다 */
  updatedAt?: string;
}
/** 지운 위젯의 기록 — 다른 PC에서 되살아나지 않게 한다 (30일 뒤 정리) */
export interface HomeTombstone {
  id: string;
  deletedAt: string;
}
export interface HomeFile {
  version: 1;
  items: HomeItem[];
  /** 지운 위젯 기록 (동기화용, items에는 지운 위젯이 없다) */
  deleted?: HomeTombstone[];
  /** 위젯 순서(items 배열 순서)를 마지막으로 바꾼 시각 (ISO) */
  orderAt?: string;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_TOMBSTONES = 200;
/** ISO 날짜 글인지 (잘못된 값은 버린다) */
const isStamp = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));

/** 파일이 없을 때(또는 초기화) 쓰는 홈 — 위젯이 하나도 없는 깨끗한 홈 */
export function defaultHome(): HomeFile {
  return { version: 1, items: [] };
}

/** 예전에 앱에 들어 있던 시계·물가 위젯을 사용자 위젯 정의로 옮긴 것 (예전 home.json의 내장 항목을 읽을 때 쓴다) */
export const CLOCK_DEF = { schema: WIDGET_SCHEMA, title: "현재 시각", blocks: [{ type: "clock" }] };
export const MACRO_DEF = { schema: WIDGET_SCHEMA, title: "미국 소비자물가와 기준금리", blocks: [{ type: "macro" }] };
const LEGACY_BUILTIN: Record<string, { def: unknown; size: Size }> = {
  clock: { def: CLOCK_DEF, size: 2 },
  macro: { def: MACRO_DEF, size: 3 },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 저장된 값을 홈 파일로 바로잡는다. 모양이 아예 틀리면 null(호출한 쪽이 원본을 따로 보관하고 기본값을 쓴다). 예전의 내장 시계·물가 항목은 사용자 위젯으로 바꾼다 */
export function migrateHome(raw: unknown): HomeFile | null {
  if (!isObject(raw) || !Array.isArray(raw.items)) return null;
  const seen = new Set<string>();
  const items: HomeItem[] = [];
  for (const entry of raw.items) {
    if (!isObject(entry) || items.length >= HOME_MAX_ITEMS) continue;
    const legacy = entry.kind === "builtin" && typeof entry.builtin === "string" && Object.prototype.hasOwnProperty.call(LEGACY_BUILTIN, entry.builtin) ? LEGACY_BUILTIN[entry.builtin] : null;
    if (entry.kind === "builtin" && !legacy) continue; // 모르는 내장 항목은 버린다
    let id = typeof entry.id === "string" && ID_PATTERN.test(entry.id) ? entry.id : "";
    if (!id || seen.has(id)) id = `w${items.length + 1}-${seen.size + 1}`;
    while (seen.has(id)) id += "x";
    seen.add(id);
    const size = SIZES.find((s) => s === entry.size) ?? legacy?.size ?? 1;
    items.push({ id, size, hidden: entry.hidden === true, def: legacy ? legacy.def : entry.def, ...(isStamp(entry.updatedAt) ? { updatedAt: entry.updatedAt } : {}) });
  }
  const home: HomeFile = { version: 1, items };
  if (Array.isArray(raw.deleted)) {
    const deleted = raw.deleted
      .filter((d): d is { id: string; deletedAt: string } => isObject(d) && typeof d.id === "string" && ID_PATTERN.test(d.id) && isStamp(d.deletedAt))
      .slice(0, MAX_TOMBSTONES)
      .map((d) => ({ id: d.id, deletedAt: d.deletedAt }));
    if (deleted.length) home.deleted = deleted;
  }
  if (isStamp(raw.orderAt)) home.orderAt = raw.orderAt;
  return home;
}

// ── 배치 바꾸기 (편집 모드) — 모두 새 홈을 돌려주고 원본은 건드리지 않는다. 없는 id면 그대로 돌려준다 ──

/** id 위젯을 목록의 to번째 자리로 옮긴다 (to는 옮긴 뒤의 번호, 범위를 벗어나면 맨 앞·맨 뒤) */
export function moveItem(home: HomeFile, id: string, to: number): HomeFile {
  const from = home.items.findIndex((i) => i.id === id);
  if (from < 0) return home;
  const target = Math.max(0, Math.min(home.items.length - 1, Math.trunc(to)));
  if (target === from) return home;
  const items = [...home.items];
  const [moved] = items.splice(from, 1);
  items.splice(target, 0, moved);
  return { ...home, items };
}

/** 보이는 위젯 사이에서 앞(-1)·뒤(+1)로 한 칸 옮긴다. 숨긴 위젯은 건너뛴다 (숨긴 것끼리의 순서는 그대로) */
export function shiftItem(home: HomeFile, id: string, delta: -1 | 1): HomeFile {
  const from = home.items.findIndex((i) => i.id === id);
  if (from < 0) return home;
  for (let i = from + delta; i >= 0 && i < home.items.length; i += delta) {
    if (!home.items[i].hidden) return moveItem(home, id, i);
  }
  return home;
}

export function setItemSize(home: HomeFile, id: string, size: Size): HomeFile {
  if (!SIZES.includes(size)) return home;
  return { ...home, items: home.items.map((i) => (i.id === id && i.size !== size ? { ...i, size } : i)) };
}

export function setItemHidden(home: HomeFile, id: string, hidden: boolean): HomeFile {
  return { ...home, items: home.items.map((i) => (i.id === id && i.hidden !== hidden ? { ...i, hidden } : i)) };
}

// ── 값 경로 ──

type Seg = string | number | "*";
function parsePath(path: string): Seg[] | null {
  const p = path.startsWith("$") ? path.slice(1) : path;
  const segs: Seg[] = [];
  const re = /\.?([A-Za-z_][\w-]*)|\[(\d+|\*)\]/gy;
  let pos = 0;
  while (pos < p.length) {
    re.lastIndex = pos;
    const m = re.exec(p);
    if (!m) return null;
    segs.push(m[1] !== undefined ? m[1] : m[2] === "*" ? "*" : Number(m[2]));
    pos = re.lastIndex;
  }
  return segs;
}

/** 점·인덱스·[*]만 허용하는 미니 경로로 값을 꺼낸다 ("a.b[0].c", "$.rows[*].price"). 없으면 undefined */
export function getPath(root: unknown, path: string): unknown {
  const segs = parsePath(path.trim());
  if (!segs) return undefined;
  const walk = (value: unknown, i: number): unknown => {
    if (i === segs.length) return value;
    const s = segs[i];
    if (s === "*") return Array.isArray(value) ? value.map((v) => walk(v, i + 1)) : undefined;
    if (typeof s === "number") return Array.isArray(value) ? walk(value[s], i + 1) : undefined;
    if (!isObject(value) || !Object.prototype.hasOwnProperty.call(value, s)) return undefined;
    return walk(value[s], i + 1);
  };
  return walk(root, 0);
}

const WHOLE_REF = /^\{\{\s*([^{}]+?)\s*\}\}$/;

/** 값 자리 해석: "{{경로}}" 한 개뿐이면 원래 값 그대로, 글 안의 {{경로}}는 글자로만 끼워 넣는다 (HTML로 해석하지 않음) */
export function resolveValue(value: unknown, data: unknown): unknown {
  if (typeof value !== "string") return value;
  const whole = WHOLE_REF.exec(value);
  if (whole) return getPath(data, whole[1]);
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, p: string) => {
    const v = getPath(data, p);
    return v === undefined || v === null ? "" : typeof v === "object" ? "" : String(v);
  });
}

// ── 표시 형식 ──

export const FORMAT_TYPES = ["number", "percent", "currency", "date", "relative", "unit"] as const;
export type FormatType = (typeof FORMAT_TYPES)[number];
export interface Format {
  type: FormatType;
  digits?: number;
  unit?: string;
  currency?: string;
}

export function formatValue(value: unknown, format?: Format): string {
  if (value === undefined || value === null || value === "") return "-";
  if (!format) return typeof value === "object" ? "-" : String(value);
  const n = typeof value === "number" ? value : Number(value);
  const digits = format.digits ?? (format.type === "percent" ? 1 : 2);
  switch (format.type) {
    case "number":
      return Number.isFinite(n) ? n.toLocaleString("ko-KR", { maximumFractionDigits: digits }) : String(value);
    case "percent":
      return Number.isFinite(n) ? `${n.toLocaleString("ko-KR", { maximumFractionDigits: digits })}%` : String(value);
    case "currency":
      return Number.isFinite(n)
        ? n.toLocaleString("ko-KR", { style: "currency", currency: format.currency ?? "KRW", maximumFractionDigits: format.digits ?? 0 })
        : String(value);
    case "unit":
      return Number.isFinite(n) ? `${n.toLocaleString("ko-KR", { maximumFractionDigits: digits })}${format.unit ?? ""}` : String(value);
    case "date": {
      const d = new Date(typeof value === "number" ? value : String(value));
      return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
    }
    case "relative": {
      const d = new Date(typeof value === "number" ? value : String(value));
      if (Number.isNaN(d.getTime())) return String(value);
      const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
      return days === 0 ? "오늘" : days > 0 ? `${days}일 후` : `${-days}일 전`;
    }
  }
}

// ── 조건·색 ──

export const COLORS = ["good", "warn", "bad", "muted", "accent"] as const;
export type Color = (typeof COLORS)[number];
const WHEN_OPS = ["exists", "eq", "ne", "gt", "lt", "gte", "lte"] as const;

/** 블록의 when 조건. 없으면 항상 보인다 */
export function whenOk(when: unknown, data: unknown): boolean {
  if (!isObject(when) || typeof when.path !== "string") return true;
  const v = getPath(data, when.path);
  const target = when.value;
  switch (when.op) {
    case "exists":
      return v !== undefined && v !== null && v !== "";
    case "eq":
      return v === target || String(v) === String(target);
    case "ne":
      return !(v === target || String(v) === String(target));
    case "gt":
      return Number(v) > Number(target);
    case "lt":
      return Number(v) < Number(target);
    case "gte":
      return Number(v) >= Number(target);
    case "lte":
      return Number(v) <= Number(target);
    default:
      return true;
  }
}

/** thresholds에서 처음 맞는 색 (없으면 undefined) */
export function thresholdColor(value: unknown, thresholds: unknown): Color | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Array.isArray(thresholds) || !Number.isFinite(n)) return undefined;
  for (const t of thresholds) {
    if (!isObject(t)) continue;
    const ok =
      (t.gte === undefined || n >= Number(t.gte)) && (t.gt === undefined || n > Number(t.gt)) && (t.lte === undefined || n <= Number(t.lte)) && (t.lt === undefined || n < Number(t.lt));
    if (ok && COLORS.includes(t.color as Color)) return t.color as Color;
  }
  return undefined;
}

// ── 변환 (소스로 받은 자료를 다듬는 선언형 단계, 소스 연결은 T07) ──

export const TRANSFORM_OPS = ["pick", "map", "filter", "sort", "limit", "group", "agg"] as const;

/** 한 단계 변환. 배열에 대해서만 동작하고 모르는 입력은 그대로 돌려준다 */
export function runTransform(value: unknown, step: unknown): unknown {
  if (!isObject(step)) return value;
  switch (step.op) {
    case "pick":
      return typeof step.path === "string" ? getPath(value, step.path) : value;
    case "map":
      return Array.isArray(value) && typeof step.path === "string" ? value.map((v) => getPath(v, step.path as string)) : value;
    case "filter":
      return Array.isArray(value) && typeof step.path === "string" ? value.filter((v) => whenOk({ path: step.path, op: step.is ?? "exists", value: step.value }, v)) : value;
    case "sort": {
      if (!Array.isArray(value)) return value;
      const key = typeof step.path === "string" ? step.path : null;
      const dir = step.dir === "desc" ? -1 : 1;
      return [...value].sort((a, b) => {
        const x = key ? getPath(a, key) : a;
        const y = key ? getPath(b, key) : b;
        // 숫자로 읽히는 값(CSV의 글 "1380" 포함)은 숫자로 비교하고 아니면 글자로 비교한다
        const nx = typeof x === "string" && x.trim() === "" ? NaN : Number(x);
        const ny = typeof y === "string" && y.trim() === "" ? NaN : Number(y);
        return (Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : String(x).localeCompare(String(y))) * dir;
      });
    }
    case "limit":
      return Array.isArray(value) ? value.slice(0, Math.max(0, Math.min(MAX_ROWS, Number(step.n) || 0))) : value;
    case "group": {
      if (!Array.isArray(value) || typeof step.path !== "string") return value;
      const groups = new Map<string, unknown[]>();
      for (const v of value) {
        const k = String(getPath(v, step.path) ?? "");
        groups.set(k, [...(groups.get(k) ?? []), v]);
      }
      return [...groups].map(([key, items]) => ({ key, items, count: items.length }));
    }
    case "agg": {
      if (!Array.isArray(value)) return value;
      const nums = (typeof step.path === "string" ? value.map((v) => getPath(v, step.path as string)) : value).map(Number).filter(Number.isFinite);
      switch (step.fn) {
        case "sum":
          return nums.reduce((a, b) => a + b, 0);
        case "avg":
          return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : undefined;
        case "min":
          return nums.length ? Math.min(...nums) : undefined;
        case "max":
          return nums.length ? Math.max(...nums) : undefined;
        case "count":
          return value.length;
        default:
          return value;
      }
    }
    default:
      return value;
  }
}

export function runTransforms(value: unknown, steps: unknown): unknown {
  return Array.isArray(steps) ? steps.reduce<unknown>((v, s) => runTransform(v, s), value) : value;
}

// ── 블록 정의·검증 ──

interface Ctx {
  count: number;
  errors: string[];
  depth: number;
}
interface BlockSpec {
  /** 이 블록이 받는 키 (공통 키 type·when·thresholds·format은 따로 허용) */
  keys: string[];
  validate(block: Record<string, unknown>, where: string, ctx: Ctx): void;
  /** 생성 지침(LLM)에 넣는 설명과 예시 */
  promptDoc: string;
  example: Block;
}

const COMMON_KEYS = ["type", "when", "thresholds", "format"];
const str = (v: unknown, max = MAX_TEXT) => typeof v === "string" && v.length <= max;
const valueOrRef = (v: unknown) => typeof v === "string" ? str(v) : typeof v === "number" || typeof v === "boolean";

function checkChildren(children: unknown, where: string, ctx: Ctx) {
  if (!Array.isArray(children) || children.length === 0) return void ctx.errors.push(`${where}: children가 비어 있거나 배열이 아닙니다`);
  children.forEach((c, i) => checkBlock(c, `${where}.children[${i}]`, ctx));
}

export const BLOCK_SPECS: Record<string, BlockSpec> = {
  text: {
    keys: ["text", "size"],
    validate: (b, w, c) => {
      if (!str(b.text)) c.errors.push(`${w}: text는 2,000자 이하의 글이어야 합니다`);
      if (b.size !== undefined && !["sm", "md", "lg"].includes(b.size as string)) c.errors.push(`${w}: size는 sm·md·lg 중 하나입니다`);
    },
    promptDoc: "text — 글 한 덩어리. {text, size?:'sm'|'md'|'lg'}",
    example: { type: "text", text: "오늘도 좋은 하루", size: "md" },
  },
  stat: {
    keys: ["label", "value", "sub"],
    validate: (b, w, c) => {
      if (!str(b.label, 80)) c.errors.push(`${w}: label은 80자 이하의 글이어야 합니다`);
      if (!valueOrRef(b.value)) c.errors.push(`${w}: value는 글·숫자·{{경로}}여야 합니다`);
      if (b.sub !== undefined && !str(b.sub, 200)) c.errors.push(`${w}: sub는 200자 이하의 글이어야 합니다`);
    },
    promptDoc: "stat — 큰 숫자 하나. {label, value, sub?} + 공통 format·thresholds",
    example: { type: "stat", label: "남은 일수", value: 12, format: { type: "unit", unit: "일" } },
  },
  table: {
    keys: ["columns", "rows"],
    validate: (b, w, c) => {
      const cols = b.columns;
      if (!Array.isArray(cols) || cols.length === 0 || cols.length > 12 || !cols.every((x) => isObject(x) && str(x.key, 60) && str(x.label, 60))) c.errors.push(`${w}: columns는 {key,label} 12개 이하 배열이어야 합니다`);
      if (typeof b.rows === "string") {
        if (!str(b.rows)) c.errors.push(`${w}: rows 글이 너무 깁니다`);
      } else if (!Array.isArray(b.rows) || b.rows.length > MAX_ROWS || !b.rows.every(isObject)) c.errors.push(`${w}: rows는 객체 ${MAX_ROWS}개 이하 배열이거나 {{경로}}여야 합니다`);
    },
    promptDoc: "table — 표. {columns:[{key,label}], rows:[{키:값}] 또는 '{{경로}}'}",
    example: { type: "table", columns: [{ key: "name", label: "이름" }], rows: [{ name: "예시" }] },
  },
  line: {
    keys: ["points", "label"],
    validate: (b, w, c) => checkPoints(b, w, c),
    promptDoc: "line — 선그래프. {points:[숫자 또는 {x,y}] 또는 '{{경로}}', label?}",
    example: { type: "line", points: [1, 3, 2, 5] },
  },
  bar: {
    keys: ["points", "label"],
    validate: (b, w, c) => checkPoints(b, w, c),
    promptDoc: "bar — 막대그래프. line과 같은 points",
    example: { type: "bar", points: [{ x: "월", y: 3 }, { x: "화", y: 5 }] },
  },
  checklist: {
    keys: ["items"],
    validate: (b, w, c) => {
      const items = b.items;
      if (!Array.isArray(items) || items.length > MAX_ROWS || !items.every((x) => isObject(x) && str(x.text, 200) && (x.done === undefined || typeof x.done === "boolean"))) c.errors.push(`${w}: items는 {text, done?} ${MAX_ROWS}개 이하 배열이어야 합니다`);
    },
    promptDoc: "checklist — 체크 목록(눌러서 체크하면 저장됨). {items:[{text, done?}]}",
    example: { type: "checklist", items: [{ text: "물 마시기", done: false }] },
  },
  clock: {
    keys: ["tz"],
    validate: (b, w, c) => {
      if (b.tz !== undefined) {
        try {
          new Intl.DateTimeFormat("ko-KR", { timeZone: String(b.tz) });
        } catch {
          c.errors.push(`${w}: tz가 올바른 시간대(예: Asia/Seoul)가 아닙니다`);
        }
      }
    },
    promptDoc: "clock — 시각. {tz?:'Asia/Seoul'} (없으면 이 PC의 시간대)",
    example: { type: "clock", tz: "Asia/Tokyo" },
  },
  macro: {
    keys: [],
    validate: () => {},
    promptDoc: "macro — 미국 소비자물가 상승률(전년비)과 기준금리를 겹친 그래프(기간 선택·다시 받기 포함). 앱이 직접 자료를 받아 그리므로 sources가 필요 없고 설정 키도 없습니다.",
    example: { type: "macro" },
  },
  row: {
    keys: ["children"],
    validate: (b, w, c) => checkChildren(b.children, w, c),
    promptDoc: "row — 자식 블록을 가로로 나열. {children:[블록…]}",
    example: { type: "row", children: [{ type: "stat", label: "A", value: 1 }, { type: "stat", label: "B", value: 2 }] },
  },
  column: {
    keys: ["children"],
    validate: (b, w, c) => checkChildren(b.children, w, c),
    promptDoc: "column — 자식 블록을 세로로 나열. {children:[블록…]}",
    example: { type: "column", children: [{ type: "text", text: "위" }, { type: "text", text: "아래" }] },
  },
  tabs: {
    keys: ["tabs"],
    validate: (b, w, c) => {
      const tabs = b.tabs;
      if (!Array.isArray(tabs) || tabs.length === 0 || tabs.length > 8) return void c.errors.push(`${w}: tabs는 1~8개 배열이어야 합니다`);
      tabs.forEach((t, i) => {
        if (!isObject(t) || !str(t.label, 40)) return void c.errors.push(`${w}.tabs[${i}]: label이 필요합니다`);
        if (Object.keys(t).some((k) => k !== "label" && k !== "children")) c.errors.push(`${w}.tabs[${i}]: 모르는 키가 있습니다`);
        checkChildren(t.children, `${w}.tabs[${i}]`, c);
      });
    },
    promptDoc: "tabs — 탭. {tabs:[{label, children:[블록…]}]}",
    example: { type: "tabs", tabs: [{ label: "일", children: [{ type: "text", text: "오늘" }] }] },
  },
};

function checkPoints(b: Record<string, unknown>, w: string, c: Ctx) {
  const p = b.points;
  if (typeof p === "string") {
    if (!str(p)) c.errors.push(`${w}: points 글이 너무 깁니다`);
  } else if (!Array.isArray(p) || p.length > MAX_POINTS || !p.every((x) => typeof x === "number" || (isObject(x) && typeof x.y === "number" && (x.x === undefined || typeof x.x === "string" || typeof x.x === "number")))) {
    c.errors.push(`${w}: points는 숫자 또는 {x,y} ${MAX_POINTS}개 이하 배열이거나 {{경로}}여야 합니다`);
  }
  if (b.label !== undefined && !str(b.label, 80)) c.errors.push(`${w}: label은 80자 이하여야 합니다`);
}

function checkFormat(format: unknown, where: string, ctx: Ctx) {
  if (format === undefined) return;
  if (!isObject(format) || !FORMAT_TYPES.includes(format.type as FormatType)) return void ctx.errors.push(`${where}: format.type은 ${FORMAT_TYPES.join("·")} 중 하나입니다`);
  if (Object.keys(format).some((k) => !["type", "digits", "unit", "currency"].includes(k))) ctx.errors.push(`${where}: format에 모르는 키가 있습니다`);
  if (format.digits !== undefined && !(Number.isInteger(format.digits) && (format.digits as number) >= 0 && (format.digits as number) <= 6)) ctx.errors.push(`${where}: format.digits는 0~6입니다`);
  if (format.unit !== undefined && !str(format.unit, 12)) ctx.errors.push(`${where}: format.unit은 12자 이하입니다`);
  if (format.currency !== undefined && !(typeof format.currency === "string" && /^[A-Z]{3}$/.test(format.currency))) ctx.errors.push(`${where}: format.currency는 KRW·USD 같은 3글자 코드입니다`);
}

function checkBlock(block: unknown, where: string, ctx: Ctx) {
  if (++ctx.count > MAX_BLOCKS) {
    if (ctx.count === MAX_BLOCKS + 1) ctx.errors.push(`블록이 ${MAX_BLOCKS}개를 넘습니다`);
    return;
  }
  if (!isObject(block) || typeof block.type !== "string") return void ctx.errors.push(`${where}: 블록에 type이 필요합니다`);
  const spec = Object.prototype.hasOwnProperty.call(BLOCK_SPECS, block.type) ? BLOCK_SPECS[block.type] : null;
  if (!spec) return void ctx.errors.push(`${where}: 모르는 블록 종류 '${block.type}'입니다`);
  const unknownKeys = Object.keys(block).filter((k) => !COMMON_KEYS.includes(k) && !spec.keys.includes(k));
  if (unknownKeys.length) ctx.errors.push(`${where}: 모르는 키 ${unknownKeys.map((k) => `'${k}'`).join(", ")}`);
  if (ctx.depth > 4) return void ctx.errors.push(`${where}: 블록이 너무 깊게 겹쳐 있습니다`);
  if (block.when !== undefined) {
    const w = block.when;
    if (!isObject(w) || !str(w.path, 200) || !WHEN_OPS.includes(w.op as (typeof WHEN_OPS)[number]) || (w.value !== undefined && !valueOrRef(w.value))) ctx.errors.push(`${where}: when은 {path, op, value?} 형식입니다`);
  }
  if (block.thresholds !== undefined) {
    const t = block.thresholds;
    if (!Array.isArray(t) || t.length > 8 || !t.every((x) => isObject(x) && COLORS.includes(x.color as Color) && ["gte", "gt", "lte", "lt"].every((k) => x[k] === undefined || typeof x[k] === "number"))) ctx.errors.push(`${where}: thresholds는 {gte?|gt?|lte?|lt?, color:${COLORS.join("|")}} 8개 이하 배열입니다`);
  }
  checkFormat(block.format, where, ctx);
  ctx.depth++;
  spec.validate(block, where, ctx);
  ctx.depth--;
}

/** 소스 이름이 인증 정보처럼 보이는 헤더·쿼리는 위젯 정의에 둘 수 없다 (키는 커넥터가 맡는다, T11·T12) */
const SECRET_NAME = /^(authorization|proxy-authorization|cookie)$|key|token|secret|passw/i;

const SOURCE_KEYS = ["id", "url", "query", "format", "refreshMin", "transform"];

function checkTransform(steps: unknown, where: string, ctx: Ctx) {
  if (steps === undefined) return;
  if (!Array.isArray(steps) || steps.length > 20 || !steps.every((s) => isObject(s) && TRANSFORM_OPS.includes(s.op as (typeof TRANSFORM_OPS)[number]))) ctx.errors.push(`${where}: transform은 op가 ${TRANSFORM_OPS.join("·")} 중 하나인 단계 20개 이하 배열입니다`);
}

function checkSources(sources: unknown, ctx: Ctx) {
  if (sources === undefined) return;
  if (!Array.isArray(sources) || sources.length > 5 || !sources.every(isObject)) return void ctx.errors.push("sources는 객체 5개 이하 배열이어야 합니다");
  const ids = new Set<string>();
  sources.forEach((s, i) => {
    const w = `sources[${i}]`;
    const unknownKeys = Object.keys(s).filter((k) => !SOURCE_KEYS.includes(k));
    if (unknownKeys.length) ctx.errors.push(`${w}: 모르는 키 ${unknownKeys.map((k) => `'${k}'`).join(", ")} (헤더·본문·인증·POST는 지원하지 않습니다)`);
    if (typeof s.id !== "string" || !/^[a-z][a-z0-9_]{0,19}$/.test(s.id)) ctx.errors.push(`${w}: id는 영문 소문자로 시작하는 소문자·숫자·_ 1~20자입니다`);
    else if (ids.has(s.id)) ctx.errors.push(`${w}: id '${s.id}'가 겹칩니다`);
    else ids.add(s.id);
    if (typeof s.url !== "string" || s.url.length > 500) ctx.errors.push(`${w}: url은 500자 이하의 글이어야 합니다`);
    else {
      let url: URL | null = null;
      try {
        url = new URL(s.url);
      } catch {}
      if (!url || url.protocol !== "https:" || url.username || url.password) ctx.errors.push(`${w}: url은 https 주소여야 합니다 (아이디·비밀번호 포함 불가)`);
      else if (/^(\d+\.){3}\d+$/.test(url.hostname) || url.hostname.includes(":") || url.hostname === "localhost") ctx.errors.push(`${w}: 숫자 주소(IP)·localhost는 쓸 수 없습니다 (도메인 주소만)`);
      else if ([...url.searchParams.keys()].some((k) => SECRET_NAME.test(k))) ctx.errors.push(`${w}: 인증 정보(key·token 등)가 든 주소는 쓸 수 없습니다 (키가 필요 없는 공개 API만)`);
    }
    if (s.query !== undefined) {
      const q = s.query;
      if (!isObject(q) || Object.keys(q).length > 10 || !Object.values(q).every((v) => (typeof v === "string" && v.length <= 200) || typeof v === "number")) ctx.errors.push(`${w}: query는 글·숫자 값 10개 이하 객체여야 합니다`);
      else if (Object.keys(q).some((k) => SECRET_NAME.test(k))) ctx.errors.push(`${w}.query: 인증 정보(Authorization·key·token 등)는 위젯 정의에 둘 수 없습니다`);
    }
    if (s.format !== undefined && !SOURCE_FORMATS.includes(s.format as SourceFormat)) ctx.errors.push(`${w}: format은 ${SOURCE_FORMATS.join("·")} 중 하나입니다`);
    if (s.refreshMin !== undefined && !(typeof s.refreshMin === "number" && s.refreshMin >= 15 && s.refreshMin <= 1440)) ctx.errors.push(`${w}.refreshMin은 15 이상 1440 이하여야 합니다`);
    checkTransform(s.transform, w, ctx);
  });
}

export type WidgetCheck = { ok: true; def: WidgetDef } | { ok: false; errors: string[] };

/** 위젯 정의를 검사한다. 모르는 키·블록, 한도 초과, 높은 schema는 거부하고 이유를 한글로 돌려준다 */
export function validateWidget(def: unknown): WidgetCheck {
  const ctx: Ctx = { count: 0, errors: [], depth: 0 };
  if (!isObject(def)) return { ok: false, errors: ["정의가 객체가 아닙니다"] };
  if (typeof def.schema === "number" && def.schema > WIDGET_SCHEMA) return { ok: false, errors: [`schema ${def.schema}: 이 앱 버전이 지원하지 않습니다 (앱을 업데이트하세요)`] };
  if (def.schema !== WIDGET_SCHEMA) ctx.errors.push(`schema는 ${WIDGET_SCHEMA}여야 합니다`);
  const extra = Object.keys(def).filter((k) => !["schema", "title", "sources", "blocks"].includes(k));
  if (extra.length) ctx.errors.push(`모르는 키 ${extra.map((k) => `'${k}'`).join(", ")}`);
  if (!str(def.title, 60) || !(def.title as string).trim()) ctx.errors.push("title은 1~60자 글이어야 합니다");
  checkSources(def.sources, ctx);
  if (!Array.isArray(def.blocks) || def.blocks.length === 0) ctx.errors.push("blocks가 비어 있거나 배열이 아닙니다");
  else def.blocks.forEach((b, i) => checkBlock(b, `blocks[${i}]`, ctx));
  return ctx.errors.length ? { ok: false, errors: ctx.errors.slice(0, 8) } : { ok: true, def: def as unknown as WidgetDef };
}

/** 체크리스트 한 칸을 눌렀을 때의 새 정의. path는 최상위 블록 번호부터 (row·column은 자식 번호, tabs는 탭 번호·자식 번호) */
export function toggleChecklist(def: WidgetDef, path: number[], index: number): WidgetDef {
  const at = (blocks: Block[], p: number[]): Block[] => {
    const [i, ...rest] = p;
    return blocks.map((b, idx) => {
      if (idx !== i) return b;
      if (rest.length === 0) {
        if (b.type !== "checklist" || !Array.isArray(b.items)) return b;
        return { ...b, items: (b.items as { text: string; done?: boolean }[]).map((it, k) => (k === index ? { ...it, done: !it.done } : it)) };
      }
      if (b.type === "tabs" && Array.isArray(b.tabs)) {
        const [t, ...r] = rest;
        return { ...b, tabs: (b.tabs as { label: string; children: Block[] }[]).map((tab, ti) => (ti === t ? { ...tab, children: at(tab.children, r) } : tab)) };
      }
      return Array.isArray(b.children) ? { ...b, children: at(b.children as Block[], rest) } : b;
    });
  };
  return { ...def, blocks: at(def.blocks, path) };
}

/** 생성 지침(LLM)에 넣을 블록 설명 — BLOCK_SPECS에서 만든다 */
export function blockPromptDocs(): string {
  return Object.values(BLOCK_SPECS).map((s) => `- ${s.promptDoc}\n  예: ${JSON.stringify(s.example)}`).join("\n");
}

// ── 외부 자료 해석 (받은 글 → 값) ──

/** CSV(쉼표, 큰따옴표 묶음 지원) → 첫 줄을 이름으로 쓴 객체 배열. 줄 수는 MAX_ROWS까지 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) break;
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    if (row.some((c) => c !== "")) rows.push(row);
  }
  const [head, ...body] = rows;
  if (!head) return [];
  return body.slice(0, MAX_ROWS).map((r) => Object.fromEntries(head.map((name, i) => [name.trim(), r[i] ?? ""])));
}

/** DOM과 같은 모양만 쓰는 최소 XML 요소 (브라우저의 Element도, 테스트용 가짜도 맞는다) */
export interface XmlLike {
  tagName: string;
  textContent: string | null;
  children: ArrayLike<XmlLike>;
}

/**
 * XML 요소 → 값. 자식 요소가 없으면 글(문자열), 있으면 객체이고 자식 이름마다 값을 모은다:
 * 자식 요소가 있는 요소는 항상 배열(하나뿐이어도), 글만 있는 요소는 문자열(같은 이름이 반복되면 배열).
 * 예: RSS → { channel: [{ title: "…", item: [{ title: "…", link: "…" }, …] }] }
 */
export function xmlElementToValue(el: XmlLike): unknown {
  const kids = Array.from(el.children);
  if (kids.length === 0) return (el.textContent ?? "").trim();
  const out: Record<string, unknown> = {};
  for (const kid of kids) {
    const name = kid.tagName.replace(/^.*:/, "");
    if (name === "__proto__" || name === "constructor" || name === "prototype") continue;
    const value = xmlElementToValue(kid);
    const nested = typeof value === "object";
    const prev = out[name];
    if (prev === undefined) out[name] = nested ? [value] : value;
    else out[name] = Array.isArray(prev) ? [...prev, value] : [prev, value];
  }
  return out;
}
