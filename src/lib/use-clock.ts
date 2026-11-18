"use client";

// 현재 시각(초 단위) 구독. 다음 초가 시작되는 시점마다 알리고, 화면이 다시 보이면(다른 앱을 보다 돌아오면) 바로 알린다.
// 홈의 시계 위젯과 위쪽 바의 작은 시계가 함께 쓴다.

import { useSyncExternalStore } from "react";
import { msUntilNextSecond } from "./clock-core";

function subscribe(onChange: () => void) {
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    timer = setTimeout(() => {
      onChange();
      schedule();
    }, msUntilNextSecond(Date.now()));
  };
  const onVisible = () => {
    if (!document.hidden) onChange();
  };
  schedule();
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

const nowSecond = () => Math.floor(Date.now() / 1000);
/** 서버(정적 렌더링)에는 시각이 없다 — 하이드레이션이 끝난 뒤에 채운다 */
const serverSecond = () => null;

/** 지금 시각의 Date (1초마다 갱신, 정적 렌더링 중에는 null) */
export function useClockDate(): Date | null {
  const second = useSyncExternalStore<number | null>(subscribe, nowSecond, serverSecond);
  return second === null ? null : new Date(second * 1000);
}
