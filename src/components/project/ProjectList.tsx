"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, FolderGit2, Plus, Trash2 } from "lucide-react";
import { CreateProjectDialog } from "./CreateProjectDialog";
import { TerminalPanel } from "./TerminalPanel";
import { ResizeHandle } from "./ResizeHandle";
import { PageHeader } from "@/components/ui/PageHeader";
import { buttonPrimary } from "@/components/ui/styles";
import { getAgent } from "@/lib/agents";
import { confirmAction } from "@/lib/confirm";
import { HOME_LIST_MIN, HOME_LIST_RATIO_DEFAULT, HOME_TERMINAL_MIN, homeSplitFromDrag, resolveHomeList } from "@/lib/pane-layout";
import { usePlatform } from "@/lib/platform";
import { describeHost, remoteKey } from "@/lib/ssh-core";
import { useSshHosts } from "@/lib/ssh-hosts";
import { routes } from "@/lib/routes";
import { flushStorage, useHydrated } from "@/lib/storage";
import { useProjects } from "@/lib/store";
import type { Project } from "@/lib/types";
import { useUiState } from "@/lib/ui-prefs";

const normalizePath = (path: string) => path.replace(/[\\/]+$/, "").toLowerCase();

function locationLabel(p: Project, hostName: (id: string) => string | undefined) {
  const remote = p.location?.remote;
  return remote ? `${hostName(remote.hostId) ?? "원격 PC"} · ${p.location!.path}` : (p.location?.path ?? "");
}

function deleteMessage(p: Project) {
  return p.location
    ? `'${p.name}' 프로젝트 등록을 해제할까요?\n폴더와 파일은 삭제되지 않습니다.\n(${p.location.path})`
    : `'${p.name}' 프로젝트를 삭제할까요?`;
}

export function ProjectList() {
  const router = useRouter();
  const hydrated = useHydrated();
  const platform = usePlatform();
  const { projects, createProject, deleteProject } = useProjects();
  const { hosts } = useSshHosts();
  const hostName = (id: string) => {
    const h = hosts.find((x) => x.id === id);
    return h ? `${h.label} (${describeHost(h)})` : undefined;
  };
  const [dialogOpen, setDialogOpen] = useState(false);

  // 목록 | 터미널 비율: 구분선을 끌어 조절하고 이 PC에 저장한다
  const { homeSplit, setHomeSplit } = useUiState();
  const box = useRef<HTMLDivElement>(null);
  const [total, setTotal] = useState(0);
  const [draft, setDraft] = useState<number | null>(null);
  const draftRef = useRef<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setTotal(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const ratio = draft ?? homeSplit;
  const listWidth = total > 0 ? resolveHomeList(total, ratio) : undefined;
  const resizeTo = (px: number) => {
    const next = homeSplitFromDrag(total, px);
    draftRef.current = next;
    setDraft(next);
  };
  const commit = () => {
    if (draftRef.current !== null) setHomeSplit(draftRef.current);
    draftRef.current = null;
    setDraft(null);
  };

  const description = "프로젝트는 이 PC의 로컬 폴더에 연결됩니다. 다른 PC의 프로젝트는 그 PC에서 엽니다.";

  return (
    // 왼쪽: 프로젝트 목록, 오른쪽: 터미널 (고정 폭 목록 + 남는 폭 전부 터미널)
    <div ref={box} className="flex h-full min-h-0">
      <div
        className="shrink-0 overflow-y-auto p-4 md:p-6"
        style={listWidth !== undefined ? { width: listWidth } : { width: `${ratio * 100}%` }}
        data-testid="project-list-pane"
      >
      <PageHeader
        title="프로젝트"
        description={description}
        action={
          <button onClick={() => setDialogOpen(true)} className={buttonPrimary} data-testid="new-project">
            <Plus className="size-4" aria-hidden />새 프로젝트
          </button>
        }
      />

      {!hydrated ? (
        <p className="text-sm text-muted">불러오는 중…</p>
      ) : projects.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted">
          프로젝트가 없습니다. 새 프로젝트를 만들어 보세요.
        </div>
      ) : (
        <ul className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
          {projects.map((p) => (
            <li key={p.id} className="group relative rounded-xl border border-border bg-surface p-4 hover:border-accent">
              <Link href={routes.project(p.id)} className="flex flex-col gap-2 after:absolute after:inset-0">
                <span className="flex items-center gap-2 pr-6 font-medium">
                  <FolderGit2 className="size-4 shrink-0 text-accent" aria-hidden />
                  <span className="truncate">{p.name}</span>
                  {!p.location && (
                    <span className="shrink-0 rounded bg-background px-1.5 py-0.5 text-[11px] font-normal text-muted">폴더 미연결</span>
                  )}
                </span>
                <span className="line-clamp-2 min-h-10 text-sm text-muted">{p.description || "설명 없음"}</span>
                {p.location && (
                  <span className="truncate font-mono text-xs text-muted" title={locationLabel(p, hostName)}>
                    {locationLabel(p, hostName)}
                  </span>
                )}
                <span className="flex items-center justify-between text-xs text-muted">
                  <span className="inline-flex items-center gap-1">
                    <Bot className="size-3.5" aria-hidden />
                    {getAgent(p.agent).name}
                  </span>
                  <span>{p.createdAt.slice(0, 10)}</span>
                </span>
              </Link>
              <button
                onClick={async () => {
                  if (await confirmAction(deleteMessage(p))) deleteProject(p.id);
                }}
                aria-label={`${p.name} 삭제`}
                className="absolute top-3 right-3 z-10 rounded p-1 text-muted opacity-100 hover:text-red-600 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <CreateProjectDialog
        open={dialogOpen}
        platform={platform}
        onClose={() => setDialogOpen(false)}
        isPathRegistered={(path) =>
          projects.some((p) => p.location && !p.location.remote && normalizePath(p.location.path) === normalizePath(path))
        }
        isRemoteRegistered={(hostId, path) =>
          projects.some((p) => p.location?.remote && remoteKey(p.location.remote.hostId, p.location.path) === remoteKey(hostId, path))
        }
        onCreate={async (input) => {
          const project = createProject(input);
          setDialogOpen(false);
          await flushStorage(); // 폴더 접근 권한 확인이 projects.json을 기준으로 하므로 저장 완료 후 이동
          router.push(routes.project(project.id));
        }}
      />
      </div>
      <ResizeHandle
        label="프로젝트 목록과 터미널 너비 조절"
        side="left"
        value={listWidth ?? 0}
        min={HOME_LIST_MIN}
        max={Math.max(HOME_LIST_MIN, total - HOME_TERMINAL_MIN)}
        onResize={resizeTo}
        onCommit={commit}
        onReset={() => setHomeSplit(HOME_LIST_RATIO_DEFAULT)}
      />
      <div className="min-w-0 flex-1 p-4 pl-3 md:p-6 md:pl-3" data-testid="home-terminal-pane">
        <TerminalPanel sessionKey="home" root={null} title="터미널" ids={{ section: "home-terminal", host: "terminal-host", restart: "terminal-restart", error: "terminal-error" }} />
      </div>
    </div>
  );
}
