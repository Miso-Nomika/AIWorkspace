"use client";

// 개인 홈 — 미국 물가·금리 자료 캐시와 갱신.
// 해석한 월 단위 값만 이 PC(`home-macro`)에 저장하고, 홈을 열 때 하루(24시간)가 지났으면 새로 받는다.
// 물가나 금리 한쪽만 실패해도 다른 쪽과 기존 값은 그대로 두고, 같은 요청은 한 번만 보낸다.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { desktop, errorMessage } from "./desktop";
import {
  EMPTY_MACRO,
  MacroFormatError,
  cacheNeedsRefresh,
  monthlyAverage,
  normalizeMacroCache,
  parseBls,
  parseEffr,
  pickRange,
  yearOverYear,
  type MacroCache,
  type MacroRange,
} from "./macro-core";
import { getStored, setStored, useStoredState, whenStorageReady } from "./storage";

const KEY = "home-macro";
const SETTINGS_KEY = "home-settings";
const EMPTY_SETTINGS: { macroRange?: unknown } = {};

function readCache(): MacroCache {
  return normalizeMacroCache(getStored<unknown>(KEY, EMPTY_MACRO));
}

// ── 갱신 중 상태 (저장하지 않음) ──
let refreshing = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const setRefreshing = (value: boolean) => {
  refreshing = value;
  listeners.forEach((l) => l());
};

function explain(error: unknown): string {
  return error instanceof MacroFormatError ? error.message : errorMessage(error);
}

/** 물가·금리를 받아 저장한다. 이미 받는 중이면 그 요청을 기다린다. 한쪽이 실패해도 성공한 쪽은 저장한다 */
export function refreshMacro(): Promise<void> {
  if (inflight) return inflight;
  setRefreshing(true);
  inflight = (async () => {
    const [cpi, rate] = await Promise.allSettled([
      desktop.fetchCpi().then((texts) => parseBls(texts)),
      desktop.fetchEffr().then((text) => monthlyAverage(parseEffr(text))),
    ]);
    const now = new Date().toISOString();
    const old = readCache();
    const errors: string[] = [];
    let next: MacroCache = { ...old };
    if (cpi.status === "fulfilled") next = { ...next, cpi: cpi.value, cpiAt: now };
    else errors.push(`물가: ${explain(cpi.reason)}`);
    if (rate.status === "fulfilled") next = { ...next, rate: rate.value, rateAt: now };
    else errors.push(`금리: ${explain(rate.reason)}`);
    setStored<MacroCache>(KEY, { ...next, error: errors.length ? errors.join(" / ") : null });
  })().finally(() => {
    inflight = null;
    setRefreshing(false);
  });
  return inflight;
}

/** 홈에서 쓴다: 저장된 자료와 전년비, 갱신 중 여부, 새로고침. 처음 열 때(또는 하루가 지났을 때) 자동으로 한 번 받는다 */
export function useMacroData() {
  const [stored] = useStoredState<unknown>(KEY, EMPTY_MACRO);
  const cache = normalizeMacroCache(stored);
  const busy = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => refreshing,
    () => false,
  );
  const refresh = useCallback(() => void refreshMacro(), []);
  useEffect(() => {
    // 저장소를 다 읽은 뒤에 판단한다 (읽기 전에는 저장된 자료가 있어도 비어 보인다)
    void whenStorageReady().then(() => {
      if (cacheNeedsRefresh(readCache(), Date.now())) void refreshMacro();
    });
  }, []);
  return { cache, inflation: yearOverYear(cache.cpi), busy, refresh };
}

/** 그래프 기간 설정 (이 PC에 저장) */
export function useMacroRange(): [MacroRange, (range: MacroRange) => void] {
  const [settings, setSettings] = useStoredState<{ macroRange?: unknown }>(SETTINGS_KEY, EMPTY_SETTINGS);
  const range = pickRange(settings.macroRange);
  return [range, (next) => setSettings({ ...settings, macroRange: next })];
}
