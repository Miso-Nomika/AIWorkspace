"use client";

// 공통 메모리 동기화 엔진 (데스크톱 전용).
// - 이 PC의 memories.json을 기준으로 동작하므로 오프라인에서도 조회·편집이 가능하다.
// - 동기화 폴더(Google Drive)에 접근할 수 있을 때: 다른 PC 스냅샷을 읽어 병합 → 이 PC 스냅샷을 쓴다.
// - 시점: 앱 시작, 30초마다, 메모리 변경 직후(1.5초 묶음), 창 포커스·네트워크 복귀 시.
// - 매번 에이전트용 메모리 파일(AIWORKSPACE_MEMORY.md)과 선택한 전역 CLI 파일을 갱신한다.
// - 병합 후 중복 항목·오래된 삭제 기록을 정리한다 (cleanupMemories — 모든 PC가 같은 결과).
// - 화면 설정 중 테마(prefs)도 같은 스냅샷에 담아 마지막 변경을 모든 PC에 반영한다.

import { useSyncExternalStore } from "react";
import { desktop, errorMessage, isDesktop } from "./desktop";
import { cleanupMemories, mergeMemories, normalizeMemory, sameMemories } from "./memory-merge";
import { buildGlobalMemoryPrompt, buildMemoryPrompt } from "./memory-prompt";
import { getStored, setStored, subscribeStorage, whenStorageReady } from "./storage";
import type { Memory } from "./types";
import { DEFAULT_PREFS, normalizePrefs, type Prefs } from "./ui-prefs";

export interface SyncSettings {
  /** Google Drive 동기화 폴더 (예: G:\내 드라이브). null이면 동기화 끔 */
  folder: string | null;
  /** ~/.claude/CLAUDE.md 에도 반영 (AIWorkspace 밖에서 Claude Code를 써도 참고) */
  claudeGlobal: boolean;
}

export const DEFAULT_SYNC: SyncSettings = { folder: null, claudeGlobal: false };
export const SYNC_INTERVAL_MS = 30_000;
const CHANGE_DEBOUNCE_MS = 1_500;
const SNAPSHOT_SCHEMA = 1;

export interface SyncState {
  status: "idle" | "disabled" | "syncing" | "synced" | "offline" | "error";
  lastSyncAt: string | null;
  message: string | null;
  /** 동기화 폴더에서 확인한 기기 수 (이 PC 포함) */
  devices: number;
  exportPath: string | null;
}

let state: SyncState = { status: "idle", lastSyncAt: null, message: null, devices: 0, exportPath: null };
const listeners = new Set<() => void>();
let running: Promise<void> | null = null;
let queued = false;
let started = false;

function setState(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function snapshotStamp(list: Memory[], prefs: Prefs) {
  return list.reduce((max, m) => (m.updatedAt > max ? m.updatedAt : max), prefs.updatedAt);
}

function readLocalMemories(): Memory[] {
  return getStored<Memory[]>("memories", []).map(normalizeMemory).filter((m): m is Memory => !!m);
}

/** 정리 결과가 저장된 값과 다르면 저장한다 */
function saveIfChanged(next: Memory[]) {
  if (!sameMemories(next, readLocalMemories())) setStored("memories", next);
}

async function runSync() {
  await whenStorageReady();
  const settings = getStored<SyncSettings>("sync", DEFAULT_SYNC);
  const device = getStored<{ id: string } | null>("device", null);
  const local = readLocalMemories();
  let merged = local;

  if (!settings.folder || !device) {
    merged = cleanupMemories(local).list;
    saveIfChanged(merged);
    setState({ status: "disabled", message: null, devices: 0 });
  } else {
    setState({ status: "syncing" });
    try {
      const snapshots = await desktop.memorySyncPull(settings.folder);
      const deviceIds = new Set<string>([device.id]);
      const localPrefs = normalizePrefs(getStored("prefs", DEFAULT_PREFS)) ?? DEFAULT_PREFS;
      let prefs = localPrefs;
      const remoteLists = snapshots.flatMap((s) => {
        const snap = s as { deviceId?: unknown; memories?: unknown; prefs?: unknown };
        if (!Array.isArray(snap.memories)) return [];
        if (typeof snap.deviceId === "string") deviceIds.add(snap.deviceId);
        const remotePrefs = normalizePrefs(snap.prefs);
        if (remotePrefs && remotePrefs.updatedAt > prefs.updatedAt) prefs = remotePrefs;
        return [snap.memories.map(normalizeMemory).filter((m): m is Memory => !!m)];
      });
      // 다른 PC에서 바꾼 테마가 더 최신이면 반영
      if (prefs !== localPrefs) setStored("prefs", prefs);
      merged = mergeMemories([local, ...remoteLists]);
      // 동기화 중 사용자가 편집했으면 그 변경도 잃지 않도록 최신 로컬과 한 번 더 병합
      merged = cleanupMemories(mergeMemories([readLocalMemories(), merged])).list;
      saveIfChanged(merged);

      await desktop.memorySyncPush(settings.folder, device.id, {
        schema: SNAPSHOT_SCHEMA,
        deviceId: device.id,
        // 내용이 바뀔 때만 파일이 바뀌도록 현재 시각 대신 마지막 수정 시각을 쓴다 (불필요한 Drive 업로드 방지)
        updatedAt: snapshotStamp(merged, prefs),
        memories: merged,
        prefs,
      });
      setState({ status: "synced", lastSyncAt: new Date().toISOString(), message: null, devices: deviceIds.size });
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      setState({
        status: code === "SYNC_FOLDER_UNAVAILABLE" ? "offline" : "error",
        message: errorMessage(error),
      });
    }
  }

  // 에이전트가 참고할 메모리 파일 갱신 (동기화 여부와 무관)
  try {
    // 전역 CLAUDE.md(~/.claude)에 같은 메모리가 들어가면 Claude가 그 파일도 읽으므로 앱이 넘기는 파일에서는 목록을 뺀다 (두 번 들어가지 않게).
    // 전역 파일에 쓰지 못했으면(경로 없음·쓰기 실패) 목록을 다시 넣어 메모리가 빠지지 않게 한다.
    const globalMarkdown = buildGlobalMemoryPrompt(merged);
    let result = await desktop.memoryExport(buildMemoryPrompt(merged, { includeSections: !settings.claudeGlobal }), globalMarkdown, settings.claudeGlobal).catch(() => null);
    if (!result || (settings.claudeGlobal && !result.claudeGlobal)) {
      // (같은 설정으로 다시 호출: 앱 파일은 목록을 넣어 먼저 쓰고, 전역 파일 쓰기가 또 실패하면 오류만 기록한다)
      result = await desktop.memoryExport(buildMemoryPrompt(merged), globalMarkdown, settings.claudeGlobal);
    }
    setState({ exportPath: result.path });
  } catch (error) {
    console.error("[memory] 에이전트용 메모리 파일 갱신 실패", error);
  }
}

/** 지금 동기화. 실행 중이면 끝난 뒤 한 번 더 실행한다. */
export function syncMemoriesNow(): Promise<void> {
  if (!isDesktop()) return Promise.resolve();
  if (running) {
    queued = true;
    return running;
  }
  running = runSync()
    .catch((error) => console.error("[memory] 동기화 오류", error))
    .finally(() => {
      running = null;
      if (queued) {
        queued = false;
        void syncMemoriesNow();
      }
    });
  return running;
}

/** 앱 시작 시 한 번 호출. 주기·이벤트 기반 자동 동기화를 시작한다. */
export function startMemorySync() {
  if (started || !isDesktop()) return;
  started = true;

  let lastMemories: unknown = undefined;
  let lastSettings: unknown = undefined;
  let lastPrefs: unknown = undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void syncMemoriesNow(), delay);
  };

  void whenStorageReady().then(() => {
    lastMemories = getStored("memories", undefined);
    lastSettings = getStored("sync", undefined);
    lastPrefs = getStored("prefs", undefined);
    void syncMemoriesNow();
    // 메모리·테마·동기화 설정이 바뀌면 곧바로 동기화
    subscribeStorage(() => {
      const memories = getStored("memories", undefined);
      const settings = getStored("sync", undefined);
      const prefs = getStored("prefs", undefined);
      const settingsChanged = settings !== lastSettings;
      if (memories !== lastMemories || prefs !== lastPrefs || settingsChanged) {
        lastMemories = memories;
        lastSettings = settings;
        lastPrefs = prefs;
        schedule(settingsChanged ? 0 : CHANGE_DEBOUNCE_MS);
      }
    });
  });

  setInterval(() => void syncMemoriesNow(), SYNC_INTERVAL_MS);
  window.addEventListener("online", () => void syncMemoriesNow());
  window.addEventListener("focus", () => void syncMemoriesNow());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const SERVER_STATE: SyncState = { status: "idle", lastSyncAt: null, message: null, devices: 0, exportPath: null };

export function useMemorySyncState(): SyncState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
}
