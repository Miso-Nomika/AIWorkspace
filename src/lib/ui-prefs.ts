"use client";

// 화면 설정
// - prefs (동기화): 테마. 개인 취향이므로 공통 메모리와 함께 Google Drive로 모든 PC에 반영한다 (memory-sync.ts).
// - ui (이 PC 전용): 사이드바 접힘, 패널 너비 비율. 화면 크기가 PC마다 달라 동기화하지 않는다.

import { useCallback, useSyncExternalStore } from "react";
import { BOOT_KEY } from "./boot-script";
import { normalizeHomeSplit, normalizeRatios, normalizeTerminalRatio, type PaneRatios } from "./pane-layout";
import { getStored, subscribeStorage, useStoredState, whenStorageReady } from "./storage";

export type Theme = "light" | "dark" | "system";

export interface Prefs {
  theme: Theme;
  /** 마지막 변경 시각 — PC 간 동기화 시 최신 값이 이긴다. 빈 문자열이면 한 번도 바꾸지 않음 */
  updatedAt: string;
}

export interface UiState {
  sidebarCollapsed?: boolean;
  panes?: PaneRatios;
  /** 접어 둔 패널 (프로젝트 화면의 탐색기·뷰어) */
  collapsed?: { files?: boolean; code?: boolean };
  /** 프로젝트 선택 화면에서 왼쪽 프로젝트 목록이 차지하는 비율 (나머지는 터미널) */
  homeSplit?: number;
  /** 프로젝트 화면 뷰어 아래 터미널: 열려 있는지, 뷰어 영역 높이 대비 터미널 높이 비율 */
  terminal?: { open?: boolean; ratio?: number };
}

export const DEFAULT_PREFS: Prefs = { theme: "system", updatedAt: "" };
const EMPTY_UI: UiState = {};

export function normalizePrefs(value: unknown): Prefs | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const theme = v.theme === "light" || v.theme === "dark" || v.theme === "system" ? v.theme : null;
  if (!theme || typeof v.updatedAt !== "string") return null;
  return { theme, updatedAt: v.updatedAt };
}

// ── 테마 ──

const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

function subscribeSystemTheme(listener: () => void) {
  const q = darkQuery();
  q.addEventListener("change", listener);
  return () => q.removeEventListener("change", listener);
}

function useSystemDark() {
  return useSyncExternalStore(subscribeSystemTheme, () => darkQuery().matches, () => false);
}

export function useTheme() {
  const [prefs, setPrefs] = useStoredState<Prefs>("prefs", DEFAULT_PREFS);
  const systemDark = useSystemDark();
  const theme = normalizePrefs(prefs)?.theme ?? "system";
  const resolved: "light" | "dark" = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  const setTheme = useCallback(
    (next: Theme) => setPrefs({ theme: next, updatedAt: new Date().toISOString() }),
    [setPrefs],
  );
  return { theme, resolved, setTheme, toggle: () => setTheme(resolved === "dark" ? "light" : "dark") };
}

// ── 사이드바·패널 (이 PC 전용) ──

export function useUiState() {
  const [ui, setUi] = useStoredState<UiState>("ui", EMPTY_UI);
  const update = useCallback((patch: Partial<UiState>) => setUi((prev) => ({ ...prev, ...patch })), [setUi]);
  return {
    sidebarCollapsed: !!ui.sidebarCollapsed,
    panes: normalizeRatios(ui.panes),
    homeSplit: normalizeHomeSplit(ui.homeSplit),
    terminal: { open: !!ui.terminal?.open, ratio: normalizeTerminalRatio(ui.terminal?.ratio) },
    setTerminal: (patch: { open?: boolean; ratio?: number }) => update({ terminal: { ...ui.terminal, ...patch } }),
    collapsed: { files: !!ui.collapsed?.files, code: !!ui.collapsed?.code },
    setCollapsed: (patch: { files?: boolean; code?: boolean }) => update({ collapsed: { ...ui.collapsed, ...patch } }),
    toggleSidebar: () => update({ sidebarCollapsed: !ui.sidebarCollapsed }),
    setPanes: (panes: PaneRatios) => update({ panes }),
    setHomeSplit: (homeSplit: number) => update({ homeSplit }),
  };
}

// ── <html>에 반영 ──

let lastApplied = "";

function apply() {
  const prefs = normalizePrefs(getStored("prefs", DEFAULT_PREFS)) ?? DEFAULT_PREFS;
  const ui = getStored<UiState>("ui", EMPTY_UI);
  const dark = prefs.theme === "dark" || (prefs.theme === "system" && darkQuery().matches);
  // 저장소의 다른 키(채팅 등)가 바뀔 때도 불리므로 바뀐 게 없으면 건너뛴다
  const signature = `${prefs.theme}|${dark}|${!!ui.sidebarCollapsed}`;
  if (signature === lastApplied) return;
  lastApplied = signature;
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  if (ui.sidebarCollapsed) root.setAttribute("data-sidebar", "collapsed");
  else root.removeAttribute("data-sidebar");
  try {
    // 다음 실행 때 첫 화면부터 적용하기 위한 사본 (boot-script.ts)
    localStorage.setItem(BOOT_KEY, JSON.stringify({ theme: prefs.theme, sidebarCollapsed: !!ui.sidebarCollapsed }));
  } catch {
    // 저장소 접근 불가 — 다음 실행 때 잠깐 기본 테마로 보일 뿐이다
  }
}

let started = false;

/** 앱 시작 시 한 번 호출. 설정이 바뀌면(다른 PC에서 동기화된 경우 포함) 즉시 화면에 반영한다. */
export function startUiPrefs() {
  if (started) return;
  started = true;
  void whenStorageReady().then(() => {
    apply();
    subscribeStorage(apply);
    subscribeSystemTheme(apply);
  });
}
