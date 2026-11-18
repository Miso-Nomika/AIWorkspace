"use client";

// 키-값 저장소. 화면은 store.ts의 도메인 훅을 거쳐서만 사용한다.
// 앱 데이터 폴더의 키별 JSON 파일에 저장한다 (src-tauri/src/data.rs).
// 시작할 때 전체를 메모리로 읽어 두고(동기 읽기), 쓰기는 즉시 반영한 뒤 파일에 비동기로 저장한다.

import { useCallback, useSyncExternalStore } from "react";
import { desktop } from "./desktop";

interface Driver {
  loadAll(): Promise<Record<string, unknown>>;
  save(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

const fileDriver: Driver = {
  async loadAll() {
    const data = await desktop.loadAllData();
    // 이 기기의 고유 ID. 프로젝트 폴더가 어느 PC에 있는지 구분하는 기준 (platform.ts)
    if (!data.device) {
      data.device = { id: crypto.randomUUID(), createdAt: new Date().toISOString() };
      await desktop.saveData("device", data.device);
    }
    return data;
  },
  save: (key, value) => desktop.saveData(key, value),
  remove: (key) => desktop.removeData(key),
};

const cache = new Map<string, unknown>();
const listeners = new Set<() => void>();
const pendingWrites = new Map<string, Promise<void>>();
let ready = false;
let driver: Driver | null = null;
let readyPromise: Promise<void> | null = null;

function notify() {
  listeners.forEach((l) => l());
}

function ensureInit(): Promise<void> {
  if (readyPromise) return readyPromise;
  driver = fileDriver;
  readyPromise = driver
    .loadAll()
    .then((data) => Object.entries(data).forEach(([k, v]) => cache.set(k, v)))
    .catch((error) => console.error("[storage] 데이터를 불러오지 못했습니다", error))
    .finally(() => {
      ready = true;
      notify();
    });
  return readyPromise;
}

// ── 훅 밖(백그라운드 동기화 등)에서 쓰는 접근 함수 ──

/** 저장소를 다 읽을 때까지 기다린다 */
export function whenStorageReady(): Promise<void> {
  return ensureInit();
}

export function getStored<T>(key: string, fallback: T): T {
  return ready ? read(key, fallback) : fallback;
}

export function setStored<T>(key: string, value: T) {
  write(key, value);
}

/** 저장소 변경 알림 (모든 키). 해제 함수를 돌려준다 */
export function subscribeStorage(listener: () => void): () => void {
  return subscribe(listener);
}

/** 같은 키의 저장 순서를 보장한다. */
function persist(key: string, op: (d: Driver) => Promise<void>) {
  const d = driver;
  if (!d) return;
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const next = previous
    .then(() => op(d))
    .catch((error) => console.error(`[storage] '${key}' 저장 실패`, error));
  pendingWrites.set(key, next);
}

/** 진행 중인 저장이 모두 끝날 때까지 기다린다 (예: 새 프로젝트 등록 직후 Rust가 projects.json을 읽기 전). */
export async function flushStorage() {
  await Promise.all(pendingWrites.values());
}

function read<T>(key: string, fallback: T): T {
  return cache.has(key) ? (cache.get(key) as T) : fallback;
}

function write<T>(key: string, value: T) {
  cache.set(key, value);
  notify();
  persist(key, (d) => d.save(key, value));
}

/** 키 삭제 (예: 프로젝트 삭제 시 해당 채팅 기록 정리) */
export function removeStored(key: string) {
  cache.delete(key);
  notify();
  persist(key, (d) => d.remove(key));
}

function subscribe(listener: () => void) {
  ensureInit();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 저장되는 상태. `fallback`은 모듈 상수처럼 참조가 고정된 값을 넘긴다.
 * 저장소를 다 읽기 전(정적 렌더링, 로딩 중)에는 fallback을 돌려준다 → useHydrated()로 로딩 표시.
 */
export function useStoredState<T>(key: string, fallback: T) {
  const value = useSyncExternalStore(
    subscribe,
    () => (ready ? read(key, fallback) : fallback),
    () => fallback,
  );

  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = read(key, fallback);
      write(key, typeof next === "function" ? (next as (p: T) => T)(prev) : next);
    },
    [key, fallback],
  );

  return [value, setValue] as const;
}

/** 저장소를 모두 읽어 화면에 쓸 준비가 되었는지 */
export function useHydrated() {
  return useSyncExternalStore(
    subscribe,
    () => ready,
    () => false,
  );
}

export function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
