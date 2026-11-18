// 모델 선택지와 응답 통계 표시 (순수 함수, 외부 의존 없음 — node로 직접 테스트 가능)
// 실제 값 검사는 Rust(agent.rs)가 한 번 더 한다.

import type { MainModel, PlannerModel, RunStats } from "./types";

export interface ModelChoice<T extends string> {
  id: T;
  label: string;
  hint: string;
}

/** 실제 코딩(파일 수정·명령 실행·문서 갱신)을 하는 모델 */
export const MAIN_MODEL_CHOICES: ModelChoice<MainModel>[] = [
  { id: "haiku", label: "Haiku", hint: "가장 빠르고 저렴합니다. 간단한 수정에 알맞습니다." },
  { id: "sonnet", label: "Sonnet", hint: "속도와 품질의 균형. 대부분의 작업에 알맞습니다." },
  { id: "opus", label: "Opus", hint: "가장 신중합니다. 어려운 작업에 알맞지만 사용량이 큽니다." },
];

/** 새 기능 기획·복잡한 설계(planner)를 맡는 모델 */
export const PLANNER_MODEL_CHOICES: ModelChoice<PlannerModel>[] = [
  { id: "opus", label: "Opus", hint: "기획·설계를 맡깁니다 (기본)." },
  { id: "fable", label: "Fable", hint: "기획·설계를 가장 고성능 모델에 맡깁니다. 사용량이 가장 큽니다." },
];

export const DEFAULT_MAIN_MODEL: MainModel = "sonnet";
export const DEFAULT_PLANNER_MODEL: PlannerModel = "opus";

/** 저장된 값이 선택지에 없으면(이전 버전·손상) 기본값 */
export function pickMainModel(value: string | undefined): MainModel {
  return MAIN_MODEL_CHOICES.find((c) => c.id === value)?.id ?? DEFAULT_MAIN_MODEL;
}

export function pickPlannerModel(value: string | undefined): PlannerModel {
  return PLANNER_MODEL_CHOICES.find((c) => c.id === value)?.id ?? DEFAULT_PLANNER_MODEL;
}

/** 걸린 시간: 1분 미만은 초(소수 첫째 자리), 이상은 "분 초" */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}초`;
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}분 ${total % 60}초`;
}

/** 비용(USD): 1센트 미만은 소수 셋째 자리까지 */
export function formatCost(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

/** 응답 아래에 보여줄 한 줄 (예: "12초 · 약 $0.07"). 표시할 값이 없으면 빈 문자열 */
export function formatRunStats(stats: RunStats | undefined): string {
  const parts: string[] = [];
  if (stats?.durationMs !== undefined && stats.durationMs >= 0) parts.push(formatDuration(stats.durationMs));
  if (stats?.costUsd !== undefined && stats.costUsd >= 0) parts.push(`약 ${formatCost(stats.costUsd)}`);
  return parts.join(" · ");
}
