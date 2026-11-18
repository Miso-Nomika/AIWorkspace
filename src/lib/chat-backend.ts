// 일반 채팅 실행: Rust `chat_send`를 부르고 줄 단위 출력을 해석해 진행 상황과 최종 결과를 돌려준다.

import { createChatParser, type ChatProgress, type ChatResult } from "./chat-parse";
import { desktop } from "./desktop";
import { recordRateLimits } from "./usage";
import { parseRateLimitEvent } from "./usage-math";

export interface ChatRunRequest {
  provider: "claude" | "codex";
  /** CLI에 넘길 모델 이름 (없으면 기본) */
  model?: string | null;
  /** 지침 (buildChatMemoryPrompt) */
  system: string;
  /** 이번에 보낼 글 (첨부 텍스트 블록 포함) */
  prompt: string;
  /** 첨부 이미지 파일 경로 */
  images?: string[];
  web: boolean;
  /** 이어 갈 세션 id */
  session?: string;
}

export interface ChatRun {
  result: Promise<ChatResult>;
  cancel: () => void;
}

export function runChat(request: ChatRunRequest, onProgress: (progress: ChatProgress) => void): ChatRun {
  const requestId = crypto.randomUUID();
  const parser = createChatParser(request.provider);
  const stderr: string[] = [];
  const result = desktop
    .chatSend(
      { requestId, provider: request.provider, model: request.model ?? undefined, system: request.system, prompt: request.prompt, images: request.images, web: request.web, session: request.session },
      (event) => {
        if (event.type === "stderr") {
          stderr.push(event.line);
          return;
        }
        if (request.provider === "claude") {
          try {
            const limits = parseRateLimitEvent(JSON.parse(event.line));
            if (limits) recordRateLimits(limits);
          } catch {}
        }
        if (parser.handle(event.line)) onProgress(parser.snapshot());
      },
    )
    .then((exit) => parser.finish(exit, stderr));
  return { result, cancel: () => void desktop.chatCancel(requestId) };
}
