"use client";

// 구독 플랜과 사용량(5시간 세션·주간 남은 비율) 저장소. 상단 사용량 막대가 읽는다.
// - 값은 Claude Code를 실행할 때마다 오는 rate_limit_event로 갱신된다 (backend/local.ts).
// - 앱을 처음 켰을 때(저장된 값이 없을 때) 한 번, 그리고 사용자가 새로고침을 누를 때만 가장 작은 모델로 짧게 실행해 값을 받아 온다.
// - 이 PC에 저장하고 동기화하지 않는다 (값이 금방 낡는다). 플랜은 `claude auth status`에서 구독 종류만 읽는다.

import { desktop, isDesktop } from "./desktop";
import { getStored, setStored, useStoredState, whenStorageReady } from "./storage";
import { parseRateLimitEvent, type RateLimits } from "./usage-math";

export interface UsageData {
  /** 구독 종류 원문 (subscriptionType) */
  plan: string | null;
  /** 세부 등급 원문 (planTier, 예: Max 5x·20x 구분) */
  tier: string | null;
  limits: RateLimits;
  /** 한도 값을 마지막으로 받은 시각 (ISO) */
  updatedAt: string | null;
}

const EMPTY: UsageData = { plan: null, tier: null, limits: {}, updatedAt: null };

export function useUsage(): UsageData {
  return { ...EMPTY, ...useStoredState<Partial<UsageData>>("usage", EMPTY)[0] };
}

function current(): UsageData {
  return { ...EMPTY, ...getStored<Partial<UsageData>>("usage", EMPTY) };
}

/** 플랜 확인 사이의 최소 간격 — 한 번의 실행에서 사용량 이벤트가 여러 번 와도 CLI를 반복 호출하지 않는다 */
const PLAN_REFRESH_MIN_MS = 60_000;
let lastPlanRefresh = 0;

/** Claude Code가 보낸 사용률을 저장한다 (한쪽만 오면 다른 쪽은 이전 값 유지). 구독 플랜도 함께 다시 확인한다. */
export function recordRateLimits(limits: RateLimits) {
  const prev = current();
  setStored<UsageData>("usage", {
    ...prev,
    limits: { fiveHour: limits.fiveHour ?? prev.limits.fiveHour, sevenDay: limits.sevenDay ?? prev.limits.sevenDay },
    updatedAt: new Date().toISOString(),
  });
  if (Date.now() - lastPlanRefresh > PLAN_REFRESH_MIN_MS) void refreshPlan();
}

export async function refreshPlan() {
  lastPlanRefresh = Date.now();
  const info = await desktop.claudePlan().catch(() => null);
  const prev = current();
  // 일시적으로 확인에 실패해도 기존 배지를 지우지 않는다 (값을 얻었을 때만 바꾼다)
  if (info && (info.subscription !== prev.plan || info.tier !== prev.tier)) setStored<UsageData>("usage", { ...prev, plan: info.subscription, tier: info.tier });
}

/** 사용량 확인 실행이 돌려준 rate_limit_event 한 줄을 저장한다. 값을 읽었으면 true */
function applyProbeLine(line: string): boolean {
  try {
    const limits = parseRateLimitEvent(JSON.parse(line));
    if (!limits) return false;
    recordRateLimits(limits);
    return true;
  } catch {
    return false;
  }
}

/** 가장 작은 모델로 짧게 실행해 현재 사용률을 받아 온다. 값을 받으면 true */
export async function probeUsage(): Promise<boolean> {
  const line = await desktop.claudeUsageProbe().catch(() => null);
  return line ? applyProbeLine(line) : false;
}

let started = false;

/** 앱 시작 시 한 번 호출. 플랜을 확인하고, 저장된 사용률이 없으면 한 번 받아 온다. */
export function startUsage() {
  if (started || !isDesktop()) return;
  started = true;
  // 백그라운드 자동 세션 새로고침(Rust)이나 트레이 메뉴가 실행한 결과를 받아 저장한다 (창이 숨겨져 있어도 이벤트는 온다)
  void desktop.onUsageProbed((line) => void whenStorageReady().then(() => applyProbeLine(line)));
  void whenStorageReady().then(async () => {
    await refreshPlan();
    const { limits } = current();
    if (!limits.fiveHour && !limits.sevenDay) await probeUsage();
  });
}
