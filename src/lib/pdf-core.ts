// PDF 뷰어의 순수 계산 (외부 의존 없음 — node로 직접 테스트 가능)

/** 화면에서 이 거리보다 멀어진 쪽은 그림 메모리를 돌려준다 (그리기 시작은 600px 안쪽) */
export const KEEP_MARGIN = "2400px 0px";

/** 한 쪽의 그림(캔버스) 최대 화소 수. 큰 확대·고해상도 화면에서도 쪽 하나가 수십 MB를 넘지 않게 한다 (넘으면 해상도를 낮춰 그린다) */
export const MAX_CANVAS_PIXELS = 12_000_000;

/** 캔버스 화소 수가 한도를 넘으면 줄일 배율 (1이면 그대로) */
export function pixelLimitScale(width: number, height: number): number {
  const pixels = width * height;
  return pixels > MAX_CANVAS_PIXELS ? Math.sqrt(MAX_CANVAS_PIXELS / pixels) : 1;
}
