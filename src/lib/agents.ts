// AI 에이전트 목록. 현재는 Claude Code만 지원한다.
// 다른 에이전트를 추가할 때 함께 고칠 곳: types.ts(AgentId) · 이 목록 · backend/local.ts(PARSERS) · src-tauri/src/agent.rs(AGENTS, build_args)

import type { AgentId } from "./types";

export interface AgentInfo {
  id: AgentId;
  name: string;
  vendor: string;
}

export const AGENTS: AgentInfo[] = [{ id: "claude-code", name: "Claude Code", vendor: "Anthropic" }];

export function getAgent(id: AgentId): AgentInfo {
  return AGENTS.find((a) => a.id === id) ?? AGENTS[0];
}
