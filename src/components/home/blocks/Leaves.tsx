"use client";

import { Check } from "lucide-react";
import { formatClockDate, formatClockTime } from "@/lib/clock-core";
import { useClockDate } from "@/lib/use-clock";
import { MAX_POINTS, MAX_ROWS, formatValue, getPath, resolveValue, thresholdColor, type Block, type Color, type Format } from "@/lib/home-widget-core";

/** 말단 블록 렌더러. data는 소스로 받은 자료(T07 전에는 비어 있다), 글 안의 {{경로}}는 글자로만 끼워 넣는다 */
export interface LeafProps {
  block: Block;
  data: unknown;
  path: number[];
  onToggle: (path: number[], index: number) => void;
}

const COLOR_CLASS: Record<Color, string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-red-600 dark:text-red-400",
  muted: "text-muted",
  accent: "text-accent",
};

const asFormat = (b: Block) => b.format as Format | undefined;

export function TextBlock({ block, data }: LeafProps) {
  const size = block.size === "lg" ? "text-xl font-semibold" : block.size === "sm" ? "text-xs text-muted" : "text-sm";
  return <p className={`whitespace-pre-wrap break-words ${size}`}>{String(resolveValue(block.text, data) ?? "")}</p>;
}

export function StatBlock({ block, data }: LeafProps) {
  const value = resolveValue(block.value, data);
  const color = thresholdColor(value, block.thresholds);
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted">{String(resolveValue(block.label, data) ?? "")}</p>
      <p className={`mt-0.5 break-words text-3xl font-semibold tabular-nums ${color ? COLOR_CLASS[color] : ""}`} data-testid="block-stat-value">
        {formatValue(value, asFormat(block))}
      </p>
      {block.sub !== undefined && <p className="mt-0.5 text-xs text-muted">{String(resolveValue(block.sub, data) ?? "")}</p>}
    </div>
  );
}

export function TableBlock({ block, data }: LeafProps) {
  const rows = resolveValue(block.rows, data);
  const list = (Array.isArray(rows) ? rows : []).slice(0, MAX_ROWS);
  const columns = block.columns as { key: string; label: string; format?: Format }[];
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted">
            {columns.map((c) => (
              <th key={c.key} className="px-2 py-1 font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((row, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              {columns.map((c) => (
                <td key={c.key} className="px-2 py-1 tabular-nums">
                  {formatValue(resolveValue(getPath(row, c.key), data), c.format ?? asFormat(block))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {list.length === 0 && <p className="px-2 py-1 text-xs text-muted">자료 없음</p>}
    </div>
  );
}

/** 숫자로 읽히는 글(CSV 값 "324.8" 등)은 숫자로, 빈 글·숫자가 아닌 값은 NaN으로 */
function asNumber(v: unknown): number {
  if (typeof v === "number") return v;
  return typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
}

function toPoints(raw: unknown): { x?: string | number; y: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_POINTS)
    .map((p) => (p !== null && typeof p === "object" ? { ...(p as { x?: string | number }), y: asNumber((p as { y?: unknown }).y) } : { y: asNumber(p) }))
    .filter((p) => Number.isFinite(p.y));
}

const W = 300;
const H = 110;

export function LineBlock({ block, data }: LeafProps) {
  const points = toPoints(resolveValue(block.points, data));
  if (points.length < 2) return <p className="text-xs text-muted">자료 없음</p>;
  const ys = points.map((p) => p.y);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${((i / (points.length - 1)) * W).toFixed(1)},${(H - 6 - ((p.y - min) / span) * (H - 12)).toFixed(1)}`).join("");
  return (
    <div>
      {block.label !== undefined && <p className="mb-1 text-xs text-muted">{String(block.label)}</p>}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-28 w-full" role="img" aria-label={String(block.label ?? "선그래프")}>
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
      <p className="mt-1 flex justify-between text-xs tabular-nums text-muted">
        <span>{formatValue(min, asFormat(block))}</span>
        <span>{formatValue(max, asFormat(block))}</span>
      </p>
    </div>
  );
}

export function BarBlock({ block, data }: LeafProps) {
  const points = toPoints(resolveValue(block.points, data));
  if (points.length === 0) return <p className="text-xs text-muted">자료 없음</p>;
  const max = Math.max(...points.map((p) => p.y), 0) || 1;
  return (
    <div>
      {block.label !== undefined && <p className="mb-1 text-xs text-muted">{String(block.label)}</p>}
      <div className="flex h-28 items-end gap-1" role="img" aria-label={String(block.label ?? "막대그래프")}>
        {points.map((p, i) => (
          <div key={i} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-0.5" title={`${p.x ?? ""} ${formatValue(p.y, asFormat(block))}`.trim()}>
            <div className="w-full rounded-sm bg-accent" style={{ height: `${Math.max(2, (Math.max(p.y, 0) / max) * 100)}%` }} />
            {p.x !== undefined && <span className="w-full truncate text-center text-[10px] text-muted">{String(p.x)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChecklistBlock({ block, path, onToggle }: LeafProps) {
  const items = block.items as { text: string; done?: boolean }[];
  return (
    <ul className="space-y-1">
      {items.map((it, i) => (
        <li key={i}>
          <button type="button" onClick={() => onToggle(path, i)} className="flex w-full items-start gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-background" role="checkbox" aria-checked={!!it.done}>
            <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${it.done ? "border-accent bg-accent text-white dark:text-zinc-950" : "border-border"}`}>{it.done && <Check className="size-3" aria-hidden />}</span>
            <span className={`min-w-0 break-words ${it.done ? "text-muted line-through" : ""}`}>{it.text}</span>
          </button>
        </li>
      ))}
      {items.length === 0 && <li className="text-xs text-muted">항목 없음</li>}
    </ul>
  );
}

export function ClockBlock({ block }: LeafProps) {
  const date = useClockDate();
  const tz = typeof block.tz === "string" ? block.tz : undefined;
  const fmt = (o: Intl.DateTimeFormatOptions) => (date ? new Intl.DateTimeFormat("ko-KR", { timeZone: tz, ...o }).format(date) : " ");
  // 시간대를 정하지 않으면 이 PC의 시간대로 "2026년 11월 13일 (금)"과 24시간 "15:04:05"를 보인다
  const dateText = date ? (tz ? fmt({ year: "numeric", month: "long", day: "numeric", weekday: "short" }) : formatClockDate(date)) : " ";
  const timeText = date ? (tz ? fmt({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : formatClockTime(date)) : "--:--:--";
  return (
    <div suppressHydrationWarning>
      <p className="text-sm text-muted" data-testid="home-clock-date">
        {dateText}
      </p>
      <p className="mt-1 font-mono text-4xl font-semibold tabular-nums" data-testid="home-clock-time">
        {timeText}
      </p>
      <p className="mt-1 text-xs text-muted">{tz ?? "이 PC의 시간대 기준"}</p>
    </div>
  );
}
