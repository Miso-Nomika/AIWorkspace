"use client";

// 음악 목록·내려받기·재생. 화면(음악 탭)과 무관하게 앱이 켜져 있는 동안 계속 재생되도록 <audio>는 이 모듈이 하나만 들고 있다.
// - 목록과 재생 모드는 이 PC에만 저장한다 (options처럼 앱 데이터 폴더 JSON, 동기화하지 않음). 음원 파일은 Rust가 앱 데이터 폴더에 둔다.
// - 곡을 추가하면 내려받기 대기열에 넣고 한 번에 하나씩 받는다. 파일이 없는 곡을 재생하려 하면 먼저 받는다.

import { useSyncExternalStore } from "react";
import { desktop, errorMessage, isDesktop, type MusicToolStatus } from "./desktop";
import { clampVolume, enabledIds, nextTrack, playableIds, parseYoutubeId, pickMode, shuffleNext, stepTrack, type PlayMode } from "./music-core";
import { activeTracks, normalizeTrack, sameTracks, type StoredTrack } from "./music-merge";
import { getStored, setStored, useStoredState, whenStorageReady } from "./storage";

/** 목록의 곡 (병합·동기화 형식과 같다: 링크·제목·길이·곡별 음량, updatedAt·deletedAt은 동기화용) */
export type Track = StoredTrack;

interface Saved {
  /** 삭제 기록(deletedAt)이 붙은 곡까지 모두 — 다른 PC에 삭제를 전파하려고 남겨 둔다 */
  tracks: StoredTrack[];
  mode: PlayMode;
}

const EMPTY: Saved = { tracks: [], mode: "all" };

/** 저장되는 값 (목록·모드) */
export function useMusicSaved() {
  const [stored] = useStoredState<Partial<Saved>>("music", EMPTY);
  return { tracks: activeTracks(readTracks(stored.tracks)), mode: pickMode(stored.mode) };
}

/** 저장된 곡 배열을 읽는다 (낯선 항목은 버린다) */
function readTracks(raw: unknown): StoredTrack[] {
  return Array.isArray(raw) ? raw.map(normalizeTrack).filter((t): t is StoredTrack => !!t) : [];
}

/** 재생·목록용: 삭제되지 않은 곡만 */
function saved(): { tracks: StoredTrack[]; mode: PlayMode } {
  const stored = getStored<Partial<Saved>>("music", EMPTY);
  return { tracks: activeTracks(readTracks(stored.tracks)), mode: pickMode(stored.mode) };
}

/** 동기화용: 삭제 기록까지 모두 */
export function getAllTracks(): StoredTrack[] {
  return readTracks(getStored<Partial<Saved>>("music", EMPTY).tracks);
}

function saveAll(tracks: StoredTrack[]) {
  setStored<Saved>("music", { tracks, mode: pickMode(getStored<Partial<Saved>>("music", EMPTY).mode) });
}

function saveMode(mode: PlayMode) {
  setStored<Saved>("music", { tracks: getAllTracks(), mode });
}

const now = () => new Date().toISOString();

/** 곡 하나를 바꾸고 바꾼 시각을 찍는다 (병합은 이 시각이 더 나중인 쪽을 따른다) */
function updateTrack(id: string, change: (track: StoredTrack) => StoredTrack) {
  saveAll(getAllTracks().map((t) => (t.id === id ? { ...change(t), updatedAt: now() } : t)));
}

// ── 실행 중 상태 (저장하지 않음) ──

export interface MusicRuntime {
  /** 이 PC에 음원 파일이 있는 곡 */
  files: ReadonlySet<string>;
  /** 내려받는 중인 곡의 진행률 0~100 */
  downloading: Readonly<Record<string, number>>;
  /** 내려받기 대기 중인 곡 */
  queued: readonly string[];
  /** 곡별 오류 문장 */
  errors: Readonly<Record<string, string>>;
  currentId: string | null;
  playing: boolean;
  /** 지금 재생기에 적용된 음량 0~1 */
  audioVolume: number;
  /** 재생 위치·길이 (초) */
  position: number;
  length: number | null;
  tool: MusicToolStatus | null;
  toolBusy: boolean;
  toolError: string | null;
  /** 재생할 곡이 없을 때 등 사용자에게 알릴 안내 (곡을 재생하면 사라짐) */
  notice: string | null;
}

let runtime: MusicRuntime = {
  files: new Set(),
  downloading: {},
  queued: [],
  errors: {},
  currentId: null,
  playing: false,
  audioVolume: 1,
  position: 0,
  length: null,
  tool: null,
  toolBusy: false,
  toolError: null,
  notice: null,
};
const listeners = new Set<() => void>();

function patch(next: Partial<MusicRuntime>) {
  runtime = { ...runtime, ...next };
  listeners.forEach((l) => l());
}

export function useMusicRuntime(): MusicRuntime {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => runtime,
    () => runtime,
  );
}

// ── yt-dlp 도구 ──

export async function refreshTool() {
  patch({ tool: await desktop.musicToolStatus().catch(() => ({ path: null, source: null, version: null })) });
}

/** 사용자가 버튼을 누르면 공식 릴리즈에서 yt-dlp를 받는다 */
export async function installTool() {
  patch({ toolBusy: true, toolError: null });
  try {
    patch({ tool: await desktop.musicToolInstall() });
  } catch (error) {
    patch({ toolError: errorMessage(error) });
  } finally {
    patch({ toolBusy: false });
  }
}

/** 앱이 받아 둔 yt-dlp를 최신으로 (유튜브가 바뀌어 내려받기가 실패할 때) */
export async function updateTool() {
  patch({ toolBusy: true, toolError: null });
  try {
    patch({ tool: await desktop.musicToolUpdate() });
  } catch (error) {
    const message = errorMessage(error);
    patch({ toolError: message === "NOT_APP_TOOL" ? "이 PC에 따로 설치된 yt-dlp는 앱이 업데이트하지 않습니다. 직접 업데이트해 주세요." : message });
  } finally {
    patch({ toolBusy: false });
  }
}

// ── 내려받기 대기열 ──

let working = false;

async function processQueue() {
  if (working) return;
  working = true;
  try {
    while (runtime.queued.length > 0) {
      const id = runtime.queued[0];
      const rest = runtime.queued.slice(1);
      patch({ queued: rest, downloading: { ...runtime.downloading, [id]: 0 }, errors: withoutKey(runtime.errors, id) });
      try {
        const result = await desktop.musicDownload(id, (percent) => patch({ downloading: { ...runtime.downloading, [id]: percent } }));
        // 제목·길이는 내려받을 때 알게 된다. 값이 실제로 달라질 때만 "바꿈"으로 기록한다 —
        // 다른 PC에서 만든 곡을 이 PC에서 처음 재생(내려받기)했을 뿐인데 변경 시각이 갱신되면, 다른 PC에서 방금 바꾼 음량 등을 덮어쓸 수 있다.
        const known = getAllTracks().find((t) => t.id === id);
        const title = result.title || known?.title;
        const duration = result.duration ?? known?.duration ?? null;
        if (known && (known.title !== title || known.duration !== duration)) updateTrack(id, (t) => ({ ...t, title: title ?? t.title, duration }));
        patch({ files: new Set(runtime.files).add(id) });
      } catch (error) {
        patch({ errors: { ...runtime.errors, [id]: errorMessage(error) === "TOOL_NOT_INSTALLED" ? "yt-dlp가 없어 내려받지 못했습니다. 위의 안내에서 먼저 받아 주세요." : errorMessage(error) } });
      }
      patch({ downloading: withoutKey(runtime.downloading, id) });
    }
  } finally {
    working = false;
  }
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

/** 내려받기 대기열에 넣는다 (이미 받았거나 대기·진행 중이면 무시). 실패한 곡의 "다시 시도"도 이 함수 */
export function enqueueDownload(id: string) {
  if (runtime.files.has(id) || id in runtime.downloading || runtime.queued.includes(id)) return;
  patch({ queued: [...runtime.queued, id], errors: withoutKey(runtime.errors, id) });
  void processQueue();
}

// ── 목록 ──

/** 링크를 목록에 추가하고 내려받는다. 잘못된 링크·중복이면 사용자에게 보여 줄 문장을 돌려준다 (성공하면 null) */
export function addTrack(input: string): string | null {
  const parsed = parseYoutubeId(input);
  if ("error" in parsed) return parsed.error;
  const all = getAllTracks();
  const existing = all.find((t) => t.id === parsed.id);
  if (existing && !existing.deletedAt) return "이미 등록된 곡입니다.";
  const stamp = now();
  // 지웠던 곡을 다시 넣으면 삭제 기록을 지우고 되살린다 (제목·음량은 그대로 이어받는다)
  if (existing) saveAll(all.map((t) => (t.id === parsed.id ? { ...t, deletedAt: undefined, addedAt: stamp, updatedAt: stamp } : t)));
  else saveAll([...all, { id: parsed.id, url: `https://www.youtube.com/watch?v=${parsed.id}`, title: parsed.id, duration: null, addedAt: stamp, updatedAt: stamp }]);
  enqueueDownload(parsed.id);
  return null;
}

export async function removeTrack(id: string) {
  if (runtime.currentId === id) stop();
  const stamp = now();
  saveAll(getAllTracks().map((t) => (t.id === id ? { ...t, deletedAt: stamp, updatedAt: stamp } : t)));
  patch({ queued: runtime.queued.filter((q) => q !== id), errors: withoutKey(runtime.errors, id) });
  await desktop.musicDeleteFile(id).catch(() => {});
  const files = new Set(runtime.files);
  files.delete(id);
  patch({ files });
}

/** 곡을 비활성/활성으로 바꾼다. 비활성 곡은 셔플·다음 곡 후보에서 빠진다 (직접 눌러 재생하는 것은 가능). 목록과 함께 저장·동기화된다 */
export function setTrackDisabled(id: string, disabled: boolean) {
  updateTrack(id, (t) => {
    const next = { ...t };
    if (disabled) next.disabled = true;
    else delete next.disabled;
    return next;
  });
}

const NO_ACTIVE_NOTICE = "재생할 수 있는 활성 곡이 없습니다. 비활성 곡을 켜 주세요.";

export function setMode(mode: PlayMode) {
  saveMode(mode);
  cycle = runtime.currentId ? [runtime.currentId] : [];
}

/** 곡별 음량을 바꾼다 (0~1). 저장하고, 지금 재생 중인 곡이면 바로 적용한다 */
export function setTrackVolume(id: string, volume: number) {
  const value = clampVolume(volume);
  updateTrack(id, (t) => ({ ...t, volume: value }));
  if (runtime.currentId === id && audio) audio.volume = value;
}

/**
 * 동기화로 합쳐진 목록을 적용한다. 다른 PC에서 지운 곡은 이 PC의 음원 파일도 지우고(재생 중이면 멈춤),
 * 새로 생긴 곡은 목록에만 추가한다 (음원은 재생할 때 링크로 받는다). 바뀐 게 없으면 아무것도 하지 않는다.
 */
export function applyMergedTracks(merged: StoredTrack[]) {
  const before = getAllTracks();
  if (sameTracks(before, merged)) return;
  const wasActive = new Set(activeTracks(before).map((t) => t.id));
  saveAll(merged);
  for (const track of merged) {
    if (!track.deletedAt || !wasActive.has(track.id)) continue;
    if (runtime.currentId === track.id) stop();
    void desktop.musicDeleteFile(track.id).catch(() => {});
    const files = new Set(runtime.files);
    files.delete(track.id);
    patch({ files, queued: runtime.queued.filter((q) => q !== track.id), errors: withoutKey(runtime.errors, track.id) });
  }
}

// ── 재생 ──

let audio: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
/** 재생 요청이 겹칠 때 마지막 요청만 따른다 */
let playToken = 0;

function player(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = "auto";
  audio.addEventListener("timeupdate", () => patch({ position: audio?.currentTime ?? 0, length: Number.isFinite(audio?.duration) ? (audio?.duration ?? null) : runtime.length }));
  audio.addEventListener("durationchange", () => patch({ length: Number.isFinite(audio?.duration) ? (audio?.duration ?? null) : null }));
  audio.addEventListener("volumechange", () => patch({ audioVolume: audio?.volume ?? 1 }));
  audio.addEventListener("play", () => patch({ playing: true }));
  audio.addEventListener("pause", () => patch({ playing: false }));
  audio.addEventListener("error", () => {
    const id = runtime.currentId;
    if (id) patch({ errors: { ...runtime.errors, [id]: "재생할 수 없습니다. 파일이 손상됐거나 이 PC가 이 형식(m4a)을 지원하지 않을 수 있습니다 (Linux는 gstreamer1.0-libav 설치가 필요할 수 있습니다)." }, playing: false });
  });
  audio.addEventListener("ended", () => {
    // 이어서 재생하는 것은 활성이고 받아 둔 곡뿐이다 (비활성 곡·받지 못한 곡은 건너뛴다). 한 곡 반복은 비활성이어도 그 곡을 반복한다
    const { tracks, mode } = saved();
    const playable = mode === "one" && runtime.currentId ? [runtime.currentId] : playableIds(tracks, (id) => runtime.files.has(id), runtime.currentId);
    const result = nextTrack(playable, runtime.currentId, mode, cycle);
    cycle = result.played;
    if (result.id) void playTrack(result.id);
    else patch({ playing: false, position: 0, notice: mode === "all" && enabledIds(tracks).length === 0 ? NO_ACTIVE_NOTICE : null });
  });
  return audio;
}

function releaseUrl() {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
}

/** 셔플 이어 재생의 이번 한 바퀴에서 이미 재생한 곡 */
let cycle: string[] = [];
/** 이전 곡 버튼용: 직전에 들은 곡들 (오래된 것부터, 최대 50곡) */
let history: string[] = [];

/** 곡을 재생한다. 파일이 없으면 먼저 내려받는다. (fromHistory: 이전 곡 버튼으로 돌아가는 재생이면 기록에 쌓지 않는다) */
export async function playTrack(id: string, options: { fromHistory?: boolean } = {}) {
  if (!options.fromHistory && runtime.currentId && runtime.currentId !== id) history = [...history.slice(-49), runtime.currentId];
  if (!cycle.includes(id)) cycle = [...cycle, id];
  const token = ++playToken;
  const element = player();
  patch({ currentId: id, notice: null, errors: withoutKey(runtime.errors, id), position: 0, length: saved().tracks.find((t) => t.id === id)?.duration ?? null });
  try {
    if (!runtime.files.has(id)) {
      enqueueDownload(id);
      // 내려받기가 끝나거나 실패할 때까지 기다린다
      await new Promise<void>((resolve) => {
        const check = () => {
          if (runtime.files.has(id) || (id in runtime.errors && !(id in runtime.downloading) && !runtime.queued.includes(id)) || token !== playToken) {
            listeners.delete(check);
            resolve();
          }
        };
        listeners.add(check);
        check();
      });
      if (token !== playToken || !runtime.files.has(id)) return;
    }
    const bytes = await desktop.musicRead(id);
    if (token !== playToken) return;
    releaseUrl();
    objectUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/mp4" }));
    element.src = objectUrl;
    element.volume = clampVolume(saved().tracks.find((t) => t.id === id)?.volume);
    await element.play();
  } catch (error) {
    if (token === playToken) patch({ errors: { ...runtime.errors, [id]: errorMessage(error) }, playing: false });
  }
}

export function togglePlay() {
  if (!audio || !runtime.currentId) {
    const first = saved().tracks[0];
    if (first) void playTrack(first.id);
    return;
  }
  if (audio.paused) void audio.play().catch(() => {});
  else audio.pause();
}

/**
 * 이전·다음 버튼. 셔플 이어 재생에서 "다음"은 셔플 순서의 다음 곡, "이전"은 직전에 들은 곡이고,
 * 그 밖의 모드(또는 기록이 없을 때)는 목록 순서대로 움직인다.
 */
export function stepPlay(delta: 1 | -1) {
  const { tracks, mode } = saved();
  const ids = tracks.map((t) => t.id);
  const active = enabledIds(tracks);
  if (delta === -1 && history.length > 0) {
    const previous = history[history.length - 1];
    history = history.slice(0, -1);
    if (ids.includes(previous)) {
      void playTrack(previous, { fromHistory: true });
      return;
    }
  }
  if (delta === 1 && mode === "all") {
    const result = shuffleNext(active, cycle, runtime.currentId);
    cycle = result.played;
    if (result.id) void playTrack(result.id);
    else if (tracks.length > 0) patch({ notice: NO_ACTIVE_NOTICE });
    return;
  }
  const next = stepTrack(active, runtime.currentId, delta);
  if (next) void playTrack(next);
  else if (tracks.length > 0) patch({ notice: NO_ACTIVE_NOTICE });
}

export function seek(seconds: number) {
  if (audio && Number.isFinite(seconds)) audio.currentTime = seconds;
}

export function stop() {
  playToken++;
  audio?.pause();
  releaseUrl();
  if (audio) audio.removeAttribute("src");
  patch({ currentId: null, playing: false, position: 0, length: null });
}

let started = false;

/** 앱 시작 시 한 번 호출. 받아 둔 음원 목록과 yt-dlp 상태를 읽는다. */
export function startMusic() {
  if (started || !isDesktop()) return;
  started = true;
  void whenStorageReady().then(async () => {
    const [files] = await Promise.all([desktop.musicFiles().catch(() => [] as string[]), refreshTool()]);
    patch({ files: new Set(files) });
    // 받아 둔 파일이 없는 곡(다른 PC에서 만든 목록·지워진 파일)은 재생할 때 자동으로 받는다
  });
}
