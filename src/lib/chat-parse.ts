// 일반 채팅 CLI 출력 해석 (순수 함수, 외부 의존 없음 — node로 직접 테스트 가능).
// Claude: stream-json 줄마다 system(init: session_id) · assistant(text · tool_use: WebSearch·WebFetch) · user(tool_result) · result.
// Codex: --json 줄마다 thread.started(thread_id) · item.completed(agent_message · web_search · command_execution) · turn.completed(usage) · error · turn.failed.
// 줄 형식은 실제 CLI 출력으로 확인한 것이다 (tests/fixtures에 실제 출력 샘플).

export type ChatProvider = "claude" | "codex";

/** 답을 만드는 동안 한 일: 웹 검색 · 웹 페이지 읽기 · 명령 실행(Codex) */
export interface ChatActivity {
  kind: "search" | "fetch" | "command";
  label: string;
  url?: string;
}

/** 맥락 사용량: 마지막 요청이 모델에 보낸 입력 토큰(캐시 포함)과 출력 토큰 */
export interface ChatUsage {
  contextTokens: number;
  outputTokens: number;
}

export interface ChatProgress {
  text: string;
  activity: ChatActivity[];
}

export interface ChatExitInfo {
  code: number | null;
  cancelled: boolean;
  timedOut: boolean;
}

export interface ChatResult extends ChatProgress {
  /** 이어서 대화할 세션 id (Claude 세션 id · Codex 스레드 id) */
  sessionId?: string;
  usage?: ChatUsage;
  isError: boolean;
  cancelled: boolean;
  timedOut: boolean;
  /** 대화가 모델이 받을 수 있는 길이를 넘었다는 오류 */
  contextFull: boolean;
  /** 오류 설명 (isError일 때) */
  error?: string;
}

type Json = Record<string, unknown>;

const CONTEXT_FULL = /prompt is too long|context (window|length)|maximum context|too many tokens|input is too long|exceeds? the (context|token)/i;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** 표준 오류에서 사용자에게 보여 줄 만한 마지막 줄들 (색 코드·Codex가 매번 찍는 안내 제외) */
function stderrTail(stderr: string[]): string {
  return stderr
    .map((l) => l.replace(ANSI, "").trim())
    .filter((l) => l && !/^Reading prompt from stdin/i.test(l))
    .slice(-4)
    .join("\n");
}

export function createChatParser(provider: ChatProvider) {
  const texts: string[] = [];
  const activity: ChatActivity[] = [];
  let sessionId: string | undefined;
  let usage: ChatUsage | undefined;
  let resultText: string | undefined;
  let resultIsError = false;
  const errors: string[] = [];

  /** 줄 하나 처리. 화면을 갱신해야 하면 true */
  function handleClaude(event: Json): boolean {
    switch (event.type) {
      case "system":
        if (event.subtype === "init" && typeof event.session_id === "string") sessionId = event.session_id;
        return false;
      case "assistant": {
        const message = (event.message ?? {}) as { content?: unknown[]; usage?: Json };
        let changed = false;
        for (const block of (message.content ?? []) as { type: string; text?: string; name?: string; input?: Json }[]) {
          if (block.type === "text" && block.text?.trim()) {
            texts.push(block.text.trim());
            changed = true;
          } else if (block.type === "tool_use" && block.name === "WebSearch") {
            activity.push({ kind: "search", label: String(block.input?.query ?? "") });
            changed = true;
          } else if (block.type === "tool_use" && block.name === "WebFetch") {
            const url = String(block.input?.url ?? "");
            activity.push({ kind: "fetch", label: hostOf(url), url });
            changed = true;
          }
        }
        const u = message.usage;
        if (u) usage = { contextTokens: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens), outputTokens: num(u.output_tokens) };
        return changed;
      }
      case "result":
        resultText = typeof event.result === "string" ? event.result : undefined;
        resultIsError = event.is_error === true;
        if (typeof event.session_id === "string") sessionId = event.session_id;
        return true;
      default:
        return false;
    }
  }

  function handleCodex(event: Json): boolean {
    switch (event.type) {
      case "thread.started":
        if (typeof event.thread_id === "string") sessionId = event.thread_id;
        return false;
      case "item.completed": {
        const item = (event.item ?? {}) as Json;
        if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
          texts.push(item.text.trim());
          return true;
        }
        if (item.type === "web_search") {
          const action = (item.action ?? {}) as { queries?: unknown[] };
          const queries = Array.isArray(action.queries) ? action.queries.map(String).filter(Boolean) : [];
          if (queries.length === 0 && typeof item.query === "string" && item.query) queries.push(item.query);
          for (const query of queries) activity.push({ kind: "search", label: query });
          if (queries.length === 0) {
            // 검색어 없이 페이지를 연 경우: 첫 결과의 주소를 보여 준다
            const first = Array.isArray(item.results) ? ((item.results[0] ?? {}) as { url?: string }).url : undefined;
            if (first) activity.push({ kind: "fetch", label: hostOf(first), url: first });
            else return false;
          }
          return true;
        }
        if (item.type === "command_execution" && typeof item.command === "string") {
          activity.push({ kind: "command", label: item.command });
          return true;
        }
        return false;
      }
      case "turn.completed": {
        const u = (event.usage ?? {}) as Json;
        usage = { contextTokens: num(u.input_tokens), outputTokens: num(u.output_tokens) };
        return false;
      }
      case "error":
        if (typeof event.message === "string") errors.push(event.message);
        return false;
      case "turn.failed": {
        const message = ((event.error ?? {}) as Json).message;
        if (typeof message === "string") errors.push(message);
        return false;
      }
      default:
        return false;
    }
  }

  return {
    handle(line: string): boolean {
      let event: Json;
      try {
        event = JSON.parse(line) as Json;
      } catch {
        return false;
      }
      return provider === "claude" ? handleClaude(event) : handleCodex(event);
    },

    snapshot(): ChatProgress {
      return { text: texts.join("\n\n"), activity: activity.map((a) => ({ ...a })) };
    },

    finish(exit: ChatExitInfo, stderr: string[]): ChatResult {
      let text = texts.join("\n\n");
      if (!text && !resultIsError && resultText) text = resultText;
      let error: string | undefined;
      if (exit.timedOut) {
        error = "TIMEOUT";
      } else if (!exit.cancelled) {
        if (resultIsError) error = resultText || "응답을 받지 못했습니다.";
        else if (errors.length > 0) error = errors.join("\n");
        else if (exit.code !== 0 && !text) error = stderrTail(stderr) || `채팅 프로그램이 비정상 종료되었습니다 (코드 ${exit.code ?? "알 수 없음"}).`;
      }
      return {
        text: resultIsError ? "" : text,
        activity: activity.map((a) => ({ ...a })),
        sessionId,
        usage,
        isError: !!error,
        cancelled: exit.cancelled,
        timedOut: exit.timedOut,
        contextFull: !!error && CONTEXT_FULL.test(error),
        error,
      };
    },
  };
}
