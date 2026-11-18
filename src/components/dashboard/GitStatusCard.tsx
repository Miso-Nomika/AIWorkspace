"use client";

import { useState } from "react";
import { GitBranch, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { desktop, errorMessage, type GitStatus } from "@/lib/desktop";
import { projectRoot } from "@/lib/ssh-core";
import { usePlatform } from "@/lib/platform";
import { useHydrated } from "@/lib/storage";
import { useProjects } from "@/lib/store";
import { statusLabel } from "@/lib/git-status";
import { useAsync } from "@/lib/use-async";

const MAX_CHANGES = 8;

function GitView({ status }: { status: GitStatus }) {
  if (!status.isRepo) return <p className="text-sm text-muted">Git 저장소가 아닌 폴더입니다.</p>;
  const shown = status.changes.slice(0, MAX_CHANGES);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="font-mono font-medium">{status.branch ?? "(브랜치 없음)"}</span>
        {status.upstream ? (
          <span className="text-muted" title={status.upstream}>
            ↑{status.ahead} ↓{status.behind}
          </span>
        ) : (
          <span className="text-xs text-muted">원격 추적 없음</span>
        )}
        <span className="text-muted">변경 {status.changes.length}개</span>
      </div>
      {status.changes.length === 0 ? (
        <p className="mb-3 rounded-lg border border-border px-3 py-2 text-sm text-muted">변경 사항이 없습니다.</p>
      ) : (
        <ul className="mb-3 divide-y divide-border rounded-lg border border-border">
          {shown.map((c) => {
            const s = statusLabel(c.status);
            return (
              <li key={c.status + c.path} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className={`w-12 shrink-0 text-xs font-medium ${s.className}`}>{s.label}</span>
                <span className="truncate font-mono text-xs" title={c.path}>
                  {c.path}
                </span>
              </li>
            );
          })}
          {status.changes.length > MAX_CHANGES && (
            <li className="px-3 py-2 text-xs text-muted">외 {status.changes.length - MAX_CHANGES}개</li>
          )}
        </ul>
      )}
      {status.lastCommit && (
        <p className="truncate text-xs text-muted">
          최근 커밋 <span className="font-mono">{status.lastCommit.hash}</span> · {status.lastCommit.message} ·{" "}
          {status.lastCommit.relativeTime}
        </p>
      )}
    </>
  );
}

/** 이 PC 프로젝트 폴더의 실제 Git 상태 */
export function GitStatusCard({ className }: { className?: string }) {
  const hydrated = useHydrated();
  const platform = usePlatform();
  const { projects } = useProjects();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);

  const localProjects = projects.filter((p) => p.location && p.location.deviceId === platform.deviceId);
  const selected = localProjects.find((p) => p.id === selectedId) ?? localProjects[0];

  const key = selected?.location ? `git:${selected.id}:${refreshCount}` : null;
  const git = useAsync(key, () => desktop.gitStatus(projectRoot(selected!.location!)));

  const icon = <GitBranch className="size-4 text-accent" aria-hidden />;

  return (
    <Card
      title="Git 상태"
      icon={icon}
      className={className}
      action={
        selected && (
          <div className="flex items-center gap-1">
            <select
              value={selected.id}
              onChange={(e) => setSelectedId(e.target.value)}
              aria-label="Git 상태를 볼 프로젝트"
              className="max-w-40 truncate rounded border border-border bg-background px-1 py-0.5 text-xs"
            >
              {localProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => setRefreshCount((n) => n + 1)}
              aria-label="Git 상태 새로고침"
              className="rounded p-1 text-muted hover:text-foreground"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </div>
        )
      }
    >
      {!hydrated || (key && git.status === "loading") ? (
        <p className="text-sm text-muted">불러오는 중…</p>
      ) : !selected ? (
        <p className="text-sm text-muted">로컬 폴더에 연결된 프로젝트가 없습니다. 프로젝트를 만들면 Git 상태가 표시됩니다.</p>
      ) : git.status === "error" ? (
        <p className="text-sm text-red-600">{errorMessage(git.error)}</p>
      ) : git.status === "success" ? (
        <GitView status={git.data} />
      ) : null}
    </Card>
  );
}
