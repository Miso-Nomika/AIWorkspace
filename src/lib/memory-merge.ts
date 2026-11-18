// 공통 메모리 병합 (순수 함수, 외부 의존 없음 — node로 직접 테스트 가능)
// 규칙: 같은 id면 updatedAt이 늦은 쪽이 이긴다. 같으면 삭제 > 기기 ID 큰 쪽 (모든 PC에서 같은 결과).

import type { Memory, MemoryCategory } from "./types";

const CATEGORIES: MemoryCategory[] = ["preference", "communication", "feedback"];
// 0.3.x 이전 분류 → 현재 분류
const LEGACY_CATEGORY: Record<string, MemoryCategory> = { other: "preference" };
// 없앤 분류: 코드 작성 방식(코딩 스타일·기술 스택)은 에이전트가 판단하므로 저장하지 않는다. 이 분류의 항목은 불러올 때 버린다
const RETIRED_CATEGORIES = new Set(["coding", "style", "tech"]);

export function normalizeCategory(value: unknown): MemoryCategory {
  if (CATEGORIES.includes(value as MemoryCategory)) return value as MemoryCategory;
  return LEGACY_CATEGORY[String(value)] ?? "preference";
}

/** 외부(다른 PC 파일 등)에서 온 값을 검증·정규화한다. 형식이 틀리면 null */
export function normalizeMemory(value: unknown): Memory | null {
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  if (typeof m.id !== "string" || !m.id || typeof m.updatedAt !== "string") return null;
  if (RETIRED_CATEGORIES.has(String(m.category))) return null;
  return {
    id: m.id,
    category: normalizeCategory(m.category),
    title: typeof m.title === "string" ? m.title : "",
    content: typeof m.content === "string" ? m.content : "",
    updatedAt: m.updatedAt,
    ...(typeof m.deletedAt === "string" ? { deletedAt: m.deletedAt } : {}),
    ...(typeof m.updatedBy === "string" ? { updatedBy: m.updatedBy } : {}),
    ...(m.source === "learned" || m.source === "manual" ? { source: m.source } : {}),
  };
}

function wins(a: Memory, b: Memory): boolean {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  if (!!a.deletedAt !== !!b.deletedAt) return !!a.deletedAt;
  return (a.updatedBy ?? "") > (b.updatedBy ?? "");
}

/** 여러 출처(이 PC, 다른 PC들)의 메모리 목록을 하나로 합친다. 최신 수정이 앞에 온다. */
export function mergeMemories(lists: Memory[][]): Memory[] {
  const byId = new Map<string, Memory>();
  for (const list of lists) {
    for (const item of list) {
      const current = byId.get(item.id);
      if (!current || wins(item, current)) byId.set(item.id, item);
    }
  }
  return [...byId.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id.localeCompare(b.id)));
}

/** 내용이 같은지 (순서 무관) */
export function sameMemories(a: Memory[], b: Memory[]): boolean {
  if (a.length !== b.length) return false;
  const key = (list: Memory[]) => JSON.stringify([...list].sort((x, y) => x.id.localeCompare(y.id)));
  return key(a) === key(b);
}

export function activeMemories(list: Memory[]): Memory[] {
  return list.filter((m) => !m.deletedAt);
}

// ── 정리: 중복 항목 · 오래된 삭제 기록 ──

/** 삭제 기록 보관 기간. 이보다 오래 동기화하지 않은 PC가 있으면 그 PC의 항목이 되살아날 수 있다. */
export const TOMBSTONE_TTL_DAYS = 180;

/** 비교용: 대소문자·공백·문장부호 차이를 무시한다 */
export function dedupeKey(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function tombstone(m: Memory, at: string): Memory {
  return { id: m.id, category: m.category, title: m.title, content: "", updatedAt: at, deletedAt: at, ...(m.updatedBy ? { updatedBy: m.updatedBy } : {}) };
}

/**
 * 공통 메모리 정리. 다른 항목은 건드리지 않는다.
 * - 내용이 같은 항목: 가장 최근 것만 남긴다.
 * - 같은 분류·같은 제목의 '자동 학습' 항목: 더 최근 항목이 있으면 지운다 (같은 주제를 다시 학습한 것 = 갱신).
 *   직접 작성한 항목은 제목이 같아도 내용이 다르면 유지한다.
 * - 오래된 삭제 기록(TOMBSTONE_TTL_DAYS)을 지운다.
 * 지운 항목은 삭제 기록으로 남겨 다른 PC에도 전파한다. 시각은 남긴 항목의 수정 시각을 써서
 * 모든 PC가 같은 결과를 만든다 (현재 시각을 쓰면 PC마다 달라져 동기화가 끝나지 않는다).
 */
export function cleanupMemories(list: Memory[], now = Date.now()): { list: Memory[]; removed: number; purged: number } {
  const cutoff = new Date(now - TOMBSTONE_TTL_DAYS * 86_400_000).toISOString();
  const order = [...list].sort((a, b) => (a.updatedAt !== b.updatedAt ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.id < b.id ? 1 : -1));
  const byContent = new Map<string, Memory>();
  const byTitle = new Map<string, Memory>();
  const result: Memory[] = [];
  let removed = 0;
  let purged = 0;

  for (const m of order) {
    if (m.deletedAt) {
      if (m.deletedAt < cutoff) purged++;
      else result.push(m);
      continue;
    }
    const contentKey = `${dedupeKey(m.content)}`;
    const titleKey = `${m.category}:${dedupeKey(m.title)}`;
    const newer = (contentKey && byContent.get(contentKey)) || (m.source === "learned" && byTitle.get(titleKey)) || null;
    if (newer) {
      removed++;
      result.push(tombstone(m, newer.updatedAt));
      continue;
    }
    if (contentKey) byContent.set(contentKey, m);
    if (!byTitle.has(titleKey)) byTitle.set(titleKey, m);
    result.push(m);
  }
  if (!removed && !purged) return { list, removed, purged };
  return { list: mergeMemories([result]), removed, purged };
}
