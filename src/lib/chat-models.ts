// 일반 채팅의 모델 선택 (순수 함수, 외부 의존 없음). 모델 id는 "서비스:모델" 형식으로 대화에 저장한다.
//  - Claude: claude:haiku · claude:sonnet · claude:opus
//  - ChatGPT: codex:<모델 이름> (이 계정의 Codex가 보여 주는 목록 — `codex debug models`), codex: 는 Codex의 기본 모델

import type { ChatProvider } from "./chat-parse";

export type { ChatProvider };

export interface ChatModelChoice {
  /** "claude:sonnet" · "codex:gpt-6.1-sol" · "codex:"(기본 모델) */
  id: string;
  provider: ChatProvider;
  /** CLI에 넘길 모델 이름 (없으면 CLI 기본값) */
  model: string | null;
  label: string;
  hint?: string;
  /** 맥락 창 크기(토큰) — 사용량 경고에 쓴다 */
  contextWindow: number;
}

export const PROVIDER_LABELS: Record<ChatProvider, string> = { claude: "Claude", codex: "ChatGPT" };

/** 맥락 사용량이 창의 이 비율을 넘으면 새 세션으로 이어 가기를 권한다 */
export const CONTEXT_WARN_RATIO = 0.7;
const DEFAULT_CONTEXT_WINDOW = 200_000;

export const CLAUDE_CHAT_MODELS: ChatModelChoice[] = [
  { id: "claude:haiku", provider: "claude", model: "haiku", label: "Claude Haiku", hint: "빠르고 가벼운 질문", contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: "claude:sonnet", provider: "claude", model: "sonnet", label: "Claude Sonnet", hint: "균형 (기본)", contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: "claude:opus", provider: "claude", model: "opus", label: "Claude Opus", hint: "어려운 질문·긴 조사", contextWindow: DEFAULT_CONTEXT_WINDOW },
];

export const DEFAULT_CHAT_MODEL = "claude:sonnet";

/** Codex가 보여 주는 모델 하나 (Rust `chat_codex_models`의 결과) */
export interface CodexModelInfo {
  slug: string;
  displayName: string;
  contextWindow?: number | null;
}

/** ChatGPT 선택지: 항상 "기본 모델"이 있고, 목록을 얻었으면 이어서 그 모델들 */
export function chatgptChoices(models: CodexModelInfo[]): ChatModelChoice[] {
  const fallback: ChatModelChoice = { id: "codex:", provider: "codex", model: null, label: "ChatGPT (기본 모델)", hint: "계정의 기본 모델", contextWindow: DEFAULT_CONTEXT_WINDOW };
  return [
    fallback,
    ...models.map((m) => ({
      id: `codex:${m.slug}`,
      provider: "codex" as const,
      model: m.slug,
      label: `ChatGPT ${m.displayName}`,
      contextWindow: m.contextWindow && m.contextWindow > 0 ? m.contextWindow : DEFAULT_CONTEXT_WINDOW,
    })),
  ];
}

export function chatChoices(codexModels: CodexModelInfo[]): ChatModelChoice[] {
  return [...CLAUDE_CHAT_MODELS, ...chatgptChoices(codexModels)];
}

/** 저장된 모델 id가 지금 선택지에 있으면 그대로, 아니면 기본값 (계정이 바뀌어 모델이 사라진 경우 등) */
export function pickChatModel(id: unknown, choices: ChatModelChoice[]): string {
  return typeof id === "string" && choices.some((c) => c.id === id) ? id : DEFAULT_CHAT_MODEL;
}

/** "claude:sonnet" → { provider: "claude", model: "sonnet" }. 형식이 다르면 null */
export function parseChatModel(id: string): { provider: ChatProvider; model: string | null } | null {
  const i = id.indexOf(":");
  if (i < 0) return null;
  const provider = id.slice(0, i);
  const model = id.slice(i + 1);
  if (provider !== "claude" && provider !== "codex") return null;
  return { provider, model: model || null };
}

export function modelLabel(id: string, choices: ChatModelChoice[]): string {
  return choices.find((c) => c.id === id)?.label ?? id;
}

/** 맥락 사용 비율 (0~1 이상). 사용량을 모르면 null */
export function contextRatio(contextTokens: number | undefined, id: string, choices: ChatModelChoice[]): number | null {
  if (!contextTokens || contextTokens <= 0) return null;
  const window = choices.find((c) => c.id === id)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  return contextTokens / window;
}

export function shouldWarnContext(ratio: number | null): boolean {
  return ratio !== null && ratio >= CONTEXT_WARN_RATIO;
}
