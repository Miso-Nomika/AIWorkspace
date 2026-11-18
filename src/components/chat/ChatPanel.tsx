"use client";

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, FileText, ImagePlus, Loader2, SendHorizontal, ShieldCheck, Square, X } from "lucide-react";
import { ActivityList } from "./ActivityList";
import { Markdown } from "./Markdown";
import { PermissionPrompt } from "./PermissionPrompt";
import { ZoomControl } from "@/components/ZoomControl";
import { useZoom } from "@/lib/use-zoom";
import { playChatDoneSound } from "@/lib/notify-sound";
import { useAgentStatuses } from "@/lib/agent-status";
import { getAgent } from "@/lib/agents";
import {
  PERMISSION_CHOICES,
  PERMISSION_HINTS,
  PERMISSION_LABELS,
  needsUserAnswer,
  type AgentProgress,
  type AgentRun,
  type PermissionDecision,
  type PermissionRequest,
  type ProjectBackend,
} from "@/lib/backend";
import { docUpdates } from "@/lib/doc-updates";
import { desktop, errorMessage } from "@/lib/desktop";
import { projectRoot } from "@/lib/ssh-core";
import { looksSensitive } from "@/lib/memory-core";
import { helpText, matchSlash, parseSlash, planPrompt, type SlashAction } from "@/lib/slash-commands";
import { MAX_ATTACHMENTS, isImageFile, prepareImage, type ImageAttachment } from "@/lib/image-attach";
import { CATEGORY_LABELS, extractLearned } from "@/lib/memory-prompt";
import { MAIN_MODEL_CHOICES, PLANNER_MODEL_CHOICES, formatRunStats, pickMainModel, pickPlannerModel, type ModelChoice } from "@/lib/models";
import { useChat, useMemories } from "@/lib/store";
import type { ChatMessage, PermissionMode, Project } from "@/lib/types";

interface Props {
  project: Project;
  backend: ProjectBackend;
  onPermissionModeChange: (mode: PermissionMode) => void;
  onAllowedToolsChange: (rules: string[]) => void;
  onModelsChange: (models: Pick<Project, "mainModel" | "plannerModel">) => void;
}

interface PendingPermission {
  request: PermissionRequest;
  resolve: (decision: PermissionDecision) => void;
}

export function ChatPanel({ project, backend, onPermissionModeChange, onAllowedToolsChange, onModelsChange }: Props) {
  const { messages, addMessage, sessions, setSession } = useChat(project.id);
  const { learnMemories } = useMemories();
  const agents = useAgentStatuses();
  const [input, setInput] = useState("");
  const [run, setRun] = useState<AgentRun | null>(null);
  const [progress, setProgress] = useState<AgentProgress | null>(null);
  const [pending, setPending] = useState<PendingPermission[]>([]);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const { zoom, setZoom, bind } = useZoom("chat", { stickBottom: true });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(inputRef, input);
  // 실행 도중 "항상 허용"한 규칙을 같은 실행의 다음 요청에도 바로 적용하기 위해 최신 값을 참조
  const allowedRef = useRef<string[]>(project.allowedTools ?? []);
  useEffect(() => {
    allowedRef.current = project.allowedTools ?? [];
  }, [project.allowedTools]);
  // 화면이 닫힐 때(프로젝트 삭제 등) 실행을 멈추고 대기 중인 권한 요청을 거절한다 — 아무도 답할 수 없어 CLI가 영원히 기다리는 것을 막는다
  const runRef = useRef<AgentRun | null>(null);
  const pendingRef = useRef<PendingPermission[]>([]);
  useEffect(() => {
    runRef.current = run;
    pendingRef.current = pending;
  }, [run, pending]);
  useEffect(
    () => () => {
      pendingRef.current.forEach((p) => p.resolve({ behavior: "deny", message: "화면이 닫혀 거부되었습니다." }));
      runRef.current?.cancel();
    },
    [],
  );
  // 자동 승인: 실행 도중 바꿔도 다음 요청부터 바로 적용되도록 최신 값을 참조
  const autoRef = useRef(project.permissionMode === "auto");
  const autoCountRef = useRef(0);
  useEffect(() => {
    autoRef.current = project.permissionMode === "auto";
  }, [project.permissionMode]);

  const agentName = getAgent(project.agent).name;
  const permissionMode = project.permissionMode ?? "default";
  const allowedTools = project.allowedTools ?? [];
  const mainModel = pickMainModel(project.mainModel);
  const plannerModel = pickPlannerModel(project.plannerModel);
  const isLocal = backend.kind === "local";
  const slashMatches = matchSlash(input);
  const status = agents.find(project.agent);
  // 실행할 수 없는 상태면 안내하고 입력을 막는다
  const isRemoteProject = !!project.location?.remote; // 원격(SSH) 프로젝트는 원격 PC의 Claude Code를 쓰므로 이 PC의 설치 여부를 보지 않는다
  const blockedReason = !isLocal
    ? "이 PC에서 실행할 수 없는 프로젝트입니다. (탐색기 아래 안내 참고)"
    : isRemoteProject
      ? null
      : agents.loading && !status
        ? "에이전트를 확인하는 중…"
        : status && !status.installed
        ? `${agentName}가 이 PC에 설치되어 있지 않습니다. 설치한 뒤 대시보드에서 다시 확인하세요.`
        : null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, progress, pending.length]);

  /** 권한 모드 변경. 자동 승인으로 바꾸면 이미 떠 있는 권한 요청도 바로 허용한다 (질문·계획 승인은 제외). */
  function changePermissionMode(mode: PermissionMode) {
    autoRef.current = mode === "auto";
    onPermissionModeChange(mode);
    if (mode !== "auto") return;
    const waiting = pending.filter((p) => !needsUserAnswer(p.request.toolName));
    autoCountRef.current += waiting.length;
    setPending((prev) => prev.filter((p) => !waiting.includes(p)));
    waiting.forEach((p) => p.resolve({ behavior: "allow" }));
  }

  function decide(item: PendingPermission, decision: PermissionDecision) {
    if (decision.behavior === "allow" && decision.rememberRule && !allowedRef.current.includes(decision.rememberRule)) {
      allowedRef.current = [...allowedRef.current, decision.rememberRule];
      onAllowedToolsChange(allowedRef.current);
    }
    setPending((prev) => prev.filter((p) => p !== item));
    item.resolve(decision);
  }

  /** 이미지 파일을 첨부 목록에 추가 (선택·붙여넣기 공통). 형식이 아니거나 장수를 넘으면 안내 */
  async function attach(files: File[]) {
    const images = files.filter(isImageFile);
    if (!images.length) {
      if (files.length) setAttachError("PNG·JPEG·GIF·WebP 이미지만 첨부할 수 있습니다.");
      return;
    }
    const room = MAX_ATTACHMENTS - attachments.length;
    setAttachError(images.length > room ? `이미지는 한 번에 ${MAX_ATTACHMENTS}장까지 첨부할 수 있습니다.` : null);
    try {
      const prepared = await Promise.all(images.slice(0, Math.max(0, room)).map(prepareImage));
      setAttachments((prev) => [...prev, ...prepared].slice(0, MAX_ATTACHMENTS));
    } catch (error) {
      setAttachError(errorMessage(error));
    }
  }

  /** 에이전트를 부르지 않는 슬래시 명령 (/help · /model · 잘못된 명령). 입력과 답을 대화에 남긴다 */
  function runLocalCommand(action: Exclude<SlashAction, { type: "none" }>, typed: string) {
    const modelIds = MAIN_MODEL_CHOICES.map((c) => c.id).join(" · ");
    let reply: string;
    if (action.type === "help") {
      reply = helpText();
    } else if (action.type === "model") {
      const choice = MAIN_MODEL_CHOICES.find((c) => c.id === action.arg);
      if (choice) {
        onModelsChange({ mainModel: choice.id, plannerModel });
        reply = `작업 모델을 **${choice.label}**로 바꿨습니다. 다음 요청부터 적용됩니다.`;
      } else if (action.arg) {
        reply = `'${action.arg}'은(는) 없는 모델입니다. ${modelIds} 중에서 고르세요.`;
      } else {
        const current = MAIN_MODEL_CHOICES.find((c) => c.id === mainModel)?.label ?? mainModel;
        const planner = PLANNER_MODEL_CHOICES.find((c) => c.id === plannerModel)?.label ?? plannerModel;
        reply = `작업 모델: **${current}** (기획 모델: ${planner}). 바꾸려면 "/model haiku"처럼 입력하세요 — ${modelIds}`;
      }
    } else if (action.type === "plan") {
      reply = "기획할 내용을 함께 적어 주세요. 예: /plan 로그인 기능 추가";
    } else {
      reply = `지원하지 않는 명령입니다: /${action.name}. /help로 사용할 수 있는 명령을 볼 수 있습니다.`;
    }
    setInput("");
    addMessage({ role: "user", content: typed, agent: project.agent });
    addMessage({ role: "assistant", content: reply, agent: project.agent });
  }

  async function submit() {
    const typed = input.trim();
    if ((!typed && !attachments.length) || run || blockedReason) return;
    // 슬래시 명령: 앱이 직접 처리한다 (/plan은 요청 문장을 만들어 에이전트에 보낸다)
    const slash = parseSlash(typed);
    if (slash.type !== "none" && !(slash.type === "plan" && slash.arg)) {
      runLocalCommand(slash, typed);
      return;
    }
    const text = slash.type === "plan" ? planPrompt(slash.arg) : typed || "첨부한 이미지를 확인해 줘.";
    const sent = attachments;
    setInput("");
    setAttachments([]);
    setAttachError(null);
    addMessage({ role: "user", content: typed, agent: project.agent, images: sent.length ? sent.map((a) => a.preview) : undefined });

    let current: AgentRun;
    try {
      current = backend.runAgent(
        {
          agent: project.agent,
          project,
          prompt: text,
          sessionId: sessions[project.agent],
          permissionMode,
          allowedTools,
          mainModel,
          plannerModel,
          images: sent.length ? sent.map(({ mediaType, data }) => ({ mediaType, data })) : undefined,
        },
        {
          onProgress: setProgress,
          onPermission: (request) =>
            new Promise<PermissionDecision>((resolve) => {
              // 같은 실행 중에 "항상 허용"한 규칙과 일치하면 다시 묻지 않는다
              if (request.suggestedRule && allowedRef.current.includes(request.suggestedRule)) {
                resolve({ behavior: "allow" });
                return;
              }
              // 자동 승인: 사용자가 답해야 하는 질문·계획 승인만 묻는다
              if (autoRef.current && !needsUserAnswer(request.toolName)) {
                autoCountRef.current++;
                resolve({ behavior: "allow" });
                return;
              }
              setPending((prev) => [...prev, { request, resolve }]);
            }),
        },
      );
    } catch (error) {
      addMessage({ role: "assistant", content: errorMessage(error), agent: project.agent, error: true });
      return;
    }
    setRun(current);
    setProgress({ text: "", activity: [] });
    autoCountRef.current = 0;
    try {
      const result = await current.result;
      if (result.sessionId) setSession(project.agent, result.sessionId);
      // 응답에 담긴 새 개인 취향·피드백을 공통 메모리에 반영하고 화면에서는 태그를 숨긴다
      const { text: visibleText, learned } = extractLearned(result.text);
      const notes = [...result.notes];
      if (autoCountRef.current > 0) notes.push(`권한 요청 ${autoCountRef.current}건을 자동 승인했습니다.`);
      // 공통 항목은 공통 메모리(Drive 동기화)로, scope="project" 항목은 이 프로젝트 폴더의 CLAUDE.md(프로젝트 메모리)로 나눠 저장한다
      const commonItems = learned.filter((l) => l.scope !== "project");
      if (commonItems.length && learnMemories(commonItems) > 0) {
        notes.push(`메모리에 반영: ${commonItems.map((l) => `${CATEGORY_LABELS[l.category]} · ${l.title}`).join(", ")}`);
      }
      const projectItems = learned.filter((l) => l.scope === "project" && !looksSensitive(`${l.title} ${l.content}`));
      const memoryRoot = backend.kind === "local" && project.location ? projectRoot(project.location) : undefined;
      if (projectItems.length && memoryRoot) {
        try {
          const saved = await desktop.projectMemoryAdd(memoryRoot, projectItems.map((l) => l.content));
          if (saved.added > 0) notes.push(`프로젝트 메모리에 저장: ${projectItems.map((l) => l.title).join(", ")}`);
        } catch (error) {
          notes.push(`프로젝트 메모리 저장 실패: ${errorMessage(error)}`);
        }
      }
      addMessage({
        role: "assistant",
        content: visibleText || (result.cancelled ? "" : "(응답 없음)"),
        agent: project.agent,
        activity: result.activity.length ? result.activity : undefined,
        notes: notes.length ? notes : undefined,
        error: result.isError,
        stats: result.stats,
      });
      playChatDoneSound(result.cancelled ? "cancelled" : result.isError ? "error" : "done", "project");
    } catch (error) {
      addMessage({ role: "assistant", content: errorMessage(error), agent: project.agent, error: true });
      playChatDoneSound("error", "project");
    } finally {
      setRun(null);
      setProgress(null);
      setPending([]);
    }
  }

  return (
    <div ref={bind} className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <span className="text-sm font-medium">AI 채팅</span>
        {isLocal && (
          <div className="ml-auto flex items-center gap-2">
            {allowedTools.length > 0 && (
              <AllowedRules rules={allowedTools} disabled={!!run} onRemove={(rule) => onAllowedToolsChange(allowedTools.filter((r) => r !== rule))} />
            )}
            <PermissionToggle value={permissionMode} onChange={changePermissionMode} />
          </div>
        )}
        <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {isLocal && (
            <>
            <ModelSelect
              label="작업 모델"
              testId="main-model"
              value={mainModel}
              choices={MAIN_MODEL_CHOICES}
              onChange={(id) => onModelsChange({ mainModel: id, plannerModel })}
            />
            <ModelSelect
              label="기획 모델"
              testId="planner-model"
              value={plannerModel}
              choices={PLANNER_MODEL_CHOICES}
              onChange={(id) => onModelsChange({ mainModel, plannerModel: id })}
            />
            </>
          )}
          <div className="ml-auto">
            <ZoomControl zoom={zoom} onChange={setZoom} label="채팅 확대·축소" testId="chat-zoom" />
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="chat-scroll">
        <div className="space-y-3" style={{ zoom: zoom / 100 }} data-testid="chat-zoomed" data-zoom-content>
        {messages.length === 0 && !run && (
          <p className="pt-8 text-center text-sm text-muted">
            {agentName}에게 요청해 보세요.
            <br />
            {`프로젝트 폴더에서 실행됩니다. 권한: ${PERMISSION_LABELS[permissionMode]} — ${PERMISSION_HINTS[permissionMode]}`}
          </p>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {run && progress && (
          <div className="flex justify-start">
            <div className="w-full max-w-[92%] rounded-2xl border border-border bg-background px-3.5 py-2 text-sm">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted">
                <Loader2 className="size-3 animate-spin" aria-hidden />
                {pending.length ? `${agentName}가 응답을 기다립니다` : `${agentName} 작업 중…`}
              </div>
              <ActivityList items={progress.activity} />
              {progress.text && <Markdown text={extractLearned(progress.text, 3, true).text} />}
            </div>
          </div>
        )}
        {pending.some((p) => !needsUserAnswer(p.request.toolName)) && (
          <div className="flex justify-end">
            <button
              onClick={() => changePermissionMode("auto")}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted hover:bg-background hover:text-foreground"
              title={PERMISSION_HINTS.auto}
            >
              <ShieldCheck className="size-3.5" aria-hidden />
              이후 모두 자동 승인
            </button>
          </div>
        )}
        {pending.map((item) => (
          <PermissionPrompt key={item.request.requestId} agentName={agentName} request={item.request} onDecide={(d) => decide(item, d)} />
        ))}
        <div ref={bottomRef} />
        </div>
      </div>

      {blockedReason && (
        <p className="flex gap-1.5 border-t border-border px-4 py-2 text-xs text-muted">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {blockedReason}
        </p>
      )}

      {(attachments.length > 0 || attachError) && (
        <div className="border-t border-border px-3 pt-2">
          {attachments.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label="첨부한 이미지" data-testid="attachments">
              {attachments.map((a, i) => (
                <li key={i} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element -- 정적 export에서는 data URL 미리보기를 그대로 쓴다 */}
                  <img src={a.preview} alt={a.name} title={a.name} className="size-14 rounded-md border border-border object-cover" />
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={`${a.name} 첨부 해제`}
                    className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-surface p-0.5 text-muted hover:text-red-600"
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {attachError && <p className="mt-1 text-xs text-red-600">{attachError}</p>}
        </div>
      )}

      {slashMatches.length > 0 && (
        <ul className="border-t border-border px-3 pt-2 text-xs" aria-label="슬래시 명령" data-testid="slash-list">
          {slashMatches.map((c) => (
            <li key={c.name}>
              <button
                type="button"
                onClick={() => {
                  setInput(`/${c.name} `);
                  inputRef.current?.focus();
                }}
                className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left hover:bg-background"
              >
                <span className="font-mono text-accent">{c.usage}</span>
                <span className="text-muted">{c.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className={`flex items-end gap-2 p-3 ${attachments.length > 0 || attachError || slashMatches.length > 0 ? "" : "border-t border-border"}`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          data-testid="attach-input"
          onChange={(e) => {
            void attach(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={!!blockedReason || !!run || attachments.length >= MAX_ATTACHMENTS}
          aria-label="이미지 첨부"
          title="이미지 첨부 (붙여넣기도 가능)"
          className="rounded-lg border border-border p-2.5 text-muted hover:bg-background hover:text-foreground disabled:opacity-40"
        >
          <ImagePlus className="size-4" />
        </button>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            // 클립보드에 이미지가 있으면(스크린샷 등) 첨부로 처리하고 글 붙여넣기는 막는다
            const files = Array.from(e.clipboardData.files).filter(isImageFile);
            if (!files.length) return;
            e.preventDefault();
            void attach(files);
          }}
          onKeyDown={(e) => {
            // 슬래시 명령 이름을 치는 중 Tab: 첫 후보로 완성
            if (e.key === "Tab" && slashMatches.length > 0) {
              e.preventDefault();
              setInput(`/${slashMatches[0].name} `);
              return;
            }
            // 한글 IME 조합 중 Enter는 무시 (중복 전송 방지)
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          disabled={!!blockedReason}
          placeholder="메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)"
          aria-label="메시지 입력"
          data-testid="chat-input"
          className="min-h-10 flex-1 resize-none overflow-y-hidden rounded-lg border border-border bg-background px-3 py-2 text-sm leading-5 outline-none focus:border-accent disabled:opacity-50"
        />
        {run ? (
          <button
            type="button"
            onClick={() => run.cancel()}
            aria-label="실행 중지"
            data-testid="chat-stop"
            title="실행 중지"
            className="rounded-lg border border-border p-2.5 text-red-600 hover:bg-background"
          >
            <Square className="size-4" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={(!input.trim() && !attachments.length) || !!blockedReason}
            aria-label="전송"
            data-testid="chat-send"
            className="rounded-lg bg-accent p-2.5 text-white disabled:opacity-40 dark:text-zinc-950"
          >
            <SendHorizontal className="size-4" />
          </button>
        )}
      </form>
    </div>
  );
}

/** 입력창이 화면에서 차지할 수 있는 최대 비율. 넘으면 내부 스크롤 */
const INPUT_MAX_VIEWPORT = 0.5;

/**
 * 입력 내용에 맞춰 입력창 높이를 늘리고 줄인다.
 * 창 크기·패널 너비가 바뀌면(줄바꿈 위치가 달라짐) 다시 계산한다.
 */
function useAutoGrow(ref: React.RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const max = Math.max(120, Math.round(window.innerHeight * INPUT_MAX_VIEWPORT));
      el.style.height = "auto";
      // scrollHeight는 테두리를 뺀 값 (box-sizing: border-box)
      const border = el.offsetHeight - el.clientHeight;
      const needed = el.scrollHeight + border;
      el.style.height = `${Math.min(needed, max)}px`;
      el.style.overflowY = needed > max ? "auto" : "hidden";
    };
    fit();
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      fit();
    });
    observer.observe(el);
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [ref, value]);
}

/** 권한 선택: 변경 전 확인 / 자동 승인. 실행 중에도 바꿀 수 있다. */
function PermissionToggle({ value, onChange }: { value: PermissionMode; onChange: (mode: PermissionMode) => void }) {
  const legacy = !PERMISSION_CHOICES.includes(value);
  return (
    <div role="radiogroup" aria-label="에이전트 권한" className="inline-flex rounded-md border border-border p-0.5 text-xs" data-testid="permission-toggle">
      {PERMISSION_CHOICES.map((mode) => {
        const active = value === mode;
        return (
          <button
            key={mode}
            role="radio"
            aria-checked={active}
            onClick={() => !active && onChange(mode)}
            title={PERMISSION_HINTS[mode]}
            className={`rounded px-2 py-0.5 transition-colors ${
              active ? (mode === "auto" ? "bg-amber-500 text-white dark:bg-amber-400 dark:text-zinc-950" : "bg-accent text-white dark:text-zinc-950") : "text-muted hover:text-foreground"
            }`}
          >
            {PERMISSION_LABELS[mode]}
          </button>
        );
      })}
      {legacy && (
        <span className="px-2 py-0.5 text-muted" title={PERMISSION_HINTS[value]}>
          현재: {PERMISSION_LABELS[value]}
        </span>
      )}
    </div>
  );
}

/** 모델 선택 (프로젝트별 저장, 다음 요청부터 적용) */
function ModelSelect<T extends string>({
  label,
  testId,
  value,
  choices,
  onChange,
}: {
  label: string;
  testId: string;
  value: T;
  choices: ModelChoice<T>[];
  onChange: (id: T) => void;
}) {
  const current = choices.find((c) => c.id === value);
  return (
    <label className="inline-flex items-center gap-1.5" title={current?.hint}>
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        data-testid={testId}
        className="rounded-md border border-border bg-background px-1.5 py-0.5 text-xs text-foreground outline-none focus:border-accent"
      >
        {choices.map((c) => (
          <option key={c.id} value={c.id} title={c.hint}>
            {c.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** "항상 허용"한 규칙 목록 (프로젝트별) */
function AllowedRules({ rules, disabled, onRemove }: { rules: string[]; disabled: boolean; onRemove: (rule: string) => void }) {
  return (
    <details className="relative text-xs">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded border border-border px-1.5 py-0.5 text-muted [&::-webkit-details-marker]:hidden">
        <ShieldCheck className="size-3.5" aria-hidden />
        항상 허용 {rules.length}
      </summary>
      <ul className="absolute right-0 z-20 mt-1 w-72 space-y-1 rounded-lg border border-border bg-surface p-2 shadow-lg" aria-label="항상 허용 규칙">
        {rules.map((rule) => (
          <li key={rule} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono" title={rule}>
              {rule}
            </span>
            <button onClick={() => onRemove(rule)} disabled={disabled} aria-label={`${rule} 허용 해제`} className="rounded p-0.5 text-muted hover:text-red-600 disabled:opacity-40">
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * 대화 한 칸. memo로 감싸 입력창에 글자를 칠 때마다 지난 답변(마크다운 파싱)을 전부 다시 그리지 않게 한다 —
 * 대화가 길수록 입력이 굼떠지던 원인이었다.
 */
const MessageBubble = memo(function MessageBubble({ message: m }: { message: ChatMessage }) {
  const isUser = m.role === "user";
  // 이번 응답에서 TODO.md·기능명세서.md를 고쳤으면 표시한다
  const docs = isUser ? [] : docUpdates(m.activity);
  const statsText = isUser ? "" : formatRunStats(m.stats);
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`rounded-2xl px-3.5 py-2 text-sm ${
          isUser
            ? "max-w-[85%] bg-accent whitespace-pre-wrap text-white dark:text-zinc-950"
            : m.error
              ? "w-full max-w-[92%] border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950"
              : "w-full max-w-[92%] border border-border bg-background"
        }`}
      >
        {!isUser && <div className="mb-1 text-xs font-medium text-muted">{getAgent(m.agent).name}</div>}
        {m.images && m.images.length > 0 && (
          <div className={`flex flex-wrap justify-end gap-1.5 ${m.content ? "mb-1.5" : ""}`} data-testid="message-images">
            {m.images.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element -- data URL 미리보기
              <img key={i} src={src} alt={`첨부 이미지 ${i + 1}`} className="max-h-24 rounded-md" />
            ))}
          </div>
        )}
        {m.activity && <ActivityList items={m.activity} />}
        {m.content && (isUser ? m.content : <Markdown text={m.content} />)}
        {docs.length > 0 && (
          <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent" data-testid="doc-updates">
            <FileText className="size-3" aria-hidden />
            문서 갱신: {docs.join(" · ")}
          </p>
        )}
        {m.notes?.map((note, i) => (
          <p key={i} className="mt-1.5 text-xs text-muted">
            ※ {note}
          </p>
        ))}
        {statsText && (
          <p className="mt-1.5 text-[11px] text-muted" data-testid="run-stats" title="걸린 시간 · API 요금 기준 추정 비용 (구독이면 실제 청구액이 아닙니다)">
            {statsText}
          </p>
        )}
      </div>
    </div>
  );
});
