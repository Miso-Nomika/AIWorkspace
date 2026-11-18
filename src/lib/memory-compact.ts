"use client";

// 공통 메모리 압축 (데스크톱): 분류마다 하나의 짧은 핵심 항목으로 합친다.
// 1) 초안 만들기 — Claude Code(도구 없이)가 압축 전 항목과 길어진 핵심 항목을 분류별로 합친 초안을 만든다.
// 2) 적용 — 사용자가 초안을 확인·수정한 뒤 적용. 적용 직전 내용은 이 PC의 앱 데이터에 백업하고(memories-backup),
//    합쳐진 옛 항목은 삭제 기록으로 바뀌어 다른 PC에도 반영된다.

import { desktop } from "./desktop";
import { applyCompaction, categoriesToCompact, legacyItems } from "./memory-core";
import { normalizeMemory } from "./memory-merge";
import { buildCompactPrompt, buildReactionDigest, pairReactions, parseCompaction } from "./memory-prompt";
import { getStored, setStored, whenStorageReady } from "./storage";
import type { ChatMessage, Memory, MemoryCategory, Project } from "./types";

export type CompactDrafts = Partial<Record<MemoryCategory, string>>;

function readMemories(): Memory[] {
  return getStored<Memory[]>("memories", []).map(normalizeMemory).filter((m): m is Memory => !!m);
}

/** 이 PC의 모든 프로젝트 대화에서 "에이전트 응답 → 사용자 반응" 쌍을 모은다 (오래된 순) */
function collectReactionPairs() {
  const projects = getStored<Project[]>("projects", []);
  return projects.flatMap((p) => pairReactions(p.name, getStored<ChatMessage[]>(`chat:${p.id}`, [])));
}

/** 압축 초안을 만든다. 분류별 본문을 돌려주고, 읽을 수 있는 결과가 없으면 COMPACT_EMPTY 오류 */
export async function draftCompaction(): Promise<CompactDrafts> {
  await whenStorageReady();
  const memories = readMemories();
  const categories = categoriesToCompact(memories);
  if (categories.length === 0) return {};
  // 최근 대화에서 사용자가 좋아한 방식은 강화하고 고치라고 한 방식은 피하도록 반응도 함께 넘긴다
  const output = await desktop.memoryAnalyze(buildCompactPrompt(memories, categories, buildReactionDigest(collectReactionPairs())));
  const drafts = parseCompaction(output, categories);
  if (Object.keys(drafts).length === 0) throw new Error("COMPACT_EMPTY");
  return drafts;
}

/** 초안을 적용한다. 적용 전 내용을 백업하고 합쳐진 항목 수를 돌려준다 */
export function applyCompactionDrafts(drafts: CompactDrafts): { merged: number } {
  const prev = readMemories();
  const merged = legacyItems(prev).filter((m) => drafts[m.category]?.trim()).length;
  const deviceId = getStored<{ id: string } | null>("device", null)?.id ?? "web";
  setStored("memories-backup", { at: new Date().toISOString(), items: prev });
  setStored("memories", applyCompaction(prev, drafts, deviceId, new Date().toISOString()));
  return { merged };
}
