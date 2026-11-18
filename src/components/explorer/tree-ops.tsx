"use client";

// 파일 트리의 조작: 새 파일·폴더 만들기(우클릭 메뉴·상단 버튼), 이름 바꾸기(F2·우클릭 메뉴 R), 트리 안에서 끌어 옮기기, 파일 관리자에서 끌어다 복사해 넣기.
// 파일 트리 안의 끌기는 HTML5 끌어 놓기가 아니라 마우스 이벤트로 직접 구현한다 — Tauri의 파일 끌어 놓기(아래 onDragDropEvent)가
// Windows에서 웹의 HTML5 끌어 놓기 이벤트를 가로채기 때문이다.

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FilePlus, FolderPlus, Pencil, Trash2, X } from "lucide-react";
import { confirmAction } from "@/lib/confirm";
import { desktop } from "@/lib/desktop";
import { canDropInto, treeError } from "@/lib/tree-paths";

export type CreateKind = "file" | "dir";

/** 트리의 파일·폴더 하나 (프로젝트 기준 상대 경로) */
export interface TreeTarget {
  path: string;
  isFolder: boolean;
}

/** FileTree에 내려 주는 조작 모음 */
export interface TreeOps {
  /** 놓으면 들어갈 폴더 강조 ("" = 프로젝트 최상위) */
  dropDir: string | null;
  /** 지금 끌고 있는 항목 */
  dragging: string | null;
  /** 이름 입력 중인 새 항목 (parent 폴더 안) */
  creating: { parent: string; kind: CreateKind } | null;
  createError: string | null;
  /** 이름을 바꾸는 중인 항목의 경로 */
  renaming: string | null;
  renameError: string | null;
  commitRename: (name: string) => void;
  cancelRename: () => void;
  /** 행에서 누른 키: F2면 이름 바꾸기를 시작한다 (처리했으면 true) */
  onRowKeyDown: (event: ReactKeyboardEvent, path: string) => boolean;
  onRowPointerDown: (event: ReactPointerEvent, path: string) => void;
  /** target: 우클릭한 항목 (빈 곳이면 없음 — 삭제 메뉴는 항목이 있을 때만) */
  onContextMenu: (event: ReactMouseEvent, dir: string, target?: TreeTarget) => void;
  /** 끌기를 마친 직후의 클릭(열기·펼치기)이면 true — 무시해야 한다 */
  consumeClickSuppress: () => boolean;
  commitCreate: (name: string) => void;
  cancelCreate: () => void;
}

interface Options {
  root: string | null;
  /** 파일 관리자에서 끌어다 놓기·끌어 옮기기를 받을 수 있는 상태 (보이는 프로젝트의 파일 탭) */
  enabled: boolean;
  /** 폴더(와 그 상위 폴더)를 펼친다 */
  expand: (dir: string) => void;
  /** 디스크가 바뀌었으니 트리를 다시 읽는다 */
  onChanged: () => void;
  onOpenFile: (path: string) => void;
  /** 트리 안에서 from이 to로 옮겨졌다 (열린 파일·펼침 상태를 따라 옮기기 위해) */
  onMoved: (from: string, to: string) => void;
  /** path(파일 또는 폴더)가 영구 삭제되었다 (열린 파일·펼침 상태를 정리하기 위해) */
  onDeleted: (path: string) => void;
}

const DRAG_THRESHOLD = 5;

/** 이름 입력칸이 닫힌 뒤 그 행에 포커스를 돌려준다 (키보드로 계속 F2를 쓸 수 있게). 목록을 다시 읽는 중이면 행이 나타날 때까지 잠깐 기다린다 */
function focusRowSoon(path: string) {
  let tries = 0;
  const attempt = () => {
    const row = Array.from(document.querySelectorAll<HTMLElement>("[data-tree-path]")).find((el) => el.dataset.treePath === path);
    if (row) row.focus();
    else if (++tries < 20) setTimeout(attempt, 50);
  };
  setTimeout(attempt, 0);
}

/** 마우스 아래의 트리 폴더 ("" = 최상위). 트리 밖이면 null. x·y는 화면(CSS) 좌표 */
function dirAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-tree-dir]");
  return el ? (el.dataset.treeDir ?? "") : null;
}

export function useTreeOps(options: Options) {
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragPoint, setDragPoint] = useState<{ x: number; y: number } | null>(null);
  const [creating, setCreating] = useState<{ parent: string; kind: CreateKind } | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renamingRef = useRef<string | null>(null);
  useEffect(() => {
    renamingRef.current = renaming;
  }, [renaming]);
  const [menu, setMenu] = useState<{ x: number; y: number; dir: string; target?: TreeTarget } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 새 폴더 버튼이 만들 위치: 마지막으로 누른 폴더(또는 마지막으로 연 파일의 폴더) */
  const [activeDir, setActiveDir] = useState("");

  // 이벤트 처리기(window 리스너 등)가 항상 최신 값을 쓰도록
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const suppressClick = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 9000);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  // ── 새 파일·폴더 ──
  const startCreate = useCallback((dir: string, kind: CreateKind) => {
    setMenu(null);
    setCreateError(null);
    setActiveDir(dir);
    setCreating({ parent: dir, kind });
    if (dir) latest.current.expand(dir);
  }, []);
  const cancelCreate = useCallback(() => {
    setCreating(null);
    setCreateError(null);
  }, []);
  const commitCreate = useCallback(
    (name: string) => {
      const { root, expand, onChanged, onOpenFile } = latest.current;
      const target = creating;
      const trimmed = name.trim();
      if (!root || !target) return;
      if (!trimmed) return cancelCreate();
      desktop
        .createProjectEntry(root, target.parent, trimmed, target.kind)
        .then((path) => {
          setCreating(null);
          setCreateError(null);
          if (target.parent) expand(target.parent);
          onChanged();
          if (target.kind === "file") onOpenFile(path);
        })
        .catch((error) => setCreateError(treeError(error)));
    },
    [creating, cancelCreate],
  );

  // ── 이름 바꾸기 (F2 · 우클릭 메뉴의 "이름 변경(R)") ──
  const startRename = useCallback((path: string) => {
    if (!latest.current.root) return;
    setMenu(null);
    setCreating(null);
    setCreateError(null);
    setRenameError(null);
    setRenaming(path);
  }, []);
  const cancelRename = useCallback(() => {
    // 포커스를 잃어서 닫힌 경우(다른 곳을 눌렀을 때)에는 포커스를 가져오지 않고, Esc·Enter로 닫힌 경우에만 행으로 돌려준다
    if (document.activeElement instanceof HTMLInputElement && document.activeElement.dataset.testid === "tree-rename-input") {
      const row = renamingRef.current;
      if (row) focusRowSoon(row);
    }
    setRenaming(null);
    setRenameError(null);
  }, []);
  const commitRename = useCallback(
    (name: string) => {
      const { root, onMoved, onChanged } = latest.current;
      const path = renaming;
      const trimmed = name.trim();
      if (!root || !path) return;
      if (!trimmed || trimmed === (path.split("/").pop() ?? path)) return cancelRename(); // 비웠거나 그대로면 취소
      desktop
        .renameProjectEntry(root, path, trimmed)
        .then((to) => {
          setRenaming(null);
          setRenameError(null);
          onMoved(path, to); // 열린 파일·펼침 상태를 새 이름으로 따라가게 한다
          onChanged();
          focusRowSoon(to);
        })
        .catch((error) => setRenameError(treeError(error)));
    },
    [renaming, cancelRename],
  );
  const onRowKeyDown = useCallback(
    (event: ReactKeyboardEvent, path: string) => {
      if (event.key !== "F2" || event.nativeEvent.isComposing || !latest.current.root) return false;
      event.preventDefault();
      startRename(path);
      return true;
    },
    [startRename],
  );

  // ── 우클릭 메뉴 ──
  const onContextMenu = useCallback((event: ReactMouseEvent, dir: string, target?: TreeTarget) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, dir, target });
  }, []);

  // ── 영구 삭제 (휴지통 없음) ──
  const deleteEntry = useCallback(
    async (target: TreeTarget) => {
      setMenu(null);
      const { root, onChanged, onDeleted } = latest.current;
      if (!root) return;
      const name = target.path.split("/").pop() ?? target.path;
      const what = target.isFolder ? `'${name}' 폴더와 그 안의 모든 파일을` : `'${name}' 파일을`;
      const message = `${what} 영구 삭제할까요?\n\n휴지통에 들어가지 않으며 되돌릴 수 없습니다. (Git 저장소라면 마지막 커밋에 있던 파일은 '변경' 탭에서 되돌릴 수 있습니다.)`;
      if (!(await confirmAction(message))) return;
      try {
        const count = await desktop.deleteProjectEntry(root, target.path);
        onDeleted(target.path);
        onChanged();
        showNotice(`삭제했습니다: ${name}${target.isFolder ? ` (항목 ${count}개)` : ""}`);
      } catch (error) {
        showNotice(`삭제하지 못했습니다: ${treeError(error)}`);
      }
    },
    [showNotice],
  );
  useEffect(() => {
    if (!menu) return;
    // 메뉴가 열려 있을 때 R(한글 자판에서도 같은 자리의 키)을 누르면 이름 변경
    const accelerator = (event: KeyboardEvent) => {
      if (!menu.target || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.code === "KeyR" || event.key.toLowerCase() === "r") {
        event.preventDefault();
        startRename(menu.target.path);
      }
    };
    window.addEventListener("keydown", accelerator);
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event.type === "pointerdown" && (event.target as HTMLElement | null)?.closest("[data-tree-menu]")) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", accelerator);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu, startRename]);

  // ── 트리 안에서 끌어 옮기기 (마우스 이벤트) ──
  const onRowPointerDown = useCallback(
    (event: ReactPointerEvent, path: string) => {
      if (event.button !== 0 || event.pointerType === "touch" || !latest.current.root || !latest.current.enabled) return;
      const start = { x: event.clientX, y: event.clientY };
      let active = false;
      let target: string | null = null;
      const previousSelect = document.body.style.userSelect;

      const move = (e: PointerEvent) => {
        if (!active) {
          if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD) return;
          active = true;
          setDragging(path);
          document.body.style.userSelect = "none";
        }
        const dir = dirAt(e.clientX, e.clientY);
        target = dir !== null && canDropInto(path, dir) ? dir : null;
        setDropDir(target);
        setDragPoint({ x: e.clientX, y: e.clientY });
      };
      const finish = (drop: boolean) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("keydown", key);
        document.body.style.userSelect = previousSelect;
        if (!active) return;
        // 끌기를 마친 직후에 따라오는 클릭은 무시한다 (파일이 열리거나 폴더가 접히지 않게)
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 0);
        setDragging(null);
        setDropDir(null);
        setDragPoint(null);
        const { root, expand, onChanged, onMoved } = latest.current;
        if (!drop || target === null || !root) return;
        const dir = target;
        desktop
          .moveProjectEntry(root, path, dir)
          .then((to) => {
            if (dir) expand(dir);
            onMoved(path, to);
            onChanged();
          })
          .catch((error) => showNotice(`옮기지 못했습니다: ${treeError(error)}`));
      };
      const up = () => finish(true);
      const key = (e: KeyboardEvent) => {
        if (e.key === "Escape") finish(false);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("keydown", key);
    },
    [showNotice],
  );

  // ── 파일 관리자에서 끌어다 놓기: 놓은 폴더로 복사 (원본은 그대로) ──
  const { root, enabled } = options;
  useEffect(() => {
    if (!root || !enabled) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const importDropped = async (dir: string, paths: string[]) => {
      try {
        const result = await desktop.importIntoProject(root, dir, paths);
        if (dir) latest.current.expand(dir);
        latest.current.onChanged();
        const skipped = result.skipped;
        const detail = skipped
          .slice(0, 3)
          .map((s) => `${s.name}(${s.reason})`)
          .join(", ");
        showNotice(
          `${result.copied.length}개를 복사했습니다.${skipped.length ? ` ${skipped.length}개는 건너뛰었습니다: ${detail}${skipped.length > 3 ? " …" : ""}` : ""}`,
        );
      } catch (error) {
        showNotice(`복사하지 못했습니다: ${treeError(error)}`);
      }
    };
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "leave") return setDropDir(null);
        // 위치는 물리 픽셀 → 화면(CSS) 픽셀로 바꿔 트리 행을 찾는다
        const ratio = window.devicePixelRatio || 1;
        const dir = dirAt(payload.position.x / ratio, payload.position.y / ratio);
        if (payload.type === "drop") {
          setDropDir(null);
          if (dir !== null && payload.paths.length > 0) void importDropped(dir, payload.paths);
        } else {
          setDropDir(dir);
        }
      })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
      setDropDir(null);
    };
  }, [root, enabled, showNotice]);

  const ops: TreeOps = {
    dropDir,
    dragging,
    creating,
    createError,
    renaming,
    renameError,
    commitRename,
    cancelRename,
    onRowKeyDown,
    onRowPointerDown,
    onContextMenu,
    consumeClickSuppress: () => suppressClick.current,
    commitCreate,
    cancelCreate,
  };
  return {
    ops,
    activeDir,
    setActiveDir,
    startCreate,
    startRename,
    deleteEntry,
    menu,
    closeMenu: () => setMenu(null),
    notice,
    dismissNotice: () => setNotice(null),
    dragging,
    dragPoint,
  };
}

type TreeOpsState = ReturnType<typeof useTreeOps>;

/** 우클릭 메뉴·끌기 표시·안내 메시지 (화면 맨 위에 겹쳐 그린다) */
export function TreeOverlays({ tree }: { tree: TreeOpsState }) {
  const { menu, notice, dragging, dragPoint } = tree;
  return (
    <>
      {notice && (
        <div className="mx-2 mb-1 flex items-start gap-2 rounded border border-border bg-background px-2 py-1.5 text-xs" role="status" data-testid="tree-notice">
          <span className="min-w-0 flex-1 break-words">{notice}</span>
          <button onClick={tree.dismissNotice} aria-label="안내 닫기" className="shrink-0 text-muted hover:text-foreground">
            <X className="size-3.5" />
          </button>
        </div>
      )}
      {menu && (
        <ul
          data-tree-menu
          role="menu"
          data-testid="tree-menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 168), top: Math.min(menu.y, window.innerHeight - (menu.target ? 170 : 90)) }}
          className="fixed z-50 w-40 rounded-lg border border-border bg-surface p-1 text-sm shadow-lg"
        >
          <li role="none">
            <button role="menuitem" onClick={() => tree.startCreate(menu.dir, "file")} data-testid="tree-menu-new-file" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-background">
              <FilePlus className="size-4 text-muted" aria-hidden />새 파일
            </button>
          </li>
          <li role="none">
            <button role="menuitem" onClick={() => tree.startCreate(menu.dir, "dir")} data-testid="tree-menu-new-folder" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-background">
              <FolderPlus className="size-4 text-muted" aria-hidden />새 폴더
            </button>
          </li>
          {menu.target && (
            <li role="none" className="mt-1 border-t border-border pt-1">
              <button role="menuitem" onClick={() => tree.startRename((menu.target as TreeTarget).path)} data-testid="tree-menu-rename" aria-keyshortcuts="R" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-background">
                <Pencil className="size-4 text-muted" aria-hidden />이름 변경(R)
              </button>
            </li>
          )}
          {menu.target && (
            <li role="none">
              <button role="menuitem" onClick={() => void tree.deleteEntry(menu.target as TreeTarget)} data-testid="tree-menu-delete" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-red-600 hover:bg-background">
                <Trash2 className="size-4" aria-hidden />삭제
              </button>
            </li>
          )}
        </ul>
      )}
      {dragging && dragPoint && (
        <div style={{ left: dragPoint.x + 12, top: dragPoint.y + 12 }} className="pointer-events-none fixed z-50 max-w-60 truncate rounded border border-accent bg-surface px-2 py-0.5 text-xs shadow" data-testid="tree-drag-label">
          {dragging.split("/").pop()}
        </div>
      )}
    </>
  );
}
