"use client";

import { Bot, CheckCircle2, Circle, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { useAgentStatuses } from "@/lib/agent-status";
import { AGENTS } from "@/lib/agents";

/** 이 PC의 에이전트 CLI 설치 상태 (현재 Claude Code) */
export function AgentsCard({ className }: { className?: string }) {
  const agents = useAgentStatuses();

  return (
    <Card
      title="Claude Code"
      icon={<Bot className="size-4 text-accent" aria-hidden />}
      className={className}
      action={
        <button
          onClick={agents.refresh}
          disabled={agents.loading}
          aria-label="에이전트 다시 확인"
          title="다시 확인"
          className="rounded p-1 text-muted hover:text-foreground disabled:opacity-40"
        >
          <RefreshCw className={`size-3.5 ${agents.loading ? "animate-spin" : ""}`} />
        </button>
      }
    >
      <ul className="flex flex-col gap-2">
        {AGENTS.map((a) => {
          const s = agents.find(a.id);
          const state = !s ? "checking" : s.installed ? "ready" : "missing";
          return (
            <li key={a.id} className="flex items-center gap-3 rounded-lg border border-border p-3" data-agent={a.id}>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{a.name}</div>
                <div className="truncate text-xs text-muted" title={s?.path ?? undefined}>
                  {s?.installed ? (s.version ?? "버전 확인 불가") : a.vendor}
                </div>
              </div>
              <span
                className={`inline-flex shrink-0 items-center gap-1 text-xs ${
                  state === "ready" ? "text-green-700 dark:text-green-400" : "text-muted"
                }`}
              >
                {state === "ready" ? <CheckCircle2 className="size-3.5" aria-hidden /> : <Circle className="size-3.5" aria-hidden />}
                {state === "ready" ? "연결됨" : state === "missing" ? "미설치" : "확인 중"}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
