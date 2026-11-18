// 앱 옵션 (옵션 탭). 저장은 앱 데이터 폴더의 options.json — Rust도 같은 파일을 읽는다(창 닫기·세션 새로고침 스레드).
// 새 옵션을 더할 때는 src-tauri/src/options.rs의 읽기 함수와 이름을 맞춘다.

import { useCallback, useMemo } from "react";
import { DEFAULT_SOUND_VOLUME } from "./notify-core";
import { useStoredState } from "./storage";

export interface Options {
  /** 창을 닫으면 종료하지 않고 트레이로 숨겨 계속 실행 */
  closeToTray: boolean;
  /** 5시간 세션이 끝나면 가장 작은 모델을 한 번 실행해 새 세션을 시작 */
  autoSession: boolean;
  /** 컴퓨터를 켜면 앱을 트레이로 숨겨 자동 실행 */
  autostart: boolean;
  /** 채팅이 끝나면 알림음 (전체 스위치 — 끄면 아래 세부 설정이 모두 숨겨지고 소리가 나지 않는다). Rust는 읽지 않는다 (기본 켜짐) */
  chatSound: boolean;
  /** 사이드바 "채팅"(일반 채팅)에서 알림음 */
  soundChat: boolean;
  /** 위 알림음의 음량 0~1 */
  soundChatVolume: number;
  /** 프로젝트 화면의 AI 채팅에서 알림음 */
  soundProject: boolean;
  /** 위 알림음의 음량 0~1 */
  soundProjectVolume: number;
}

export const DEFAULT_OPTIONS: Options = {
  closeToTray: false,
  autoSession: false,
  autostart: false,
  chatSound: true,
  soundChat: true,
  soundChatVolume: DEFAULT_SOUND_VOLUME,
  soundProject: true,
  soundProjectVolume: DEFAULT_SOUND_VOLUME,
};

export function useOptions() {
  const [stored, setStored] = useStoredState<Partial<Options>>("options", DEFAULT_OPTIONS);
  // 이전 버전에서 저장한 값에 없는 옵션은 기본값으로 채운다
  const options = useMemo<Options>(() => ({ ...DEFAULT_OPTIONS, ...stored }), [stored]);
  const setOption = useCallback(<K extends keyof Options>(key: K, value: Options[K]) => setStored((prev) => ({ ...DEFAULT_OPTIONS, ...prev, [key]: value })), [setStored]);
  return { options, setOption };
}
