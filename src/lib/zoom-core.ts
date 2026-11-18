// 확대·축소 계산 (순수 함수 — node로 직접 테스트 가능)

export const ZOOM_MIN = 50;
export const ZOOM_MAX = 300;
export const ZOOM_DEFAULT = 100;
/** 막대·키보드 한 단계 */
export const ZOOM_STEP = 10;
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return ZOOM_DEFAULT;
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)) * 100) / 100;
}

/** 마우스 휠 한 칸(deltaY 100)은 10%, 터치패드 핀치는 작은 deltaY가 연속으로 와서 그만큼만 바뀐다 */
export function wheelZoom(current: number, deltaY: number): number {
  return clampZoom(current - deltaY / 10);
}

/** 키보드: Ctrl+0 초기화, Ctrl+= / Ctrl++ 확대, Ctrl+- 축소. 해당 없으면 null */
export function keyZoom(current: number, key: string): number | null {
  if (key === "0") return ZOOM_DEFAULT;
  if (key === "=" || key === "+") return clampZoom(current + ZOOM_STEP);
  if (key === "-" || key === "_") return clampZoom(current - ZOOM_STEP);
  return null;
}

/** 커서(point)가 내용(start부터 size 길이)의 어느 비율 지점을 가리키는지. 내용 크기가 0이면 가운데 */
export function fractionOf(start: number, size: number, point: number): number {
  return size > 0 ? (point - start) / size : 0.5;
}

/**
 * 비율을 바꾼 뒤, 아까 가리키던 지점(fraction)이 다시 커서(point) 아래에 오도록 스크롤을 얼마나 더 움직일지.
 * start·size는 비율을 바꾼 뒤의 내용 위치·크기. 양수면 스크롤을 뒤쪽(오른쪽·아래)으로 움직인다.
 */
export function scrollShift(start: number, size: number, fraction: number, point: number): number {
  return start + fraction * size - point;
}
