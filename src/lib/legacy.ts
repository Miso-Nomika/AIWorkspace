// 이전 버전 데이터 정리 (순수 함수, 외부 의존 없음 — node로 직접 테스트 가능)

import type { Project } from "./types";

/** 이전 버전이 기본으로 넣던 시연용 프로젝트 (폴더 없음) */
const LEGACY_SAMPLE_IDS = new Set(["sample-web", "sample-api"]);

/**
 * - 시연용 샘플 프로젝트(폴더가 연결되지 않은 sample-web/sample-api)를 뺀다.
 * - Codex·Cursor로 지정된 프로젝트는 Claude Code로 바꾼다 (지원 에이전트가 Claude Code뿐).
 * 바뀐 게 없으면 changed=false (원래 배열을 그대로 돌려준다).
 */
export function migrateProjects(projects: Project[]): { projects: Project[]; removedIds: string[]; changed: boolean } {
  const removedIds = projects.filter((p) => !p.location && LEGACY_SAMPLE_IDS.has(p.id)).map((p) => p.id);
  const kept = projects.filter((p) => !removedIds.includes(p.id));
  const otherAgent = kept.some((p) => (p.agent as string) !== "claude-code");
  if (!removedIds.length && !otherAgent) return { projects, removedIds, changed: false };
  return { projects: kept.map((p) => ({ ...p, agent: "claude-code" as const })), removedIds, changed: true };
}
