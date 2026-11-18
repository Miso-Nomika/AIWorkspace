// 일반 채팅의 대화 기록 모델과 순수 로직 (외부 의존 없음 — node로 직접 테스트 가능).
// 저장 구조: 목록 `chats` = ChatMeta[], 대화마다 `gchat:<id>` = GeneralMessage[] (둘 다 이 PC에만 저장, 동기화하지 않음).
// 이미지·첨부 글·도구 결과 원문은 대화 JSON에 넣지 않고 채팅 파일 폴더(chat-files/<대화 id>)에 둔다.

import type { AttachmentRecord } from "./chat-attach.ts";
import type { ChatTurn } from "./chat-context.ts";
import { DEFAULT_CHAT_MODEL } from "./chat-models.ts";
import type { ChatActivity, ChatProvider } from "./chat-parse.ts";

export interface ChatSessionRef {
  provider: ChatProvider;
  id: string;
}

export interface ChatMeta {
  id: string;
  title: string;
  /** "claude:sonnet" · "codex:gpt-6.1-sol" · "codex:"(기본 모델) */
  model: string;
  updatedAt: string;
  /** 메시지 수 (목록에서 대화를 열지 않고 보여 주기 위해) */
  count: number;
  /** 웹 검색 토글 (기본 켬) */
  web: boolean;
  /** 지금 이어 가는 CLI 세션 (같은 서비스일 때만 이어 간다) */
  session?: ChatSessionRef | null;
  /** 지금까지 쓴 모든 세션 — 대화를 지울 때 CLI가 남긴 세션 파일까지 지우기 위해 */
  sessions?: ChatSessionRef[];
  /** 마지막 답을 만들 때 모델이 받은 입력 토큰 수 (맥락 사용량 경고용) */
  contextTokens?: number;
}

export interface GeneralMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /** 이 메시지를 보내거나 받은 모델 (ChatMeta.model 형식) */
  model: string;
  provider: ChatProvider;
  attachments?: AttachmentRecord[];
  activity?: ChatActivity[];
  status?: "done" | "stopped" | "error";
  /** 오류 메시지인지 */
  error?: boolean;
  /** 오류 원인이 대화가 너무 길어서인지 ("새 세션으로 이어 가기"를 보여 준다) */
  contextFull?: boolean;
  /** 사용자 메시지: 세션 없이 최근 대화로 이어 보낸 경우의 안내 */
  note?: string;
  /** 답 아래에 보여 줄 안내 (메모리 반영 등) */
  notes?: string[];
}

export const DEFAULT_CHAT_TITLE = "새 대화";
export const TITLE_MAX = 40;

/** 첫 질문 앞 40자 (한글·일본어·이모지를 글자 단위로 센다) */
export function titleFrom(text: string, max = TITLE_MAX): string {
  const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const chars = Array.from(firstLine);
  if (chars.length === 0) return DEFAULT_CHAT_TITLE;
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : firstLine;
}

export function newChatMeta(id: string, now: string, model = DEFAULT_CHAT_MODEL): ChatMeta {
  return { id, title: DEFAULT_CHAT_TITLE, model, updatedAt: now, count: 0, web: true, session: null, sessions: [] };
}

/** 저장된 값이 낯설거나 깨졌으면 버리거나 보정한다 */
export function normalizeMeta(raw: unknown): ChatMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  const ref = (v: unknown): ChatSessionRef | null =>
    v && typeof v === "object" && ((v as ChatSessionRef).provider === "claude" || (v as ChatSessionRef).provider === "codex") && typeof (v as ChatSessionRef).id === "string" ? { provider: (v as ChatSessionRef).provider, id: (v as ChatSessionRef).id } : null;
  const sessions = Array.isArray(r.sessions) ? r.sessions.map(ref).filter((s): s is ChatSessionRef => !!s) : [];
  return {
    id: r.id,
    title: typeof r.title === "string" && r.title.trim() ? r.title : DEFAULT_CHAT_TITLE,
    model: typeof r.model === "string" && r.model ? r.model : DEFAULT_CHAT_MODEL,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date(0).toISOString(),
    count: typeof r.count === "number" && r.count >= 0 ? r.count : 0,
    web: r.web !== false,
    session: ref(r.session),
    sessions,
    contextTokens: typeof r.contextTokens === "number" && r.contextTokens > 0 ? r.contextTokens : undefined,
  };
}

export function normalizeMessage(raw: unknown): GeneralMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || (r.role !== "user" && r.role !== "assistant") || typeof r.content !== "string") return null;
  return { ...(r as unknown as GeneralMessage), provider: r.provider === "codex" ? "codex" : "claude", model: typeof r.model === "string" ? r.model : DEFAULT_CHAT_MODEL, createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date(0).toISOString() };
}

/** 최근에 바뀐 대화가 위로 */
export function sortChats(list: ChatMeta[]): ChatMeta[] {
  return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 세션 목록에 없을 때만 더한다 */
export function addSession(sessions: ChatSessionRef[] | undefined, ref: ChatSessionRef): ChatSessionRef[] {
  const list = sessions ?? [];
  return list.some((s) => s.provider === ref.provider && s.id === ref.id) ? list : [...list, ref];
}

/** 모델에 다시 보낼 이전 대화: 오류 메시지·내용 없는 메시지는 뺀다 */
export function toTurns(messages: GeneralMessage[]): ChatTurn[] {
  return messages
    .filter((m) => !m.error && (m.content.trim() || m.attachments?.length))
    .map((m) => ({ role: m.role, content: m.content, attachmentNames: m.attachments?.map((a) => a.name) }));
}

/** 마지막 메시지가 질문이면 답을 받지 못한 것 (앱이 꺼졌거나 오류 전에 끊김) */
export function needsRetry(messages: GeneralMessage[]): boolean {
  return messages.length > 0 && messages[messages.length - 1].role === "user";
}

export interface SendPlan {
  /** 이어 갈 세션 id (같은 서비스의 세션이 있을 때) */
  resume?: string;
  /** 세션 없이 최근 대화(buildPrompt)로 이어 보내야 하는지 — 이전 대화가 있는데 이어 갈 세션이 없을 때 */
  fallback: boolean;
}

export function planSend(meta: Pick<ChatMeta, "session">, provider: ChatProvider, hasHistory: boolean): SendPlan {
  if (meta.session && meta.session.provider === provider) return { resume: meta.session.id, fallback: false };
  return { fallback: hasHistory };
}

/** CLI가 이어 갈 세션을 찾지 못했다는 오류인지 */
export function isSessionLostError(error: string | undefined): boolean {
  return !!error && /no conversation found|session.{0,40}not found|could not find.{0,30}session|no (saved )?session|thread.{0,40}not found|not find.{0,30}thread|no rollout/i.test(error);
}

/** 이번 턴에 웹을 열어 봤거나 첨부가 있었다면 답의 메모리 학습 태그를 저장하지 않는다 (웹 페이지·문서에 숨긴 지시로 메모리가 오염되는 것을 막는다) */
export function skipLearning(activity: ChatActivity[] | undefined, attachmentCount: number): boolean {
  return attachmentCount > 0 || (activity ?? []).some((a) => a.kind === "search" || a.kind === "fetch");
}

/** 채팅에 쓸 프로그램(CLI)을 찾지 못했을 때의 안내: 설치와 로그인 방법 */
export function missingCliGuide(provider: ChatProvider): string {
  return provider === "claude"
    ? "Claude Code를 이 PC에서 찾지 못했습니다. 설치한 뒤 터미널에서 `claude`를 실행해 구독 계정으로 로그인하세요."
    : "Codex(ChatGPT)를 이 PC에서 찾지 못했습니다. `npm install -g @openai/codex`로 설치한 뒤 터미널에서 `codex login`으로 ChatGPT 계정에 로그인하세요.";
}

/** 세션 없이 보낸 이유를 사용자에게 알리는 문구 */
export function fallbackNote(omitted: number, total: number): string {
  return omitted > 0 ? `이전 대화 ${total}개 중 최근 ${total - omitted}개만 전달했습니다 (길이 제한).` : "이어 갈 세션이 없어 이전 대화를 글로 다시 전달했습니다.";
}
