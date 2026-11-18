// 로컬 백엔드: 이 기기의 프로젝트 폴더를 Rust 명령으로 읽고, 에이전트 CLI를 프로젝트 폴더에서 실행한다 (데스크톱 앱 전용).

import { desktop } from "../desktop";
import { projectRoot } from "../ssh-core";
import type { AgentId, PermissionMode, Project } from "../types";
import { recordRateLimits } from "../usage";
import { buildControlResponse, createClaudeStreamParser } from "./claude-stream";
import type { AgentRun, ProjectBackend } from "./types";

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: "변경 전 확인",
  auto: "자동 승인",
  acceptEdits: "파일 수정 자동 허용",
  plan: "읽기 전용(계획)",
};

export const PERMISSION_HINTS: Record<PermissionMode, string> = {
  default: "터미널과 같습니다. 파일 수정·명령 실행 전에 승인을 묻습니다.",
  auto: "파일 수정·명령 실행을 묻지 않고 자동으로 허용합니다. 질문과 계획 승인만 묻습니다.",
  acceptEdits: "파일 수정은 묻지 않고, 명령 실행만 승인을 묻습니다.",
  plan: "파일을 읽고 계획만 세웁니다. 실행 전에 계획 승인을 묻습니다.",
};

/** 채팅창에서 고르는 권한 (이전 버전에서 고른 다른 모드는 그대로 표시만 한다) */
export const PERMISSION_CHOICES: PermissionMode[] = ["default", "auto"];

/** 사용자가 직접 답해야 하는 요청 (자동 승인 대상 아님) */
export function needsUserAnswer(toolName: string) {
  return toolName === "AskUserQuestion" || toolName === "ExitPlanMode";
}

/** CLI에 넘길 권한 모드. 자동 승인은 파일 수정을 CLI가 바로 허용하고, 나머지 요청은 AIWorkspace가 허용한다. */
function cliPermissionMode(mode: PermissionMode): Exclude<PermissionMode, "auto"> {
  return mode === "auto" ? "acceptEdits" : mode;
}

function rootOf(project: Project): string {
  if (!project.location) throw new Error("NOT_FOUND");
  return projectRoot(project.location); // 원격(SSH) 프로젝트는 ssh://… 형태
}

// 에이전트별 출력 해석기 (에이전트를 추가하면 src-tauri/src/agent.rs와 함께 등록).
const PARSERS: Partial<Record<AgentId, typeof createClaudeStreamParser>> = {
  "claude-code": createClaudeStreamParser,
};

export const localBackend: ProjectBackend = {
  kind: "local",

  listFiles: (project, expanded) => desktop.listProjectFiles(rootOf(project), expanded),
  readFile: (project, path) => desktop.readProjectFile(rootOf(project), path),
  readFileBytes: (project, path) => desktop.readProjectFileBytes(rootOf(project), path),
  readSheet: (project, path) => desktop.readProjectSheet(rootOf(project), path),

  runAgent(req, { onProgress, onPermission }): AgentRun {
    const createParser = PARSERS[req.agent];
    if (!createParser) return { result: Promise.reject(new Error("AGENT_NOT_SUPPORTED")), cancel() {} };

    const root = rootOf(req.project);
    const runId = crypto.randomUUID();
    const parser = createParser(root, PERMISSION_LABELS[req.permissionMode]);
    const stderr: string[] = [];

    const result = desktop
      .runAgent(
        {
          runId,
          agent: req.agent,
          root,
          prompt: req.prompt,
          sessionId: req.sessionId,
          permissionMode: cliPermissionMode(req.permissionMode),
          allowedTools: req.allowedTools,
          mainModel: req.mainModel,
          plannerModel: req.plannerModel,
          images: req.images,
        },
        (event) => {
          if (event.type === "stderr") {
            stderr.push(event.line);
            return;
          }
          const { changed, permission, rateLimits } = parser.handle(event.line);
          if (rateLimits) recordRateLimits(rateLimits);
          if (changed) onProgress(parser.snapshot());
          if (permission) {
            // 사용자가 답할 때까지 CLI는 대기한다 (터미널의 승인 프롬프트와 같음)
            onPermission(permission)
              .catch(() => ({ behavior: "deny" as const, message: "응답할 수 없어 거부되었습니다." }))
              .then((decision) => desktop.respondAgent(runId, buildControlResponse(permission, decision)))
              .catch((error) => console.error("[agent] 권한 응답 실패", error));
          }
        },
      )
      .then((exit) => parser.finish(exit, stderr));

    return { result, cancel: () => void desktop.cancelAgent(runId) };
  },
};
