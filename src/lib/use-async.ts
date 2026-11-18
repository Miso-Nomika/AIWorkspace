"use client";

import { useEffect, useState } from "react";

export type AsyncState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "error"; error: unknown };

/**
 * key가 바뀔 때마다 load()를 다시 실행한다. key가 null이면 실행하지 않는다.
 * 이전 key의 늦게 도착한 결과는 버린다.
 * version은 같은 key에서 다시 읽고 싶을 때 올린다 — 이전 결과를 그대로 보여 주다가 새 결과로 바꾼다 (깜빡임 없음).
 */
export function useAsync<T>(key: string | null, load: () => Promise<T>, version = 0): AsyncState<T> {
  const [result, setResult] = useState<{ key: string; state: AsyncState<T> } | null>(null);

  useEffect(() => {
    if (key === null) return;
    let alive = true;
    load().then(
      (data) => alive && setResult({ key, state: { status: "success", data } }),
      (error) => alive && setResult({ key, state: { status: "error", error } }),
    );
    return () => {
      alive = false;
    };
    // load는 key로 식별한다 (매 렌더마다 새 함수여도 다시 실행하지 않음)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);

  if (key === null) return { status: "idle" };
  return result?.key === key ? result.state : { status: "loading" };
}
