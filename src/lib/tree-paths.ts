import { sshErrorMessage } from "./ssh-core.ts";

// 파일 트리 경로 계산 (순수 함수, 외부 의존 없음 — node로 직접 테스트 가능). 경로는 프로젝트 기준 상대 경로이고 구분자는 "/"다.

/** 한 폴더에서 보여 주는 최대 항목 수 — 처음부터 이만큼 보여 준다 (Rust의 MAX_LIST_LIMIT와 같다) */
export const TREE_MAX = 50_000;

/** 항목이 들어 있는 폴더 ("" = 프로젝트 최상위) */
export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** 끌어 옮길 때 dir 폴더가 from의 도착지로 유효한지: 이미 그 폴더 안이거나, 자기 자신·자기 하위 폴더면 안 된다 */
export function canDropInto(from: string, dir: string): boolean {
  if (dir === parentDir(from)) return false;
  return dir !== from && !dir.startsWith(`${from}/`);
}

/** 이동으로 바뀐 경로를 따라간다: from 자체 또는 그 아래 경로면 to 기준으로 바꾼다 */
export function remapPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}

/** 폴더와 그 상위 폴더를 모두 펼친 새 집합 ("a/b/c" → a, a/b, a/b/c). 이미 모두 펼쳐져 있으면 같은 집합을 돌려준다 */
export function withExpanded(expanded: Set<string>, dir: string): Set<string> {
  if (!dir) return expanded;
  const parts = dir.split("/");
  const needed = parts.map((_, i) => parts.slice(0, i + 1).join("/")).filter((p) => !expanded.has(p));
  return needed.length ? new Set([...expanded, ...needed]) : expanded;
}

const TREE_MESSAGES: Record<string, string> = {
  ALREADY_EXISTS: "같은 이름이 이미 있습니다.",
  IGNORED_DIR: "node_modules·.git 같은 제외 폴더 안에서는 만들거나 옮기거나 지울 수 없습니다.",
  NOT_A_DIR: "폴더가 아닙니다.",
  MOVE_INTO_SELF: "폴더를 자기 자신이나 그 하위 폴더로 옮길 수 없습니다.",
  SYMLINK: "바로가기(심볼릭 링크)는 옮길 수 없습니다.",
  INVALID_NAME: '이름으로 쓸 수 없습니다. (\\ / : * ? " < > | 사용 불가, 앞뒤 공백·끝의 점 불가, CON·NUL 같은 Windows 예약 이름 불가, 200자 이하)',
  OUTSIDE_PROJECT: "프로젝트 폴더 밖입니다.",
  NOT_FOUND: "항목을 찾을 수 없습니다. 이미 이동되었거나 삭제되었을 수 있습니다.",
  NOT_REGISTERED: "등록된 프로젝트 폴더가 아닙니다.",
};

/** 파일 트리 조작의 오류 코드를 사용자 메시지로 바꾼다 (Rust가 돌려주는 코드). 모르는 코드는 그대로 보여 준다 */
export function treeError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code.startsWith("MOVE_FAILED") || code.startsWith("CREATE_FAILED") || code.startsWith("DELETE_FAILED") || code.startsWith("RENAME_FAILED")) return `작업에 실패했습니다. (${code.slice(code.indexOf(":") + 2)})`;
  return TREE_MESSAGES[code] ?? sshErrorMessage(code) ?? code;
}
