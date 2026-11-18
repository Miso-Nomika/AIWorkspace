"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, FolderOpen, RefreshCw, XCircle } from "lucide-react";
import { buttonGhost, buttonPrimary } from "@/components/ui/styles";
import { useAgentStatuses } from "@/lib/agent-status";
import { getAgent } from "@/lib/agents";
import { desktop } from "@/lib/desktop";
import { DEFAULT_SYNC, type SyncSettings } from "@/lib/memory-sync";
import { usePlatform } from "@/lib/platform";
import { getStored, setStored, useHydrated, useStoredState } from "@/lib/storage";
import type { Project } from "@/lib/types";
import { useTheme, type Theme } from "@/lib/ui-prefs";
import { useAsync } from "@/lib/use-async";

export interface SetupState {
  status: "open" | "done";
  completedAt?: string;
}

/** 첫 실행 설정을 다시 연다 (메모리 화면) */
export function openSetup() {
  setStored<SetupState>("setup", { status: "open" });
}

const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "시스템 설정" },
  { id: "light", label: "라이트" },
  { id: "dark", label: "다크" },
];

/**
 * 새 PC에서 처음 실행할 때 필요한 설정을 한 화면에서 끝낸다.
 * Claude Code 확인 → Google Drive 동기화 폴더(자동 감지) → 전역 메모리 연동 → 테마.
 * 동기화 폴더를 정하면 곧바로 다른 PC의 공통 메모리·테마를 받아온다. 프로젝트는 PC마다 따로 만든다.
 */
export function SetupDialog() {
  const platform = usePlatform();
  const hydrated = useHydrated();
  const [setup] = useStoredState<SetupState | null>("setup", null);

  // 처음 실행: 이미 쓰던 PC(동기화 폴더나 로컬 프로젝트가 있음)면 묻지 않고 완료로 기록한다
  useEffect(() => {
    if (!hydrated || setup) return;
    const sync = getStored<SyncSettings>("sync", DEFAULT_SYNC);
    const projects = getStored<Project[]>("projects", []);
    const used = !!sync.folder || projects.some((p) => p.location);
    setStored<SetupState>("setup", used ? { status: "done", completedAt: new Date().toISOString() } : { status: "open" });
  }, [hydrated, setup]);

  if (setup?.status !== "open") return null;
  return <SetupForm deviceName={platform.deviceName} />;
}

function SetupForm({ deviceName }: { deviceName: string | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const agents = useAgentStatuses();
  const { theme, setTheme } = useTheme();
  const current = getStored<SyncSettings>("sync", DEFAULT_SYNC);
  const candidates = useAsync("setup-drive-candidates", () => desktop.memorySyncCandidates());
  const [folder, setFolder] = useState<string | null>(current.folder);
  const [touchedFolder, setTouchedFolder] = useState(false);
  const [claudeGlobal, setClaudeGlobal] = useState<boolean | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const found = candidates.status === "success" ? candidates.data : [];
  // 고르기 전에는 처음 찾은 Google Drive 폴더를 제안한다
  const chosenFolder = touchedFolder ? folder : (folder ?? found[0] ?? null);
  const installed = (id: "claude-code") => !!agents.find(id)?.installed;
  // 전역 연동 기본값: Claude Code가 설치되어 있으면 켠다
  const claude = claudeGlobal ?? (current.claudeGlobal || installed("claude-code"));

  const close = (status: SetupState["status"]) => {
    setStored<SetupState>("setup", { status, completedAt: new Date().toISOString() });
  };
  const finish = () => {
    setStored<SyncSettings>("sync", { ...current, folder: chosenFolder, claudeGlobal: claude });
    close("done");
  };
  const pick = async () => {
    const picked = await desktop.pickFolder(chosenFolder ?? undefined);
    if (picked) {
      setFolder(picked);
      setTouchedFolder(true);
    }
  };

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        close("done");
      }}
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-2xl border border-border bg-surface p-0 text-foreground backdrop:bg-black/40"
      aria-label="시작 설정"
      data-testid="setup-dialog"
    >
      <div className="flex max-h-[85vh] flex-col">
        <header className="border-b border-border px-6 py-4">
          <h2 className="text-lg font-semibold">AIWorkspace 시작 설정</h2>
          <p className="text-sm text-muted">
            {deviceName ? `${deviceName} — ` : ""}이 PC에서 처음 실행합니다. 개인 취향(공통 메모리)과 테마는 다른 PC와 같게 맞추고, 프로젝트는 PC마다 따로 관리합니다.
          </p>
        </header>

        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-6 py-4 text-sm">
          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h3 className="font-medium">1. Claude Code</h3>
              <button onClick={agents.refresh} disabled={agents.loading} className="ml-auto inline-flex items-center gap-1 text-xs text-accent hover:underline disabled:opacity-40">
                <RefreshCw className={`size-3 ${agents.loading ? "animate-spin" : ""}`} aria-hidden />
                다시 확인
              </button>
            </div>
            <ul className="flex flex-col gap-1">
              {(["claude-code"] as const).map((id) => {
                const status = agents.find(id);
                return (
                  <li key={id} className="flex items-center gap-2 text-xs">
                    {status?.installed ? <CheckCircle2 className="size-4 text-green-600" aria-hidden /> : <XCircle className="size-4 text-muted" aria-hidden />}
                    <span className="font-medium">{getAgent(id).name}</span>
                    <span className="text-muted">{agents.loading && !status ? "확인 중…" : status?.installed ? (status.version ?? "설치됨") : "설치되지 않음"}</span>
                  </li>
                );
              })}
            </ul>
            {!installed("claude-code") && !agents.loading && (
              <p className="text-xs text-muted">대화에는 Claude Code가 필요합니다. 설치하고 터미널에서 한 번 로그인한 뒤 &lsquo;다시 확인&rsquo;을 누르세요.</p>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="font-medium">2. Google Drive 동기화 폴더</h3>
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate rounded-lg bg-background px-3 py-1.5 font-mono text-xs" title={chosenFolder ?? undefined} data-testid="setup-folder">
                {chosenFolder ?? (candidates.status === "loading" ? "찾는 중…" : "찾지 못함 — 폴더를 선택하세요")}
              </span>
              <button onClick={pick} className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                <FolderOpen className="size-3.5" aria-hidden />
                폴더 선택…
              </button>
              {chosenFolder && (
                <button
                  onClick={() => {
                    setFolder(null);
                    setTouchedFolder(true);
                  }}
                  className="text-xs text-muted hover:text-red-600"
                >
                  사용 안 함
                </button>
              )}
            </div>
            <p className="text-xs text-muted">
              다른 PC와 같은 Google Drive 폴더(예: Google Drive for desktop의 &lsquo;내 드라이브&rsquo;)를 고르면 저장된 공통 메모리와 테마를 바로 받아옵니다.
            </p>
          </section>

          <section className="flex flex-col gap-1.5">
            <h3 className="font-medium">3. 에이전트 연동</h3>
            <p className="text-xs text-muted">AIWorkspace에서 실행하는 Claude Code는 항상 공통 메모리를 참고합니다. AIWorkspace 밖에서 쓸 때도 참고하게 하려면:</p>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={claude} onChange={(e) => setClaudeGlobal(e.target.checked)} />
              Claude Code 전역 메모리(<span className="font-mono">~/.claude/CLAUDE.md</span>)에 반영
            </label>
          </section>

          <section className="flex flex-col gap-1.5">
            <h3 className="font-medium">4. 테마</h3>
            <div role="radiogroup" aria-label="테마" className="flex gap-2">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  role="radio"
                  aria-checked={theme === t.id}
                  onClick={() => setTheme(t.id)}
                  className={`rounded-lg border px-3 py-1.5 text-xs ${theme === t.id ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:text-foreground"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </section>
        </div>

        <footer className="flex justify-end gap-2 border-t border-border px-6 py-3">
          <button onClick={() => close("done")} className={buttonGhost}>
            나중에
          </button>
          <button onClick={finish} className={buttonPrimary} data-testid="setup-finish">
            설정 완료
          </button>
        </footer>
      </div>
    </dialog>
  );
}
