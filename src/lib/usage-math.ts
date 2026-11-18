// 사용량 표시 계산 (순수 함수, 외부 의존 없음 — node로 직접 테스트 가능).
// Claude Code는 실행할 때마다 rate_limit_event를 보낸다:
//   {"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":0.74,"resetsAt":<epoch 초>},"seven_day":{...}}}}
// utilization은 사용한 비율(0~1). 실제 값이 단조롭게 늘어나는 것을 확인해 비율로 해석한다 (0.2 → 0.74).

export interface RateWindow {
  /** 사용한 비율 0~1 */
  utilization: number;
  /** 한도가 초기화되는 시각 (epoch 초) */
  resetsAt: number | null;
}

export interface RateLimits {
  fiveHour?: RateWindow;
  sevenDay?: RateWindow;
}

function parseWindow(value: unknown): RateWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.utilization !== "number" || !Number.isFinite(o.utilization)) return undefined;
  return {
    utilization: Math.min(1, Math.max(0, o.utilization)),
    resetsAt: typeof o.resetsAt === "number" && Number.isFinite(o.resetsAt) ? o.resetsAt : null,
  };
}

/** rate_limit_event에서 5시간·7일 사용률을 꺼낸다. 형식이 달라 읽을 수 없으면 null (형식은 비공식이라 바뀔 수 있다) */
export function parseRateLimitEvent(event: unknown): RateLimits | null {
  const info = (event as { rate_limit_info?: { unifiedWindows?: Record<string, unknown> } } | null)?.rate_limit_info;
  const windows = info?.unifiedWindows;
  if (!windows || typeof windows !== "object") return null;
  const fiveHour = parseWindow(windows.five_hour);
  const sevenDay = parseWindow(windows.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
}

/** 남은 비율(%). 초기화 시각이 지났으면 새 한도로 보고 100%로 표시한다 (reset: true). */
export function remaining(window: RateWindow, nowSec: number): { percent: number; reset: boolean } {
  if (window.resetsAt !== null && window.resetsAt <= nowSec) return { percent: 100, reset: true };
  return { percent: Math.round((1 - window.utilization) * 100), reset: false };
}

/** "2시간 13분 뒤" 같은 초기화까지 남은 시간 */
export function formatUntil(resetsAt: number | null, nowSec: number): string {
  if (resetsAt === null) return "";
  const minutes = Math.ceil((resetsAt - nowSec) / 60);
  if (minutes <= 0) return "초기화됨";
  if (minutes < 60) return `${minutes}분 뒤`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}시간 ${minutes % 60}분 뒤` : `${hours}시간 뒤`;
  return hours % 24 ? `${Math.floor(hours / 24)}일 ${hours % 24}시간 뒤` : `${Math.floor(hours / 24)}일 뒤`;
}

/** 초기화 시각을 짧게: 24시간 안이면 "15:20", 그 밖에는 "일 09:00" (시간대는 PC 설정을 따른다. timeZone은 테스트용) */
export function formatResetClock(resetsAt: number | null, nowSec: number, timeZone?: string): string {
  if (resetsAt === null || resetsAt <= nowSec) return "";
  const date = new Date(resetsAt * 1000);
  const time = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(date);
  if (resetsAt - nowSec < 24 * 3600) return time;
  return `${new Intl.DateTimeFormat("ko-KR", { weekday: "short", timeZone }).format(date)} ${time}`;
}

export type Level = "ok" | "low" | "critical";

/** 막대 색 단계: 남은 20% 이하 주황, 10% 이하 빨강 */
export function levelOf(percentRemaining: number): Level {
  if (percentRemaining <= 10) return "critical";
  if (percentRemaining <= 20) return "low";
  return "ok";
}

// `claude auth status`가 알려 주는 구독 종류. pro만 실제로 확인했고 나머지는 추정이다 —
// 틀려도 아래 규칙 때문에 원문이 그대로 보이고, 화면의 툴팁에도 원문을 보여 준다.
const PLAN_NAMES: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise", free: "Free" };

function prettify(raw: string): string {
  const text = raw.replace(/_/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * 플랜 이름 표시용 ("pro" → "Pro", "max"+"default_claude_max_20x" → "Max 20x", "max_5x" → "Max 5x").
 * Max는 plan·tier 문자열에서 `<숫자>x`를 찾아 배수를 붙이고, 모르는 값은 원문을 다듬어 그대로 보여 준다.
 */
export function planLabel(plan: string | null, tier?: string | null): string | null {
  const base = plan?.trim();
  if (!base) return null;
  const name = PLAN_NAMES[base.toLowerCase().split(/[_-]/)[0]];
  if (!name) return prettify(base);
  const multiplier = /(\d+)x/i.exec(`${base} ${tier ?? ""}`)?.[1];
  return name === "Max" && multiplier ? `Max ${multiplier}x` : name;
}

/** 플랜 배지 툴팁: CLI가 알려 준 원문 (라벨이 실제와 다를 때 확인용) */
export function planTitle(plan: string | null, tier?: string | null): string {
  const raw = [plan, tier].filter(Boolean).join(" · ");
  return raw ? `구독 플랜 (Claude가 알려 준 값: ${raw})` : "구독 플랜";
}

/** "N분 전" — 값이 얼마나 오래됐는지 */
export function formatAgo(thenMs: number, nowMs: number): string {
  const minutes = Math.floor((nowMs - thenMs) / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}시간 전` : `${Math.floor(hours / 24)}일 전`;
}
