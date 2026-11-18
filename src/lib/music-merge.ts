// 음악 목록 병합 (순수 함수, 외부 의존 없음 — node로 직접 테스트 가능).
// 여러 PC가 Drive(.AIWorkspace)에 각자 올린 목록을 합친다: 곡(영상 ID)마다 마지막으로 바꾼 쪽이 이긴다.
// 삭제는 지우지 않고 삭제 기록(deletedAt)으로 남겨 다른 PC에도 전파하고, 30일이 지나면 정리한다 (메모리 병합과 같은 규칙).
// 목록에는 링크·제목·길이·곡별 음량만 담는다 — 음원 파일은 올리지 않는다 (다른 PC에서는 재생할 때 링크로 다시 받는다).

import { clampVolume } from "./music-core.ts";

export interface StoredTrack {
  /** 유튜브 영상 ID (11자) */
  id: string;
  url: string;
  title: string;
  /** 초 (내려받기 전에는 모름) */
  duration: number | null;
  addedAt: string;
  /** 곡별 음량 0~1 (없으면 최대) */
  volume?: number;
  /** 비활성 곡 (셔플·다음 곡으로 넘어갈 때 후보에서 빠진다). 없으면 활성 */
  disabled?: boolean;
  /** 마지막으로 바꾼 시각 (ISO) — 병합 기준 */
  updatedAt: string;
  /** 삭제 기록 (있으면 삭제된 곡) */
  deletedAt?: string;
}

export const TOMBSTONE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** 저장된 값을 곡으로 읽는다. 형식이 낯설면 null (손상·이전 버전). updatedAt이 없던 이전 저장값은 추가한 시각으로 본다 */
export function normalizeTrack(raw: unknown): StoredTrack | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !VIDEO_ID.test(o.id)) return null;
  const addedAt = typeof o.addedAt === "string" && o.addedAt ? o.addedAt : "1970-01-01T00:00:00.000Z";
  const track: StoredTrack = {
    id: o.id,
    url: `https://www.youtube.com/watch?v=${o.id}`, // 주소는 ID로만 만든다 (낯선 주소를 받아들이지 않음)
    title: typeof o.title === "string" && o.title ? o.title.slice(0, 300) : o.id,
    duration: typeof o.duration === "number" && Number.isFinite(o.duration) && o.duration >= 0 ? o.duration : null,
    addedAt,
    updatedAt: typeof o.updatedAt === "string" && o.updatedAt ? o.updatedAt : addedAt,
  };
  if (o.volume !== undefined) track.volume = clampVolume(o.volume);
  if (o.disabled === true) track.disabled = true;
  if (typeof o.deletedAt === "string" && o.deletedAt) track.deletedAt = o.deletedAt;
  return track;
}

/** 곡마다 마지막으로 바꾼 쪽을 고른다 (같은 시각이면 삭제 기록이 이긴다). 결과는 추가한 순서 */
export function mergeTracks(lists: StoredTrack[][]): StoredTrack[] {
  const best = new Map<string, StoredTrack>();
  for (const track of lists.flat()) {
    const current = best.get(track.id);
    const wins = !current || track.updatedAt > current.updatedAt || (track.updatedAt === current.updatedAt && !!track.deletedAt && !current.deletedAt);
    if (wins) best.set(track.id, track);
  }
  return [...best.values()].sort((a, b) => (a.addedAt === b.addedAt ? (a.id < b.id ? -1 : 1) : a.addedAt < b.addedAt ? -1 : 1));
}

/** 오래된 삭제 기록을 정리한다 */
export function pruneTombstones(tracks: StoredTrack[], nowMs: number): StoredTrack[] {
  return tracks.filter((t) => !t.deletedAt || nowMs - Date.parse(t.deletedAt) < TOMBSTONE_MAX_AGE_MS);
}

export function activeTracks(tracks: StoredTrack[]): StoredTrack[] {
  return tracks.filter((t) => !t.deletedAt);
}

/** 두 목록이 같은 내용인지 (불필요한 저장·동기화를 막는다) */
export function sameTracks(a: StoredTrack[], b: StoredTrack[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

/** 스냅샷 파일의 안내 시각: 목록에서 가장 나중에 바뀐 시각 (내용이 같으면 파일도 같아지게 현재 시각을 쓰지 않는다) */
export function snapshotStamp(tracks: StoredTrack[]): string {
  return tracks.reduce((max, t) => (t.updatedAt > max ? t.updatedAt : max), "1970-01-01T00:00:00.000Z");
}
