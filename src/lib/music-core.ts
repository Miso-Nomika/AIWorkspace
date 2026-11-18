// 음악 재생의 순수 로직 (외부 의존 없음 — node로 직접 테스트 가능): 유튜브 링크 해석, 다음 곡 정하기, 시간 표시.

/** 재생 모드: 끄기(한 곡 재생 후 멈춤) · 한 곡 반복 · 셔플 이어 재생(목록을 무작위 순서로 한 바퀴씩 이어서 재생). 저장값 "all"은 이전 버전과의 호환을 위해 그대로 둔다 */
export type PlayMode = "off" | "one" | "all";

export const PLAY_MODES: PlayMode[] = ["all", "one", "off"];
export const DEFAULT_PLAY_MODE: PlayMode = "all";

export const PLAY_MODE_LABELS: Record<PlayMode, string> = {
  all: "셔플 이어 재생",
  one: "한 곡 반복",
  off: "반복 끄기",
};

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);

export type ParsedLink = { id: string } | { error: string };

/**
 * 유튜브 링크(또는 영상 ID 11자)에서 영상 ID를 뽑는다.
 * 지원: watch?v= · youtu.be/ · shorts/ · embed/ · live/ · music.youtube.com.
 * 재생목록 링크는 v 값이 있을 때만 그 곡 하나로 본다 (없으면 안내).
 */
export function parseYoutubeId(input: string): ParsedLink {
  const text = input.trim();
  if (!text) return { error: "유튜브 링크를 입력하세요." };
  if (VIDEO_ID.test(text)) return { id: text };
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { error: "유튜브 링크가 아닙니다." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "유튜브 링크가 아닙니다." };
  const host = url.hostname.toLowerCase();
  let candidate: string | null = null;
  if (host === "youtu.be") {
    candidate = url.pathname.split("/")[1] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    const [first, second] = url.pathname.split("/").filter(Boolean);
    if (first === "watch") candidate = url.searchParams.get("v");
    else if (["shorts", "embed", "live"].includes(first)) candidate = second ?? null;
    else if (first === "playlist") return { error: "재생목록 링크는 지원하지 않습니다. 곡 하나의 링크를 넣어 주세요." };
  } else {
    return { error: "유튜브 링크가 아닙니다." };
  }
  return candidate && VIDEO_ID.test(candidate) ? { id: candidate } : { error: "링크에서 영상 ID를 찾지 못했습니다." };
}

/** 셔플 결과: 다음 곡과, 이번 한 바퀴에서 이미 재생한 곡들 */
export interface ShuffleResult {
  id: string | null;
  played: string[];
}

/**
 * 셔플 이어 재생의 다음 곡. 한 바퀴(목록의 모든 곡)를 무작위 순서로 한 번씩 재생하고, 다 돌면 새 바퀴를 시작한다.
 * 새 바퀴의 첫 곡은 방금 들은 곡이 아니다 (곡이 둘 이상일 때) — 바퀴가 바뀌어도 같은 곡이 연속으로 나오지 않는다. played는 이번 바퀴에서 이미 재생한 곡 (목록에서 지워진 곡은 무시).
 * rng는 0 이상 1 미만의 값을 돌려주는 함수 (테스트에서 고정값을 넣는다).
 */
export function shuffleNext(ids: string[], played: string[], current: string | null, rng: () => number = Math.random): ShuffleResult {
  if (ids.length === 0) return { id: null, played: [] };
  if (ids.length === 1) return { id: ids[0], played: [ids[0]] };
  const done = played.filter((id) => ids.includes(id));
  let candidates = ids.filter((id) => !done.includes(id) && id !== current);
  let round = done;
  if (candidates.length === 0) {
    // 한 바퀴를 다 돌았다: 모든 곡이 다시 후보가 되는 새 바퀴 (방금 들은 곡만 첫 곡에서 뺀다)
    round = [];
    candidates = ids.filter((id) => id !== current);
  }
  const id = candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))];
  return { id, played: [...round, id] };
}

/**
 * 곡이 끝났을 때 이어서 재생할 곡 (id가 null이면 멈춤). 모드별: 끄기=멈춤 · 한 곡 반복=같은 곡 · 셔플 이어 재생=셔플.
 * ids는 이어서 재생할 수 있는 곡들, played는 셔플의 이번 바퀴 기록.
 */
export function nextTrack(ids: string[], current: string | null, mode: PlayMode, played: string[] = [], rng: () => number = Math.random): ShuffleResult {
  if (current === null || ids.length === 0) return { id: null, played };
  if (mode === "one") return { id: current, played };
  if (mode === "off") return { id: null, played };
  return shuffleNext(ids, played, current, rng);
}

/** 비활성 곡을 뺀 곡 번호들 (이전 곡 기록·직접 재생은 비활성 곡도 허용하므로 이어서 재생할 곡을 고를 때만 쓴다) */
export function enabledIds(tracks: { id: string; disabled?: boolean }[]): string[] {
  return tracks.filter((t) => !t.disabled).map((t) => t.id);
}

/**
 * 곡이 끝났을 때 이어서 재생할 수 있는 곡들: 활성이고 이 PC에 음원이 있는 곡 (지금 재생 중인 곡이 활성이면 파일 여부와 상관없이 포함).
 * 비활성 곡은 들어가지 않는다.
 */
export function playableIds(tracks: { id: string; disabled?: boolean }[], hasFile: (id: string) => boolean, current: string | null): string[] {
  return enabledIds(tracks).filter((id) => hasFile(id) || id === current);
}

/** 이전·다음 버튼(셔플이 아닐 때·기록이 없을 때): 목록 순서대로 delta만큼 이동 (처음·끝에서는 반대편으로) */
export function stepTrack(ids: string[], current: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const index = current === null ? -1 : ids.indexOf(current);
  if (index < 0) return delta === 1 ? ids[0] : ids[ids.length - 1];
  return ids[(index + delta + ids.length) % ids.length];
}

/** 모드 버튼을 누를 때 다음 모드 (셔플 이어 재생 → 한 곡 반복 → 반복 끄기 → …) */
export function cycleMode(mode: PlayMode): PlayMode {
  return PLAY_MODES[(PLAY_MODES.indexOf(mode) + 1) % PLAY_MODES.length];
}

/** 저장된 값이 모드가 아니면(손상·이전 버전) 기본값 */
export function pickMode(value: unknown): PlayMode {
  return PLAY_MODES.find((m) => m === value) ?? DEFAULT_PLAY_MODE;
}

/** 곡별 음량: 0(무음)~1(최대). 곡마다 따로 저장하고 기본은 최대 */
export const DEFAULT_VOLUME = 1;

/** 저장된 값이 숫자가 아니거나 범위 밖이면(손상·이전 버전) 보정한다 */
export function clampVolume(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_VOLUME;
}

/** 슬라이더 값(0~100) ↔ 음량(0~1) */
export function volumeFromPercent(percent: number): number {
  return clampVolume(Math.round(percent) / 100);
}

export function percentOfVolume(volume: unknown): number {
  return Math.round(clampVolume(volume) * 100);
}

/** 초 → "3:05" (1시간 이상은 "1:02:03"). 모르면 "-:--" */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "-:--";
  const total = Math.floor(seconds);
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
