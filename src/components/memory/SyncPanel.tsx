"use client";

import { Cloud, CloudOff, FolderOpen, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { openSetup } from "@/components/layout/SetupDialog";
import { desktop } from "@/lib/desktop";
import { DEFAULT_SYNC, syncMemoriesNow, useMemorySyncState, type SyncSettings } from "@/lib/memory-sync";
import { useStoredState } from "@/lib/storage";
import { useAsync } from "@/lib/use-async";

const STATUS_TEXT = {
  idle: "확인 중…",
  disabled: "동기화 꺼짐 — 이 PC에만 저장됩니다",
  syncing: "동기화 중…",
  synced: "동기화됨",
  offline: "오프라인 — 이 PC에 저장 중, 연결되면 자동 동기화",
  error: "동기화 오류",
} as const;

function time(iso: string | null) {
  return iso ? new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
}

/** Google Drive 동기화 설정과 상태 + Claude Code 연동 설정 */
export function SyncPanel() {
  const sync = useMemorySyncState();
  const [settings, setSettings] = useStoredState<SyncSettings>("sync", DEFAULT_SYNC);
  const candidates = useAsync("drive-candidates", () => desktop.memorySyncCandidates());
  // 실제로 파일을 두는 폴더 (고른 폴더 안의 .AIWorkspace). 동기화가 끝날 때마다 다시 확인한다
  const location = useAsync<string>(
    settings.folder ? `sync-location:${settings.folder}` : null,
    () => desktop.memorySyncLocation(settings.folder!),
    sync.lastSyncAt ? Date.parse(sync.lastSyncAt) : 0,
  );

  const update = (patch: Partial<SyncSettings>) => setSettings((prev) => ({ ...prev, ...patch }));
  const chooseFolder = async () => {
    const first = candidates.status === "success" ? candidates.data[0] : undefined;
    const picked = await desktop.pickFolder(settings.folder ?? first);
    if (picked) update({ folder: picked });
  };
  const suggestions = candidates.status === "success" ? candidates.data.filter((c) => c !== settings.folder) : [];

  const Icon =
    sync.status === "syncing" ? Loader2 : sync.status === "offline" || sync.status === "disabled" ? CloudOff : sync.status === "error" ? TriangleAlert : Cloud;

  return (
    <section className="mb-6 rounded-xl border border-border bg-surface" aria-label="동기화 설정">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Icon
          className={`size-4 ${sync.status === "synced" ? "text-green-600" : sync.status === "error" ? "text-red-600" : "text-muted"} ${sync.status === "syncing" ? "animate-spin" : ""}`}
          aria-hidden
        />
        <span className="text-sm font-medium" data-testid="sync-status" data-status={sync.status}>
          {STATUS_TEXT[sync.status]}
        </span>
        {sync.status === "synced" && (
          <span className="text-xs text-muted">
            {time(sync.lastSyncAt)} · 기기 {sync.devices}대
          </span>
        )}
        <button onClick={openSetup} className="ml-auto text-xs text-muted hover:text-foreground hover:underline">
          시작 설정 다시 열기
        </button>
        <button
          onClick={() => void syncMemoriesNow()}
          disabled={!settings.folder || sync.status === "syncing"}
          className=" inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-background disabled:opacity-40"
        >
          <RefreshCw className="size-3" aria-hidden />
          지금 동기화
        </button>
      </div>

      <div className="flex flex-col gap-3 px-4 py-3 text-sm">
        {sync.message && <p className="text-xs text-red-600">{sync.message}</p>}

        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted">Google Drive 동기화 폴더</span>
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate rounded-lg bg-background px-3 py-1.5 font-mono text-xs" data-testid="sync-folder" title={settings.folder ?? undefined}>
              {settings.folder ?? "설정되지 않음"}
            </span>
            <button onClick={chooseFolder} className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
              <FolderOpen className="size-3.5" aria-hidden />
              폴더 선택…
            </button>
            {settings.folder && (
              <button onClick={() => update({ folder: null })} className="text-xs text-muted hover:text-red-600">
                동기화 끄기
              </button>
            )}
          </div>
          {settings.folder && location.status === "success" && (
            <p className="text-xs text-muted" data-testid="sync-location">
              저장 위치: <span className="font-mono">{location.data}</span>
            </p>
          )}
          {suggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted">찾은 Google Drive:</span>
              {suggestions.map((path) => (
                <button key={path} onClick={() => update({ folder: path })} className="rounded border border-border px-2 py-0.5 font-mono hover:bg-background">
                  {path}
                </button>
              ))}
            </div>
          )}
          <p className="text-xs text-muted">
            Google Drive 폴더(Windows: Google Drive for desktop의 &lsquo;내 드라이브&rsquo;, Linux: rclone 등으로 연결한 폴더)를 고르면 그 안에{" "}
            <span className="font-mono">.AIWorkspace</span> 폴더를 자동으로 만들고 기기별 파일(<span className="font-mono">memory-기기.json</span>, 음악 목록은 <span className="font-mono">music-기기.json</span>, 홈 위젯은 <span className="font-mono">home-기기.json</span>)만 저장합니다.
            프로젝트와 대화 기록, 음원 파일은 동기화하지 않습니다. (Linux에서 드라이브 전체를 동기화하느라 느리면 rclone을{" "}
            <span className="font-mono">gdrive:.AIWorkspace</span> 폴더만 연결하세요.)
          </p>
        </div>

        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <span className="text-xs text-muted">AI 에이전트 연동</span>
          <p className="text-xs">AIWorkspace에서 실행하는 Claude Code는 항상 공통 메모리를 참고합니다.</p>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={settings.claudeGlobal}
              onChange={(e) => update({ claudeGlobal: e.target.checked })}
              aria-label="Claude Code 전역 메모리에 반영"
            />
            Claude Code 전역 메모리(<span className="font-mono">~/.claude/CLAUDE.md</span>)에도 반영 — 터미널에서 직접 쓸 때도 참고
          </label>
          <p className="text-xs text-muted">
            전역 파일에는 AIWorkspace 관리 영역만 추가·갱신하며 기존 내용은 그대로 둡니다. 체크를 해제하면 관리 영역을 지웁니다.
          </p>
        </div>
      </div>
    </section>
  );
}
