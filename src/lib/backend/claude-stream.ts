// Claude Code 양방향 stream-json 출력 해석.
// 줄마다 JSON 이벤트:
//   system(init: session_id / permission_denied) · assistant(text, tool_use) · user(tool_result)
//   control_request(can_use_tool: 권한·질문 요청) · result

import { shortenRule } from "../allow-rules";
import type { AgentExit } from "../desktop";
import type { ActivityItem, RunStats } from "../types";
import { parseRateLimitEvent, type RateLimits } from "../usage-math";
import type { AgentProgress, AgentRunResult, AskQuestion, PermissionDecision, PermissionRequest } from "./types";

type Input = Record<string, unknown>;

const MAX_OUTPUT = 8000;
const MAX_DETAIL_LINES = 60;

function relative(path: unknown, root: string): string {
  if (typeof path !== "string") return "";
  const normalizedRoot = root.replace(/[\\/]+$/, "").toLowerCase();
  return path.toLowerCase().startsWith(normalizedRoot) ? path.slice(normalizedRoot.length).replace(/^[\\/]/, "") : path;
}

function clip(text: string, maxLines = MAX_DETAIL_LINES): string {
  const lines = text.split("\n");
  return lines.length > maxLines ? [...lines.slice(0, maxLines), `… (${lines.length - maxLines}줄 더)`].join("\n") : text;
}

function diff(oldText: unknown, newText: unknown): string {
  const minus = String(oldText ?? "").split("\n").map((l) => `- ${l}`);
  const plus = String(newText ?? "").split("\n").map((l) => `+ ${l}`);
  return clip([...minus, ...plus].join("\n"));
}

/** 도구 호출을 사람이 읽을 요약(label)과 상세(detail: 명령·diff·내용)로 바꾼다 */
export function describeTool(name: string, input: Input, root: string): { label: string; detail?: string } {
  const file = relative(input.file_path ?? input.notebook_path ?? input.path, root);
  switch (name) {
    case "Read":
      return { label: `파일 읽기: ${file}` };
    case "Edit":
      return { label: `파일 수정: ${file}`, detail: diff(input.old_string, input.new_string) };
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : [];
      return { label: `파일 수정: ${file}`, detail: clip(edits.map((e) => diff(e.old_string, e.new_string)).join("\n\n")) };
    }
    case "NotebookEdit":
      return { label: `노트북 수정: ${file}`, detail: clip(String(input.new_source ?? "")) };
    case "Write":
      return { label: `파일 작성: ${file}`, detail: clip(String(input.content ?? "")) };
    case "Bash":
    case "PowerShell":
      return { label: `명령 실행: ${String(input.description ?? input.command ?? "").slice(0, 80)}`, detail: String(input.command ?? "") };
    case "Glob":
    case "Grep":
      return { label: `검색: ${String(input.pattern ?? "")}` };
    case "WebFetch":
      return { label: `웹 가져오기: ${String(input.url ?? "")}` };
    case "WebSearch":
      return { label: `웹 검색: ${String(input.query ?? "")}` };
    case "ExitPlanMode":
      return { label: "계획 승인 요청", detail: String(input.plan ?? "") };
    case "AskUserQuestion":
      return { label: "질문" };
    case "TodoWrite":
      return { label: "할 일 목록 갱신" };
    default:
      return { label: name, detail: Object.keys(input).length ? clip(JSON.stringify(input, null, 2), 30) : undefined };
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n");
  }
  return "";
}

function rawSuggestedRule(request: Input, toolName: string, input: Input): string | undefined {
  const suggestions = Array.isArray(request.permission_suggestions) ? (request.permission_suggestions as Input[]) : [];
  for (const s of suggestions) {
    if (s.type !== "addRules" || s.behavior !== "allow" || !Array.isArray(s.rules)) continue;
    const rule = (s.rules as Input[])[0];
    if (rule && typeof rule.toolName === "string") {
      return typeof rule.ruleContent === "string" && rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
    }
  }
  if (toolName === "Bash" && typeof input.command === "string") return `Bash(${input.command})`;
  if (toolName === "AskUserQuestion" || toolName === "ExitPlanMode") return undefined;
  return toolName;
}

/** "항상 허용"으로 저장할 규칙 — 긴 명령은 줄이고, 줄일 수 없으면(여러 명령을 이은 스크립트 등) 제안하지 않는다 */
function suggestedRule(request: Input, toolName: string, input: Input): string | undefined {
  const rule = rawSuggestedRule(request, toolName, input);
  return rule === undefined ? undefined : shortenRule(rule);
}

function parseQuestions(input: Input): AskQuestion[] | undefined {
  if (!Array.isArray(input.questions)) return undefined;
  return (input.questions as Input[]).map((q) => ({
    question: String(q.question ?? ""),
    header: typeof q.header === "string" ? q.header : undefined,
    multiSelect: q.multiSelect === true,
    options: Array.isArray(q.options)
      ? (q.options as Input[]).map((o) => ({ label: String(o.label ?? ""), description: typeof o.description === "string" ? o.description : undefined }))
      : [],
  }));
}

/** 권한 결정 → CLI에 보낼 control_response */
export function buildControlResponse(request: PermissionRequest, decision: PermissionDecision) {
  const response =
    decision.behavior === "allow"
      ? { behavior: "allow", updatedInput: decision.updatedInput ?? request.input }
      : { behavior: "deny", message: decision.message };
  return { type: "control_response", response: { subtype: "success", request_id: request.requestId, response } };
}

export function createClaudeStreamParser(root: string, permissionLabel: string) {
  const texts: string[] = [];
  const activity: ActivityItem[] = [];
  let sessionId: string | undefined;
  let resultText: string | undefined;
  let isError = false;
  let denials = 0;
  let stats: RunStats | undefined;

  const find = (id: unknown) => activity.find((a) => a.id === id);

  return {
    /** 한 줄 처리. changed: 화면 갱신 필요 / permission: 사용자에게 물어야 할 요청 */
    handle(line: string): { changed: boolean; permission?: PermissionRequest; rateLimits?: RateLimits } {
      let event: Input;
      try {
        event = JSON.parse(line);
      } catch {
        return { changed: false };
      }
      switch (event.type) {
        case "system":
          if (event.subtype === "init" && typeof event.session_id === "string") sessionId = event.session_id;
          if (event.subtype === "permission_denied") {
            const item = find(event.tool_use_id);
            if (item) {
              item.denied = true;
              item.output = String(event.message ?? "권한이 거부되었습니다.");
            }
            return { changed: true };
          }
          return { changed: false };
        case "assistant": {
          const content = (event.message as { content?: unknown[] } | undefined)?.content ?? [];
          for (const block of content as { type: string; id?: string; text?: string; name?: string; input?: Input }[]) {
            if (block.type === "text" && block.text?.trim()) texts.push(block.text.trim());
            if (block.type === "tool_use" && block.name) {
              activity.push({ id: block.id ?? `tool-${activity.length}`, ...describeTool(block.name, block.input ?? {}, root) });
            }
          }
          return { changed: true };
        }
        case "user": {
          const content = (event.message as { content?: unknown } | undefined)?.content;
          if (!Array.isArray(content)) return { changed: false };
          for (const block of content as Input[]) {
            if (block.type !== "tool_result") continue;
            const item = find(block.tool_use_id);
            if (!item) continue;
            const text = toolResultText(block.content);
            item.output = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (잘림)` : text;
            item.isError = block.is_error === true;
          }
          return { changed: true };
        }
        case "control_request": {
          const request = (event.request ?? {}) as Input;
          if (request.subtype !== "can_use_tool" || typeof event.request_id !== "string") return { changed: false };
          const toolName = String(request.tool_name ?? "");
          const input = (request.input ?? {}) as Input;
          return {
            changed: false,
            permission: {
              requestId: event.request_id,
              toolName,
              description: typeof request.description === "string" ? request.description : undefined,
              input,
              summary: describeTool(toolName, input, root),
              suggestedRule: suggestedRule(request, toolName, input),
              questions: toolName === "AskUserQuestion" ? parseQuestions(input) : undefined,
            },
          };
        }
        case "rate_limit_event": {
          // 5시간·7일 사용량 (상단 사용량 막대용). 형식이 낯서면 무시한다
          const rateLimits = parseRateLimitEvent(event);
          return rateLimits ? { changed: false, rateLimits } : { changed: false };
        }
        case "result":
          resultText = typeof event.result === "string" ? event.result : undefined;
          isError = event.is_error === true;
          if (typeof event.session_id === "string") sessionId = event.session_id;
          denials = Array.isArray(event.permission_denials) ? event.permission_denials.length : 0;
          stats = {
            durationMs: typeof event.duration_ms === "number" ? event.duration_ms : undefined,
            costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined,
          };
          return { changed: true };
        default:
          return { changed: false };
      }
    },

    snapshot(): AgentProgress {
      return { text: texts.join("\n\n"), activity: activity.map((a) => ({ ...a })) };
    },

    finish(exit: AgentExit, stderr: string[]): AgentRunResult {
      const notes: string[] = [];
      let text = texts.join("\n\n") || resultText || "";
      if (exit.cancelled) {
        notes.push("사용자가 실행을 중지했습니다.");
      } else if (resultText === undefined && exit.code !== 0) {
        isError = true;
        const tail = stderr.slice(-5).join("\n");
        text = text || `Claude Code가 비정상 종료되었습니다 (코드 ${exit.code ?? "알 수 없음"}).${tail ? `\n${tail}` : ""}`;
      } else if (isError && resultText) {
        text = resultText;
      }
      if (denials > 0) {
        notes.push(`실행하지 않은 작업이 ${denials}건 있습니다 (거부했거나 권한 설정 '${permissionLabel}' 때문).`);
      }
      return { text, activity: activity.map((a) => ({ ...a })), sessionId, isError, cancelled: exit.cancelled, stats, notes };
    },
  };
}
