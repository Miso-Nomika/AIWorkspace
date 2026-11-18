"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, Globe, Loader2, MessageSquarePlus, Paperclip, Pencil, RotateCcw, SendHorizontal, Square, Trash2, X } from "lucide-react";
import { Markdown } from "./Markdown";
import { PageHeader } from "@/components/ui/PageHeader";
import { ZoomControl } from "@/components/ZoomControl";
import { useZoom } from "@/lib/use-zoom";
import { attachProblem, classifyFile, MAX_CHAT_ATTACHMENTS } from "@/lib/chat-attach";
import { needsRetry, type ChatMeta, type GeneralMessage } from "@/lib/chat-core";
import { cancelChat, createChat, deleteAllChats, deleteChat, prepareAttachment, renameChat, retryLast, selectChat, sendMessage, setChatModel, setChatWeb, startFreshSession, useChatMessages, useChatRuntime, useChats, useRunningChats, useSelectedChatId, type DraftAttachment } from "@/lib/chat-store";
import { chatChoices, contextRatio, modelLabel, pickChatModel, shouldWarnContext, type ChatModelChoice, type CodexModelInfo } from "@/lib/chat-models";
import type { ChatActivity } from "@/lib/chat-parse";
import { confirmAction } from "@/lib/confirm";
import { desktop, errorMessage } from "@/lib/desktop";
import { extractLearned } from "@/lib/memory-prompt";
import { useHydrated } from "@/lib/storage";

/** 이 계정의 ChatGPT 모델 목록 (앱을 켠 뒤 처음 한 번만 Codex에 물어본다) */
let codexModelsCache: CodexModelInfo[] | null = null;
function useCodexModels(): CodexModelInfo[] {
  const [models, setModels] = useState<CodexModelInfo[]>(codexModelsCache ?? []);
  useEffect(() => {
    if (codexModelsCache) return;
    desktop
      .chatCodexModels()
      .then((list) => {
        codexModelsCache = list.map((m) => ({ slug: m.slug, displayName: m.displayName, contextWindow: m.contextWindow }));
        setModels(codexModelsCache);
      })
      .catch(() => {});
  }, []);
  return models;
}

function when(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time) || time <= 0) return "";
  const minutes = Math.floor((Date.now() - time) / 60000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전`;
  return new Date(time).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

/** 일반 채팅: 프로젝트와 무관한 대화. Claude·ChatGPT를 구독 계정으로 로그인한 CLI로 실행하고 웹 검색·이미지·파일 첨부를 지원한다. */
export function GeneralChat() {
  const hydrated = useHydrated();
  const chats = useChats();
  const selected = useSelectedChatId();
  const codexModels = useCodexModels();
  const choices = useMemo(() => chatChoices(codexModels), [codexModels]);
  const running = useRunningChats();
  const current = chats.find((c) => c.id === selected) ?? chats[0] ?? null;

  if (!hydrated) return <p className="p-6 text-sm text-muted">불러오는 중…</p>;

  return (
    <div className="flex h-full min-h-0" data-testid="general-chat">
      <ChatList chats={chats} currentId={current?.id ?? null} running={running} choices={choices} />
      <section className="flex min-w-0 flex-1 flex-col">
        {current ? (
          <ChatView key={current.id} chat={current} choices={choices} />
        ) : (
          <div className="mx-auto mt-16 max-w-md p-6 text-center">
            <PageHeader title="채팅" description="웹 검색·이미지·파일 첨부를 지원하는 일반 대화입니다. Claude와 ChatGPT를 구독 계정으로 로그인한 프로그램으로 실행하고, 대화 기록은 이 PC에만 저장됩니다." />
            <button onClick={() => createChat()} data-testid="chat-start" className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white dark:text-zinc-950">
              <MessageSquarePlus className="size-4" aria-hidden />새 대화 시작
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function ChatList({ chats, currentId, running, choices }: { chats: ChatMeta[]; currentId: string | null; running: string[]; choices: ChatModelChoice[] }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface" aria-label="대화 목록">
      <div className="border-b border-border p-2">
        <button onClick={() => createChat()} data-testid="chat-new" className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white dark:text-zinc-950">
          <MessageSquarePlus className="size-4" aria-hidden />새 대화
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1.5" data-testid="chat-list">
        {chats.map((chat) => (
          <li key={chat.id} data-testid="chat-item" data-chat-id={chat.id}>
            {renaming === chat.id ? (
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Enter") {
                    renameChat(chat.id, title);
                    setRenaming(null);
                  } else if (e.key === "Escape") setRenaming(null);
                }}
                onBlur={() => setRenaming(null)}
                aria-label="대화 이름"
                data-testid="chat-rename-input"
                className="w-full rounded border border-accent bg-background px-2 py-1.5 text-sm outline-none"
              />
            ) : (
              <div className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 ${chat.id === currentId ? "bg-accent-soft" : "hover:bg-background"}`}>
                <button onClick={() => selectChat(chat.id)} className="min-w-0 flex-1 text-left" data-testid="chat-select">
                  <div className="flex items-center gap-1.5">
                    {running.includes(chat.id) && <Loader2 className="size-3 shrink-0 animate-spin text-accent" aria-label="답을 받는 중" />}
                    <span className="truncate text-sm font-medium" title={chat.title} data-testid="chat-title">
                      {chat.title}
                    </span>
                  </div>
                  <div className="truncate text-[11px] text-muted">
                    {modelLabel(chat.model, choices)} · {chat.count}개 · {when(chat.updatedAt)}
                  </div>
                </button>
                <button
                  onClick={() => {
                    setTitle(chat.title);
                    setRenaming(chat.id);
                  }}
                  aria-label={`${chat.title} 이름 바꾸기`}
                  data-testid="chat-rename"
                  className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-foreground focus:opacity-100"
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  onClick={async () => {
                    if (await confirmAction(`'${chat.title}' 대화를 삭제할까요?\n이 PC에 저장된 대화 내용과 첨부 파일이 지워집니다.`)) void deleteChat(chat.id);
                  }}
                  aria-label={`${chat.title} 삭제`}
                  data-testid="chat-delete"
                  className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-red-600 focus:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )}
          </li>
        ))}
        {chats.length === 0 && <li className="p-3 text-center text-xs text-muted">대화가 없습니다.</li>}
      </ul>
      {chats.length > 0 && (
        <div className="border-t border-border p-2">
          <button
            onClick={async () => {
              if (await confirmAction(`대화 ${chats.length}개를 모두 삭제할까요?\n이 PC에 저장된 모든 대화 내용과 첨부 파일이 지워지고 되돌릴 수 없습니다.`)) void deleteAllChats();
            }}
            data-testid="chat-delete-all"
            className="w-full rounded-lg px-3 py-1.5 text-xs text-muted hover:bg-background hover:text-red-600"
          >
            모두 삭제
          </button>
        </div>
      )}
    </aside>
  );
}

function ChatView({ chat, choices }: { chat: ChatMeta; choices: ChatModelChoice[] }) {
  const messages = useChatMessages(chat.id);
  const { running, progress } = useChatRuntime(chat.id);
  const [input, setInput] = useState("");
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { zoom, setZoom, bind } = useZoom("generalChat", { stickBottom: true });
  const bottomRef = useRef<HTMLDivElement>(null);
  const model = pickChatModel(chat.model, choices);
  const ratio = contextRatio(chat.contextTokens, model, choices);
  const interrupted = !running && needsRetry(messages);
  const lastError = messages.length > 0 ? messages[messages.length - 1] : null;
  const contextFull = !running && !!lastError?.contextFull;

  // 새 글이 오면 맨 아래로
  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, progress?.text, progress?.activity.length]);

  // 입력창 높이를 내용에 맞춘다
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + (el.offsetHeight - el.clientHeight), Math.round(window.innerHeight * 0.4))}px`;
  }, [input]);

  async function attach(files: File[]) {
    setAttachError(null);
    let count = drafts.length;
    const problems: string[] = [];
    setAttachBusy(true);
    try {
      for (const file of files) {
        const problem = attachProblem(file, count);
        if (problem) {
          problems.push(problem);
          continue;
        }
        try {
          const draft = await prepareAttachment(chat.id, file);
          setDrafts((prev) => [...prev, draft]);
          count++;
        } catch (error) {
          problems.push(error instanceof Error && !/^[A-Z_]+$/.test(error.message) ? error.message : errorMessage(error));
        }
      }
    } finally {
      setAttachBusy(false);
    }
    if (problems.length) setAttachError(problems.join("\n"));
  }

  function submit() {
    const text = input.trim();
    if ((!text && drafts.length === 0) || running || attachBusy) return;
    const sending = drafts;
    setInput("");
    setDrafts([]);
    setAttachError(null);
    void sendMessage(chat.id, { text, attachments: sending });
  }

  const visibleProgress = progress ? extractLearned(progress.text, 3, true).text : "";

  return (
    <div ref={bind} className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-2.5">
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold" title={chat.title} data-testid="chat-header-title">
          {chat.title}
        </h1>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          모델
          <select
            value={model}
            onChange={(e) => setChatModel(chat.id, e.target.value)}
            disabled={running}
            aria-label="모델"
            data-testid="chat-model"
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground disabled:opacity-50"
          >
            <optgroup label="Claude">
              {choices.filter((c) => c.provider === "claude").map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                  {c.hint ? ` — ${c.hint}` : ""}
                </option>
              ))}
            </optgroup>
            <optgroup label="ChatGPT">
              {choices.filter((c) => c.provider === "codex").map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <ZoomControl zoom={zoom} onChange={setZoom} label="채팅 확대·축소" testId="general-zoom" />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" data-testid="chat-messages">
        <div className="mx-auto flex max-w-3xl flex-col gap-4" style={{ zoom: zoom / 100 }} data-testid="general-zoomed" data-zoom-content>
          {messages.length === 0 && !running && <p className="mt-10 text-center text-sm text-muted">무엇이든 물어보세요. 웹 검색이 필요한 질문은 자동으로 검색해 출처와 함께 답합니다.</p>}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {running && (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3" data-testid="chat-progress">
              {progress && progress.activity.length > 0 && <Activity items={progress.activity} open />}
              {visibleProgress ? <Markdown text={visibleProgress} /> : null}
              <p className="flex items-center gap-1.5 text-xs text-muted">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                {progress?.activity.length ? (progress.activity[progress.activity.length - 1].kind === "command" ? "명령 실행 중…" : "웹 검색 중…") : "답변을 만드는 중…"}
              </p>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {interrupted && (
        <div className="flex flex-wrap items-center gap-3 border-t border-border bg-amber-50 px-4 py-2 text-xs dark:bg-amber-950" data-testid="chat-interrupted">
          <AlertTriangle className="size-4 shrink-0 text-amber-600" aria-hidden />
          <span className="flex-1">답을 받지 못했습니다. 앱이 꺼졌거나 연결이 끊겼을 수 있습니다.</span>
          <button onClick={() => void retryLast(chat.id)} data-testid="chat-retry" className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 hover:bg-surface">
            <RotateCcw className="size-3.5" aria-hidden />
            다시 보내기
          </button>
        </div>
      )}
      {(shouldWarnContext(ratio) || contextFull) && (
        <div className="flex flex-wrap items-center gap-3 border-t border-border bg-amber-50 px-4 py-2 text-xs dark:bg-amber-950" data-testid="chat-context-warning">
          <AlertTriangle className="size-4 shrink-0 text-amber-600" aria-hidden />
          <span className="flex-1">{contextFull ? "대화가 너무 길어 더 이어 갈 수 없습니다." : `대화가 길어졌습니다 (모델이 기억할 수 있는 양의 약 ${Math.round((ratio ?? 0) * 100)}% 사용). 더 길어지면 오래된 내용을 놓칠 수 있습니다.`}</span>
          <button onClick={() => startFreshSession(chat.id)} data-testid="chat-fresh" className="rounded-lg border border-border bg-background px-2.5 py-1 hover:bg-surface">
            새 세션으로 이어 가기
          </button>
        </div>
      )}

      {(drafts.length > 0 || attachError || attachBusy) && (
        <div className="border-t border-border px-4 pt-2">
          <ul className="flex flex-wrap gap-2" aria-label="첨부" data-testid="chat-drafts">
            {drafts.map((d, i) => (
              <li key={d.record.id} className="relative flex items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1 text-xs" data-testid="chat-draft">
                {d.record.preview ? (
                  // eslint-disable-next-line @next/next/no-img-element -- 정적 export에서는 data URL 미리보기를 그대로 쓴다
                  <img src={d.record.preview} alt="" className="size-8 rounded object-cover" />
                ) : (
                  <Paperclip className="size-3.5 text-muted" aria-hidden />
                )}
                <span className="max-w-40 truncate" title={d.record.name}>
                  {d.record.name}
                </span>
                {d.record.chars !== undefined && <span className="text-muted">{d.record.chars.toLocaleString()}자</span>}
                <button onClick={() => setDrafts((prev) => prev.filter((_, j) => j !== i))} aria-label={`${d.record.name} 첨부 해제`} className="text-muted hover:text-red-600">
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
            {attachBusy && (
              <li className="flex items-center gap-1.5 text-xs text-muted">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                첨부 준비 중…
              </li>
            )}
          </ul>
          {attachError && (
            <p className="mt-1 text-xs whitespace-pre-line text-red-600" role="alert" data-testid="chat-attach-error">
              {attachError}
            </p>
          )}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex items-end gap-2 border-t border-border p-3"
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf,text/*,.txt,.md,.csv,.json,.log,.xml,.html,.yml,.yaml,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.sql"
          data-testid="chat-attach-input"
          onChange={(e) => {
            void attach(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={running || attachBusy || drafts.length >= MAX_CHAT_ATTACHMENTS}
          aria-label="파일 첨부"
          title={`이미지·PDF·텍스트 파일 첨부 (최대 ${MAX_CHAT_ATTACHMENTS}개, 이미지는 붙여넣기도 가능)`}
          className="rounded-lg border border-border p-2.5 text-muted hover:bg-background hover:text-foreground disabled:opacity-40"
        >
          <Paperclip className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => setChatWeb(chat.id, !chat.web)}
          aria-pressed={chat.web}
          title={chat.web ? "웹 검색 켜짐 — 최신 정보가 필요하면 검색합니다 (누르면 끕니다)" : "웹 검색 꺼짐 (누르면 켭니다)"}
          data-testid="chat-web"
          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-2.5 text-xs ${chat.web ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-background"}`}
        >
          <Globe className="size-4" aria-hidden />
          웹 검색
        </button>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            // 클립보드에 이미지가 있으면(스크린샷 등) 첨부로 처리한다
            const files = Array.from(e.clipboardData.files).filter((f) => classifyFile(f.name, f.type) === "image");
            if (!files.length) return;
            e.preventDefault();
            void attach(files);
          }}
          onKeyDown={(e) => {
            // 한글 IME 조합 중 Enter는 무시 (중복 전송 방지)
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)"
          aria-label="메시지 입력"
          data-testid="chat-input"
          className="min-h-10 flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm leading-5 outline-none focus:border-accent"
        />
        {running ? (
          <button type="button" onClick={() => cancelChat(chat.id)} aria-label="실행 중지" title="실행 중지" data-testid="chat-stop" className="rounded-lg border border-border p-2.5 text-red-600 hover:bg-background">
            <Square className="size-4" />
          </button>
        ) : (
          <button type="submit" disabled={(!input.trim() && drafts.length === 0) || attachBusy} aria-label="전송" data-testid="chat-send" className="rounded-lg bg-accent p-2.5 text-white disabled:opacity-40 dark:text-zinc-950">
            <SendHorizontal className="size-4" />
          </button>
        )}
      </form>
    </div>
  );
}

function MessageBubble({ message }: { message: GeneralMessage }) {
  if (message.role === "user") {
    return (
      <div className="ml-auto flex max-w-[85%] flex-col items-end gap-1.5" data-testid="chat-message" data-role="user">
        {message.attachments && message.attachments.length > 0 && (
          <ul className="flex flex-wrap justify-end gap-1.5">
            {message.attachments.map((a) => (
              <li key={a.id} className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-xs" data-testid="chat-message-attachment">
                {a.preview ? (
                  // eslint-disable-next-line @next/next/no-img-element -- 정적 export에서는 data URL 미리보기를 그대로 쓴다
                  <img src={a.preview} alt={a.name} className="size-10 rounded object-cover" />
                ) : (
                  <Paperclip className="size-3.5 text-muted" aria-hidden />
                )}
                <span className="max-w-48 truncate" title={a.name}>
                  {a.name}
                </span>
                {a.truncated && <span className="text-amber-600">일부만 전달됨</span>}
              </li>
            ))}
          </ul>
        )}
        {message.content && <div className="rounded-2xl rounded-tr-sm bg-accent-soft px-3.5 py-2 text-sm whitespace-pre-wrap break-words">{message.content}</div>}
        {message.note && <p className="text-[11px] text-muted" data-testid="chat-message-note">{message.note}</p>}
      </div>
    );
  }
  return (
    <div className={`flex max-w-full flex-col gap-2 rounded-xl border p-3 ${message.error ? "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950" : "border-border bg-surface"}`} data-testid="chat-message" data-role="assistant">
      {message.activity && message.activity.length > 0 && <Activity items={message.activity} />}
      {message.error ? <p className="text-sm whitespace-pre-wrap text-red-700 dark:text-red-300">{message.content}</p> : <Markdown text={message.content} />}
      {message.status === "stopped" && <p className="text-xs text-muted">중지됨</p>}
      {message.notes?.map((n) => (
        <p key={n} className="text-[11px] text-muted">
          {n}
        </p>
      ))}
    </div>
  );
}

/** 답을 만들 때 한 일: 웹 검색 · 열어 본 페이지 · (ChatGPT) 실행한 명령. 열어 본 주소는 눌러서 기본 브라우저로 연다 */
function Activity({ items, open = false }: { items: ChatActivity[]; open?: boolean }) {
  const searches = items.filter((i) => i.kind === "search").length;
  const fetches = items.filter((i) => i.kind === "fetch").length;
  const commands = items.filter((i) => i.kind === "command").length;
  const summary = [searches ? `검색 ${searches}회` : "", fetches ? `페이지 ${fetches}개 열람` : "", commands ? `명령 ${commands}개 실행` : ""].filter(Boolean).join(" · ");
  return (
    <details open={open} className="text-xs text-muted" data-testid="chat-activity">
      <summary className="cursor-pointer select-none">{summary}</summary>
      <ul className="mt-1 flex flex-col gap-0.5 pl-3">
        {items.map((a, i) => (
          <li key={i} className="flex min-w-0 items-center gap-1" data-kind={a.kind}>
            <span className="shrink-0">{a.kind === "search" ? "검색:" : a.kind === "fetch" ? "읽음:" : "명령:"}</span>
            {a.url ? (
              <button onClick={() => void desktop.openExternalUrl(a.url as string).catch(() => {})} className="inline-flex min-w-0 items-center gap-1 text-accent hover:underline" title={a.url}>
                <span className="truncate">{a.label}</span>
                <ExternalLink className="size-3 shrink-0" aria-hidden />
              </button>
            ) : (
              <span className="truncate" title={a.label}>
                {a.label}
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
