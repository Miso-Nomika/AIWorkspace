"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, FileCode, FileText, FolderOpen, FolderPlus, Info, PanelLeftClose, PanelLeftOpen, PanelRightClose, RefreshCw, SquareTerminal } from "lucide-react";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { FileTree } from "@/components/explorer/FileTree";
import { FileViewer } from "@/components/explorer/FileViewer";
import { TreeOverlays, useTreeOps } from "@/components/explorer/tree-ops";
import { ChangesPanel } from "./ChangesPanel";
import { ResizeHandle } from "./ResizeHandle";
import { ResizeHandleY } from "./ResizeHandleY";
import { TerminalPanel } from "./TerminalPanel";
import { resolveBackend, type FileListing } from "@/lib/backend";
import { desktop, errorMessage, type GitStatus, type SheetBook } from "@/lib/desktop";
import { ConnectionBanner } from "@/components/remote/ConnectionBanner";
import { projectRoot } from "@/lib/ssh-core";
import { fileKind, isTextKind } from "@/lib/file-kind";
import {
  DEFAULT_RATIOS,
  PANE_MIN,
  RAIL_WIDTH,
  TERMINAL_MIN,
  TERMINAL_RATIO_DEFAULT,
  VIEWER_MIN,
  ratiosFromDrag,
  resolveLayout,
  resolvePaneWidths,
  resolveTerminalHeight,
  terminalRatioFromDrag,
  type PaneRatios,
} from "@/lib/pane-layout";
import { usePlatform } from "@/lib/platform";
import { routes } from "@/lib/routes";
import { useHydrated } from "@/lib/storage";
import { useProjects } from "@/lib/store";
import { parentDir, remapPath, withExpanded } from "@/lib/tree-paths";
import { useUiState } from "@/lib/ui-prefs";
import { useAsync } from "@/lib/use-async";

/** 이번 실행에서 표준 문서를 확인한 프로젝트 폴더 (프로젝트를 열 때마다 반복하지 않음) */
const docsChecked = new Set<string>();

/** 요소 너비(px). 창 크기·사이드바 접힘으로 바뀌면 다시 계산한다. */
function useElementWidth(el: HTMLElement | null) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return width;
}

/** 요소 높이(px). */
function useElementHeight(el: HTMLElement | null) {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return height;
}

// 탐색기 | 뷰어 | 채팅 3단. 경계선을 드래그해 너비를 조절하고(비율 저장), 탐색기·뷰어는 얇은 막대로 접어 채팅을 넓게 쓸 수 있다.
// active: 지금 화면에 보이는 프로젝트인지 (보이는 프로젝트만 폴더를 감시한다)
/** 프로젝트 화면 위쪽 바로가기 (루트의 표준 문서) */
const STANDARD_DOCS = [
  { id: "todo", label: "TODO", file: "TODO.md" },
  { id: "spec", label: "기능명세서", file: "기능명세서.md" },
];

export function ProjectWorkspace({ id, active = true }: { id: string; active?: boolean }) {
  const hydrated = useHydrated();
  const platform = usePlatform();
  const { projects, updateProject } = useProjects();
  const project = projects.find((p) => p.id === id);

  const [tab, setTab] = useState<"files" | "changes">("files");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["src"]));
  // 펼친 폴더가 바뀔 때마다 올린다: 펼친 폴더의 안쪽 목록을 그때 읽는다 (처음부터 전부 읽지 않는다)
  const [expandNonce, setExpandNonce] = useState(0);
  const changeExpanded = (change: (prev: Set<string>) => Set<string>) => {
    setExpanded(change);
    setExpandNonce((n) => n + 1);
  };
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  // 실시간 갱신용 버전: 올리면 이전 내용을 보여 주다가 조용히 다시 읽는다 (깜빡임 없음)
  const [treeVersion, setTreeVersion] = useState(0);
  const [fileVersion, setFileVersion] = useState(0);
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selectedPath;
  }, [selectedPath]);

  // 패널 너비: 드래그 중에는 화면에만 반영(draft)하고, 놓으면 비율을 저장한다
  const [panesEl, setPanesEl] = useState<HTMLDivElement | null>(null);
  const totalWidth = useElementWidth(panesEl);
  const { panes, setPanes, collapsed, setCollapsed, terminal, setTerminal } = useUiState();
  const [draft, setDraft] = useState<PaneRatios | null>(null);
  const ratios = draft ?? panes;
  const base = resolvePaneWidths(totalWidth, ratios);
  const layout = resolveLayout(totalWidth, ratios, collapsed);
  const measured = totalWidth > 0;
  const resizeTo = (pane: "files" | "chat", px: number) =>
    setDraft(ratiosFromDrag(totalWidth, { files: collapsed.files ? base.files : layout.files, chat: layout.chat }, pane, px));
  const commit = () => {
    if (draft) setPanes(draft);
    setDraft(null);
  };
  const filesStyle = measured ? { width: layout.files } : { width: `${ratios.files * 100}%` };
  const chatStyle = collapsed.code ? undefined : measured ? { width: layout.chat } : { width: `${ratios.chat * 100}%` };

  // 뷰어 아래 터미널 높이: 드래그 중에는 화면에만 반영(termDraft)하고, 놓으면 비율을 저장한다
  const [viewerEl, setViewerEl] = useState<HTMLDivElement | null>(null);
  const viewerAreaHeight = useElementHeight(viewerEl);
  const [termDraft, setTermDraft] = useState<number | null>(null);
  const termDraftRef = useRef<number | null>(null);
  const termRatio = termDraft ?? terminal.ratio;
  const termHeight = viewerAreaHeight > 0 ? resolveTerminalHeight(viewerAreaHeight, termRatio) : undefined;
  const resizeTerm = (px: number) => {
    const next = terminalRatioFromDrag(viewerAreaHeight, px);
    termDraftRef.current = next;
    setTermDraft(next);
  };
  const commitTerm = () => {
    if (termDraftRef.current !== null) setTerminal({ ratio: termDraftRef.current });
    termDraftRef.current = null;
    setTermDraft(null);
  };

  const resolution = useMemo(() => (project ? resolveBackend(project, platform) : null), [project, platform]);
  const backend = resolution?.backend ?? null;
  const localRoot = backend?.kind === "local" && project?.location ? projectRoot(project.location) : null; // 원격(SSH) 프로젝트는 ssh://… 형태
  const remoteHostId = project?.location?.remote?.hostId ?? null;

  const listingKey = backend && project ? `${backend.kind}:${project.id}` : null;
  const listing = useAsync<FileListing>(listingKey, () => backend!.listFiles(project!, [...expanded]), refreshCount + treeVersion + expandNonce);

  // Git 변경 목록: 파일이 바뀔 때마다(실시간 갱신) 함께 다시 읽는다
  const git = useAsync<GitStatus>(localRoot ? `git:${project?.id}` : null, () => desktop.gitStatus(localRoot!), refreshCount + treeVersion);
  const changes = git.status === "success" && git.data.isRepo ? git.data.changes : [];
  const hasChange = !!selectedPath && changes.some((c) => c.path === selectedPath);

  // 표준 문서(TODO.md, 기능명세서.md): 새 프로젝트·기존 프로젝트 모두 처음 열 때 없는 것만 만든다 (기존 문서는 그대로)
  useEffect(() => {
    if (!localRoot || docsChecked.has(localRoot)) return;
    docsChecked.add(localRoot);
    desktop
      .ensureProjectDocs(localRoot)
      .then((created) => {
        if (created.length) setRefreshCount((n) => n + 1);
      })
      .catch((error) => console.error("[docs] 표준 문서를 만들지 못했습니다", error));
  }, [localRoot]);

  // 실시간 갱신: 보고 있는 프로젝트 폴더를 감시해 트리와 열린 파일을 자동으로 다시 읽는다.
  // 감시를 시작하지 못하는 환경(Linux 감시 한도, Drive 마운트 폴더 등)에서는 5초마다 다시 읽고, 창으로 돌아올 때도 한 번 다시 읽는다.
  const liveRoot = active ? localRoot : null;
  useEffect(() => {
    if (!liveRoot) return;
    let disposed = false;
    let treeTimer: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let unlisten: (() => void) | null = null;
    const reloadTree = () => {
      if (treeTimer) return; // 짧은 시간에 몰린 변경은 한 번만
      treeTimer = setTimeout(() => {
        treeTimer = null;
        setTreeVersion((n) => n + 1);
      }, 300);
    };
    const reloadAll = () => {
      reloadTree();
      setFileVersion((n) => n + 1);
    };
    void (async () => {
      const off = await listen<{ root: string; paths: string[] }>("project-fs-changed", (event) => {
        if (event.payload.root !== liveRoot) return;
        reloadTree();
        const open = selectedRef.current;
        // 경로가 아주 많으면(상한) 열린 파일도 바뀌었을 수 있다고 본다
        if (open && (event.payload.paths.length >= 500 || event.payload.paths.includes(open))) setFileVersion((n) => n + 1);
      });
      if (disposed) return off();
      unlisten = off;
      const watching = await desktop.watchProject(liveRoot).catch(() => false);
      if (disposed) return;
      reloadAll(); // 다른 탭에 가 있는 동안 바뀐 것을 반영
      if (!watching) poll = setInterval(reloadAll, 5000);
    })();
    window.addEventListener("focus", reloadAll);
    return () => {
      disposed = true;
      if (treeTimer) clearTimeout(treeTimer);
      if (poll) clearInterval(poll);
      unlisten?.();
      window.removeEventListener("focus", reloadAll);
      void desktop.unwatchProject(liveRoot).catch(() => {});
    };
  }, [liveRoot]);

  // 형식에 따라 읽는 방식이 다르다: 텍스트 계열은 글자로, 이미지·PDF는 바이트로, 그 밖의 형식은 읽지 않는다 (뷰어가 안내만 보여 줌).
  // 변경 내용을 볼 때는 파일 자체를 읽지 않는다 (삭제된 파일도 변경 내용은 볼 수 있다).
  const kind = selectedPath ? fileKind(selectedPath) : null;
  const contentKey = listingKey && selectedPath && kind && isTextKind(kind) && !showDiff ? `${listingKey}:${selectedPath}` : null;
  const content = useAsync<string>(contentKey, () => backend!.readFile(project!, selectedPath!), refreshCount + fileVersion);
  const bytesKey = listingKey && selectedPath && (kind === "image" || kind === "pdf") && !showDiff ? `${listingKey}:bytes:${selectedPath}` : null;
  const bytes = useAsync<ArrayBuffer>(bytesKey, () => backend!.readFileBytes(project!, selectedPath!), refreshCount + fileVersion);
  const sheetKey = listingKey && selectedPath && kind === "sheet" && !showDiff ? `${listingKey}:sheet:${selectedPath}` : null;
  const sheet = useAsync<SheetBook>(sheetKey, () => backend!.readSheet(project!, selectedPath!), refreshCount + fileVersion);
  const diffKey = localRoot && showDiff && selectedPath ? `diff:${project?.id}:${selectedPath}` : null;
  const diff = useAsync<string>(diffKey, () => desktop.gitDiff(localRoot!, selectedPath!), refreshCount + fileVersion);

  // 파일 트리 조작: 새 파일·폴더 만들기, 트리 안에서 끌어 옮기기, 파일 관리자에서 끌어다 복사해 넣기
  const tree = useTreeOps({
    root: localRoot,
    enabled: active && !!localRoot && tab === "files" && !collapsed.files,
    expand: (dir) => changeExpanded((prev) => withExpanded(prev, dir)),
    onChanged: () => setRefreshCount((n) => n + 1),
    onOpenFile: (path) => {
      setSelectedPath(path);
      setShowDiff(false);
      if (collapsed.code) setCollapsed({ code: false });
    },
    onDeleted: (path) => {
      const inside = (p: string) => p === path || p.startsWith(`${path}/`);
      setSelectedPath((prev) => (prev && inside(prev) ? null : prev));
      changeExpanded((prev) => new Set([...prev].filter((p) => !inside(p))));
    },
    onMoved: (from, to) => {
      setSelectedPath((prev) => (prev ? remapPath(prev, from, to) : prev));
      changeExpanded((prev) => new Set([...prev].map((p) => remapPath(p, from, to))));
    },
  });

  if (!hydrated) return <p className="p-6 text-sm text-muted">불러오는 중…</p>;

  if (!project || !backend) {
    return (
      <div className="p-6 text-sm">
        <p className="mb-3">프로젝트를 찾을 수 없습니다.</p>
        <Link href={routes.home} className="text-accent underline">
          프로젝트 목록으로
        </Link>
      </div>
    );
  }

  /** 파일을 연다. 뷰어가 접혀 있으면 펼친다. diffMode: 변경 내용으로 연다 */
  const openFile = (path: string, diffMode: boolean) => {
    setSelectedPath(path);
    setShowDiff(diffMode);
    if (collapsed.code) setCollapsed({ code: false });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-3">
        <Link href={routes.home} aria-label="프로젝트 목록" className="rounded p-1 text-muted hover:text-foreground">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold">{project.name}</h1>
          <p className="truncate text-xs text-muted" title={project.location?.path}>
            {project.location?.remote ? `원격 · ${project.location.path}` : (project.location?.path ?? project.description)}
          </p>
        </div>
        {openError && <span className="text-xs text-red-600">{openError}</span>}
        {remoteHostId && <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted" data-testid="remote-badge">SSH</span>}
        {localRoot && (
          <div className="inline-flex items-center gap-1.5" data-testid="doc-shortcuts">
            {STANDARD_DOCS.map((doc) => {
              const exists = listing.status === "success" && listing.data.nodes.some((n) => n.type === "file" && n.name === doc.file);
              return (
                <button
                  key={doc.file}
                  onClick={() => openFile(doc.file, false)}
                  disabled={!exists}
                  title={exists ? `${doc.file} 열기` : `${doc.file} 파일이 없습니다`}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-background disabled:opacity-40"
                  data-testid={`open-doc-${doc.id}`}
                >
                  <FileText className="size-3.5" aria-hidden />
                  {doc.label}
                </button>
              );
            })}
          </div>
        )}
        {localRoot && !remoteHostId && (
          <button
            onClick={async () => {
              setOpenError(null);
              try {
                await desktop.openProjectFolder(localRoot);
              } catch (error) {
                setOpenError(errorMessage(error));
              }
            }}
            title="이 프로젝트 폴더를 파일 관리자(Windows 탐색기·Linux 파일 관리자)로 엽니다"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-background"
            data-testid="open-folder"
          >
            <FolderOpen className="size-3.5" aria-hidden />
            폴더 열기
          </button>
        )}
      </header>
      {remoteHostId && <ConnectionBanner hostId={remoteHostId} onReconnected={() => setRefreshCount((n) => n + 1)} />}

      <div ref={setPanesEl} className="flex min-h-0 flex-1" data-testid="workspace-panes">
        {collapsed.files ? (
          <Rail label="탐색기 펴기" icon={PanelLeftOpen} onExpand={() => setCollapsed({ files: false })} testId="rail-files" />
        ) : (
          <section className="flex shrink-0 flex-col bg-surface" style={filesStyle} data-testid="pane-files">
            <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
              <div role="tablist" aria-label="탐색기 보기" className="inline-flex rounded-md border border-border p-0.5 text-xs">
                <TabButton active={tab === "files"} onClick={() => setTab("files")} testId="tab-files">
                  파일
                </TabButton>
                <TabButton active={tab === "changes"} onClick={() => setTab("changes")} testId="tab-changes">
                  변경{changes.length > 0 ? ` ${changes.length}` : ""}
                </TabButton>
              </div>
              <div className="ml-auto flex items-center">
                {backend.kind === "local" && tab === "files" && (
                  <button
                    onClick={() => tree.startCreate(tree.activeDir, "dir")}
                    aria-label="새 폴더"
                    title="새 폴더 (선택한 폴더 안에 만듭니다)"
                    className="rounded p-1 text-muted hover:text-foreground"
                    data-testid="tree-new-folder"
                  >
                    <FolderPlus className="size-3.5" />
                  </button>
                )}
                {backend.kind === "local" && (
                  <button
                    onClick={() => setRefreshCount((n) => n + 1)}
                    aria-label="새로고침"
                    title="새로고침"
                    className="rounded p-1 text-muted hover:text-foreground"
                  >
                    <RefreshCw className="size-3.5" />
                  </button>
                )}
                <button
                  onClick={() => setCollapsed({ files: true })}
                  aria-label="탐색기 접기"
                  title="탐색기 접기"
                  className="rounded p-1 text-muted hover:text-foreground"
                  data-testid="collapse-files"
                >
                  <PanelLeftClose className="size-3.5" />
                </button>
              </div>
            </div>
            <TreeOverlays tree={tree} />
            <div
              className={`min-h-0 flex-1 overflow-y-auto p-2 ${tab === "files" && tree.ops.dropDir === "" ? "ring-2 ring-inset ring-accent" : ""}`}
              data-tree-dir={tab === "files" && localRoot ? "" : undefined}
              onContextMenu={tab === "files" && localRoot ? (event) => tree.ops.onContextMenu(event, "") : undefined}
              data-testid="tree-scroll"
            >
              {tab === "changes" ? (
                <ChangesPanel git={git} root={localRoot!} selectedPath={showDiff ? selectedPath : null} onSelect={(path) => openFile(path, true)} onChanged={() => setRefreshCount((n) => n + 1)} onReverted={(paths) => setSelectedPath((prev) => (prev && paths.some((p) => prev === p.replace(/\/$/, "") || prev.startsWith(p)) ? null : prev))} />
              ) : (
                <>
                  {listing.status === "loading" && <p className="p-2 text-sm text-muted">파일 목록을 불러오는 중…</p>}
                  {listing.status === "error" && <p className="p-2 text-sm text-red-600">{errorMessage(listing.error)}</p>}
                  {listing.status === "success" && listing.data.nodes.length === 0 && backend.kind !== "unavailable" && (
                    <p className="p-2 text-sm text-muted">빈 폴더입니다.</p>
                  )}
                  {listing.status === "success" && (
                    <FileTree
                      nodes={listing.data.nodes}
                      expanded={expanded}
                      total={listing.data.total}
                      selectedPath={showDiff ? null : selectedPath}
                      onToggle={(path) => {
                        tree.setActiveDir(path);
                        changeExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(path)) next.delete(path);
                          else next.add(path);
                          return next;
                        });
                      }}
                      onSelect={(path) => {
                        tree.setActiveDir(parentDir(path));
                        openFile(path, false);
                      }}
                      ops={localRoot ? tree.ops : undefined}
                    />
                  )}
                </>
              )}
            </div>
            <PlatformNotice
              notice={
                resolution?.notice ??
                (tab === "files" && listing.status === "success" && listing.data.truncated
                  ? "항목이 20만 개를 넘거나 12단계보다 깊은 곳은 일부만 표시합니다. (node_modules, .git 등은 항상 제외)"
                  : undefined)
              }
            />
          </section>
        )}

        {!collapsed.files && !collapsed.code && (
          <ResizeHandle
            label="탐색기 너비 조절"
            side="left"
            value={layout.files}
            min={PANE_MIN.files}
            max={totalWidth - PANE_MIN.code - layout.chat}
            onResize={(px) => resizeTo("files", px)}
            onCommit={commit}
            onReset={() => setPanes({ ...ratios, files: DEFAULT_RATIOS.files })}
          />
        )}

        {collapsed.code ? (
          <Rail label="뷰어 펴기" icon={FileCode} onExpand={() => setCollapsed({ code: false })} testId="rail-code" />
        ) : (
          <section className="flex min-w-0 flex-1 flex-col" data-testid="pane-code">
            <div ref={setViewerEl} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-hidden">
              <FileViewer
                path={selectedPath}
                content={content.status === "success" ? content.data : undefined}
                bytes={bytes.status === "success" ? bytes.data : undefined}
                sheet={sheet.status === "success" ? sheet.data : undefined}
                loading={content.status === "loading" || bytes.status === "loading" || sheet.status === "loading"}
                error={
                  content.status === "error"
                    ? errorMessage(content.error)
                    : bytes.status === "error"
                      ? errorMessage(bytes.error)
                      : sheet.status === "error"
                        ? errorMessage(sheet.error)
                        : undefined
                }
                diff={
                  localRoot
                    ? {
                        active: showDiff,
                        hasChange,
                        text: diff.status === "success" ? diff.data : undefined,
                        loading: diff.status === "loading",
                        error: diff.status === "error" ? errorMessage(diff.error) : undefined,
                        onChange: setShowDiff,
                      }
                    : undefined
                }
                action={
                  <>
                    {localRoot && (
                      <button
                        onClick={() => setTerminal({ open: !terminal.open })}
                        aria-label={terminal.open ? "터미널 닫기" : "터미널 열기"}
                        aria-pressed={terminal.open}
                        title={terminal.open ? "터미널 닫기 (셸은 계속 실행됩니다)" : remoteHostId ? "뷰어 아래에 터미널 열기 (원격 폴더로 ssh 접속)" : "뷰어 아래에 이 프로젝트 폴더의 터미널 열기"}
                        className={`rounded p-1 hover:text-foreground ${terminal.open ? "bg-accent-soft text-accent" : "text-muted"}`}
                        data-testid="toggle-terminal"
                      >
                        <SquareTerminal className="size-3.5" />
                      </button>
                    )}
                    <button
                      onClick={() => setCollapsed({ code: true })}
                      aria-label="뷰어 접기"
                      title="뷰어 접기 (채팅을 넓게)"
                      className="rounded p-1 text-muted hover:text-foreground"
                      data-testid="collapse-code"
                    >
                      <PanelRightClose className="size-3.5" />
                    </button>
                  </>
                }
              />
              </div>
              {terminal.open && localRoot && project && (
                <>
                  <ResizeHandleY
                    label="뷰어와 터미널 높이 조절"
                    value={termHeight ?? 0}
                    min={TERMINAL_MIN}
                    max={Math.max(TERMINAL_MIN, viewerAreaHeight - VIEWER_MIN)}
                    onResize={resizeTerm}
                    onCommit={commitTerm}
                    onReset={() => setTerminal({ ratio: TERMINAL_RATIO_DEFAULT })}
                  />
                  <div className="shrink-0" style={{ height: termHeight }} data-testid="project-terminal-pane">
                    <TerminalPanel
                      sessionKey={`p-${project.id}`}
                      root={localRoot}
                      title="터미널"
                      ids={{ section: "project-terminal", host: "project-terminal-host", restart: "project-terminal-restart", error: "project-terminal-error" }}
                      autoFocus
                      bare
                    />
                  </div>
                </>
              )}
            </div>
          </section>
        )}

        {!collapsed.code && (
          <ResizeHandle
            label="채팅 너비 조절"
            side="right"
            value={layout.chat}
            min={PANE_MIN.chat}
            max={totalWidth - PANE_MIN.code - layout.files}
            onResize={(px) => resizeTo("chat", px)}
            onCommit={commit}
            onReset={() => setPanes({ ...ratios, chat: DEFAULT_RATIOS.chat })}
          />
        )}

        <section className={`flex flex-col bg-surface ${collapsed.code ? "min-w-0 flex-1" : "shrink-0"}`} style={chatStyle} data-testid="pane-chat">
          <ChatPanel
            project={project}
            backend={backend}
            onPermissionModeChange={(permissionMode) => updateProject(project.id, { permissionMode })}
            onAllowedToolsChange={(allowedTools) => updateProject(project.id, { allowedTools })}
            onModelsChange={(models) => updateProject(project.id, models)}
          />
        </section>
      </div>
    </div>
  );
}

/** 접힌 패널: 얇은 막대의 버튼을 누르면 다시 펼친다 */
function Rail({ label, icon: Icon, onExpand, testId }: { label: string; icon: typeof FileCode; onExpand: () => void; testId: string }) {
  return (
    <button
      onClick={onExpand}
      title={label}
      aria-label={label}
      data-testid={testId}
      style={{ width: RAIL_WIDTH }}
      className="flex shrink-0 flex-col items-center border-r border-border bg-surface py-2.5 text-muted hover:bg-background hover:text-foreground"
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

function TabButton({ active, onClick, testId, children }: { active: boolean; onClick: () => void; testId: string; children: React.ReactNode }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      data-testid={testId}
      className={`rounded px-2 py-0.5 ${active ? "bg-accent text-white dark:text-zinc-950" : "text-muted hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}

/** 실행할 수 없는 이유나 주의 사항 안내 */
function PlatformNotice({ notice }: { notice?: string }) {
  if (!notice) return null;
  return (
    <p className="flex gap-1.5 border-t border-border px-4 py-2 text-xs text-muted">
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {notice}
    </p>
  );
}
