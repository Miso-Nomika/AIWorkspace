// 프로젝트별로 어떤 백엔드를 쓸지 결정한다.
// 기준: 프로젝트 폴더가 어느 기기에 있는가 (Project.location.deviceId)

import type { Platform } from "../platform";
import type { Project } from "../types";
import { localBackend } from "./local";
import type { ProjectBackend } from "./types";

export type {
  AgentProgress,
  AgentRun,
  AgentRunRequest,
  AgentRunResult,
  AskQuestion,
  BackendKind,
  FileListing,
  PermissionDecision,
  PermissionRequest,
  ProjectBackend,
} from "./types";
export { PERMISSION_CHOICES, PERMISSION_HINTS, PERMISSION_LABELS, needsUserAnswer } from "./local";

export interface BackendResolution {
  backend: ProjectBackend;
  /** 원하는 실행 방식을 쓸 수 없을 때 사용자에게 보여줄 안내 */
  notice?: string;
}

function unavailable(message: string): ProjectBackend {
  return {
    kind: "unavailable",
    listFiles: async () => ({ nodes: [], truncated: false, total: 0 }),
    readFile: async () => {
      throw new Error(message);
    },
    readFileBytes: async () => {
      throw new Error(message);
    },
    readSheet: async () => {
      throw new Error(message);
    },
    runAgent: () => ({ result: Promise.reject(new Error(message)), cancel() {} }),
  };
}

export function resolveBackend(project: Project, platform: Platform): BackendResolution {
  const location = project.location;

  // 폴더가 연결되지 않은 프로젝트 (이전 버전의 시연용 프로젝트 등)
  if (!location) {
    const message = "프로젝트 폴더가 연결되어 있지 않습니다. 이 프로젝트를 삭제하고 폴더를 선택해 다시 만들어 주세요.";
    return { backend: unavailable(message), notice: message };
  }

  // 프로젝트 폴더가 이 기기에 있음 → 로컬
  if (platform.deviceId === location.deviceId) return { backend: localBackend };

  // 다른 기기에 있음 → 원격 실행을 추가하면 이 자리에 remote 백엔드를 둔다
  const where = location.deviceName ?? "다른 PC";
  const message = `이 프로젝트는 ${where}에 있습니다. 다른 PC의 프로젝트를 원격으로 여는 기능은 아직 지원하지 않습니다.`;
  return { backend: unavailable(message), notice: message };
}
