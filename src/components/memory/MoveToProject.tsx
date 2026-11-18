"use client";

import { useState } from "react";
import { FolderInput } from "lucide-react";
import { desktop, errorMessage } from "@/lib/desktop";
import { projectRoot } from "@/lib/ssh-core";
import { useStoredState } from "@/lib/storage";
import { useProjects } from "@/lib/store";

/**
 * 공통 메모리의 한 줄을 "프로젝트 메모리"(그 프로젝트 폴더의 CLAUDE.md)로 옮긴다.
 * 프로젝트에만 해당하는 내용이 공통 메모리에 섞여 들어갔을 때 정리하는 용도. 이 PC에 폴더가 연결된 프로젝트만 고를 수 있다.
 * 옮기기에 성공하면 onMoved로 부모가 공통 메모리에서 그 줄을 지운다 (삭제 기록이 남아 다른 PC에서도 사라진다).
 */
export function MoveToProject({ line, label, onMoved }: { line: string; label: string; onMoved: () => void }) {
  const { projects } = useProjects();
  const [device] = useStoredState<{ id: string } | null>("device", null);
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const local = projects.filter((p) => p.location?.path && p.location.deviceId === device?.id);

  async function move() {
    const target = local.find((p) => p.id === projectId);
    if (!target?.location) return;
    setBusy(true);
    setError(null);
    try {
      await desktop.projectMemoryAdd(projectRoot(target.location), [line]);
      setOpen(false);
      onMoved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => {
          setOpen(true);
          setProjectId(local[0]?.id ?? "");
        }}
        aria-label={`${label} 프로젝트로 옮기기`}
        title="이 프로젝트에만 해당하는 내용이면 그 프로젝트의 메모리(CLAUDE.md)로 옮깁니다"
        data-testid="memory-move"
        className="inline-flex h-fit shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-background hover:text-foreground"
      >
        <FolderInput className="size-3" aria-hidden />
        프로젝트로
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="memory-move-form">
      {local.length === 0 ? (
        <span className="text-muted">이 PC에 연결된 프로젝트가 없습니다.</span>
      ) : (
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="옮길 프로젝트"
          data-testid="memory-move-project"
          className="rounded border border-border bg-background px-1.5 py-0.5"
        >
          {local.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      {local.length > 0 && (
        <button onClick={() => void move()} disabled={busy || !projectId} data-testid="memory-move-confirm" className="rounded bg-accent px-2 py-0.5 text-white disabled:opacity-50 dark:text-zinc-950">
          {busy ? "옮기는 중…" : "옮기기"}
        </button>
      )}
      <button onClick={() => setOpen(false)} className="rounded px-1.5 py-0.5 text-muted hover:text-foreground">
        취소
      </button>
      {error && <span className="basis-full text-red-600">{error}</span>}
    </div>
  );
}
