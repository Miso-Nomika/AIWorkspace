"use client";

import { useState } from "react";
import { ArrowUpFromLine, GitCommitHorizontal, Loader2, Undo2 } from "lucide-react";
import { confirmAction } from "@/lib/confirm";
import { desktop, errorMessage, type GitStatus } from "@/lib/desktop";
import { statusLabel } from "@/lib/git-status";
import type { useAsync } from "@/lib/use-async";

interface Props {
  git: ReturnType<typeof useAsync<GitStatus>>;
  root: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** 커밋·푸시가 끝나 Git 상태를 다시 읽어야 할 때 */
  onChanged: () => void;
  /** 선택한 파일을 되돌렸다 (열려 있던 파일을 닫기 위해) */
  onReverted?: (paths: string[]) => void;
}

/**
 * Git 기준으로 바뀐 파일 목록 (Claude Code가 고친 파일을 한눈에) + 커밋·푸시.
 * 파일을 누르면 변경 내용을 보여 주고, 체크한 파일만 한 커밋으로 만들거나 마지막 커밋 상태로 되돌린다. 커밋·푸시·되돌리기는 버튼을 눌렀을 때만 실행한다.
 */
export function ChangesPanel({ git, root, selectedPath, onSelect, onChanged, onReverted }: Props) {
  // 체크 해제한 파일 (새로 생긴 파일은 기본으로 체크됨)
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"commit" | "push" | "revert" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  if (git.status === "loading" || git.status === "idle") return <p className="p-2 text-sm text-muted">변경 내용을 확인하는 중…</p>;
  if (git.status === "error") return <p className="p-2 text-sm text-red-600">{errorMessage(git.error)}</p>;
  if (!git.data.isRepo) return <p className="p-2 text-sm text-muted">Git 저장소가 아니라 변경 목록을 볼 수 없습니다.</p>;

  const { changes, branch, upstream, ahead, behind } = git.data;
  const chosen = changes.filter((c) => !excluded.has(c.path)).map((c) => c.path);
  const canCommit = !busy && chosen.length > 0 && message.trim().length > 0;
  const canPush = !busy && !!branch && (!upstream || ahead > 0);

  function toggle(path: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  async function run(kind: "commit" | "push") {
    setBusy(kind);
    setResult(null);
    try {
      const text = kind === "commit" ? await desktop.gitCommit(root, chosen, message) : await desktop.gitPush(root);
      if (kind === "commit") {
        setMessage("");
        setExcluded(new Set());
      }
      setResult({ ok: true, text });
    } catch (error) {
      setResult({ ok: false, text: errorMessage(error) });
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  /** 체크한 파일을 마지막 커밋 상태로 되돌린다. 새 파일은 삭제되므로 확인 창에서 무엇이 어떻게 되는지 먼저 알린다 */
  async function revert() {
    const picked = changes.filter((c) => !excluded.has(c.path));
    const added = picked.filter((c) => c.status === "??" || c.status.startsWith("A")).length;
    const lines = [`선택한 ${picked.length}개 파일의 변경을 마지막 커밋 상태로 되돌립니다.`];
    if (picked.length - added > 0) lines.push(`- 수정·삭제·이름 변경 ${picked.length - added}개: 마지막 커밋의 내용으로 복원됩니다. 고친 내용은 사라집니다.`);
    if (added > 0) lines.push(`- 새 파일 ${added}개: 삭제됩니다 (휴지통 없음).`);
    lines.push("", "되돌릴 수 없습니다. 계속할까요?");
    if (!(await confirmAction(lines.join("\n")))) return;
    setBusy("revert");
    setResult(null);
    try {
      const report = await desktop.gitRevert(root, chosen);
      const parts = [`되돌렸습니다: 복원 ${report.restored}개 · 삭제 ${report.removed}개`];
      for (const s of report.skipped) parts.push(`건너뜀: ${s.path} (${s.reason})`);
      setResult({ ok: report.skipped.length === 0, text: parts.join("\n") });
      setExcluded(new Set());
      onReverted?.(chosen);
    } catch (error) {
      setResult({ ok: false, text: errorMessage(error) });
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {changes.length === 0 ? (
        <p className="p-2 text-sm text-muted">바뀐 파일이 없습니다. (마지막 커밋과 같음)</p>
      ) : (
        <ul className="text-sm" data-testid="changes-list">
          {changes.map((c) => {
            const info = statusLabel(c.status);
            return (
              <li key={c.path} className="flex items-center">
                <input
                  type="checkbox"
                  checked={!excluded.has(c.path)}
                  onChange={() => toggle(c.path)}
                  disabled={!!busy}
                  aria-label={`${c.path} 커밋에 포함`}
                  data-testid="change-check"
                  className="mx-1.5 shrink-0"
                />
                <button
                  onClick={() => onSelect(c.path)}
                  title={c.path}
                  aria-current={selectedPath === c.path ? "true" : undefined}
                  className={`flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-background ${selectedPath === c.path ? "bg-accent-soft" : ""}`}
                >
                  <span className={`w-12 shrink-0 text-xs ${info.className}`}>{info.label}</span>
                  <span className="truncate">{c.path}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-col gap-1.5 border-t border-border p-2 text-xs">
        {changes.length > 0 && (
          <>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              placeholder="커밋 메시지 (무엇을 바꿨는지)"
              aria-label="커밋 메시지"
              data-testid="commit-message"
              disabled={!!busy}
              className="resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-accent disabled:opacity-50"
            />
            <button
              onClick={() => run("commit")}
              disabled={!canCommit}
              data-testid="commit-button"
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40 dark:text-zinc-950"
            >
              {busy === "commit" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <GitCommitHorizontal className="size-3.5" aria-hidden />}
              {chosen.length}개 파일 커밋
            </button>
            <button
              onClick={() => void revert()}
              disabled={!!busy || chosen.length === 0}
              data-testid="revert-button"
              title="체크한 파일을 마지막 커밋 상태로 되돌립니다 (새 파일은 삭제, 되돌릴 수 없음)"
              className="inline-flex items-center justify-center gap-1.5 rounded-md border border-red-300 px-3 py-1.5 text-red-700 hover:bg-red-50 disabled:opacity-40 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
            >
              {busy === "revert" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Undo2 className="size-3.5" aria-hidden />}
              {chosen.length}개 파일 되돌리기
            </button>
          </>
        )}
        <button
          onClick={() => run("push")}
          disabled={!canPush}
          data-testid="push-button"
          title={upstream ? `${upstream}에 올립니다` : "원격 저장소(origin)에 이 브랜치를 새로 올립니다"}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 hover:bg-background disabled:opacity-40"
        >
          {busy === "push" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ArrowUpFromLine className="size-3.5" aria-hidden />}
          {upstream ? (ahead > 0 ? `푸시 — 커밋 ${ahead}개를 ${upstream}에` : "푸시할 커밋 없음") : `푸시 — ${branch ?? "현재 브랜치"}를 origin에 새로`}
        </button>
        {behind > 0 && <p className="text-amber-700 dark:text-amber-400">원격에 내려받지 않은 커밋이 {behind}개 있습니다. 푸시가 거절되면 먼저 가져와야 합니다.</p>}
        {result && (
          <pre
            data-testid="git-result"
            className={`max-h-32 overflow-auto whitespace-pre-wrap rounded-md px-2 py-1.5 font-mono ${result.ok ? "bg-accent-soft text-foreground" : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"}`}
          >
            {result.text}
          </pre>
        )}
      </div>
    </div>
  );
}
