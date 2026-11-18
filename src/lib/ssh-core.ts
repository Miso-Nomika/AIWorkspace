// SSH 원격 프로젝트의 순수 계산 (외부 의존 없음 — node로 직접 테스트 가능).
// 접속 정보는 앱 데이터의 `ssh-hosts` 키에 저장하고(이 PC 전용, Drive 동기화 안 함), 프로젝트 위치(location.remote.hostId)가 가리킨다.

export interface SshHost {
  /** 영문 소문자·숫자·하이픈 (프로젝트 위치가 가리키는 값) */
  id: string;
  /** 화면에 보이는 이름 */
  label: string;
  /** 호스트 이름·주소 또는 ~/.ssh/config의 별칭 */
  host: string;
  user?: string;
  port?: number;
  /** 개인 키 파일 경로 (없으면 ssh 설정·ssh-agent를 따른다) */
  identityFile?: string;
}

/** 연결 시험 결과 (src-tauri/src/remote/cmds.rs의 TestReport) */
export interface SshTestReport {
  os: string;
  git: string | null;
  claude: { path: string; version: string; loggedIn: boolean | null } | null;
  /** 파일 변경을 알아내는 방식 */
  watch: "inotify" | "fswatch" | "poll";
  home: string;
}

/** 원격 PC의 Claude Code 상태 (src-tauri/src/remote/claude.rs) */
export interface ClaudeStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  /** 설치되어 있을 때만 (읽지 못하면 null) */
  loggedIn: boolean | null;
  authMethod: string | null;
}

/** 원격 `claude auth login` 진행 알림 */
export type ClaudeLoginEvent = { type: "url"; url: string } | { type: "output"; text: string } | { type: "done"; ok: boolean; message: string };

/** 붙여 넣은 인증 코드가 보낼 수 있는 모양인지 (한 줄, 공백 없음) — 앞뒤 공백·줄바꿈은 떼고 돌려준다 */
export function cleanLoginCode(code: string): string | null {
  const trimmed = code.trim();
  return trimmed && trimmed.length <= 2048 && !/\s/.test(trimmed) ? trimmed : null;
}

/** 설치 줄을 화면에 보이는 마지막 몇 줄만 남긴다 */
export function lastLines(lines: string[], max = 10): string[] {
  return lines.length > max ? lines.slice(lines.length - max) : lines;
}

export interface SshDirListing {
  path: string;
  dirs: string[];
}

/** 프로젝트 위치 중 root 문자열을 만드는 데 필요한 부분 */
interface RootLocation {
  path: string;
  remote?: { hostId: string };
}

/** Rust 명령에 넘기는 root 문자열: 로컬은 경로 그대로, 원격은 `ssh://<hostId><원격 절대경로>` */
export function projectRoot(location: RootLocation): string {
  return location.remote ? `ssh://${location.remote.hostId}${location.path}` : location.path;
}

/** 이름에서 hostId를 만든다 (영문 소문자·숫자·하이픈, 이미 있으면 -2, -3…). 영문이 하나도 없으면 "host" */
export function newHostId(label: string, existing: string[]): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "host";
  if (!existing.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

/** "user@host:port" 형태의 짧은 표시 */
export function describeHost(host: Pick<SshHost, "host" | "user" | "port">): string {
  return `${host.user ? `${host.user}@` : ""}${host.host}${host.port && host.port !== 22 ? `:${host.port}` : ""}`;
}

/** 원격 프로젝트가 같은 곳(같은 접속의 같은 폴더)인지 비교하는 키 */
export function remoteKey(hostId: string, path: string): string {
  return `${hostId}:${path.replace(/\/+$/, "")}`;
}

/** 원격 절대 경로의 상위 폴더 ("/home/me" → "/home", "/home" → "/") */
export function remoteParent(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

export function remoteJoin(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

export function remoteBaseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? "";
}

/** 저장된 접속 정보 중 쓸 수 있는 것만 (깨진 값은 버린다) */
export function normalizeHosts(value: unknown): SshHost[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: SshHost[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const h = item as Record<string, unknown>;
    if (typeof h.id !== "string" || typeof h.host !== "string" || !/^[a-z0-9-]{1,64}$/.test(h.id) || !h.host.trim() || seen.has(h.id)) continue;
    seen.add(h.id);
    out.push({
      id: h.id,
      label: typeof h.label === "string" && h.label.trim() ? h.label : h.host,
      host: h.host.trim(),
      ...(typeof h.user === "string" && h.user.trim() ? { user: h.user.trim() } : {}),
      ...(typeof h.port === "number" && Number.isInteger(h.port) && h.port > 0 && h.port < 65536 ? { port: h.port } : {}),
      ...(typeof h.identityFile === "string" && h.identityFile.trim() ? { identityFile: h.identityFile.trim() } : {}),
    });
  }
  return out;
}

/** 입력칸의 값으로 접속 정보를 만든다. 잘못된 값이면 이유를 돌려준다 */
export function buildHost(input: { label: string; host: string; user: string; port: string; identityFile: string }, id: string): SshHost | string {
  const host = input.host.trim();
  if (!host) return "호스트 주소(또는 ~/.ssh/config의 별칭)를 입력하세요.";
  if (host.startsWith("-") || /[\s'"]/.test(host)) return "호스트 주소에 쓸 수 없는 글자가 있습니다.";
  const user = input.user.trim();
  if (user && !/^[A-Za-z0-9_.@-]{1,64}$/.test(user)) return "사용자 이름에 쓸 수 없는 글자가 있습니다.";
  if (user.startsWith("-")) return "사용자 이름에 쓸 수 없는 글자가 있습니다.";
  let port: number | undefined;
  if (input.port.trim()) {
    port = Number(input.port.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "포트는 1~65535 사이의 숫자로 입력하세요.";
  }
  const identityFile = input.identityFile.trim();
  if (identityFile.startsWith("-")) return "키 파일 경로가 올바르지 않습니다.";
  return {
    id,
    label: input.label.trim() || host,
    host,
    ...(user ? { user } : {}),
    ...(port ? { port } : {}),
    ...(identityFile ? { identityFile } : {}),
  };
}

const SSH_MESSAGES: Record<string, string> = {
  HOST_KEY_UNKNOWN: "처음 접속하는 PC입니다. 지문을 확인하고 신뢰해 주세요.",
  HOST_KEY_CHANGED: "이 PC의 호스트 키가 이전과 다릅니다. 다른 PC로 바뀌었거나 가로채기일 수 있어 연결하지 않습니다. 원인을 확인한 뒤 known_hosts에서 해당 항목을 지워야 합니다.",
  AUTH_FAILED: "로그인에 실패했습니다. 키 인증만 지원합니다 — 사용자 이름과 키 파일(또는 ssh-agent에 올린 키)을 확인하세요.",
  SSH_NOT_FOUND: "이 PC에서 ssh 프로그램을 찾지 못했습니다. OpenSSH 클라이언트를 설치하세요.",
  INVALID_HOST: "접속 정보가 올바르지 않습니다.",
  HOST_NOT_FOUND: "저장된 접속 정보를 찾을 수 없습니다. 설정의 원격 접속에서 다시 등록하세요.",
  TIMEOUT: "원격 PC가 시간 안에 응답하지 않았습니다.",
  CONNECTION_LOST: "원격 연결이 끊겼습니다. 다시 연결하세요.",
  CONNECTION_FAILED: "원격 PC에 연결하지 못했습니다.",
  PERMISSION_DENIED: "원격 PC에서 권한이 없어 할 수 없습니다.",
  REMOTE_PROJECT: "원격 폴더는 이 PC의 파일 관리자로 열 수 없습니다.",
  INSTALL_NO_DOWNLOADER: "원격 PC에 curl 또는 wget이 없어 설치 프로그램을 받을 수 없습니다. 둘 중 하나를 설치한 뒤 다시 시도하세요.",
  INSTALL_TIMEOUT: "설치가 너무 오래 걸려 중단했습니다. 원격 PC의 인터넷 연결을 확인한 뒤 다시 시도하세요.",
  INVALID_CODE: "코드 모양이 올바르지 않습니다. 승인 화면에 나온 코드를 공백 없이 그대로 붙여 넣으세요.",
  LOGIN_NOT_FOUND: "진행 중인 로그인이 없습니다. 다시 시작하세요.",
};

/** SSH 관련 오류 코드를 사용자 메시지로 바꾼다. SSH 오류가 아니면 null */
export function sshErrorMessage(code: string): string | null {
  if (SSH_MESSAGES[code]) return SSH_MESSAGES[code];
  if (code.startsWith("UNREACHABLE")) return `원격 PC에 닿지 못했습니다. 주소·포트와 네트워크를 확인하세요. (${code.replace(/^UNREACHABLE:?\s*/, "")})`;
  if (code.startsWith("CONNECTION_FAILED")) return `원격 PC에 연결하지 못했습니다. (${code.replace(/^CONNECTION_FAILED:?\s*/, "")})`;
  if (code.startsWith("INSTALL_FAILED")) return `설치하지 못했습니다. (${code.replace(/^INSTALL_FAILED:?\s*/, "")})`;
  if (code.startsWith("UNSUPPORTED_OS")) return `지원하지 않는 운영체제입니다 (${code.replace(/^UNSUPPORTED_OS:?\s*/, "")}). 원격은 Linux·Mac만 지원합니다.`;
  return null;
}

/** 파일 변경 감지 방식의 안내 문구 */
export function watchModeLabel(mode: SshTestReport["watch"]): string {
  if (mode === "inotify") return "즉시 반영 (inotify)";
  if (mode === "fswatch") return "즉시 반영 (fswatch)";
  return "3초마다 확인 (inotify-tools를 설치하면 즉시 반영됩니다)";
}
