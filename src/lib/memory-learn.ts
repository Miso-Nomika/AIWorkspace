"use client";

// 대화 기록에서 개인 취향 학습 (데스크톱 전용).
// - 이 PC의 모든 프로젝트 대화에서 사용자 메시지를 모아 Claude Code(도구 없이)로 분석하고,
//   결과(학습 태그)를 공통 메모리에 반영한다 → memory-sync.ts가 Google Drive로 다른 PC에 전파.
// - 자동: 마지막 분석 이후 새 사용자 메시지가 AUTO_MIN_MESSAGES개 이상 쌓이면 백그라운드에서 실행.
// - 수동: 메모리 화면의 "대화 기록에서 학습".
// 응답마다 하는 즉시 학습(ChatPanel의 aiws-memory 태그)과 함께 동작한다.

import { useSyncExternalStore } from "react";
import { desktop, errorMessage, isDesktop } from "./desktop";
import { normalizeMemory } from "./memory-merge";
import { buildHistoryLearnPrompt, extractLearned, HISTORY_LEARN_LIMIT } from "./memory-prompt";
import { getStored, setStored, whenStorageReady } from "./storage";
import { learnIntoStore } from "./store";
import type { ChatMessage, Memory, Project } from "./types";

export interface LearnSettings {
  /** 자동 학습 사용 (기본 켜짐) */
  auto: boolean;
  /** 마지막으로 분석한 메시지 시각 — 이후 메시지만 분석한다 */
  lastMessageAt: string | null;
  lastRunAt: string | null;
}

export const DEFAULT_LEARN: LearnSettings = { auto: true, lastMessageAt: null, lastRunAt: null };
const AUTO_MIN_MESSAGES = 10;
const AUTO_CHECK_MS = 10 * 60_000;
const AUTO_FIRST_DELAY_MS = 60_000;

export interface LearnState {
  status: "idle" | "running" | "done" | "error";
  message: string | null;
  /** 마지막 실행에서 반영한 항목 제목 */
  learned: string[];
}

let state: LearnState = { status: "idle", message: null, learned: [] };
const listeners = new Set<() => void>();
let running: Promise<LearnState> | null = null;

function setState(next: LearnState) {
  state = next;
  listeners.forEach((l) => l());
}

export function getLearnSettings(): LearnSettings {
  return { ...DEFAULT_LEARN, ...getStored<Partial<LearnSettings>>("learn", {}) };
}

export function setLearnSettings(patch: Partial<LearnSettings>) {
  setStored("learn", { ...getLearnSettings(), ...patch });
}

/** 마지막 분석 이후의 사용자 메시지 (오래된 순, 모든 프로젝트) */
export function collectNewUserMessages(since: string | null) {
  const projects = getStored<Project[]>("projects", []);
  const items: { project: string; text: string; at: string }[] = [];
  for (const p of projects) {
    for (const m of getStored<ChatMessage[]>(`chat:${p.id}`, [])) {
      if (m.role !== "user" || !m.content.trim()) continue;
      if (since && m.createdAt <= since) continue;
      items.push({ project: p.name, text: m.content, at: m.createdAt });
    }
  }
  return items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

async function run(): Promise<LearnState> {
  await whenStorageReady();
  const settings = getLearnSettings();
  const messages = collectNewUserMessages(settings.lastMessageAt);
  if (messages.length === 0) {
    const next: LearnState = { status: "done", message: "새로 분석할 대화가 없습니다.", learned: [] };
    setState(next);
    return next;
  }
  setState({ status: "running", message: `대화 ${messages.length}개를 분석하는 중…`, learned: [] });
  try {
    const memories = getStored<Memory[]>("memories", []).map(normalizeMemory).filter((m): m is Memory => !!m);
    const output = await desktop.memoryAnalyze(buildHistoryLearnPrompt(messages, memories));
    const { learned } = extractLearned(output, HISTORY_LEARN_LIMIT);
    const changed = learnIntoStore(learned);
    setLearnSettings({ lastMessageAt: messages[messages.length - 1].at, lastRunAt: new Date().toISOString() });
    const next: LearnState = {
      status: "done",
      message: changed ? `${changed}개 항목을 메모리에 반영했습니다.` : "새로 반영할 취향이 없습니다.",
      learned: changed ? learned.map((l) => l.title) : [],
    };
    setState(next);
    return next;
  } catch (error) {
    const next: LearnState = { status: "error", message: errorMessage(error), learned: [] };
    setState(next);
    return next;
  }
}

/** 지금 대화 기록에서 학습. 실행 중이면 그 결과를 기다린다. */
export function learnFromHistoryNow(): Promise<LearnState> {
  if (!isDesktop()) return Promise.resolve(state);
  running ??= run().finally(() => {
    running = null;
  });
  return running;
}

let started = false;

/** 앱 시작 시 한 번 호출. 새 대화가 충분히 쌓이면 자동으로 학습한다. */
export function startAutoLearn() {
  if (started || !isDesktop()) return;
  started = true;
  const check = () => {
    const settings = getLearnSettings();
    if (!settings.auto || running) return;
    if (collectNewUserMessages(settings.lastMessageAt).length >= AUTO_MIN_MESSAGES) void learnFromHistoryNow();
  };
  void whenStorageReady().then(() => {
    setTimeout(check, AUTO_FIRST_DELAY_MS);
    setInterval(check, AUTO_CHECK_MS);
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const SERVER_STATE: LearnState = { status: "idle", message: null, learned: [] };

export function useLearnState(): LearnState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
}
