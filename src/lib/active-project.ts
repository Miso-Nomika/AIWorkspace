"use client";

// 마지막으로 보던 프로젝트. 사이드바의 "프로젝트" 탭이 목록 대신 이 프로젝트로 돌아가게 한다.
// (프로젝트 화면은 ProjectHost가 계속 살려 두므로, 돌아가면 작업하던 상태 그대로 보인다. 앱을 다시 시작하면 초기화)

import { useSyncExternalStore } from "react";

let last: string | null = null;
const listeners = new Set<() => void>();

export function setLastProject(id: string | null) {
  if (id === last) return;
  last = id;
  listeners.forEach((l) => l());
}

export function useLastProject(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => last,
    () => null,
  );
}
