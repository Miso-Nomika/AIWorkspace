"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUp, Folder, FolderPlus, Loader2, TriangleAlert } from "lucide-react";
import { desktop, errorMessage } from "@/lib/desktop";
import { remoteBaseName, remoteJoin, remoteParent } from "@/lib/ssh-core";

/** 원격 PC의 폴더를 앱 안에서 고른다 (홈에서 시작). 고른 폴더(현재 위치)는 onPick으로 알린다 */
export function RemoteFolderPicker({ hostId, onPick, picked }: { hostId: string; onPick: (path: string) => void; picked: string | null }) {
  const [path, setPath] = useState<string | null>(null); // 현재 위치 (처음엔 홈)
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null); // 새 폴더 이름 입력 중이면 그 값

  const load = useCallback(
    async (target?: string) => {
      setLoading(true);
      setError(null);
      try {
        const listing = await desktop.sshListDir(hostId, target);
        setPath(listing.path);
        setDirs(listing.dirs);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [hostId],
  );

  useEffect(() => {
    // 접속이 바뀌면 그 PC의 홈에서 다시 시작한다
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(undefined);
  }, [load]);

  async function makeDir() {
    if (!path || creating === null) return;
    const name = creating.trim();
    if (!name) return setCreating(null);
    try {
      const created = await desktop.sshMakeDir(hostId, path, name);
      setCreating(null);
      await load(created);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-background p-2" data-testid="remote-folder-picker">
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => path && load(remoteParent(path))} disabled={!path || path === "/" || loading} aria-label="상위 폴더" title="상위 폴더" className="rounded p-1.5 text-muted hover:text-foreground disabled:opacity-40" data-testid="remote-up">
          <ArrowUp className="size-4" />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path ?? ""} data-testid="remote-path">
          {path ?? "…"}
        </span>
        <button type="button" onClick={() => setCreating("")} disabled={!path || loading} aria-label="새 폴더" title="이 위치에 새 폴더 만들기" className="rounded p-1.5 text-muted hover:text-foreground disabled:opacity-40" data-testid="remote-new-folder">
          <FolderPlus className="size-4" />
        </button>
      </div>

      {creating !== null && (
        <div className="flex gap-2">
          <input
            autoFocus
            value={creating}
            onChange={(e) => setCreating(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void makeDir();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setCreating(null);
              }
            }}
            placeholder="새 폴더 이름"
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 py-1 text-sm outline-none focus:border-accent"
            data-testid="remote-new-folder-input"
          />
          <button type="button" onClick={makeDir} className="shrink-0 text-xs text-accent hover:underline">
            만들기
          </button>
        </div>
      )}

      <ul className="max-h-48 overflow-y-auto rounded border border-border bg-surface" data-testid="remote-dirs">
        {loading ? (
          <li className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            불러오는 중…
          </li>
        ) : dirs.length === 0 ? (
          <li className="px-3 py-2 text-xs text-muted">하위 폴더가 없습니다.</li>
        ) : (
          dirs.map((dir) => (
            <li key={dir}>
              <button type="button" onDoubleClick={() => path && load(remoteJoin(path, dir))} onClick={() => path && load(remoteJoin(path, dir))} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-background" data-testid={`remote-dir-${dir}`}>
                <Folder className="size-4 shrink-0 text-accent" aria-hidden />
                <span className="truncate">{dir}</span>
              </button>
            </li>
          ))
        )}
      </ul>

      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-red-600">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{picked ? `선택한 폴더: ${picked}` : "프로젝트로 쓸 폴더 안으로 들어간 뒤 아래 버튼을 누르세요."}</span>
        <button type="button" onClick={() => path && onPick(path)} disabled={!path || path === "/" || loading} className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-surface disabled:opacity-40" data-testid="remote-pick">
          {path && path !== "/" ? `'${remoteBaseName(path)}' 폴더 선택` : "폴더 선택"}
        </button>
      </div>
    </div>
  );
}
