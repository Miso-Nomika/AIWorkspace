"use client";

// 설치된 에이전트 CLI 감지 결과 (데스크톱 전용). 앱 실행 중 한 번 감지하고, 필요하면 refresh로 다시 감지한다.

import { useSyncExternalStore } from "react";
import { desktop, isDesktop, type AgentStatus } from "./desktop";
import type { AgentId } from "./types";

interface State {
  statuses: AgentStatus[] | null;
  loading: boolean;
}

let state: State = { statuses: null, loading: false };
let requested = false;
const listeners = new Set<() => void>();
const SERVER_STATE: State = { statuses: null, loading: false };

function setState(next: State) {
  state = next;
  listeners.forEach((l) => l());
}

function detect() {
  if (!isDesktop()) return;
  requested = true;
  setState({ ...state, loading: true });
  desktop
    .detectAgents()
    .then((statuses) => setState({ statuses, loading: false }))
    .catch((error) => {
      console.error("[agents] 감지 실패", error);
      setState({ ...state, loading: false });
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!requested) detect();
  return () => {
    listeners.delete(listener);
  };
}

export function useAgentStatuses() {
  const current = useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
  const find = (id: AgentId) => current.statuses?.find((s) => s.id === id) ?? null;
  return { ...current, find, refresh: detect };
}
