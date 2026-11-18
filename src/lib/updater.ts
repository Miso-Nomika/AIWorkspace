"use client";

// 자동 업데이트 (Tauri updater). 서명 확인과 설치는 플러그인이 하고, 이 파일은 상태와 일정을 관리한다.
// - 앱을 켠 직후(컴퓨터를 켜면 자동 실행되므로 보통 그때) 조용히 새 버전을 딱 한 번 확인한다. GitHub 호출을 최소로 하려고
//   실패해도 다시 시도하지 않고, 주기적 확인·창으로 돌아올 때의 확인도 없다 (오류는 화면에 알리지 않음). 앱을 다시 켜면 그때 한 번 더 확인한다.
// - 설치는 사용자가 알림을 눌렀을 때만 한다. 설치하면 앱이 다시 시작된다.
// - Linux .deb 설치본은 앱이 스스로 교체할 수 없으므로 "새 버전 있음" 안내만 한다 (status "manual").

import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useSyncExternalStore } from "react";
import { desktop, errorMessage, isDesktop } from "./desktop";

export interface UpdateState {
  status: "idle" | "available" | "manual" | "downloading" | "error";
  version: string | null;
  /** 내려받기 진행률 0~1 (알 수 없으면 0) */
  progress: number;
  message: string | null;
}

const INITIAL: UpdateState = { status: "idle", version: null, progress: 0, message: null };

let state: UpdateState = INITIAL;
let pending: Update | null = null;
let checking = false;
let started = false;
const listeners = new Set<() => void>();

function setState(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

/** 새 버전을 확인한다. 이미 내려받는 중이거나 확인 중이면 건너뛴다. 확인을 마쳤으면(새 버전이 없어도) true, 실패하면 false */
export async function checkForUpdate(): Promise<boolean> {
  if (!isDesktop() || checking || state.status === "downloading") return true;
  checking = true;
  try {
    // 점검용 실행(데이터 폴더를 따로 지정)에서는 업데이트 서버(GitHub)를 부르지 않는다
    if ((await desktop.installKind()) === "test") return true;
    const update = await check();
    if (!update) return true;
    pending = update;
    const kind = await desktop.installKind();
    setState({ status: kind === "package" ? "manual" : "available", version: update.version, message: null });
    return true;
  } catch (error) {
    // 오프라인·서버 오류는 조용히 넘기고 곧 다시 시도한다
    console.warn("[updater] 업데이트 확인 실패", error);
    return false;
  } finally {
    checking = false;
  }
}

/** 내려받아 설치하고 앱을 다시 시작한다 (호출 전에 사용자 확인을 받는다). */
export async function installUpdate() {
  if (!pending || state.status === "downloading") return;
  setState({ status: "downloading", progress: 0, message: null });
  let total = 0;
  let received = 0;
  try {
    await pending.downloadAndInstall((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      else if (event.event === "Progress") {
        received += event.data.chunkLength;
        setState({ progress: total ? Math.min(1, received / total) : 0 });
      }
    });
    await relaunch();
  } catch (error) {
    setState({ status: "error", message: errorMessage(error) });
  }
}

/** 앱 시작 시 한 번 호출: 새 버전을 딱 한 번 확인한다 (실패해도 다시 시도하지 않는다). */
export function startUpdateChecks() {
  if (started || !isDesktop()) return;
  started = true;
  void checkForUpdate();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}
