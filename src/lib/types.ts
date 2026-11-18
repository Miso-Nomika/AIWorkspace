// 도메인 타입. 나중에 DB/API 스키마와 맞춰 확장한다.

/** 지원 에이전트. 현재 Claude Code만 — 추가 시 agents.ts의 안내 참고 */
export type AgentId = "claude-code";

/**
 * 에이전트 권한 (Claude Code permission mode와 같음)
 * - default: 터미널 기본 — 파일 수정·명령 실행 전에 AIWorkspace가 승인을 묻는다
 * - acceptEdits: 파일 수정은 자동 허용, 명령 실행은 승인 요청
 * - plan: 읽기·계획만
 * - auto: 자동 승인 — 권한 요청에 AIWorkspace가 대신 '허용'으로 답한다 (CLI는 acceptEdits로 실행).
 *         CLI의 권한 확인 자체를 끄는 bypassPermissions와 달리 CLI의 거부 규칙은 그대로 적용되고,
 *         질문(AskUserQuestion)·계획 승인(ExitPlanMode)은 계속 사용자에게 묻는다.
 */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto";

/** 실제 작업(코딩)을 하는 메인 모델 — Claude Code --model 별칭 */
export type MainModel = "haiku" | "sonnet" | "opus";
/** 기획(planner 서브에이전트)을 맡는 모델 */
export type PlannerModel = "opus" | "fable";

/** 한 번의 응답에 든 시간·비용 (Claude Code result 이벤트) */
export interface RunStats {
  durationMs?: number;
  /** API 요금 기준 추정액(USD). 구독 사용자는 실제 청구액이 아니다 */
  costUsd?: number;
}

/** 에이전트 도구 사용 기록 (명령 출력·수정 내용을 펼쳐 볼 수 있음) */
export interface ActivityItem {
  id: string;
  label: string;
  /** 실행한 명령, 수정 diff 등 */
  detail?: string;
  /** 도구 실행 결과 */
  output?: string;
  isError?: boolean;
  /** 권한이 거부되어 실행되지 않음 */
  denied?: boolean;
}

/** 프로젝트 폴더가 실제로 있는 위치 (어느 PC의 어느 경로) */
export interface ProjectLocation {
  deviceId: string;
  deviceName?: string;
  /** 로컬이면 이 PC의 경로, 원격(SSH)이면 원격 PC의 절대 경로 */
  path: string;
  /** SSH로 접속하는 원격 폴더인 경우 접속 정보의 id (설정의 "원격 접속"에 저장된 접속). 이때 deviceId는 이 앱이 있는 PC다 */
  remote?: { hostId: string };
}

export interface Project {
  id: string;
  name: string;
  description: string;
  agent: AgentId;
  createdAt: string; // ISO
  location?: ProjectLocation; // 없으면 폴더 미연결 (이전 버전의 시연용 프로젝트)
  permissionMode?: PermissionMode; // 기본 default (터미널과 같음)
  /** "항상 허용"한 규칙 (예: "Bash(npm run build *)") — 다음 실행부터 묻지 않음 */
  allowedTools?: string[];
  mainModel?: MainModel; // 기본 sonnet
  plannerModel?: PlannerModel; // 기본 opus
}

export interface FileNode {
  name: string;
  type: "file" | "folder";
  children?: FileNode[];
  /** 폴더를 읽었을 때 그 안의 전체 항목 수 (children이 이보다 적으면 이름순 앞 50,000개만 담긴 것 — 끝에 안내 줄을 보인다) */
  total?: number;
  content?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  agent: AgentId;
  createdAt: string; // ISO
  activity?: (ActivityItem | string)[]; // 에이전트 도구 사용 기록 (0.3.x는 문자열)
  notes?: string[]; // 참고 사항 (중지, 권한 거부 등)
  error?: boolean;
  images?: string[]; // 사용자가 첨부한 이미지의 작은 미리보기 (data URL)
  stats?: RunStats; // 응답에 걸린 시간·비용
}

/** 공통(개인) 메모리 분류: 개인 취향 / 대화 방식 / 피드백 (코드 작성 방식은 에이전트가 판단하므로 저장하지 않는다) */
export type MemoryCategory = "preference" | "communication" | "feedback";

/** 공통 메모리. 모든 PC가 Google Drive로 동기화한다 (마지막 수정 우선). */
export interface Memory {
  id: string;
  category: MemoryCategory;
  title: string;
  content: string;
  updatedAt: string; // ISO — 동기화 병합 기준
  deletedAt?: string; // 삭제 기록(tombstone). 다른 PC에도 삭제를 전파하기 위해 남겨 둔다
  updatedBy?: string; // 마지막으로 수정한 기기 ID
  source?: "manual" | "learned"; // learned = AI 사용 중 자동 학습
}
