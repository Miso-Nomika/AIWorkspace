"use client";

// 도메인별 데이터 접근 훅. 화면은 이 훅만 사용한다.
// 저장 위치를 바꿀 때 화면 코드는 그대로 두고 여기만 수정한다.
//
// 데이터 범위 (클라우드 동기화 기준)
// - 기기 전용: projects, chat:<id>, session:<id>, device — 이 PC의 폴더 경로와 묶여 있어 동기화하지 않는다.
// - 기기 전용(화면): ui(사이드바·패널 너비), setup(첫 실행 설정), learn(대화 기록 학습 상태).
// - 동기화 대상: memories — 개인 취향·대화 방식·피드백. prefs — 테마.
//   Google Drive 폴더로 모든 PC와 양방향 동기화한다 (memory-sync.ts, 마지막 수정 우선 + 삭제 기록).

import { useCallback, useMemo } from "react";
import { migrateProjects } from "./legacy";
import { mergeLearnedIntoCore, upsertCore } from "./memory-core";
import { activeMemories, normalizeMemory } from "./memory-merge";
import type { LearnedMemory } from "./memory-prompt";
import { getStored, newId, removeStored, setStored, useStoredState, whenStorageReady } from "./storage";
import type { AgentId, ChatMessage, Memory, MemoryCategory, Project } from "./types";

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_PROJECTS: Project[] = [];
const EMPTY_MEMORIES: Memory[] = [];
const EMPTY_SESSIONS: Partial<Record<AgentId, string>> = {};
const chatKey = (projectId: string) => `chat:${projectId}`;
/** 에이전트별 대화 세션 ID (Claude Code --resume 용). 대화를 지우면 함께 지운다. */
const sessionKey = (projectId: string) => `session:${projectId}`;

export function useProjects() {
  const [projects, setProjects] = useStoredState<Project[]>("projects", EMPTY_PROJECTS);

  const createProject = useCallback(
    (input: Omit<Project, "id" | "createdAt">) => {
      const project: Project = { id: newId(), createdAt: new Date().toISOString(), ...input };
      setProjects((prev) => [project, ...prev]);
      return project;
    },
    [setProjects],
  );

  const updateProject = useCallback(
    (id: string, patch: Partial<Omit<Project, "id">>) => {
      setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    },
    [setProjects],
  );

  const deleteProject = useCallback(
    (id: string) => {
      setProjects((prev) => prev.filter((p) => p.id !== id));
      removeStored(chatKey(id));
      removeStored(sessionKey(id));
    },
    [setProjects],
  );

  return { projects, createProject, updateProject, deleteProject };
}

export function useChat(projectId: string) {
  const [messages, setMessages] = useStoredState<ChatMessage[]>(chatKey(projectId), EMPTY_MESSAGES);

  const addMessage = useCallback(
    (msg: Omit<ChatMessage, "id" | "createdAt">) => {
      setMessages((prev) => [...prev, { ...msg, id: newId(), createdAt: new Date().toISOString() }]);
    },
    [setMessages],
  );

  const [sessions, setSessions] = useStoredState(sessionKey(projectId), EMPTY_SESSIONS);

  const setSession = useCallback(
    (agent: AgentId, sessionId: string) => setSessions((prev) => ({ ...prev, [agent]: sessionId })),
    [setSessions],
  );

  const clear = useCallback(() => {
    setMessages([]);
    removeStored(sessionKey(projectId));
  }, [setMessages, projectId]);

  return { messages, addMessage, sessions, setSession, clear };
}

const EMPTY_DEVICE = null as { id: string } | null;

/**
 * 공통 메모리. 저장 형식에는 삭제 기록(deletedAt)이 남아 있고, 화면에는 활성 항목만 돌려준다.
 * 동기화는 memory-sync.ts가 이 데이터를 기준으로 백그라운드에서 처리한다.
 */
export function useMemories() {
  const [stored, setMemories] = useStoredState<Memory[]>("memories", EMPTY_MEMORIES);
  const [device] = useStoredState("device", EMPTY_DEVICE);
  const deviceId = device?.id ?? "web";

  const all = useMemo(() => stored.map(normalizeMemory).filter((m): m is Memory => !!m), [stored]);
  const memories = useMemo(() => activeMemories(all), [all]);

  /** 분류별 핵심 항목을 직접 고친다 (내용을 비우면 그 분류 항목을 삭제) */
  const saveCore = useCallback(
    (category: MemoryCategory, content: string) => {
      setMemories((prev) => upsertCore(prev, category, content, deviceId, new Date().toISOString(), "manual"));
    },
    [setMemories, deviceId],
  );

  /** 삭제는 기록으로 남겨 다른 PC에도 전파한다 */
  const deleteMemory = useCallback(
    (id: string) => {
      const now = new Date().toISOString();
      setMemories((prev) =>
        prev.map((m) =>
          m.id === id ? { id: m.id, category: m.category, title: m.title, content: "", updatedAt: now, deletedAt: now, updatedBy: deviceId } : m,
        ),
      );
    },
    [setMemories, deviceId],
  );

  /** AI 응답에서 학습한 항목을 분류별 핵심 항목에 한 줄씩 덧붙인다. 바뀐 항목 수를 돌려준다 */
  const learnMemories = useCallback((items: LearnedMemory[]) => learnIntoStore(items, deviceId), [deviceId]);

  return { memories, saveCore, deleteMemory, learnMemories };
}

/** 학습 항목을 공통 메모리에 반영 (훅 밖 — 대화 기록 학습 등에서도 사용). 바뀐 항목 수 */
export function learnIntoStore(items: LearnedMemory[], deviceId?: string): number {
  if (!items.length) return 0;
  const by = deviceId ?? getStored<{ id: string } | null>("device", null)?.id ?? "web";
  const prev = getStored<Memory[]>("memories", EMPTY_MEMORIES);
  const { list, changed } = mergeLearnedIntoCore(prev, items, by, new Date().toISOString());
  if (changed) setStored("memories", list);
  return changed;
}

// ── 이전 버전 데이터 정리 (앱 시작 시 한 번) ──

/** 시연용 샘플 프로젝트와 그 대화 기록을 지우고, 다른 에이전트로 지정된 프로젝트를 Claude Code로 바꾼다 (legacy.ts). 메모리는 건드리지 않는다. */
export async function cleanupLegacyData() {
  await whenStorageReady();
  const result = migrateProjects(getStored<Project[]>("projects", EMPTY_PROJECTS));
  if (!result.changed) return;
  setStored("projects", result.projects);
  for (const id of result.removedIds) {
    removeStored(chatKey(id));
    removeStored(sessionKey(id));
  }
}
