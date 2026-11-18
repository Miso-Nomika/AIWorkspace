"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { axisTicks, buildChart, cutMonths, formatChartValue, rangeLabel, xLabel, xTicks, type ChartAxis, type ChartSeries } from "@/lib/home-chart-core";
import { linePath, nearestIndex, xPosition, yPosition } from "@/lib/macro-core";
import type { LeafProps } from "./Leaves";

const HEIGHT = 260;
const TOP = 12;
const BOTTOM = HEIGHT - 28;
const BAR_EDGE = 10;
const COLOR_VAR: Record<ChartSeries["color"], string> = {
  orange: "var(--series-inflation)",
  indigo: "var(--series-rate)",
  green: "var(--series-green)",
  pink: "var(--series-pink)",
};

/**
 * 여러 계열을 한 그래프에 그리는 블록 (정의의 {"type":"chart"}).
 * 직접 그린 SVG라 라이트·다크 테마는 CSS 변수로 따라가고, 마우스를 올리면 그 위치의 모든 계열 값을 보여 준다.
 */
export function ChartBlock({ block, data }: LeafProps) {
  const full = useMemo(() => buildChart(block, data), [block, data]);
  const ranges = Array.isArray(block.ranges) && full.dated ? (block.ranges as number[]) : [];
  const [months, setMonths] = useState<number | null>(typeof block.range === "number" ? block.range : null);
  const [hoverAt, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const chart = useMemo(() => cutMonths(full, months), [full, months]);
  const count = chart.xs.length;
  // 기간을 줄이면 마우스 위치 번호가 범위를 벗어날 수 있다
  const hover = hoverAt !== null && hoverAt < count ? hoverAt : null;
  const hasBar = chart.series.some((s) => s.kind === "bar");
  const hasValues = chart.series.some((s) => s.values.some((v) => v !== null));
  const hasData = hasValues && (count > 1 || hasBar);
  const interpolate = block.gap === "interpolate";

  // 세로축: 왼쪽·오른쪽에 계열을 나눠 담는다 (한 쪽에만 있으면 그 쪽만 쓴다)
  const axes = (["left", "right"] as ChartAxis[]).flatMap((side) => {
    const list = chart.series.filter((s) => s.axis === side);
    const values = list.flatMap((s) => s.values).filter((v): v is number => v !== null);
    if (list.length === 0 || values.length === 0) return [];
    return [{ side, unit: list[0].unit, ticks: axisTicks(Math.min(...values), Math.max(...values), list.some((s) => s.kind === "bar")) }];
  });
  const axisOf = (side: ChartAxis) => axes.find((a) => a.side === side) ?? axes[0];
  const hasLeft = axes.some((a) => a.side === "left");
  const hasRight = axes.some((a) => a.side === "right");
  const left = hasLeft ? 44 : 12;
  const right = Math.max(left + 40, width - (hasRight ? 48 : 16));
  const plotLeft = left + (hasBar ? BAR_EDGE : 0);
  const plotRight = right - (hasBar ? BAR_EDGE : 0);
  const x = (i: number) => xPosition(i, count, plotLeft, plotRight);
  const yOf = (s: ChartSeries, v: number) => {
    const t = axisOf(s.axis).ticks;
    return yPosition(v, t.min, t.max, TOP, BOTTOM);
  };
  const pixelsPerPoint = count > 1 ? (plotRight - plotLeft) / (count - 1) : 0;
  const marks = xTicks(chart, pixelsPerPoint);
  const gridTicks = axes[0]?.ticks.ticks ?? [];
  const gridAxis = axes[0];
  const barSeries = chart.series.filter((s) => s.kind === "bar");
  const barWidth = Math.max(1, Math.min(24, (pixelsPerPoint * 0.7) / Math.max(1, barSeries.length) || 24));

  const summary = hasData ? chart.series.map((s) => `${s.label} 최신 ${formatChartValue([...s.values].reverse().find((v) => v !== null) ?? null, s)}`).join(", ") : "그래프 (자료 없음)";

  return (
    <div className="min-w-0" data-testid="chart-block">
      {ranges.length > 0 && (
        <div role="group" aria-label="그래프 기간" className="mb-2 inline-flex rounded-md border border-border p-0.5 text-xs">
          {[...ranges.map((m) => ({ id: String(m), value: m as number | null, label: rangeLabel(m) })), { id: "all", value: null, label: "전체" }].map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={months === r.value}
              onClick={() => setMonths(r.value)}
              data-testid={`chart-range-${r.id}`}
              className={`rounded px-2 py-0.5 ${months === r.value ? "bg-accent text-white dark:text-zinc-950" : "text-muted hover:text-foreground"}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="범례" data-testid="chart-legend">
        {chart.series.map((s, i) => (
          <li key={i} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-5 rounded" style={{ background: COLOR_VAR[s.color], height: s.kind === "bar" ? 8 : 2 }} aria-hidden />
            {s.label}
          </li>
        ))}
      </ul>
      <div ref={box} className="relative w-full" style={{ height: HEIGHT }}>
        {hasData && width > 0 ? (
          <>
            <svg
              width={width}
              height={HEIGHT}
              role="img"
              aria-label={summary}
              data-testid="chart-svg"
              onMouseMove={(e) => setHover(nearestIndex(e.clientX - e.currentTarget.getBoundingClientRect().left, count, plotLeft, plotRight))}
              onMouseLeave={() => setHover(null)}
            >
              {gridAxis &&
                gridTicks.map((t) => {
                  const y = yPosition(t, gridAxis.ticks.min, gridAxis.ticks.max, TOP, BOTTOM);
                  return <line key={t} x1={left} x2={right} y1={y} y2={y} stroke="var(--border)" strokeWidth={t === 0 ? 1.5 : 1} />;
                })}
              {axes.map((a) =>
                a.ticks.ticks.map((t) => (
                  <text
                    key={`${a.side}${t}`}
                    x={a.side === "left" ? left - 6 : right + 6}
                    y={yPosition(t, a.ticks.min, a.ticks.max, TOP, BOTTOM)}
                    textAnchor={a.side === "left" ? "end" : "start"}
                    dominantBaseline="middle"
                    fontSize={11}
                    fill="var(--muted)"
                  >
                    {t}
                    {a.unit}
                  </text>
                )),
              )}
              {marks.map((m) => (
                <text key={`${m.i}${m.text}`} x={x(m.i)} y={BOTTOM + 16} textAnchor="middle" fontSize={11} fill="var(--muted)">
                  {m.text}
                </text>
              ))}
              {barSeries.map((s, bi) =>
                s.values.map((v, i) => {
                  if (v === null) return null;
                  const zero = Math.min(Math.max(0, axisOf(s.axis).ticks.min), axisOf(s.axis).ticks.max);
                  const y0 = yOf(s, zero);
                  const y1 = yOf(s, v);
                  const bx = x(i) - (barWidth * barSeries.length) / 2 + bi * barWidth;
                  return <rect key={`${bi}-${i}`} x={bx} y={Math.min(y0, y1)} width={barWidth} height={Math.max(1, Math.abs(y1 - y0))} fill={COLOR_VAR[s.color]} opacity={0.85} data-testid={`chart-bar-${s.label}`} />;
                }),
              )}
              {chart.series.map((s, si) => {
                if (s.kind !== "line") return null;
                const pts = s.values.map((v, i) => (v === null ? null : { x: x(i), y: yOf(s, v) }));
                // 채운 값(보간)은 점선으로, 실측만 이은 부분은 실선으로 그린다
                const real = pts.map((p, i) => (s.filled[i] ? null : p));
                return (
                  <g key={si}>
                    {interpolate && s.filled.some(Boolean) && <path d={linePath(pts)} fill="none" stroke={COLOR_VAR[s.color]} strokeWidth={2} strokeDasharray="4 4" opacity={0.6} data-testid={`chart-gap-${s.label}`} />}
                    <path d={linePath(real)} fill="none" stroke={COLOR_VAR[s.color]} strokeWidth={2} strokeLinejoin="round" data-testid={`chart-line-${s.label}`} />
                    {real.map((p, i) => (p && !real[i - 1] && !real[i + 1] ? <circle key={i} cx={p.x} cy={p.y} r={2.5} fill={COLOR_VAR[s.color]} /> : null))}
                  </g>
                );
              })}
              {hover !== null && (
                <g pointerEvents="none">
                  <line x1={x(hover)} x2={x(hover)} y1={TOP} y2={BOTTOM} stroke="var(--muted)" strokeDasharray="3 3" />
                  {chart.series.map((s, si) => {
                    const v = s.values[hover];
                    return v !== null && s.kind === "line" ? <circle key={si} cx={x(hover)} cy={yOf(s, v)} r={4} fill={COLOR_VAR[s.color]} /> : null;
                  })}
                </g>
              )}
            </svg>
            {hover !== null && (
              <div
                className="pointer-events-none absolute top-1 rounded-md border border-border bg-surface px-2 py-1 text-xs whitespace-nowrap shadow"
                style={{ left: Math.min(Math.max(x(hover) + 10, 0), Math.max(0, width - 230)) }}
                data-testid="chart-tooltip"
              >
                {`${xLabel(chart.xs[hover], chart.dated)} · ${chart.series.map((s) => `${s.label} ${formatChartValue(s.values[hover], s)}${s.filled[hover] ? " (보간)" : ""}`).join(" · ")}`}
              </div>
            )}
          </>
        ) : (
          <p className="flex h-full items-center justify-center text-sm text-muted" data-testid="chart-empty">
            자료 없음
          </p>
        )}
      </div>
    </div>
  );
}
