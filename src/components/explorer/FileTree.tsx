"use client";

import { useState } from "react";
import { ChevronRight, File, FilePlus, Folder, FolderOpen, FolderPlus } from "lucide-react";
import type { TreeOps } from "./tree-ops";
import type { FileNode } from "@/lib/types";
import { TREE_MAX } from "@/lib/tree-paths";

interface Props {
  nodes: FileNode[];
  expanded: Set<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string, node: FileNode) => void;
  /** 이 목록 폴더의 전체 항목 수 (nodes보다 크면 끝에 "일부만 보여 줍니다" 안내 줄을 보인다) */
  total?: number;
  /** 우클릭 메뉴·끌어 옮기기·새로 만들기 (로컬 프로젝트에서만) */
  ops?: TreeOps;
  parentPath?: string;
  depth?: number;
}

// 폴더 먼저, 이름순
function sortNodes(nodes: FileNode[]) {
  return [...nodes].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1));
}

export function FileTree({ nodes, expanded, selectedPath, onToggle, onSelect, total, ops, parentPath = "", depth = 0 }: Props) {
  return (
    <ul role={depth === 0 ? "tree" : "group"} className="text-sm">
      {ops?.creating && ops.creating.parent === parentPath && (
        <CreateRow key="create" kind={ops.creating.kind} depth={depth} error={ops.createError} onCommit={ops.commitCreate} onCancel={ops.cancelCreate} />
      )}
      {sortNodes(nodes).map((node) => {
        const path = parentPath ? `${parentPath}/${node.name}` : node.name;
        const isFolder = node.type === "folder";
        const isOpen = expanded.has(path);
        const isSelected = selectedPath === path;
        const isDropTarget = isFolder && ops?.dropDir === path;
        const isRenaming = !!ops && ops.renaming === path;
        return (
          <li key={path} role="treeitem" aria-expanded={isFolder ? isOpen : undefined} aria-selected={isSelected}>
            {isRenaming && ops ? (
              <RenameRow name={node.name} isFolder={isFolder} depth={depth} error={ops.renameError} onCommit={ops.commitRename} onCancel={ops.cancelRename} />
            ) : (
            <button
              type="button"
              onClick={() => {
                if (ops?.consumeClickSuppress()) return;
                if (isFolder) onToggle(path);
                else onSelect(path, node);
              }}
              onPointerDown={ops ? (event) => ops.onRowPointerDown(event, path) : undefined}
              onKeyDown={ops ? (event) => void ops.onRowKeyDown(event, path) : undefined}
              onContextMenu={ops ? (event) => ops.onContextMenu(event, isFolder ? path : parentPath, { path, isFolder }) : undefined}
              data-tree-dir={ops ? (isFolder ? path : parentPath) : undefined}
              data-tree-path={path}
              data-drop-target={isDropTarget || undefined}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              className={`flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left ${
                isDropTarget ? "bg-accent-soft ring-1 ring-accent" : isSelected ? "bg-accent-soft text-accent" : "hover:bg-background"
              } ${ops?.dragging === path ? "opacity-40" : ""}`}
            >
              {isFolder ? (
                <>
                  <ChevronRight className={`size-3.5 shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden />
                  {isOpen ? (
                    <FolderOpen className="size-4 shrink-0 text-accent" aria-hidden />
                  ) : (
                    <Folder className="size-4 shrink-0 text-accent" aria-hidden />
                  )}
                </>
              ) : (
                <File className="ml-5 size-4 shrink-0 text-muted" aria-hidden />
              )}
              <span className="truncate">{node.name}</span>
            </button>
            )}
            {isFolder && isOpen && !node.children && ops && (
              <p style={{ paddingLeft: `${(depth + 1) * 12 + 28}px` }} className="py-1 text-xs text-muted" data-testid="tree-loading">
                불러오는 중…
              </p>
            )}
            {isFolder && isOpen && node.children && (
              <FileTree
                nodes={node.children}
                expanded={expanded}
                selectedPath={selectedPath}
                onToggle={onToggle}
                onSelect={onSelect}
                total={node.total}
                ops={ops}
                parentPath={path}
                depth={depth + 1}
              />
            )}
          </li>
        );
      })}
      {total !== undefined && total > nodes.length && <LimitRow dir={parentPath} shown={nodes.length} total={total} depth={depth} />}
    </ul>
  );
}

/** 폴더의 항목이 한 폴더에서 보여 주는 최대 수(50,000개)를 넘을 때 끝에 나오는 안내 줄: 이름순 앞부분만 보이고 있다는 것을 알린다 */
function LimitRow({ dir, shown, total, depth }: { dir: string; shown: number; total: number; depth: number }) {
  return (
    <li role="none" data-tree-more={dir} data-testid="tree-more">
      <div style={{ paddingLeft: `${depth * 12 + 28}px` }} className="py-1 pr-2 text-xs text-muted" data-testid="tree-more-text">
        항목 {total.toLocaleString()}개 중 이름순 앞 {shown.toLocaleString()}개만 보여 줍니다 (한 폴더에서 {TREE_MAX.toLocaleString()}개까지)
      </div>
    </li>
  );
}

/** 이름 바꾸기 입력 줄. 열리면 이름이 선택되어 있다(파일은 확장자를 뺀 부분만). Enter로 바꾸고 Esc·포커스를 잃으면 취소한다 (한글 입력 중의 Enter는 글자 확정이므로 무시) */
function RenameRow({ name, isFolder, depth, error, onCommit, onCancel }: { name: string; isFolder: boolean; depth: number; error: string | null; onCommit: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(name);
  const indent = `${depth * 12 + 8}px`;
  const Icon = isFolder ? Folder : File;
  return (
    <div>
      <div style={{ paddingLeft: indent }} className="flex items-center gap-1.5 py-1 pr-2">
        <Icon className={`size-4 shrink-0 text-accent ${isFolder ? "ml-5" : "ml-5"}`} aria-hidden />
        <input
          autoFocus
          value={value}
          onFocus={(e) => {
            const dot = isFolder ? -1 : name.lastIndexOf(".");
            e.currentTarget.setSelectionRange(0, dot > 0 ? dot : name.length);
          }}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit(value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          onBlur={onCancel}
          aria-label={`${name} 이름 변경`}
          data-testid="tree-rename-input"
          className="min-w-0 flex-1 rounded border border-accent bg-background px-1.5 py-0.5 text-sm outline-none"
        />
      </div>
      {error && (
        <p style={{ paddingLeft: indent }} className="pr-2 pb-1 text-xs break-words text-red-600" role="alert" data-testid="tree-rename-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** 새 파일·폴더 이름 입력 줄. Enter로 만들고 Esc·포커스를 잃으면 취소한다 (한글 입력 중의 Enter는 글자 확정이므로 무시) */
function CreateRow({ kind, depth, error, onCommit, onCancel }: { kind: "file" | "dir"; depth: number; error: string | null; onCommit: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const Icon = kind === "dir" ? FolderPlus : FilePlus;
  const indent = `${depth * 12 + 8}px`;
  return (
    <li role="none">
      <div style={{ paddingLeft: indent }} className="flex items-center gap-1.5 py-1 pr-2">
        <Icon className={`size-4 shrink-0 text-accent ${kind === "file" ? "ml-5" : ""}`} aria-hidden />
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit(name);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          onBlur={onCancel}
          placeholder={kind === "dir" ? "새 폴더 이름" : "새 파일 이름"}
          aria-label={kind === "dir" ? "새 폴더 이름" : "새 파일 이름"}
          data-testid="tree-create-input"
          className="min-w-0 flex-1 rounded border border-accent bg-background px-1.5 py-0.5 text-sm outline-none"
        />
      </div>
      {error && (
        <p style={{ paddingLeft: indent }} className="pr-2 pb-1 text-xs break-words text-red-600" role="alert" data-testid="tree-create-error">
          {error}
        </p>
      )}
    </li>
  );
}
