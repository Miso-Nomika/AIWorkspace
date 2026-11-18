"use client";

import { useState } from "react";
import { Pencil, Sparkles, Trash2 } from "lucide-react";
import { CompactPanel } from "./CompactPanel";
import { MoveToProject } from "./MoveToProject";
import { LearnPanel } from "./LearnPanel";
import { SyncPanel } from "./SyncPanel";
import { PageHeader } from "@/components/ui/PageHeader";
import { buttonGhost, buttonPrimary, inputClass } from "@/components/ui/styles";
import { confirmAction } from "@/lib/confirm";
import { CATEGORIES, CATEGORY_BUDGET_CHARS, CATEGORY_LABELS, categoryChars, coreId, legacyItems, overBudgetCategories } from "@/lib/memory-core";
import { useHydrated } from "@/lib/storage";
import { useMemories } from "@/lib/store";
import type { MemoryCategory } from "@/lib/types";

const PLACEHOLDERS: Record<MemoryCategory, string> = {
  preference: "예: - 설치 파일은 GitHub Releases로 배포한다",
  communication: "예: - 결론부터 말하고 설명은 간결하게",
  feedback: "예: - 리뷰는 심각도 순으로 정리한다",
};

/** 분류마다 하나의 핵심 목록을 보여 주고 고친다. 자동 학습은 이 목록에 한 줄씩 덧붙는다. */
export function MemoryManager() {
  const hydrated = useHydrated();
  const { memories, saveCore, deleteMemory } = useMemories();
  const [editing, setEditing] = useState<MemoryCategory | null>(null);
  const [text, setText] = useState("");
  const legacy = legacyItems(memories);
  const over = overBudgetCategories(memories);

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <PageHeader
        title="메모리"
        description="모든 PC와 AI 에이전트가 함께 쓰는 개인 취향, 대화 방식, 피드백입니다. 분류마다 하나의 목록으로 관리하고, 자동 학습은 그 목록에 한 줄씩 덧붙습니다. 분류마다 2,000자 안으로 유지하고, 한 분류라도 넘으면 메모리 압축을 권합니다."
      />

      <SyncPanel />
      <LearnPanel />
      <CompactPanel />

      {hydrated && (
        <p className={`mb-3 text-xs ${over.length ? "text-amber-600 dark:text-amber-400" : "text-muted"}`} data-testid="memory-total">
          {CATEGORIES.map((c) => `${CATEGORY_LABELS[c]} ${categoryChars(memories, c).toLocaleString()} / ${CATEGORY_BUDGET_CHARS.toLocaleString()}자`).join(" · ")}
          {over.length ? ` — ${over.map((c) => CATEGORY_LABELS[c]).join("·")}이(가) 한도를 넘었습니다. 위 '메모리 압축'으로 줄이세요.` : ""}
        </p>
      )}

      {!hydrated ? (
        <p className="text-sm text-muted">불러오는 중…</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {CATEGORIES.map((category) => {
            const core = memories.find((m) => m.id === coreId(category));
            const length = core?.content.length ?? 0;
            const isEditing = editing === category;
            return (
              <li key={category} className="rounded-xl border border-border bg-surface p-4" data-testid={`memory-core-${category}`}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="font-medium">{CATEGORY_LABELS[category]}</span>
                  {core?.source === "learned" && (
                    <span
                      className="inline-flex items-center gap-0.5 rounded-full bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent"
                      title="AI 사용 중 자동으로 덧붙은 내용이 있습니다. 직접 수정하면 확인한 항목으로 바뀝니다."
                    >
                      <Sparkles className="size-3" aria-hidden />
                      자동 학습
                    </span>
                  )}
                  <span className="text-xs text-muted">{length.toLocaleString()}자</span>
                  {!isEditing && (
                    <button
                      onClick={() => {
                        setEditing(category);
                        setText(core?.content ?? "");
                      }}
                      aria-label={`${CATEGORY_LABELS[category]} 수정`}
                      className="ml-auto rounded p-1 text-muted hover:text-foreground"
                    >
                      <Pencil className="size-4" />
                    </button>
                  )}
                </div>
                {isEditing ? (
                  <div className="flex flex-col gap-2">
                    <textarea
                      autoFocus
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      rows={7}
                      placeholder={PLACEHOLDERS[category]}
                      aria-label={`${CATEGORY_LABELS[category]} 내용`}
                      className={`${inputClass} font-mono text-xs`}
                    />
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setEditing(null)} className={buttonGhost}>
                        취소
                      </button>
                      <button
                        onClick={() => {
                          saveCore(category, text);
                          setEditing(null);
                        }}
                        className={buttonPrimary}
                      >
                        저장
                      </button>
                    </div>
                  </div>
                ) : core ? (
                  <ul className="flex flex-col gap-0.5 text-sm text-muted">
                    {core.content
                      .split("\n")
                      .filter((line) => line.trim())
                      .map((line, index, lines) => (
                        <li key={index} className="flex items-start gap-2" data-testid="memory-line">
                          <span className="min-w-0 flex-1 whitespace-pre-wrap">{line}</span>
                          <MoveToProject
                            line={line}
                            label={line.replace(/^-\s*/, "").slice(0, 30)}
                            onMoved={() => saveCore(category, lines.filter((_, i) => i !== index).join("\n"))}
                          />
                        </li>
                      ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted">아직 비어 있습니다. 연필 버튼으로 직접 쓰거나, 대화하면서 자동으로 채워집니다.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {hydrated && legacy.length > 0 && (
        <section className="mt-8" aria-label="압축 전 항목" data-testid="memory-legacy">
          <h2 className="mb-2 text-sm font-medium">압축 전 항목 ({legacy.length}개)</h2>
          <p className="mb-3 text-xs text-muted">위의 &lsquo;메모리 압축&rsquo;으로 분류별 목록에 합치면 이 항목들은 정리됩니다.</p>
          <ul className="flex flex-col gap-1.5">
            {legacy.map((m) => (
              <li key={m.id} className="flex gap-3 rounded-lg border border-border bg-surface px-3 py-2" data-memory-id={m.id}>
                <div className="min-w-0 flex-1 text-xs">
                  <span className="mr-2 rounded bg-background px-1.5 py-0.5 text-muted">{CATEGORY_LABELS[m.category]}</span>
                  <span className="font-medium">{m.title}</span>
                  <p className="mt-0.5 whitespace-pre-wrap text-muted">{m.content}</p>
                  <div className="mt-1">
                    <MoveToProject line={m.content} label={m.title} onMoved={() => deleteMemory(m.id)} />
                  </div>
                </div>
                <button
                  onClick={async () => {
                    if (await confirmAction(`'${m.title}' 항목을 삭제할까요?\n동기화된 다른 PC에서도 삭제됩니다.`)) deleteMemory(m.id);
                  }}
                  aria-label={`${m.title} 삭제`}
                  className="h-fit rounded p-1 text-muted hover:text-red-600"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
