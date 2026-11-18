// 채팅 완료 알림음 계산 (순수 함수, 외부 의존 없음 — node로 직접 테스트 가능)

export interface ChimeNote {
  /** 소리 높이 (Hz) */
  freq: number;
  /** 시작 시각 (초, 재생 시작 기준) */
  start: number;
  /** 길이 (초) */
  duration: number;
}

/** 짧고 부드러운 두 음("띠링") — 파일 없이 브라우저 오디오로 직접 만든다 */
export const CHAT_DONE_CHIME: ChimeNote[] = [
  { freq: 880, start: 0, duration: 0.16 },
  { freq: 1319, start: 0.13, duration: 0.3 },
];

export type ChatOutcome = "done" | "error" | "cancelled";
/** 어느 쪽 채팅이 끝났는지: chat = 사이드바 "채팅"(일반 채팅), project = 프로젝트 화면의 AI 채팅 */
export type SoundSource = "chat" | "project";

/** 알림음 옵션 중 이 계산이 쓰는 부분 (저장된 값이라 어떤 타입이든 올 수 있다) */
export interface SoundOptions {
  chatSound?: unknown;
  soundChat?: unknown;
  soundChatVolume?: unknown;
  soundProject?: unknown;
  soundProjectVolume?: unknown;
}

/** 기본 음량 (0~1). 60%는 처음 만든 알림음(최대 진폭 0.18)과 같은 크기 */
export const DEFAULT_SOUND_VOLUME = 0.6;
/** 음량 1(100%)일 때의 최대 진폭 */
const FULL_GAIN = 0.3;

/** 저장된 음량 값을 0~1로 (숫자가 아니면 기본값) */
export function pickSoundVolume(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SOUND_VOLUME;
  return Math.min(1, Math.max(0, value));
}

/** 음량(0~1) → 실제 최대 진폭. 0이면 소리가 나지 않는다 */
export function chimeGain(volume: number): number {
  return Math.round(FULL_GAIN * pickSoundVolume(volume) * 1000) / 1000;
}

/** 슬라이더 값(0~100) ↔ 음량(0~1) */
export const volumeToPercent = (volume: number) => Math.round(pickSoundVolume(volume) * 100);
export const percentToVolume = (percent: number) => pickSoundVolume(Math.round(percent) / 100);

/**
 * 채팅이 끝났을 때 알림음을 낼지: 전체 옵션이 꺼져 있지 않고(없으면 켜짐), 그 채팅 종류의 알림음이 꺼져 있지 않고(없으면 켜짐),
 * 음량이 0이 아니고, 사용자가 직접 멈춘 경우가 아닐 때. 답을 받았든 오류로 끝났든 "끝난" 것이므로 소리를 낸다.
 */
export function shouldPlayChatSound(options: SoundOptions | null | undefined, outcome: ChatOutcome, source: SoundSource = "chat"): boolean {
  if (outcome === "cancelled") return false;
  if (options?.chatSound === false) return false;
  if ((source === "chat" ? options?.soundChat : options?.soundProject) === false) return false;
  return soundVolumeOf(options, source) > 0;
}

/** 종류별 저장된 음량 (0~1) */
export function soundVolumeOf(options: SoundOptions | null | undefined, source: SoundSource): number {
  return pickSoundVolume(source === "chat" ? options?.soundChatVolume : options?.soundProjectVolume);
}

/** 전체 재생 시간(초) — 오디오 정리 시점 계산용 */
export function chimeLength(notes: ChimeNote[] = CHAT_DONE_CHIME): number {
  return notes.reduce((end, n) => Math.max(end, n.start + n.duration), 0);
}
