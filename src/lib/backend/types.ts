import type { ActivityItem, AgentId, FileNode, MainModel, PermissionMode, PlannerModel, Project, RunStats } from "../types";
import type { SheetBook } from "../desktop";

/**
 * 프로젝트의 파일과 에이전트에 접근하는 방식.
 * - local:       이 기기의 프로젝트 폴더 (데스크톱 앱 → Rust 명령)
 * - unavailable: 프로젝트 폴더가 다른 기기에 있음. 원격 실행(remote)이 구현되면 이 자리를 대체한다.
 * UI는 어떤 방식인지 몰라도 같은 인터페이스로 사용한다.
 */
export type BackendKind = "local" | "unavailable";

export interface AgentRunRequest {
  agent: AgentId;
  project: Project;
  prompt: string;
  /** 이전 대화를 이어갈 세션 ID (에이전트가 지원하는 경우) */
  sessionId?: string;
  permissionMode: PermissionMode;
  /** "항상 허용"한 규칙 */
  allowedTools: string[];
  /** 실제 작업을 하는 모델 (없으면 sonnet) */
  mainModel?: MainModel;
  /** 기획(planner)을 맡는 모델 (없으면 opus) */
  plannerModel?: PlannerModel;
  /** 첨부 이미지 (base64) */
  images?: { mediaType: string; data: string }[];
}

/** 실행 중 화면에 보여줄 누적 상태 */
export interface AgentProgress {
  text: string;
  activity: ActivityItem[];
}

export interface AgentRunResult extends AgentProgress {
  sessionId?: string;
  isError?: boolean;
  cancelled?: boolean;
  /** 걸린 시간·비용 (중지하거나 결과를 받지 못하면 없음) */
  stats?: RunStats;
  /** 사용자에게 알릴 참고 사항 (권한 거부 등) */
  notes: string[];
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

/** 에이전트가 실행 중에 요청한 권한 확인 (터미널의 승인 프롬프트와 같음) */
export interface PermissionRequest {
  requestId: string;
  toolName: string;
  description?: string;
  input: Record<string, unknown>;
  /** 화면에 보여줄 요약 (명령, 파일 경로, diff 등) */
  summary: { label: string; detail?: string };
  /** "항상 허용"을 고르면 저장할 규칙 (예: "Bash(npm run build *)") */
  suggestedRule?: string;
  /** AskUserQuestion 도구: 사용자에게 묻는 질문 */
  questions?: AskQuestion[];
}

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; rememberRule?: string }
  | { behavior: "deny"; message: string };

export interface AgentRunHandlers {
  onProgress: (progress: AgentProgress) => void;
  /** 권한 요청 — 사용자가 답할 때까지 기다린다 */
  onPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
}

export interface AgentRun {
  result: Promise<AgentRunResult>;
  cancel(): void;
}

export interface FileListing {
  nodes: FileNode[];
  /** 항목이 너무 많아(한 폴더 20만 개 초과·깊이 12 초과) 일부는 세지도 못했는지 */
  truncated: boolean;
  /** 프로젝트 최상위의 전체 항목 수 */
  total?: number;
}

export interface ProjectBackend {
  kind: BackendKind;
  /** expanded: 사용자가 펼친 폴더들(프로젝트 기준 상대 경로, "/" 구분) — 이 폴더들만 안까지 읽는다 */
  listFiles(project: Project, expanded: string[]): Promise<FileListing>;
  /** path: 프로젝트 폴더 기준 상대 경로 ("/" 구분) */
  readFile(project: Project, path: string): Promise<string>;
  /** 이미지·PDF를 바이트 그대로 (뷰어용) */
  readFileBytes(project: Project, path: string): Promise<ArrayBuffer>;
  /** 엑셀(xlsx·xlsm)을 시트별 표로 (뷰어용) */
  readSheet(project: Project, path: string): Promise<SheetBook>;
  runAgent(req: AgentRunRequest, handlers: AgentRunHandlers): AgentRun;
}
