"use client";

// 이 기기 정보 (데스크톱 앱 전용 — Windows·Linux).
// 프로젝트 폴더가 어느 PC에 있는지(deviceId)로 실행 가능 여부를 판단한다 (backend/index.ts).

import { useMemo, useSyncExternalStore } from "react";
import { desktop, isDesktop, type DeviceInfo } from "./desktop";
import { useStoredState } from "./storage";

export interface Platform {
  /** 이 기기의 고유 ID. 프로젝트 폴더가 어느 PC에 있는지 판단하는 기준 */
  deviceId: string | null;
  /** 이 기기 이름 (컴퓨터 이름) */
  deviceName: string | null;
  /** 새 프로젝트 폴더의 기본 위치 (문서\AIWorkspace) */
  defaultProjectsDir: string | null;
}

interface DeviceRecord {
  id: string;
}

// Rust에서 받아오는 기기 정보 (앱 실행 중 변하지 않으므로 한 번만 요청)
let deviceInfo: DeviceInfo | null = null;
let deviceInfoRequested = false;
const infoListeners = new Set<() => void>();

function subscribeDeviceInfo(listener: () => void) {
  infoListeners.add(listener);
  if (!deviceInfoRequested && isDesktop()) {
    deviceInfoRequested = true;
    desktop
      .deviceInfo()
      .then((info) => {
        deviceInfo = info;
        infoListeners.forEach((l) => l());
      })
      .catch((error) => console.error("[platform] 기기 정보를 가져오지 못했습니다", error));
  }
  return () => {
    infoListeners.delete(listener);
  };
}

export function usePlatform(): Platform {
  const info = useSyncExternalStore(subscribeDeviceInfo, () => deviceInfo, () => null);
  const [device] = useStoredState<DeviceRecord | null>("device", null);

  return useMemo<Platform>(
    () => ({
      deviceId: device?.id ?? null,
      deviceName: info?.computerName ?? null,
      defaultProjectsDir: info?.defaultProjectsDir ?? null,
    }),
    [device?.id, info],
  );
}
