"use client";

// 홈 위젯 동기화 (데스크톱 전용): 위젯 정의·체크 상태·크기·숨김·순서·삭제 기록을 Drive(.AIWorkspace)의 home-<기기ID>.json으로 주고받는다.
// 음악 동기화(music-sync.ts)와 같은 방식 — 각 기기는 자기 파일만 쓰고 다른 기기 파일은 읽기만 해서 충돌이 없고,
// 위젯마다 마지막으로 바꾼 쪽이 이긴다(home-merge.ts). 위젯이 받은 자료와 물가 캐시는 올리지 않는다(각 PC가 따로 받는다).
// 시점: 앱 시작, 30초마다, 홈 변경 직후(1.5초 묶음), 동기화 설정 변경·창 포커스·네트워크 복귀 시.
// 동기화 폴더는 공통 메모리와 같은 설정(sync.folder)을 쓴다 — 설정하지 않았으면 이 PC에만 저장한다.

import { desktop, isDesktop } from "./desktop";
import { applyMergedHome, getHome } from "./home-store";
import { homeStamp, mergeHome, normalizeSnapshot, pruneHomeTombstones } from "./home-merge";
import type { HomeFile } from "./home-widget-core";
import { getStored, subscribeStorage, whenStorageReady } from "./storage";
import type { SyncSettings } from "./memory-sync";

const SYNC_INTERVAL_MS = 30_000;
const CHANGE_DEBOUNCE_MS = 1_500;
const SNAPSHOT_SCHEMA = 1;

let running: Promise<void> | null = null;
let queued = false;
let started = false;

async function runSync() {
  await whenStorageReady();
  const settings = getStored<Partial<SyncSettings>>("sync", {});
  const device = getStored<{ id: string } | null>("device", null);
  if (!settings.folder || !device) return;
  try {
    const snapshots = await desktop.homeSyncPull(settings.folder);
    const remote = snapshots.map(normalizeSnapshot).filter((h): h is HomeFile => !!h);
    // 동기화 중에 사용자가 바꾼 것도 잃지 않도록 최신 로컬과 한 번 더 합친다 (로컬을 항상 맨 앞에 둔다)
    const merged = pruneHomeTombstones(mergeHome([getHome(), ...remote]), Date.now());
    const latest = pruneHomeTombstones(mergeHome([getHome(), merged]), Date.now());
    applyMergedHome(latest);
    await desktop.homeSyncPush(settings.folder, device.id, { schema: SNAPSHOT_SCHEMA, deviceId: device.id, updatedAt: homeStamp(latest), ...latest });
  } catch (error) {
    // 동기화 폴더가 꺼져 있거나(오프라인) 일시적 오류 — 이 PC에 저장된 홈으로 계속 쓰고 다음 기회에 다시 시도한다
    console.warn("[home] 위젯 동기화를 건너뜁니다", error);
  }
}

/** 지금 동기화. 실행 중이면 끝난 뒤 한 번 더 실행한다. */
export function syncHomeNow(): Promise<void> {
  if (!isDesktop()) return Promise.resolve();
  if (running) {
    queued = true;
    return running;
  }
  running = runSync().finally(() => {
    running = null;
    if (queued) {
      queued = false;
      void syncHomeNow();
    }
  });
  return running;
}

/** 앱 시작 시 한 번 호출 */
export function startHomeSync() {
  if (started || !isDesktop()) return;
  started = true;
  let lastHome: unknown;
  let lastSettings: unknown;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void syncHomeNow(), delay);
  };
  void whenStorageReady().then(() => {
    lastHome = getStored("home", undefined);
    lastSettings = getStored("sync", undefined);
    void syncHomeNow();
    subscribeStorage(() => {
      const home = getStored("home", undefined);
      const settings = getStored("sync", undefined);
      const settingsChanged = settings !== lastSettings;
      if (home !== lastHome || settingsChanged) {
        lastHome = home;
        lastSettings = settings;
        schedule(settingsChanged ? 0 : CHANGE_DEBOUNCE_MS);
      }
    });
  });
  setInterval(() => void syncHomeNow(), SYNC_INTERVAL_MS);
  window.addEventListener("online", () => void syncHomeNow());
  window.addEventListener("focus", () => void syncHomeNow());
}
