// 프로젝트 화면 3단 패널(탐색기 | 코드 | 채팅) 너비 계산 (순수 함수, 외부 의존 없음 — node로 직접 테스트 가능)
// 너비는 컨테이너 대비 비율로 저장한다 → 창 크기가 바뀌어도 같은 비율을 유지하고, 최소 너비만 보장한다.

export interface PaneRatios {
  files: number;
  chat: number;
}

export const DEFAULT_RATIOS: PaneRatios = { files: 0.2, chat: 0.32 };
export const PANE_MIN = { files: 160, code: 240, chat: 280 } as const;

function finite(n: unknown, fallback: number) {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1 ? n : fallback;
}

/** 저장된 값 검증 (손상·이전 형식이면 기본값) */
export function normalizeRatios(value: unknown): PaneRatios {
  const v = (value ?? {}) as Partial<PaneRatios>;
  const files = finite(v.files, DEFAULT_RATIOS.files);
  const chat = finite(v.chat, DEFAULT_RATIOS.chat);
  return files + chat < 0.9 ? { files, chat } : DEFAULT_RATIOS;
}

/** 컨테이너 너비(px)에서 실제 탐색기·채팅 너비(px). 코드 뷰어는 나머지를 쓴다. */
export function resolvePaneWidths(total: number, ratios: PaneRatios): { files: number; chat: number } {
  const minSum = PANE_MIN.files + PANE_MIN.code + PANE_MIN.chat;
  if (total <= minSum) {
    // 창이 아주 좁으면 최소 너비 비율대로 나눈다
    return { files: Math.floor((total * PANE_MIN.files) / minSum), chat: Math.floor((total * PANE_MIN.chat) / minSum) };
  }
  let files = Math.max(PANE_MIN.files, ratios.files * total);
  let chat = Math.max(PANE_MIN.chat, ratios.chat * total);
  const over = files + chat - (total - PANE_MIN.code);
  if (over > 0) {
    // 코드 뷰어 최소 너비를 지키도록 양쪽 여유분에 비례해 줄인다
    const fileSlack = files - PANE_MIN.files;
    const chatSlack = chat - PANE_MIN.chat;
    const slack = fileSlack + chatSlack;
    files -= (over * fileSlack) / slack;
    chat -= (over * chatSlack) / slack;
  }
  return { files: Math.round(files), chat: Math.round(chat) };
}

/** 접힌 패널이 차지하는 얇은 막대의 너비(px) */
export const RAIL_WIDTH = 36;

export interface Collapsed {
  files: boolean;
  code: boolean;
}

/**
 * 접힌 패널(얇은 막대)까지 반영한 실제 너비. 아무것도 접지 않았으면 resolvePaneWidths와 같다.
 * 코드 뷰어를 접으면 채팅이 나머지 너비를 모두 쓴다.
 */
export function resolveLayout(total: number, ratios: PaneRatios, collapsed: Collapsed): { files: number; code: number; chat: number } {
  const base = resolvePaneWidths(total, ratios);
  if (!collapsed.files && !collapsed.code) return { files: base.files, chat: base.chat, code: total - base.files - base.chat };
  const files = collapsed.files ? RAIL_WIDTH : base.files;
  if (collapsed.code) return { files, code: RAIL_WIDTH, chat: Math.max(0, total - files - RAIL_WIDTH) };
  const chat = Math.min(Math.max(PANE_MIN.chat, Math.round(ratios.chat * total)), Math.max(PANE_MIN.chat, total - files - PANE_MIN.code));
  return { files, code: total - files - chat, chat };
}

/** 드래그 결과(px)를 비율로 바꾼다. 다른 패널의 최소 너비를 침범하지 않게 자른다. */
export function ratiosFromDrag(
  total: number,
  current: { files: number; chat: number },
  pane: "files" | "chat",
  width: number,
): PaneRatios {
  const other = pane === "files" ? current.chat : current.files;
  const max = total - PANE_MIN.code - other;
  const clamped = Math.max(PANE_MIN[pane], Math.min(max, width));
  const next = { ...current, [pane]: clamped };
  return { files: next.files / total, chat: next.chat / total };
}

// ── 프로젝트 선택 화면 (왼쪽 프로젝트 목록 | 오른쪽 터미널) ──
// 목록 너비를 컨테이너 대비 비율로 저장한다 (창 크기가 바뀌어도 같은 비율, 최소 너비만 보장).

export const HOME_LIST_RATIO_DEFAULT = 0.45;
export const HOME_LIST_MIN = 280;
export const HOME_TERMINAL_MIN = 320;

/** 저장된 비율 검증 (손상·범위 밖이면 기본값) */
export function normalizeHomeSplit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0.1 && value < 0.9 ? value : HOME_LIST_RATIO_DEFAULT;
}

/** 컨테이너 너비(px)에서 실제 목록 너비(px). 목록·터미널 최소 너비를 지키고, 창이 너무 좁으면 최소 너비 비율대로 나눈다 */
export function resolveHomeList(total: number, ratio: number): number {
  if (total <= HOME_LIST_MIN + HOME_TERMINAL_MIN) return Math.floor((total * HOME_LIST_MIN) / (HOME_LIST_MIN + HOME_TERMINAL_MIN));
  return Math.round(Math.min(Math.max(HOME_LIST_MIN, ratio * total), total - HOME_TERMINAL_MIN));
}

/** 드래그 결과(목록 너비 px)를 비율로 바꾼다. 양쪽 최소 너비를 침범하지 않게 자른다 */
export function homeSplitFromDrag(total: number, listWidth: number): number {
  if (total <= 0) return HOME_LIST_RATIO_DEFAULT;
  return Math.max(HOME_LIST_MIN, Math.min(total - HOME_TERMINAL_MIN, listWidth)) / total;
}

// ── 프로젝트 화면 뷰어 아래 터미널 (위 뷰어 | 아래 터미널) ──
// 터미널 높이를 뷰어 영역 높이 대비 비율로 저장한다 (창 크기가 바뀌어도 같은 비율, 양쪽 최소 높이만 보장).

export const TERMINAL_RATIO_DEFAULT = 0.35;
export const TERMINAL_MIN = 120;
export const VIEWER_MIN = 160;

/** 저장된 비율 검증 (손상·범위 밖이면 기본값) */
export function normalizeTerminalRatio(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0.1 && value < 0.9 ? value : TERMINAL_RATIO_DEFAULT;
}

/** 영역 높이(px)에서 실제 터미널 높이(px). 뷰어·터미널 최소 높이를 지키고, 영역이 너무 낮으면 최소 높이 비율대로 나눈다 */
export function resolveTerminalHeight(total: number, ratio: number): number {
  if (total <= TERMINAL_MIN + VIEWER_MIN) return Math.floor((total * TERMINAL_MIN) / (TERMINAL_MIN + VIEWER_MIN));
  return Math.round(Math.min(Math.max(TERMINAL_MIN, ratio * total), total - VIEWER_MIN));
}

/** 드래그 결과(터미널 높이 px)를 비율로 바꾼다. 양쪽 최소 높이를 침범하지 않게 자른다 */
export function terminalRatioFromDrag(total: number, height: number): number {
  if (total <= 0) return TERMINAL_RATIO_DEFAULT;
  return Math.max(TERMINAL_MIN, Math.min(total - VIEWER_MIN, height)) / total;
}
