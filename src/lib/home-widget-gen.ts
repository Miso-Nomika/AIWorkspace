"use client";

import { runChat } from "./chat-backend";
import { missingCliGuide } from "./chat-core";
import { errorMessage } from "./desktop";
import { buildCreatePrompt, buildEditPrompt, buildWidgetSystemPrompt, generateWidget, looksLikeSecret, WIDGET_MODEL, type GenResult } from "./home-widget-prompt";

export interface WidgetGeneration {
  result: Promise<GenResult>;
  cancel: () => void;
}

/** 입력 글을 AI에게 보내도 되는지: API 키처럼 보이는 값이 있으면 보내지 않는다 (null이면 보내도 됨) */
export function requestProblem(request: string): string | null {
  if (!request.trim()) return "만들 위젯을 적어 주세요";
  if (request.length > 2000) return "요청이 너무 깁니다 (2,000자 이하)";
  return looksLikeSecret(request) ? "API 키처럼 보이는 값이 들어 있어 보내지 않았습니다" : null;
}

/** 요청으로 위젯 정의를 만든다 (editing이 있으면 그 정의를 고친다). 사용자의 Claude를 쓴다 */
export function generateHomeWidget(request: string, editing?: unknown): WidgetGeneration {
  let cancelled = false;
  let cancelCurrent: (() => void) | null = null;
  const system = buildWidgetSystemPrompt();
  const prompt = editing === undefined ? buildCreatePrompt(request) : buildEditPrompt(editing, request);
  const result = generateWidget(async (text, session) => {
    if (cancelled) return { text: "", isError: false, cancelled: true };
    const run = runChat({ provider: "claude", model: WIDGET_MODEL, system, prompt: text, web: true, session }, () => {});
    cancelCurrent = run.cancel;
    const r = await run.result;
    return { text: r.text, sessionId: r.sessionId, isError: r.isError, error: r.error, cancelled: r.cancelled };
  }, prompt)
    .then((r): GenResult => (r.ok && editing !== undefined && JSON.stringify(r.def) === JSON.stringify(editing) ? { ok: false, error: "요청을 반영하지 못했습니다 (위젯이 그대로입니다). 요청을 더 구체적으로 적어 다시 시도해 주세요" } : r))
    .catch((error): GenResult => ({ ok: false, error: (error instanceof Error ? error.message : String(error)) === "CLI_NOT_FOUND" ? missingCliGuide("claude") : errorMessage(error) }));
  return {
    result,
    cancel: () => {
      cancelled = true;
      cancelCurrent?.();
    },
  };
}
