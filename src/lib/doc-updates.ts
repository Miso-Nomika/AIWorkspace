// 에이전트가 이번 응답에서 표준 문서(TODO.md·기능명세서.md)를 고쳤는지 도구 기록에서 찾는다.
// (순수 함수, 외부 의존 없음 — node로 직접 테스트 가능)

import type { ActivityItem } from "./types";

/** 프로젝트 루트의 표준 문서 */
export const DOC_FILES = ["TODO.md", "기능명세서.md"] as const;

// claude-stream.ts의 describeTool이 만드는 라벨: "파일 수정: <프로젝트 기준 경로>", "파일 작성: <경로>"
const EDIT_LABEL = /^(?:파일 수정|파일 작성): (.+)$/;

/**
 * 이번 응답에서 실제로 고친 표준 문서 이름 (TODO.md, 기능명세서.md 순서, 중복 없음).
 * 프로젝트 루트의 문서만 센다. 권한이 거부되었거나 오류로 끝난 수정은 제외한다.
 */
export function docUpdates(activity: (ActivityItem | string)[] | undefined): string[] {
  const touched = new Set<string>();
  for (const item of activity ?? []) {
    if (typeof item === "string" || item.denied || item.isError) continue;
    const path = EDIT_LABEL.exec(item.label)?.[1]?.trim().replace(/\\/g, "/");
    if (!path) continue;
    const doc = DOC_FILES.find((name) => name.toLowerCase() === path.toLowerCase());
    if (doc) touched.add(doc);
  }
  return DOC_FILES.filter((name) => touched.has(name));
}
