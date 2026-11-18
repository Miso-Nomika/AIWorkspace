"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { probeUsage, refreshPlan, useUsage } from "@/lib/usage";
import { formatAgo, formatResetClock, formatUntil, levelOf, planLabel, planTitle, remaining, type Level, type RateWindow } from "@/lib/usage-math";

const STALE_AFTER_MS = 10 * 60_000;

const FILL: Record<Level, string> = {
  ok: "bg-accent",
  low: "bg-amber-500",
  critical: "bg-red-500",
};

/** 현재 시각 (분 단위로 갱신 — 초기화까지 남은 시간·"N분 전 기준" 표시용) */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** 구독 플랜 + 5시간 세션·주간 한도의 남은 % 막대. Claude 사용량 사이트를 열지 않고 바로 볼 수 있게 한다. */
export function UsageBar() {
  const usage = useUsage();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const plan = planLabel(usage.plan, usage.tier);
  const updatedMs = usage.updatedAt ? Date.parse(usage.updatedAt) : null;
  const stale = updatedMs === null || now - updatedMs > STALE_AFTER_MS;
  const hasLimits = !!usage.limits.fiveHour || !!usage.limits.sevenDay;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="usage-bar">
      {plan && (
        <span className="rounded bg-accent-soft px-1.5 py-0.5 font-medium text-accent" title={planTitle(usage.plan, usage.tier)} data-testid="usage-plan">
          {plan}
        </span>
      )}
      {hasLimits ? (
        <>
          <Meter label="세션" title="5시간 한도" window={usage.limits.fiveHour} now={now} updatedMs={updatedMs} stale={stale} />
          <Meter label="주간" title="7일 한도" window={usage.limits.sevenDay} now={now} updatedMs={updatedMs} stale={stale} />
        </>
      ) : (
        <span className="text-muted">사용량 확인 전</span>
      )}
      <button
        onClick={async () => {
          setBusy(true);
          // 사용량과 플랜을 함께 새로 받는다 (값을 못 받아도 플랜은 확인)
          await Promise.all([probeUsage(), refreshPlan()]);
          setBusy(false);
        }}
        disabled={busy}
        title="사용량 새로고침 (가장 작은 모델로 짧게 한 번 실행합니다)"
        aria-label="사용량 새로고침"
        className="rounded p-1 text-muted hover:bg-background hover:text-foreground disabled:opacity-50"
        data-testid="usage-refresh"
      >
        <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden />
      </button>
    </div>
  );
}

function Meter({
  label,
  title,
  window,
  now,
  updatedMs,
  stale,
}: {
  label: string;
  title: string;
  window?: RateWindow;
  now: number;
  updatedMs: number | null;
  stale: boolean;
}) {
  if (!window) {
    return (
      <span className="text-muted" title={`${title}: 아직 값이 없습니다`}>
        {label} –
      </span>
    );
  }
  const nowSec = Math.floor(now / 1000);
  const { percent, reset } = remaining(window, nowSec);
  const level = levelOf(percent);
  const until = reset ? "초기화됨" : formatUntil(window.resetsAt, nowSec);
  const clock = formatResetClock(window.resetsAt, nowSec);
  // 막대 옆에 바로 보이는 초기화 안내: "2시간 13분 뒤 (15:20)" / 한도가 이미 초기화됐으면 "초기화됨"
  const resetText = reset ? "초기화됨" : until ? `${until}${clock ? ` (${clock})` : ""}` : "";
  const tip = [
    `${title}: ${percent}% 남음`,
    until && (reset ? "한도가 초기화되었습니다" : `${until}${clock ? ` (${clock})` : ""} 초기화`),
    stale && updatedMs !== null ? `${formatAgo(updatedMs, now)} 기준 (Claude Code를 실행하면 갱신됩니다)` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span className={`inline-flex items-center gap-1.5 ${stale ? "opacity-60" : ""}`} title={tip} data-testid={`usage-${label}`} data-percent={percent}>
      <span className="text-muted">{label}</span>
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-border" role="meter" aria-label={`${title} 남은 비율`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span className={`block h-full rounded-full ${FILL[level]}`} style={{ width: `${percent}%` }} />
      </span>
      <span className={`w-8 tabular-nums ${level === "ok" ? "" : level === "low" ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400"}`}>{percent}%</span>
      {resetText && (
        <span className="whitespace-nowrap text-muted" data-testid={`usage-${label}-reset`}>
          ↻ {resetText}
        </span>
      )}
    </span>
  );
}
