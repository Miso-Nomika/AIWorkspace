// Git 변경 상태 표시 (대시보드·변경 파일 목록 공용)

export const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  M: { label: "수정", className: "text-amber-700 dark:text-amber-400" },
  A: { label: "추가", className: "text-green-700 dark:text-green-400" },
  D: { label: "삭제", className: "text-red-700 dark:text-red-400" },
  R: { label: "이름변경", className: "text-blue-700 dark:text-blue-400" },
  C: { label: "복사", className: "text-blue-700 dark:text-blue-400" },
  U: { label: "충돌", className: "text-red-700 dark:text-red-400" },
  "??": { label: "새 파일", className: "text-green-700 dark:text-green-400" },
};

export function statusLabel(code: string) {
  if (code === "??") return STATUS_LABELS["??"];
  if (code.includes("U")) return STATUS_LABELS.U;
  return STATUS_LABELS[code.replace(/\s/g, "")[0]] ?? { label: code, className: "text-muted" };
}
