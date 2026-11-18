"use client";

import { AgentsCard } from "./AgentsCard";
import { GitStatusCard } from "./GitStatusCard";
import { PageHeader } from "@/components/ui/PageHeader";
import { useHydrated } from "@/lib/storage";
import { useMemories, useProjects } from "@/lib/store";

export function Dashboard() {
  const hydrated = useHydrated();
  const { projects } = useProjects();
  const { memories } = useMemories();

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-8">
      <PageHeader title="대시보드" description="프로젝트 Git 상태와 Claude Code 상태를 한눈에 확인합니다." />

      <div className="mb-4 grid grid-cols-2 gap-3">
        <Stat label="프로젝트" value={hydrated ? projects.length : "–"} />
        <Stat label="메모리" value={hydrated ? memories.length : "–"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <GitStatusCard />
        <AgentsCard />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
