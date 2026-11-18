"use client";

// 음악 목록 동기화 (데스크톱 전용): 링크·제목·곡별 음량을 Drive(.AIWorkspace)의 music-<기기ID>.json으로 주고받는다.
// 공통 메모리 동기화(memory-sync.ts)와 같은 방식 — 각 기기는 자기 파일만 쓰고 다른 기기 파일은 읽기만 해서 충돌이 없고,
// 곡마다 마지막으로 바꾼 쪽이 이긴다(music-merge.ts). 음원 파일은 올리지 않으며 다른 PC에서는 재생할 때 링크로 다시 받는다.
// 시점: 앱 시작, 30초마다, 목록 변경 직후(1.5초 묶음), 동기화 설정 변경·창 포커스·네트워크 복귀 시.
// 동기화 폴더는 공통 메모리와 같은 설정(sync.folder)을 쓴다 — 설정하지 않았으면 이 PC에만 저장한다.

import { desktop, isDesktop } from "./desktop";
import { applyMergedTracks, getAllTracks } from "./music-store";
import { normalizeTrack, mergeTracks, pruneTombstones, snapshotStamp, type StoredTrack } from "./music-merge";
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
    const snapshots = await desktop.musicSyncPull(settings.folder);
    const remote = snapshots.flatMap((snapshot) => {
      const tracks = (snapshot as { tracks?: unknown } | null)?.tracks;
      return Array.isArray(tracks) ? [tracks.map(normalizeTrack).filter((t): t is StoredTrack => !!t)] : [];
    });
    // 동기화 중에 사용자가 바꾼 것도 잃지 않도록 최신 로컬과 한 번 더 합친다
    const merged = pruneTombstones(mergeTracks([getAllTracks(), ...remote]), Date.now());
    const latest = pruneTombstones(mergeTracks([getAllTracks(), merged]), Date.now());
    applyMergedTracks(latest);
    await desktop.musicSyncPush(settings.folder, device.id, { schema: SNAPSHOT_SCHEMA, deviceId: device.id, updatedAt: snapshotStamp(latest), tracks: latest });
  } catch (error) {
    // 동기화 폴더가 꺼져 있거나(오프라인) 일시적 오류 — 이 PC에 저장된 목록으로 계속 쓰고 다음 기회에 다시 시도한다
    console.warn("[music] 목록 동기화를 건너뜁니다", error);
  }
}

/** 지금 동기화. 실행 중이면 끝난 뒤 한 번 더 실행한다. */
export function syncMusicNow(): Promise<void> {
  if (!isDesktop()) return Promise.resolve();
  if (running) {
    queued = true;
    return running;
  }
  running = runSync().finally(() => {
    running = null;
    if (queued) {
      queued = false;
      void syncMusicNow();
    }
  });
  return running;
}

/** 앱 시작 시 한 번 호출 */
export function startMusicSync() {
  if (started || !isDesktop()) return;
  started = true;
  let lastMusic: unknown;
  let lastSettings: unknown;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void syncMusicNow(), delay);
  };
  void whenStorageReady().then(() => {
    lastMusic = getStored("music", undefined);
    lastSettings = getStored("sync", undefined);
    void syncMusicNow();
    subscribeStorage(() => {
      const music = getStored("music", undefined);
      const settings = getStored("sync", undefined);
      const settingsChanged = settings !== lastSettings;
      if (music !== lastMusic || settingsChanged) {
        lastMusic = music;
        lastSettings = settings;
        schedule(settingsChanged ? 0 : CHANGE_DEBOUNCE_MS);
      }
    });
  });
  setInterval(() => void syncMusicNow(), SYNC_INTERVAL_MS);
  window.addEventListener("online", () => void syncMusicNow());
  window.addEventListener("focus", () => void syncMusicNow());
}
