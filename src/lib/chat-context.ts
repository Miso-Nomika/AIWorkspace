// 세션 없이 보내야 할 때(서비스를 바꿨거나 세션을 잃었거나 사용자가 "새 세션으로 이어 가기"를 눌렀을 때) 이전 대화를 한 덩어리로 만든다.
// (순수 함수, 외부 의존 없음). 평소에는 CLI 세션을 이어 가므로 쓰지 않는다 — 세션에는 검색 결과·읽은 페이지·이미지가 그대로 남아 있다.

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  /** 그 메시지에 첨부했던 파일 이름 (내용은 다시 보내지 않고 이름만 알려 준다) */
  attachmentNames?: string[];
}

export const MAX_CONTEXT_MESSAGES = 20;
export const MAX_CONTEXT_CHARS = 24_000;

export interface BuiltPrompt {
  text: string;
  /** 길이 제한 때문에 모델에 전달되지 않은 앞쪽 메시지 수 */
  omitted: number;
}

function formatTurn(turn: ChatTurn): string {
  const who = turn.role === "user" ? "사용자" : "AI";
  const files = turn.attachmentNames?.length ? ` [이전 첨부: ${turn.attachmentNames.join(", ")}]` : "";
  return `${who}:${files} ${turn.content.trim()}`.trimEnd();
}

/**
 * 이전 대화(오래된 순)와 새 질문으로 보낼 글을 만든다. 최근 20개 메시지, 합쳐서 24,000자까지만 넣고 모자라면 오래된 것부터 뺀다.
 * 이전 대화가 없으면 질문만 그대로 돌려준다.
 */
export function buildPrompt(history: ChatTurn[], question: string, limits: { messages?: number; chars?: number } = {}): BuiltPrompt {
  const maxMessages = limits.messages ?? MAX_CONTEXT_MESSAGES;
  const maxChars = limits.chars ?? MAX_CONTEXT_CHARS;
  const recent = history.filter((t) => t.content.trim() || t.attachmentNames?.length).slice(-maxMessages);
  const lines: string[] = [];
  let size = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const line = formatTurn(recent[i]);
    if (size + line.length > maxChars && lines.length > 0) break;
    // 가장 최근 메시지 하나가 제한보다 길면 끝부분만 남긴다
    lines.unshift(line.length > maxChars ? `…${line.slice(line.length - maxChars)}` : line);
    size += line.length;
  }
  const omitted = history.filter((t) => t.content.trim() || t.attachmentNames?.length).length - lines.length;
  if (lines.length === 0) return { text: question, omitted: 0 };
  const header = omitted > 0 ? `[이전 대화 — 길어서 오래된 ${omitted}개 메시지는 생략했습니다]` : "[이전 대화]";
  return { text: `${header}\n${lines.join("\n")}\n[/이전 대화]\n\n${question}`, omitted };
}
