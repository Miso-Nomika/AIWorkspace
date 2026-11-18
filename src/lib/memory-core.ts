// 공통 메모리의 "분류별 핵심 항목" (순수 함수, 외부 의존 없음 — node로 직접 테스트 가능).
// 취향·코딩·대화·피드백 분류마다 항목을 하나(id: core-<분류>)만 두고, 불릿 목록으로 모은다.
// 자동 학습은 새 항목을 만들지 않고 그 분류의 핵심 항목에 한 줄씩 덧붙인다 → 에이전트 지침이 더 커지지 않는다.

import { dedupeKey, tombstone } from "./memory-merge.ts";
import type { Memory, MemoryCategory } from "./types";

export const CATEGORIES: MemoryCategory[] = ["preference", "communication", "feedback"];

export const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  preference: "개인 취향",
  communication: "대화 방식",
  feedback: "피드백",
};

/** 분류 하나(개인 취향·대화 방식·피드백)의 글자 수가 이 값을 넘으면 압축을 권한다 — 한 분류라도 넘으면 권한다 */
export const CATEGORY_BUDGET_CHARS = 2000;

export interface LearnedItem {
  category: MemoryCategory;
  title: string;
  content: string;
}

export const coreId = (category: MemoryCategory) => `core-${category}`;

export function isCore(m: Memory): boolean {
  return m.id === coreId(m.category);
}

/** 압축 전의 개별 항목 (핵심 항목이 아닌 활성 항목) */
export function legacyItems(list: Memory[]): Memory[] {
  return list.filter((m) => !m.deletedAt && !isCore(m));
}

/** 삭제되지 않은 모든 항목(분류별 핵심 항목 + 압축 전 항목)의 글자 수 합계 */
export function totalChars(list: Memory[]): number {
  return list.filter((m) => !m.deletedAt).reduce((sum, m) => sum + m.content.length, 0);
}

/** 한 분류의 글자 수 (삭제되지 않은 항목의 내용 합계) */
export function categoryChars(list: Memory[], category: MemoryCategory): number {
  return list.filter((m) => !m.deletedAt && m.category === category).reduce((sum, m) => sum + m.content.length, 0);
}

/** 한도(분류당 CATEGORY_BUDGET_CHARS)를 넘은 분류 */
export function overBudgetCategories(list: Memory[]): MemoryCategory[] {
  return CATEGORIES.filter((c) => categoryChars(list, c) > CATEGORY_BUDGET_CHARS);
}

/** 한 분류라도 한도를 넘었는지 */
export function overBudget(list: Memory[]): boolean {
  return overBudgetCategories(list).length > 0;
}

/** 압축이 필요한 분류: 압축 전 항목이 남아 있는 분류, 그리고 한 분류라도 한도를 넘었으면 내용이 있는 모든 분류
 *  (사용자 반응을 보고 강화·회피를 다시 정리하는 압축이라 한도를 넘지 않은 분류도 함께 다듬는다) */
export function categoriesToCompact(list: Memory[]): MemoryCategory[] {
  const legacy = new Set(legacyItems(list).map((m) => m.category));
  const over = overBudget(list);
  return CATEGORIES.filter((c) => legacy.has(c) || (over && list.some((m) => !m.deletedAt && m.category === c)));
}

/** 한 줄짜리 불릿 ("- 내용") */
export function bullet(text: string): string {
  return `- ${text.trim().replace(/\s*\n\s*/g, " ")}`;
}

/** 핵심 항목을 만들거나 바꾼다. 내용이 비면 삭제 기록으로 바꾼다 (다른 PC에도 전파). */
export function upsertCore(list: Memory[], category: MemoryCategory, content: string, deviceId: string, now: string, source: Memory["source"]): Memory[] {
  const id = coreId(category);
  const text = content.trim();
  const existing = list.find((m) => m.id === id);
  if (!text) return existing && !existing.deletedAt ? list.map((m) => (m.id === id ? { ...tombstone(m, now), updatedBy: deviceId } : m)) : list;
  const entry: Memory = { id, category, title: CATEGORY_LABELS[category], content: text, updatedAt: now, updatedBy: deviceId, source };
  return existing ? list.map((m) => (m.id === id ? entry : m)) : [entry, ...list];
}

// 비밀번호·키·토큰처럼 보이는 내용. 학습 결과는 Drive·프로젝트 파일(git)에 남으므로 저장 전에 거른다.
const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/, // OpenAI·Anthropic 등 API 키 (sk-…, sk-ant-…)
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub 토큰
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS 액세스 키
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API 키
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack 토큰
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /:\/\/[^/\s:@]+:[^/\s@]+@/, // 주소에 들어 있는 아이디:비밀번호
  /\b(?:password|passwd|pwd|secret|api[_ -]?key|access[_ -]?token|token)\s*[:=]\s*["']?[^\s"']{6,}/i, // password: 값
  /(?:비밀번호|비번|패스워드|암호|토큰|시크릿)\s*(?:은|는|이|가)?\s*[:=]?\s*["']?[^\s"']*\d[^\s"']*/, // 비번은 철수0312야 (값에 숫자가 있을 때만)
];

/** 비밀번호·API 키·토큰처럼 보이는지. 학습 결과를 저장하기 전에 걸러 낸다 (패턴 기반이라 모든 비밀을 잡지는 못한다) */
export function looksSensitive(text: string): boolean {
  if (SENSITIVE_PATTERNS.some((re) => re.test(text))) return true;
  // 길고 무작위로 보이는 한 덩어리(공백 없이 32자 이상, 영문자와 숫자가 섞임). 주소는 제외
  return text.split(/\s+/).some((token) => token.length >= 32 && !/^https?:\/\//i.test(token) && /[A-Za-z]/.test(token) && /\d/.test(token) && /^[A-Za-z0-9+/_=-]+$/.test(token));
}

/**
 * 학습한 항목을 분류별 핵심 항목에 한 줄씩 덧붙인다. 이미 들어 있는 내용은 건너뛴다.
 * 비밀번호·키·토큰처럼 보이는 항목은 저장하지 않는다.
 * (핵심 항목이 삭제 기록 상태였으면 새로 만든다 — 더 늦은 수정이라 모든 PC에서 이 쪽이 이긴다)
 */
export function mergeLearnedIntoCore(list: Memory[], items: LearnedItem[], deviceId: string, now: string): { list: Memory[]; changed: number } {
  let next = list;
  let changed = 0;
  for (const item of items) {
    if (looksSensitive(`${item.title} ${item.content}`)) continue;
    const existing = next.find((m) => m.id === coreId(item.category));
    const body = existing && !existing.deletedAt ? existing.content : "";
    if (dedupeKey(item.content) === "" || dedupeKey(body).includes(dedupeKey(item.content))) continue;
    next = upsertCore(next, item.category, body ? `${body}\n${bullet(item.content)}` : bullet(item.content), deviceId, now, "learned");
    changed++;
  }
  return { list: next, changed };
}

/**
 * 압축 결과 적용: 초안이 있는 분류마다 핵심 항목을 초안으로 바꾸고, 그 분류의 압축 전 항목은 삭제 기록으로 바꾼다.
 * 초안이 없는 분류는 그대로 둔다.
 */
export function applyCompaction(list: Memory[], drafts: Partial<Record<MemoryCategory, string>>, deviceId: string, now: string): Memory[] {
  let next = list;
  for (const category of CATEGORIES) {
    const draft = drafts[category]?.trim();
    if (!draft) continue;
    next = next.map((m) => (!m.deletedAt && !isCore(m) && m.category === category ? { ...tombstone(m, now), updatedBy: deviceId } : m));
    next = upsertCore(next, category, draft, deviceId, now, "manual");
  }
  return next;
}
