"use client";

import { Loader2, Sparkles } from "lucide-react";
import { DEFAULT_LEARN, learnFromHistoryNow, useLearnState, type LearnSettings } from "@/lib/memory-learn";
import { useStoredState } from "@/lib/storage";

function dateTime(iso: string | null) {
  return iso ? new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "아직 없음";
}

/** 대화 기록에서 개인 취향 학습 */
export function LearnPanel() {
  const learn = useLearnState();
  const [stored, setStored] = useStoredState<Partial<LearnSettings>>("learn", DEFAULT_LEARN);
  const settings = { ...DEFAULT_LEARN, ...stored };

  const running = learn.status === "running";
  return (
    <section className="mb-6 rounded-xl border border-border bg-surface" aria-label="자동 학습">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Sparkles className="size-4 text-accent" aria-hidden />
        <span className="text-sm font-medium">자동 학습</span>
        <span className="text-xs text-muted">마지막 분석: {dateTime(settings.lastRunAt)}</span>
        <button
          onClick={() => void learnFromHistoryNow()}
          disabled={running}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-background disabled:opacity-40"
          data-testid="learn-now"
        >
          {running ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Sparkles className="size-3" aria-hidden />}
          대화 기록에서 학습
        </button>
      </div>
      <div className="flex flex-col gap-2 px-4 py-3 text-xs">
        {learn.message && (
          <p className={learn.status === "error" ? "text-red-600" : "text-foreground"} data-testid="learn-status">
            {learn.message}
            {learn.learned.length > 0 && <span className="text-muted"> — {learn.learned.join(", ")}</span>}
          </p>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={settings.auto} onChange={(e) => setStored({ ...settings, auto: e.target.checked })} aria-label="대화 기록 자동 학습" />
          새 대화가 10개 이상 쌓이면 자동으로 분석해 반영
        </label>
        <p className="text-muted">
          AI 응답에 담긴 새 취향은 바로 반영되고, 여기서는 이 PC의 모든 프로젝트 대화에서 반복된 요청·피드백을 Claude Code로 분석합니다(분석에는 도구를 쓰지 않으며
          Claude Code 사용량이 조금 듭니다). 같은 주제는 기존 항목을 갱신하고, 중복 항목과 오래된 삭제 기록은 동기화할 때 자동으로 정리합니다.
        </p>
      </div>
    </section>
  );
}
