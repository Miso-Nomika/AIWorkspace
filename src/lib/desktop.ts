// 데스크톱(Tauri) 네이티브 기능 호출. Rust 명령은 src-tauri/src 에 있다.
// isDesktop(): Tauri 창 안인지 (개발 중 일반 브라우저로 열었을 때 호출을 건너뛰는 용도)

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { sshErrorMessage, type ClaudeLoginEvent, type ClaudeStatus, type SshDirListing, type SshHost, type SshTestReport } from "./ssh-core";
import type { AgentId, FileNode, MainModel, PermissionMode, PlannerModel } from "./types";

export interface AgentStatus {
  id: AgentId;
  installed: boolean;
  path: string | null;
  version: string | null;
}

export type AgentStreamEvent = { type: "stdout"; line: string } | { type: "stderr"; line: string };

export interface AgentExit {
  code: number | null;
  cancelled: boolean;
}

/** 일반 채팅 실행 요청 (src-tauri/src/chat.rs) */
export interface ChatSendRequest {
  requestId: string;
  provider: "claude" | "codex";
  /** Claude: haiku·sonnet·opus, ChatGPT: 모델 이름 (없으면 기본) */
  model?: string;
  system: string;
  prompt: string;
  /** 첨부 이미지 파일 경로 (채팅 파일 폴더 안의 것만) */
  images?: string[];
  web?: boolean;
  /** 이어 갈 이전 세션 id */
  session?: string;
}

export interface ChatExit {
  code: number | null;
  cancelled: boolean;
  timedOut: boolean;
}

export interface CodexModel {
  slug: string;
  displayName: string;
  contextWindow: number | null;
}

export interface AgentProcessRequest {
  runId: string;
  agent: AgentId;
  root: string;
  prompt: string;
  sessionId?: string;
  permissionMode: PermissionMode;
  allowedTools: string[];
  mainModel?: MainModel;
  plannerModel?: PlannerModel;
  images?: { mediaType: string; data: string }[];
}

/** 엑셀 한 시트 (Rust read_project_sheet). merges: [시작 행, 시작 열, 끝 행, 끝 열] (0부터) */
export interface SheetData {
  name: string;
  hidden: boolean;
  rows: string[][];
  merges: [number, number, number, number][];
  truncated: boolean;
  skipped: boolean;
}
export interface SheetBook {
  sheets: SheetData[];
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: { status: string; path: string }[];
  lastCommit: { hash: string; message: string; relativeTime: string } | null;
}

/** Rust가 바이트 그대로 보내는 채널 (ArrayBuffer 또는 숫자 배열로 도착) */
function rawChannel(onData: (bytes: Uint8Array) => void) {
  const channel = new Channel<ArrayBuffer | number[]>();
  channel.onmessage = (data) => onData(data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data));
  return channel;
}

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 음악: yt-dlp 도구 상태 (source: path=PC에 설치됨, app=앱이 받아 둠) */
export interface MusicToolStatus {
  path: string | null;
  source: "path" | "app" | null;
  version: string | null;
}

export interface MusicDownloadResult {
  id: string;
  title: string;
  duration: number | null;
  ext: string;
  bytes: number;
}

export interface PlanInfo {
  subscription: string;
  tier: string | null;
}

export interface DeviceInfo {
  computerName: string;
  defaultProjectsDir: string;
}

export interface FileListing {
  nodes: FileNode[];
  truncated: boolean;
}

export const desktop = {
  loadAllData: () => invoke<Record<string, unknown>>("data_load_all"),
  saveData: (key: string, value: unknown) => invoke<void>("data_save", { key, value }),
  removeData: (key: string) => invoke<void>("data_remove", { key }),
  deviceInfo: () => invoke<DeviceInfo>("device_info"),
  /** 설치 방식: "windows" | "appimage" | "package"(.deb 등 — 앱이 스스로 업데이트할 수 없음) */
  installKind: () => invoke<string>("install_kind"),
  createProjectDir: (parent: string, name: string) => invoke<string>("create_project_dir", { parent, name }),
  /** 파일 트리: 최상위는 항상 모두, expanded(프로젝트 기준 상대 경로)에 든 폴더만 안까지 읽는다 */
  listProjectFiles: (root: string, expanded: string[]) => invoke<FileListing>("list_project_files", { root, expanded }),
  readProjectFile: (root: string, path: string) => invoke<string>("read_project_file", { root, path }),
  /** 파일 트리: 폴더(parent, ""=최상위) 안에 빈 파일·폴더를 만든다. 같은 이름이 있으면 실패. 새 항목의 상대 경로 */
  createProjectEntry: (root: string, parent: string, name: string, kind: "file" | "dir") =>
    invoke<string>("create_project_entry", { root, parent, name, kind }),
  /** 파일 트리: 파일·폴더를 다른 폴더 안으로 옮긴다 (덮어쓰지 않음). 새 상대 경로 */
  moveProjectEntry: (root: string, from: string, toDir: string) => invoke<string>("move_project_entry", { root, from, toDir }),
  /** 같은 폴더 안에서 파일·폴더 이름을 바꾼다. 새 상대 경로를 돌려준다 */
  renameProjectEntry: (root: string, path: string, newName: string) => invoke<string>("rename_project_entry", { root, path, newName }),
  /** 파일 트리: 파일·폴더를 영구 삭제한다 (휴지통 없음, 폴더는 안의 내용까지). 지운 항목 수 */
  deleteProjectEntry: (root: string, path: string) => invoke<number>("delete_project_entry", { root, path }),
  /** 변경 탭: 선택한 파일을 마지막 커밋 상태로 되돌린다 (수정·삭제는 복원, 마지막 커밋에 없던 새 파일은 삭제) */
  gitRevert: (root: string, paths: string[]) =>
    invoke<{ restored: number; removed: number; skipped: { path: string; reason: string }[] }>("git_revert", { root, paths }),
  /** 파일 관리자에서 끌어다 놓은 항목들을 폴더로 복사한다 (원본은 그대로). 복사된 새 경로와 건너뛴 항목·이유 */
  importIntoProject: (root: string, targetDir: string, sources: string[]) =>
    invoke<{ copied: string[]; skipped: { name: string; reason: string }[] }>("import_into_project", { root, targetDir, sources }),
  /** 이미지·PDF를 바이트 그대로 읽는다 (뷰어용) */
  readProjectFileBytes: (root: string, path: string) => invoke<ArrayBuffer>("read_project_file_bytes", { root, path }),
  /**
   * 터미널을 연결한다. 셸은 이름표(key)마다 하나씩이고("home" = 프로젝트 선택 화면, "p-<프로젝트 id>" = 프로젝트 뷰어 아래),
   * 이미 있으면 보관해 둔 최근 출력을 먼저 보낸다. root가 있으면 그 프로젝트 폴더(원격은 ssh 접속)에서, 없으면 홈 폴더에서 시작한다.
   * 출력은 바이트 그대로 onData로 온다. 셸이 살아 있으면 true.
   */
  terminalAttach: (key: string, root: string | null, cols: number, rows: number, onData: (bytes: Uint8Array) => void) =>
    invoke<boolean>("terminal_attach", { key, root, cols, rows, onData: rawChannel(onData) }),
  /** 화면이 사라질 때 연결만 끊는다 (셸은 계속 살아 있다) */
  terminalDetach: (key: string) => invoke<void>("terminal_detach", { key }),
  /** 사용자가 친 글자를 셸에 보낸다 */
  terminalWrite: (key: string, data: string) => invoke<void>("terminal_write", { key, data }),
  terminalResize: (key: string, cols: number, rows: number) => invoke<void>("terminal_resize", { key, cols, rows }),
  /** 셸을 끄고 새로 시작한다 */
  terminalRestart: (key: string, root: string | null, cols: number, rows: number, onData: (bytes: Uint8Array) => void) =>
    invoke<boolean>("terminal_restart", { key, root, cols, rows, onData: rawChannel(onData) }),
  /** 그 이름표의 셸이 끝났을 때 한 번 알려 준다. 해제 함수를 돌려준다 */
  onTerminalExit: (key: string, handler: () => void) => listen<string>("terminal-exit", (event) => event.payload === key && handler()),
  /** 개인 홈: 미국 소비자물가(BLS) 원본 JSON 글 — 10년짜리 창 두 개, 오래된 것부터 */
  fetchCpi: () => invoke<string[]>("home_fetch_cpi"),
  /** 개인 홈: 미국 기준금리(뉴욕 연준 실효금리, 일별) 원본 JSON 글 */
  fetchEffr: () => invoke<string>("home_fetch_effr"),
  /** 개인 홈 사용자 위젯: 공개 주소(https, GET)를 Rust가 대신 받아 글로 돌려준다. preview는 아직 저장되지 않은 위젯의 미리보기 */
  homeFetch: (url: string, query: Record<string, string>, preview: boolean) => invoke<string>("home_fetch", { request: { url, query, preview } }),
  /** 엑셀(xlsx·xlsm)을 시트별 표로 읽는다 (뷰어용, 읽기 전용) */
  readProjectSheet: (root: string, path: string) => invoke<SheetBook>("read_project_sheet", { root, path }),
  gitStatus: (root: string) => invoke<GitStatus>("git_status", { root }),
  /** 한 파일의 변경 내용(마지막 커밋과의 차이, unified diff). 변경이 없으면 빈 문자열 */
  gitDiff: (root: string, path: string) => invoke<string>("git_diff", { root, path }),
  /** 선택한 파일만 한 커밋으로 만든다 (사용자가 버튼을 눌렀을 때만). 실패하면 git이 낸 메시지로 거절된다 */
  gitCommit: (root: string, paths: string[], message: string) => invoke<string>("git_commit", { root, paths, message }),
  /** 현재 브랜치를 푸시한다 (강제 푸시 없음) */
  gitPush: (root: string) => invoke<string>("git_push", { root }),
  /** 컴퓨터를 켜면 앱을 자동 실행(창 없이 트레이로)하도록 운영체제에 등록·해제한다. 실패하면 오류 메시지로 거절된다 */
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
  /** 프로젝트 폴더를 운영체제 파일 관리자로 연다 */
  openProjectFolder: (root: string) => invoke<void>("open_project_folder", { root }),
  /** 프로젝트 폴더 실시간 감시 시작 (이벤트 `project-fs-changed`). 시작하지 못하면 false → 주기적 확인으로 대신한다 */
  watchProject: (root: string) => invoke<boolean>("watch_project", { root }),
  unwatchProject: (root: string) => invoke<void>("unwatch_project", { root }),
  /** 표준 문서(TODO.md, 기능명세서.md)가 없으면 만든다. 만든 파일 이름 목록 */
  ensureProjectDocs: (root: string) => invoke<string[]>("ensure_project_docs", { root }),
  detectAgents: () => invoke<AgentStatus[]>("agent_detect"),
  /** 원격 PC에 접속해 시험한다 (OS·git·claude·감시 방식). trust=true면 처음 보는 호스트의 키를 신뢰하고 접속한다 */
  sshTest: (host: SshHost, trust = false) => invoke<SshTestReport>("ssh_test", { host, trust }),
  /** 처음 접속하는 호스트의 키 지문(SHA256) — 신뢰하기 전에 사용자에게 보여 준다 */
  sshHostFingerprint: (host: SshHost) => invoke<string>("ssh_host_fingerprint", { host }),
  /** 원격 폴더 선택기: path가 없으면 홈에서 시작. 폴더 이름만 돌려준다 */
  sshListDir: (hostId: string, path?: string) => invoke<SshDirListing>("ssh_list_dir", { hostId, path }),
  sshMakeDir: (hostId: string, parent: string, name: string) => invoke<string>("ssh_make_dir", { hostId, parent, name }),
  /** 원격 PC의 Claude Code 설치·로그인 상태 */
  sshClaudeStatus: (hostId: string) => invoke<ClaudeStatus>("ssh_claude_status", { hostId }),
  /** 원격 PC에 Claude Code를 설치한다 (공식 설치 스크립트). 진행 줄을 onLine으로 받고, 끝나면 설치 후 상태를 돌려준다 */
  sshClaudeInstall: (hostId: string, onLine: (text: string) => void) => {
    const channel = new Channel<{ type: "line"; text: string }>();
    channel.onmessage = (event) => onLine(event.text);
    return invoke<ClaudeStatus>("ssh_claude_install", { hostId, onEvent: channel });
  },
  /** 원격에서 `claude auth login`을 시작한다. 로그인 주소·출력·결과를 onEvent로 받고 loginId를 돌려준다 */
  sshClaudeLoginStart: (hostId: string, onEvent: (event: ClaudeLoginEvent) => void) => {
    const channel = new Channel<ClaudeLoginEvent>();
    channel.onmessage = onEvent;
    return invoke<string>("ssh_claude_login_start", { hostId, onEvent: channel });
  },
  /** 브라우저 승인 뒤 받은 코드를 원격 로그인에 보낸다 */
  sshClaudeLoginCode: (loginId: string, code: string) => invoke<void>("ssh_claude_login_code", { loginId, code }),
  sshClaudeLoginCancel: (loginId: string) => invoke<void>("ssh_claude_login_cancel", { loginId }),
  sshReconnect: (hostId: string) => invoke<void>("ssh_reconnect", { hostId }),
  /** 접속 정보를 지우거나 고쳤을 때 열려 있던 연결을 닫는다 */
  sshForget: (hostId: string) => invoke<void>("ssh_forget", { hostId }),
  /** 원격 연결 상태가 바뀔 때마다 알려 준다 (끊김 표시용). 해제 함수를 돌려준다 */
  onSshStatus: (handler: (status: { hostId: string; connected: boolean }) => void) => listen<{ hostId: string; connected: boolean }>("ssh-status", (event) => handler(event.payload)),
  /** 에이전트 실행. 출력은 onEvent로 줄 단위 전달되고, 프로세스가 끝나면 resolve 된다. */
  runAgent: (request: AgentProcessRequest, onEvent: (event: AgentStreamEvent) => void) => {
    const channel = new Channel<AgentStreamEvent>();
    channel.onmessage = onEvent;
    return invoke<AgentExit>("agent_run", { request, onEvent: channel });
  },
  cancelAgent: (runId: string) => invoke<boolean>("agent_cancel", { runId }),
  /** 일반 채팅 한 번 실행. 출력은 onEvent로 줄 단위 전달되고, 프로세스가 끝나면 resolve 된다 */
  chatSend: (request: ChatSendRequest, onEvent: (event: AgentStreamEvent) => void) => {
    const channel = new Channel<AgentStreamEvent>();
    channel.onmessage = onEvent;
    return invoke<ChatExit>("chat_send", { request, onEvent: channel });
  },
  chatCancel: (requestId: string) => invoke<boolean>("chat_cancel", { requestId }),
  /** 채팅 첨부(base64)를 이 대화의 채팅 파일 폴더에 저장하고 파일 경로를 돌려준다. name은 `<영문·숫자·-·_>.<png|jpg|jpeg|gif|webp|txt>` */
  chatAttachSave: (chatId: string, name: string, data: string) => invoke<string>("chat_attach_save", { chatId, name, data }),
  /** 저장해 둔 첨부 글(.txt)을 읽는다 */
  chatAttachRead: (chatId: string, name: string) => invoke<string>("chat_attach_read", { chatId, name }),
  /** 대화를 지울 때: 첨부 파일 폴더(chatId가 없으면 모든 대화의 것)와 CLI 세션 파일을 지운다 */
  chatDeleteFiles: (chatId: string | null, sessions: { provider: "claude" | "codex"; id: string }[]) =>
    invoke<{ filesRemoved: boolean; sessionsRemoved: number }>("chat_delete_files", { chatId, sessions }),
  /** 웹 주소를 기본 브라우저로 연다 (http·https만) */
  openExternalUrl: (url: string) => invoke<void>("open_external_url", { url }),
  /** 이 계정의 Codex가 보여 주는 ChatGPT 모델 목록 (없거나 실패하면 빈 목록) */
  chatCodexModels: () => invoke<CodexModel[]>("chat_codex_models"),
  /** 실행 중 권한 요청에 대한 응답 (control_response) */
  respondAgent: (runId: string, message: unknown) => invoke<void>("agent_respond", { runId, message }),
  // 음악 (src-tauri/src/music.rs): yt-dlp로 유튜브 음원만 받아 앱 데이터 폴더에 두고 재생용으로 읽는다
  musicToolStatus: () => invoke<MusicToolStatus>("music_tool_status"),
  musicToolInstall: () => invoke<MusicToolStatus>("music_tool_install"),
  musicToolUpdate: () => invoke<MusicToolStatus>("music_tool_update"),
  /** 영상 ID의 음원을 받는다 (곡마다 한 번에 하나). 진행률(0~100)을 onProgress로 알린다 */
  musicDownload: (id: string, onProgress: (percent: number) => void) => {
    const channel = new Channel<{ percent: number }>();
    channel.onmessage = (event) => onProgress(event.percent);
    return invoke<MusicDownloadResult>("music_download", { id, onEvent: channel });
  },
  /** 이 PC에 받아 둔 음원의 영상 ID 목록 */
  musicFiles: () => invoke<string[]>("music_files"),
  musicRead: (id: string) => invoke<ArrayBuffer>("music_read", { id }),
  musicDeleteFile: (id: string) => invoke<void>("music_delete_file", { id }),
  // 음악 목록 동기화 (src-tauri/src/memory.rs): 링크·제목·곡별 음량만, 음원 파일은 올리지 않는다
  musicSyncPull: (folder: string) => invoke<unknown[]>("music_sync_pull", { folder }),
  musicSyncPush: (folder: string, deviceId: string, snapshot: unknown) => invoke<void>("music_sync_push", { folder, deviceId, snapshot }),
  /** 홈 위젯 스냅샷(home-<기기ID>.json) 읽기·쓰기 — 음악과 같은 방식 */
  homeSyncPull: (folder: string) => invoke<unknown[]>("home_sync_pull", { folder }),
  homeSyncPush: (folder: string, deviceId: string, snapshot: unknown) => invoke<void>("home_sync_push", { folder, deviceId, snapshot }),
  // 공통 메모리 동기화 (src-tauri/src/memory.rs)
  memorySyncPull: (folder: string) => invoke<unknown[]>("memory_sync_pull", { folder }),
  memorySyncPush: (folder: string, deviceId: string, snapshot: unknown) =>
    invoke<void>("memory_sync_push", { folder, deviceId, snapshot }),
  memorySyncCandidates: () => invoke<string[]>("memory_sync_candidates"),
  /** 실제로 기기별 파일을 두는 폴더(고른 폴더 안의 .AIWorkspace — 없으면 만든다) */
  memorySyncLocation: (folder: string) => invoke<string>("memory_sync_location", { folder }),
  /** 구독 플랜 (예: "pro"). 로그인하지 않았거나 API 키 사용이면 null */
  /** 구독 플랜 원문 (subscriptionType, planTier). 로그인하지 않았거나 API 키 사용이면 null */
  claudePlan: () => invoke<PlanInfo | null>("claude_plan"),
  /** 사용량 확인용으로 가장 작은 모델을 한 번 실행해 rate_limit_event 한 줄을 받는다 */
  claudeUsageProbe: () => invoke<string | null>("claude_usage_probe"),
  /** Rust가 자동으로(또는 트레이 메뉴로) 실행한 사용량 확인의 결과(rate_limit_event 한 줄)를 받는다. 구독 해제 함수를 돌려준다 */
  onUsageProbed: (callback: (line: string) => void) => listen<string>("usage-probed", (event) => callback(event.payload)),
  /** 대화 기록 분석 (Claude Code, 도구 없이). 결과 텍스트에 학습 태그가 담긴다 */
  memoryAnalyze: (prompt: string) => invoke<string>("memory_analyze", { prompt }),
  memoryExport: (markdown: string, globalMarkdown: string, claudeGlobal: boolean) =>
    invoke<{ path: string; claudeGlobal: string | null }>("memory_export", {
      markdown,
      globalMarkdown,
      claudeGlobal,
    }),
  /** 프로젝트 메모리: 프로젝트 폴더 CLAUDE.md의 앱 관리 영역에 줄을 덧붙인다 (같은 줄은 건너뜀·40줄 상한). added: 실제로 추가된 줄 수 */
  projectMemoryAdd: (root: string, lines: string[]) =>
    invoke<{ path: string; added: number; total: number }>("project_memory_add", { root, lines }),
  /** 폴더 선택 대화상자. 취소하면 null */
  pickFolder: async (defaultPath?: string) => {
    const selected = await open({ directory: true, multiple: false, defaultPath });
    return typeof selected === "string" ? selected : null;
  },
};

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_NAME: "폴더 이름으로 쓸 수 없는 문자가 있습니다. (\\ / : * ? \" < > | 사용 불가, 앞뒤 공백 불가)",
  INVALID_PARENT: "폴더 위치가 올바르지 않습니다.",
  ALREADY_EXISTS: "같은 이름의 폴더가 이미 있습니다. 다른 이름을 쓰거나 '기존 폴더 선택'을 사용하세요.",
  NOT_FOUND: "파일이나 폴더를 찾을 수 없습니다. 이동되었거나 삭제되었을 수 있습니다.",
  NOT_REGISTERED: "등록된 프로젝트 폴더가 아닙니다.",
  OUTSIDE_PROJECT: "프로젝트 폴더 밖의 파일은 열 수 없습니다.",
  NOT_A_FILE: "파일이 아닙니다.",
  TOO_LARGE: "1MB보다 큰 파일은 미리보기를 지원하지 않습니다.",
  BINARY: "텍스트 파일이 아니라 미리보기를 지원하지 않습니다.",
  TOO_LARGE_MEDIA: "이미지는 20MB, PDF는 50MB보다 큰 파일은 미리보기를 지원하지 않습니다.",
  UNSUPPORTED_TYPE: "이 형식은 미리 볼 수 없습니다.",
  TOO_LARGE_SHEET: "엑셀 파일이 너무 큽니다(20MB 초과이거나 압축을 풀면 200MB 초과). 미리보기를 지원하지 않습니다.",
  INVALID_SHEET: "엑셀 파일을 읽을 수 없습니다. 손상되었거나 암호가 걸려 있을 수 있습니다.",
  INVALID_ATTACHMENT: "첨부 파일을 저장할 수 없습니다. 형식과 크기를 확인해 주세요.",
  INVALID_URL: "열 수 없는 주소입니다.",
  CLI_NOT_FOUND: "채팅에 쓸 프로그램(Claude Code 또는 Codex)을 이 PC에서 찾지 못했습니다. 설치하고 로그인한 뒤 다시 시도하세요.",
  INVALID_MODEL: "선택할 수 없는 모델입니다.",
  INVALID_SESSION: "이어 갈 대화 정보가 올바르지 않습니다.",
  INVALID_IMAGE: "첨부한 이미지를 읽을 수 없습니다. 다시 첨부해 주세요.",
  TOO_MANY_IMAGES: "이미지는 최대 5장까지 첨부할 수 있습니다.",
  PROMPT_TOO_LONG: "보내려는 내용이 너무 깁니다. 첨부를 줄여 주세요.",
  AGENT_NOT_INSTALLED: "이 PC에서 에이전트 CLI를 찾지 못했습니다. 설치 후 대시보드에서 다시 확인하세요.",
  AGENT_NOT_SUPPORTED: "이 에이전트의 실행 연동은 아직 지원하지 않습니다. (현재 Claude Code만 지원)",
  INVALID_PERMISSION_MODE: "허용되지 않은 권한 모드입니다.",
  GIT_NOT_FOUND: "Git을 찾지 못했습니다. Git을 설치하면 상태를 볼 수 있습니다.",
  SYNC_NOT_CONFIGURED: "동기화 폴더가 설정되지 않았습니다.",
  SYNC_FOLDER_UNAVAILABLE: "동기화 폴더에 접근할 수 없습니다. Google Drive가 실행 중인지 확인하세요. (변경 사항은 이 PC에 저장되고 다시 연결되면 동기화됩니다)",
  INVALID_DEVICE_ID: "기기 ID가 올바르지 않습니다.",
  INVALID_PROMPT: "분석할 대화 기록이 없거나 너무 깁니다.",
  OPEN_FAILED: "폴더를 열지 못했습니다. 파일 관리자가 설치되어 있는지 확인하세요.",
  TERMINAL_LIMIT: "터미널이 너무 많이 열려 있습니다. 다른 프로젝트의 터미널을 닫은 뒤 다시 열어 주세요.",
  NOT_A_REPO: "Git 저장소가 아니라 변경 내용을 볼 수 없습니다.",
  COMPACT_EMPTY: "압축 초안을 읽지 못했습니다. 잠시 후 다시 시도하세요.",
  ANALYZE_TIMEOUT: "대화 기록 분석이 너무 오래 걸려 중단했습니다. 잠시 후 다시 시도하세요.",
};

/** Rust 명령의 오류 코드를 사용자 메시지로 바꾼다. */
export function errorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  const ssh = sshErrorMessage(code);
  if (ssh) return ssh;
  if (code.startsWith("SPAWN_FAILED")) return `에이전트를 실행하지 못했습니다. (${code.slice(14)})`;
  if (code.startsWith("ANALYZE_FAILED")) return `대화 기록 분석에 실패했습니다. Claude Code 로그인 상태를 확인하세요. (${code.slice(16)})`;
  return ERROR_MESSAGES[code] ?? code;
}
