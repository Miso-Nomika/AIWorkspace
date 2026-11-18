// 개인 홈 — 현재 시각 표시 계산 (순수 함수, 외부 의존 없음)
// 이 PC의 시간대를 쓰고 로캘 함수(Intl·toLocale*)는 쓰지 않아 어느 환경에서도 같은 글자가 나온다.

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const two = (n: number) => String(n).padStart(2, "0");

/** "2026년 11월 13일 (금)" */
export function formatClockDate(date: Date): string {
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일 (${WEEKDAYS[date.getDay()]})`;
}

/** 24시간 "15:04:05" */
export function formatClockTime(date: Date): string {
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** 12시간 표기용 조각: 15:04 → { period: "오후", hour: 3, minute: "04" } (0시는 오전 12시, 12시는 오후 12시) */
export function formatClockParts(date: Date): { period: "오전" | "오후"; hour: number; minute: string } {
  const h = date.getHours();
  return { period: h < 12 ? "오전" : "오후", hour: h % 12 === 0 ? 12 : h % 12, minute: two(date.getMinutes()) };
}

/** 다음 초가 시작될 때까지 남은 밀리초 (1~1000) — 초가 넘어가는 시점에 맞춰 다시 그리려고 쓴다 */
export function msUntilNextSecond(nowMs: number): number {
  return 1000 - (((nowMs % 1000) + 1000) % 1000);
}
