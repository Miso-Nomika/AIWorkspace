"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, Minimize2 } from "lucide-react";
import { buttonGhost, buttonPrimary, inputClass } from "@/components/ui/styles";
import { errorMessage } from "@/lib/desktop";
import { applyCompactionDrafts, draftCompaction, type CompactDrafts } from "@/lib/memory-compact";
import { CATEGORIES, CATEGORY_BUDGET_CHARS, CATEGORY_LABELS, categoriesToCompact, legacyItems, overBudgetCategories } from "@/lib/memory-core";
import { useMemories } from "@/lib/store";

/**
 * 메모리 압축: 분류마다 하나의 핵심 목록으로 합친다 (압축 전 항목이 남아 있거나 핵심 목록이 길어졌을 때 나타난다).
 * Claude Code가 만든 초안을 사용자가 확인·수정한 뒤에만 적용한다.
 */
export function CompactPanel() {
  const { memories } = useMemories();
  const [phase, setPhase] = useState<"idle" | "drafting" | "review">("idle");
  const [drafts, setDrafts] = useState<CompactDrafts>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const categories = categoriesToCompact(memories);
  const legacy = legacyItems(memories).length;
  if (phase === "idle" && categories.length === 0 && !done) return null;

  const start = async () => {
    setPhase("drafting");
    setError(null);
    setDone(null);
    try {
      setDrafts(await draftCompaction());
      setPhase("review");
    } catch (e) {
      setError(errorMessage(e));
      setPhase("idle");
    }
  };

  const apply = () => {
    const { merged } = applyCompactionDrafts(drafts);
    setDone(`분류별 핵심 목록으로 합쳤습니다${merged ? ` (압축 전 항목 ${merged}개 정리)` : ""}. 적용 직전 내용은 이 PC에 백업되어 있습니다.`);
    setDrafts({});
    setPhase("idle");
  };

  const labels = categories.map((c) => CATEGORY_LABELS[c]).join("·");
  const overLabels = overBudgetCategories(memories).map((c) => CATEGORY_LABELS[c]).join("·");

  return (
    <section className="mb-6 rounded-xl border border-accent bg-surface" aria-label="메모리 압축" data-testid="compact-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Minimize2 className="size-4 text-accent" aria-hidden />
        <span className="text-sm font-medium">메모리 압축</span>
        {phase === "idle" && categories.length > 0 && (
          <button onClick={start} className={`${buttonPrimary} ml-auto px-2.5 py-1 text-xs`} data-testid="compact-start">
            초안 만들기
          </button>
        )}
      </div>

      <div className="flex flex-col gap-3 px-4 py-3 text-xs">
        {phase === "idle" && categories.length > 0 && (
          <p>
            {legacy > 0
              ? `압축 전 항목 ${legacy}개를 분류마다 하나의 짧은 목록으로 합칩니다. 에이전트에게 매번 전달되는 지침이 줄어듭니다.`
              : `${overLabels} 목록이 ${CATEGORY_BUDGET_CHARS.toLocaleString()}자를 넘었습니다. 압축을 권합니다 — 최근 대화에서 사용자가 좋아한 방식은 강화하고 고치라고 한 방식은 피하도록 ${labels} 목록을 다시 정리합니다.`}{" "}
            <span className="text-muted">먼저 초안을 보여 드리고, 확인한 뒤에만 적용합니다.</span>
          </p>
        )}
        {phase === "drafting" && (
          <p className="flex items-center gap-2" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Claude Code가 초안을 만드는 중…
          </p>
        )}
        {phase === "review" && (
          <>
            <p className="text-muted">초안입니다. 고칠 부분이 있으면 직접 수정한 뒤 적용하세요.</p>
            {CATEGORIES.filter((c) => drafts[c] !== undefined).map((c) => (
              <label key={c} className="flex flex-col gap-1" data-testid={`compact-draft-${c}`}>
                <span className="flex items-center gap-2 font-medium">
                  {CATEGORY_LABELS[c]}
                  <span className="font-normal text-muted">{(drafts[c] ?? "").length}자</span>
                </span>
                <textarea
                  value={drafts[c] ?? ""}
                  onChange={(e) => setDrafts({ ...drafts, [c]: e.target.value })}
                  rows={6}
                  className={`${inputClass} font-mono text-xs`}
                  aria-label={`${CATEGORY_LABELS[c]} 압축 초안`}
                />
              </label>
            ))}
            <p className="text-muted">
              적용하면 합쳐진 옛 항목은 삭제 기록으로 바뀌어 다른 PC에도 반영됩니다. 적용 직전 내용은 이 PC의 앱 데이터 폴더(memories-backup.json)에 남습니다.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setPhase("idle")} className={buttonGhost}>
                취소
              </button>
              <button onClick={apply} className={buttonPrimary} data-testid="compact-apply">
                적용
              </button>
            </div>
          </>
        )}
        {error && (
          <p className="text-red-600" role="alert">
            {error}
          </p>
        )}
        {done && (
          <p className="flex items-center gap-1.5 text-green-700 dark:text-green-400" data-testid="compact-done">
            <CheckCircle2 className="size-3.5" aria-hidden />
            {done}
          </p>
        )}
      </div>
    </section>
  );
}
