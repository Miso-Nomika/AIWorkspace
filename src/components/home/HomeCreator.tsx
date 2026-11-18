"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, RotateCcw, Sparkles, X } from "lucide-react";
import { CustomWidget } from "./CustomWidget";
import { generateHomeWidget, requestProblem, type WidgetGeneration } from "@/lib/home-widget-gen";
import type { WidgetDef } from "@/lib/home-widget-core";

export interface EditTarget {
  id: string;
  title: string;
  def: unknown;
}

interface Props {
  /** 수정 중인 위젯 (없으면 새로 만든다) */
  editing: EditTarget | null;
  onStopEditing: () => void;
  /** 미리보기에서 [추가]/[적용]을 눌렀을 때. 이미 가득 차 등으로 추가하지 못하면 오류 글을 돌려준다 */
  onAccept: (def: WidgetDef, editingId: string | null) => string | null;
}

type Phase = { name: "idle" } | { name: "busy" } | { name: "preview"; def: WidgetDef } | { name: "error"; message: string };

const BTN = "inline-flex size-8 items-center justify-center rounded-lg border border-border text-muted hover:bg-background hover:text-foreground disabled:opacity-40";

/** 홈 위쪽 입력창: 요청을 적으면 Claude가 위젯 정의를 만들고, 미리보기에서 추가·다시·취소를 고른다 */
export function HomeCreator({ editing, onStopEditing, onAccept }: Props) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const run = useRef<WidgetGeneration | null>(null);
  const lastRequest = useRef("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  useEffect(() => () => run.current?.cancel(), []);

  function start(request: string) {
    const problem = requestProblem(request);
    if (problem) return setPhase({ name: "error", message: problem });
    lastRequest.current = request;
    setPhase({ name: "busy" });
    const generation = generateHomeWidget(request, editing?.def);
    run.current = generation;
    void generation.result.then((r) => {
      if (run.current !== generation) return;
      run.current = null;
      if (r.ok) setPhase({ name: "preview", def: r.def });
      else setPhase(r.cancelled ? { name: "idle" } : { name: "error", message: r.error });
    });
  }

  function cancel() {
    run.current?.cancel();
    run.current = null;
    setPhase({ name: "idle" });
  }

  function accept(def: WidgetDef) {
    const problem = onAccept(def, editing?.id ?? null);
    if (problem) return setPhase({ name: "error", message: problem });
    setText("");
    setPhase({ name: "idle" });
    onStopEditing();
  }

  const busy = phase.name === "busy";
  return (
    <section className="mb-4" data-testid="home-creator">
      {editing && (
        <p className="mb-1 flex items-center gap-1 text-xs text-muted" data-testid="home-creator-editing">
          <span>‘{editing.title}’ 위젯을 수정하는 중입니다</span>
          <button type="button" onClick={() => { cancel(); onStopEditing(); }} title="수정 그만두기" aria-label="수정 그만두기" className="rounded p-0.5 hover:bg-background">
            <X className="size-3.5" aria-hidden />
          </button>
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) start(text);
        }}
        className="flex gap-2"
      >
        <input
          ref={input}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (phase.name === "error") setPhase({ name: "idle" });
          }}
          disabled={busy}
          placeholder={editing ? "어떻게 고칠까요? (예: 항목을 하나 더 추가해 줘)" : "홈에 추가할 위젯을 말해 보세요 (예: 크리스마스 D-day, 오늘 할 일 목록)"}
          aria-label="위젯 요청"
          data-testid="home-creator-input"
          className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-60"
        />
        <button type="submit" disabled={busy || !text.trim()} title={editing ? "수정 요청 보내기" : "위젯 만들기"} aria-label={editing ? "수정 요청 보내기" : "위젯 만들기"} data-testid="home-creator-send" className={BTN}>
          <Sparkles className="size-4" aria-hidden />
        </button>
      </form>
      {busy && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted" data-testid="home-creator-busy">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          위젯을 만드는 중입니다…
          <button type="button" onClick={cancel} title="만들기 취소" aria-label="만들기 취소" data-testid="home-creator-cancel" className="rounded p-0.5 hover:bg-background hover:text-foreground">
            <X className="size-3.5" aria-hidden />
          </button>
        </p>
      )}
      {phase.name === "error" && (
        <p className="mt-2 break-words text-xs text-red-600 dark:text-red-400" data-testid="home-creator-error">
          {phase.message}
        </p>
      )}
      {phase.name === "preview" && (
        <div className="mt-3 rounded-xl border border-dashed border-accent p-3" data-testid="home-creator-preview">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs text-muted">미리보기</p>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => accept(phase.def)} title={editing ? "수정 적용" : "홈에 추가"} aria-label={editing ? "수정 적용" : "홈에 추가"} data-testid="home-creator-accept" className={BTN}>
                <Check className="size-4" aria-hidden />
              </button>
              <button type="button" onClick={() => start(lastRequest.current)} title="다시 만들기" aria-label="다시 만들기" data-testid="home-creator-retry" className={BTN}>
                <RotateCcw className="size-4" aria-hidden />
              </button>
              <button type="button" onClick={() => setPhase({ name: "idle" })} title="취소" aria-label="취소" data-testid="home-creator-discard" className={BTN}>
                <X className="size-4" aria-hidden />
              </button>
            </div>
          </div>
          <CustomWidget id="preview" def={phase.def} preview />
        </div>
      )}
    </section>
  );
}
