"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import {
  MACRO_RANGES,
  cutRange,
  formatPercent,
  formatRefreshed,
  lastRefreshed,
  latestMonth,
  linePath,
  mergeMonthly,
  monthLabel,
  nearestIndex,
  niceTicks,
  xPosition,
  yPosition,
} from "@/lib/macro-core";
import { useMacroData, useMacroRange } from "@/lib/macro-store";
import type { LeafProps } from "./Leaves";

const HEIGHT = 260;
const PAD = { left: 44, right: 16, top: 12, bottom: 28 };
const GAP = "자료 없음";

/**
 * 미국 소비자물가 상승률(전년비)과 기준금리(실효금리 월평균)를 한 그래프(% 축 하나)에 겹친 블록 (사용자 위젯 정의에서 {"type":"macro"}로 쓴다).
 * 직접 그린 SVG라 라이트·다크 테마는 CSS 변수로 따라가고, 마우스를 올리면 그 달의 값 두 개를 보여 준다.
 */
export function MacroBlock(props: LeafProps) {
  void props;
  const { cache, inflation, busy, refresh } = useMacroData();
  const [range, setRange] = useMacroRange();
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const months = MACRO_RANGES.find((r) => r.id === range)?.months ?? null;
  const rows = useMemo(() => cutRange(mergeMonthly(inflation, cache.rate), months), [inflation, cache.rate, months]);
  const hasData = rows.length > 1;

  const values = rows.flatMap((r) => [r.inflation, r.rate]).filter((v): v is number => v !== null);
  const ticks = niceTicks(values.length ? Math.min(...values) : 0, values.length ? Math.max(...values) : 1);
  const left = PAD.left;
  const right = Math.max(left + 40, width - PAD.right);
  const top = PAD.top;
  const bottom = HEIGHT - PAD.bottom;
  const x = (i: number) => xPosition(i, rows.length, left, right);
  const y = (v: number) => yPosition(v, ticks.min, ticks.max, top, bottom);
  const pathOf = (pick: "inflation" | "rate") => linePath(rows.map((r, i) => (r[pick] === null ? null : { x: x(i), y: y(r[pick] as number) })));

  // 가로 눈금: 해마다 1월, 칸이 좁으면 건너뛰며 표시
  const yearMarks = rows.flatMap((r, i) => (r.month.endsWith("-01") ? [{ i, year: r.month.slice(0, 4) }] : []));
  const skip = yearMarks.length > 0 ? Math.max(1, Math.ceil(46 / Math.max(1, ((right - left) / Math.max(1, rows.length - 1)) * 12))) : 1;

  const latestInflation = latestMonth(inflation);
  const latestRate = latestMonth(cache.rate);
  const lastRow = rows[rows.length - 1];
  const summary = hasData
    ? `미국 소비자물가 상승률(전년비)과 기준금리 그래프. 최신 ${monthLabel(lastRow.month)}: 기준금리 ${lastRow.rate === null ? GAP : formatPercent(lastRow.rate)}${latestInflation ? `, 물가 상승률 ${monthLabel(latestInflation)} ${formatPercent(inflation[inflation.length - 1][1])}` : ""}`
    : "미국 소비자물가와 기준금리 그래프 (자료 없음)";

  const hovered = hover !== null ? rows[hover] : null;
  const refreshed = lastRefreshed(cache);

  return (
    <div className="min-w-0" data-testid="home-macro-block">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <p className="text-xs text-muted" data-testid="home-macro-updated">
          {refreshed ? `마지막 갱신: ${formatRefreshed(refreshed)}` : busy ? "자료를 받는 중…" : "아직 받은 자료가 없습니다"}
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div role="group" aria-label="그래프 기간" className="inline-flex rounded-md border border-border p-0.5 text-xs">
            {MACRO_RANGES.map((r) => (
              <button
                key={r.id}
                aria-pressed={range === r.id}
                onClick={() => setRange(r.id)}
                data-testid={`home-macro-range-${r.id}`}
                className={`rounded px-2 py-0.5 ${range === r.id ? "bg-accent text-white dark:text-zinc-950" : "text-muted hover:text-foreground"}`}
              >
                {r.label === "전체" ? "전체(약 20년)" : r.label}
              </button>
            ))}
          </div>
          <button
            onClick={refresh}
            disabled={busy}
            aria-label="물가·금리 다시 받기"
            title="물가·금리 다시 받기"
            data-testid="home-macro-refresh"
            className="rounded-md border border-border p-1.5 text-muted hover:bg-background hover:text-foreground disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
          </button>
        </div>
      </div>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="범례" data-testid="home-macro-legend">
        <li className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded" style={{ background: "var(--series-inflation)" }} aria-hidden />
          소비자물가 상승률(전년비)
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded" style={{ background: "var(--series-rate)" }} aria-hidden />
          기준금리(실효금리 EFFR, 월평균)
        </li>
      </ul>

      <div ref={box} className="relative w-full" style={{ height: HEIGHT }}>
        {hasData && width > 0 ? (
          <>
            <svg
              width={width}
              height={HEIGHT}
              role="img"
              aria-label={summary}
              data-testid="home-macro-chart"
              onMouseMove={(e) => setHover(nearestIndex(e.clientX - e.currentTarget.getBoundingClientRect().left, rows.length, left, right))}
              onMouseLeave={() => setHover(null)}
            >
              {ticks.ticks.map((t) => (
                <g key={t}>
                  <line x1={left} x2={right} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={t === 0 ? 1.5 : 1} />
                  <text x={left - 6} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--muted)">
                    {t}%
                  </text>
                </g>
              ))}
              {yearMarks.map(({ i, year }, n) =>
                n % skip === 0 ? (
                  <text key={year} x={x(i)} y={bottom + 16} textAnchor="middle" fontSize={11} fill="var(--muted)">
                    {year}
                  </text>
                ) : null,
              )}
              <path d={pathOf("inflation")} fill="none" stroke="var(--series-inflation)" strokeWidth={2} strokeLinejoin="round" data-testid="home-macro-line-inflation" />
              <path d={pathOf("rate")} fill="none" stroke="var(--series-rate)" strokeWidth={2} strokeLinejoin="round" data-testid="home-macro-line-rate" />
              {hover !== null && hovered && (
                <g pointerEvents="none">
                  <line x1={x(hover)} x2={x(hover)} y1={top} y2={bottom} stroke="var(--muted)" strokeDasharray="3 3" />
                  {hovered.inflation !== null && <circle cx={x(hover)} cy={y(hovered.inflation)} r={4} fill="var(--series-inflation)" />}
                  {hovered.rate !== null && <circle cx={x(hover)} cy={y(hovered.rate)} r={4} fill="var(--series-rate)" />}
                </g>
              )}
            </svg>
            {hovered && hover !== null && (
              <div
                className="pointer-events-none absolute top-1 rounded-md border border-border bg-surface px-2 py-1 text-xs whitespace-nowrap shadow"
                style={{ left: Math.min(Math.max(x(hover) + 10, 0), Math.max(0, width - 230)) }}
                data-testid="home-macro-tooltip"
              >
                {`${monthLabel(hovered.month)} · 물가 ${hovered.inflation === null ? GAP : formatPercent(hovered.inflation)} · 금리 ${hovered.rate === null ? GAP : formatPercent(hovered.rate)}`}
              </div>
            )}
          </>
        ) : (
          <p className="flex h-full items-center justify-center text-sm text-muted" data-testid="home-macro-empty">
            {busy ? "자료를 받는 중…" : "표시할 자료가 없습니다. 오른쪽 위 버튼으로 다시 받아 보세요."}
          </p>
        )}
      </div>

      {cache.error && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400" role="status" data-testid="home-macro-error">
          {hasData ? "갱신에 실패해 마지막으로 받은 자료를 보여 줍니다 — " : "자료를 받지 못했습니다 — "}
          {cache.error}
        </p>
      )}
      <p className="mt-2 text-xs text-muted" data-testid="home-macro-source">
        {latestInflation || latestRate
          ? `최신 자료: 물가 ${latestInflation ? monthLabel(latestInflation) : GAP}(발표 약 2주 지연) · 금리 ${latestRate ? monthLabel(latestRate) : GAP} · `
          : ""}
        출처: 미국 노동통계국(BLS) 소비자물가지수 CPI-U 계절조정 · 뉴욕 연준 실효금리(EFFR). 물가는 전년 같은 달 대비 상승률이며 과거 값은 개정될 수 있습니다.
      </p>
    </div>
  );
}
