"use client";

import { useState } from "react";
import { Download, Loader2, Pause, Play, Repeat, Repeat1, SkipBack, SkipForward, Trash2, Volume1, Volume2, VolumeX } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { PLAY_MODE_LABELS, cycleMode, formatClock, percentOfVolume, volumeFromPercent } from "@/lib/music-core";
import { addTrack, enqueueDownload, installTool, playTrack, removeTrack, seek, setMode, setTrackDisabled, setTrackVolume, stepPlay, togglePlay, updateTool, useMusicRuntime, useMusicSaved, type Track } from "@/lib/music-store";
import { useHydrated } from "@/lib/storage";

/** 음악 탭: 유튜브 링크를 등록해 내려받아 재생한다 (셔플 이어 재생·반복). 목록·재생은 다른 탭으로 옮겨도 이어진다. */
export function MusicView() {
  const hydrated = useHydrated();
  const { tracks, mode } = useMusicSaved();
  const rt = useMusicRuntime();
  const [url, setUrl] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  function submit() {
    const error = addTrack(url);
    setAddError(error);
    if (!error) setUrl("");
  }

  const toolMissing = rt.tool !== null && rt.tool.path === null;
  const ModeIcon = mode === "one" ? Repeat1 : Repeat;

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <PageHeader title="음악" description="유튜브 링크를 등록하면 음원을 내려받아 이 PC에서 재생합니다. 다른 화면으로 옮겨도 계속 재생됩니다." />

      {toolMissing && (
        <section className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950" data-testid="music-tool-missing">
          <p className="font-medium">음원을 내려받는 도구(yt-dlp)가 필요합니다</p>
          <p className="mt-1 text-xs leading-5">앱에 포함되어 있지 않아 공식 배포처(GitHub)에서 받아 이 PC의 앱 데이터 폴더에 둡니다.</p>
          <button
            onClick={() => void installTool()}
            disabled={rt.toolBusy}
            data-testid="music-tool-install"
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:text-zinc-950"
          >
            {rt.toolBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
            yt-dlp 내려받기
          </button>
          {rt.toolError && <p className="mt-2 text-xs text-red-600">{rt.toolError}</p>}
        </section>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="mb-2 flex gap-2"
      >
        <input
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setAddError(null);
          }}
          placeholder="유튜브 링크를 붙여넣으세요 (예: https://www.youtube.com/watch?v=…)"
          aria-label="유튜브 링크"
          data-testid="music-url"
          className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <button type="submit" disabled={!url.trim()} data-testid="music-add" className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:text-zinc-950">
          추가
        </button>
      </form>
      {addError && (
        <p className="mb-2 text-xs text-red-600" data-testid="music-add-error">
          {addError}
        </p>
      )}

      {hydrated && tracks.length > 0 && (
        <section className="mt-4 rounded-xl border border-border bg-surface p-3" aria-label="재생 조작" data-testid="music-player" data-audio-volume={rt.audioVolume}>
          <div className="flex items-center gap-1.5">
            <button onClick={() => stepPlay(-1)} aria-label="이전 곡" data-testid="music-prev" className="rounded-lg p-2 hover:bg-background">
              <SkipBack className="size-4" />
            </button>
            <button onClick={togglePlay} aria-label={rt.playing ? "일시정지" : "재생"} data-testid="music-toggle" className="rounded-full bg-accent p-2.5 text-white dark:text-zinc-950">
              {rt.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </button>
            <button onClick={() => stepPlay(1)} aria-label="다음 곡" data-testid="music-next" className="rounded-lg p-2 hover:bg-background">
              <SkipForward className="size-4" />
            </button>
            <button
              onClick={() => setMode(cycleMode(mode))}
              title="눌러서 바꿉니다: 셔플 이어 재생 → 한 곡 반복 → 반복 끄기"
              data-testid="music-mode"
              data-mode={mode}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-background"
            >
              <ModeIcon className="size-3.5" aria-hidden />
              {PLAY_MODE_LABELS[mode]}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-muted">
            <span className="w-12 text-right tabular-nums" data-testid="music-position">
              {formatClock(rt.currentId ? rt.position : null)}
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(1, Math.floor(rt.length ?? 0))}
              step={1}
              value={Math.min(Math.floor(rt.position), Math.max(1, Math.floor(rt.length ?? 0)))}
              onChange={(e) => seek(Number(e.target.value))}
              disabled={!rt.currentId || !rt.length}
              aria-label="재생 위치"
              data-testid="music-seek"
              className="min-w-0 flex-1 accent-[var(--accent)]"
            />
            <span className="w-12 tabular-nums" data-testid="music-length">
              {formatClock(rt.currentId ? rt.length : null)}
            </span>
          </div>
          {rt.notice && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400" role="status" data-testid="music-notice">
              {rt.notice}
            </p>
          )}
        </section>
      )}

      <ul className="mt-4 space-y-1.5" data-testid="music-list">
        {tracks.map((track) => (
          <TrackRow key={track.id} track={track} rt={rt} />
        ))}
      </ul>
      {hydrated && tracks.length === 0 && (
        <p className="mt-6 text-center text-sm text-muted" data-testid="music-empty">
          등록된 곡이 없습니다. 위에 유튜브 링크를 붙여넣어 추가하세요.
        </p>
      )}

      {rt.tool?.path && (
        <p className="mt-6 flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="music-tool-info">
          yt-dlp {rt.tool.version ?? ""} ({rt.tool.source === "app" ? "앱이 받아 둠" : "이 PC에 설치됨"})
          {rt.tool.source === "app" && (
            <button onClick={() => void updateTool()} disabled={rt.toolBusy} data-testid="music-tool-update" className="text-accent hover:underline disabled:opacity-50">
              {rt.toolBusy ? "업데이트 중…" : "업데이트"}
            </button>
          )}
          {rt.toolError && <span className="text-red-600">{rt.toolError}</span>}
        </p>
      )}
    </div>
  );
}

/** 곡별 음량 슬라이더 (곡마다 따로 저장되고, 재생 중이면 바로 반영된다) */
function VolumeControl({ track }: { track: Track }) {
  const percent = percentOfVolume(track.volume);
  const Icon = percent === 0 ? VolumeX : percent < 50 ? Volume1 : Volume2;
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted" title="이 곡의 음량">
      <Icon className="size-4 shrink-0" aria-hidden />
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={percent}
        onChange={(e) => setTrackVolume(track.id, volumeFromPercent(Number(e.target.value)))}
        aria-label={`${track.title} 음량`}
        data-testid="music-volume"
        className="w-20 accent-[var(--accent)] sm:w-28"
      />
      <span className="w-9 text-right tabular-nums" data-testid="music-volume-text">
        {percent}%
      </span>
    </div>
  );
}

function TrackRow({ track, rt }: { track: Track; rt: ReturnType<typeof useMusicRuntime> }) {
  const current = rt.currentId === track.id;
  const percent = rt.downloading[track.id];
  const queued = rt.queued.includes(track.id);
  const error = rt.errors[track.id];
  const hasFile = rt.files.has(track.id);

  let status: React.ReactNode = null;
  if (percent !== undefined) status = <span data-testid="music-track-status">받는 중 {Math.round(percent)}%</span>;
  else if (queued) status = <span data-testid="music-track-status">대기 중</span>;
  else if (error) status = null;
  else if (!hasFile) status = <span data-testid="music-track-status">재생할 때 받습니다</span>;
  else if (current && rt.playing) status = <span className="text-accent" data-testid="music-track-status">재생 중</span>;

  return (
    <li className={`rounded-lg border px-3 py-2 ${current ? "border-accent bg-accent-soft" : "border-border bg-surface"} ${track.disabled ? "opacity-60" : ""}`} data-testid="music-track" data-track-id={track.id} data-current={current} data-disabled={!!track.disabled}>
      <div className="flex items-center gap-2">
        <button
          onClick={() => (current ? togglePlay() : void playTrack(track.id))}
          aria-label={current && rt.playing ? `${track.title} 일시정지` : `${track.title} 재생`}
          data-testid="music-play"
          className="rounded-full p-1.5 hover:bg-background"
        >
          {current && rt.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={track.title} data-testid="music-track-title">
            {track.title}
          </div>
          <div className="text-xs text-muted">
            {formatClock(track.duration)}
            {track.disabled && <> · <span data-testid="music-track-disabled">비활성</span></>}
            {status && <> · {status}</>}
          </div>
        </div>
        <button
          role="switch"
          aria-checked={!track.disabled}
          onClick={() => setTrackDisabled(track.id, !track.disabled)}
          aria-label={track.disabled ? `${track.title} 활성화` : `${track.title} 비활성화`}
          title={track.disabled ? "비활성 — 셔플·다음 곡에서 제외됩니다. 눌러서 활성화" : "활성 — 눌러서 비활성화 (셔플·다음 곡에서 제외)"}
          data-testid="music-enable"
          className={`relative h-5 w-9 shrink-0 rounded-full border border-border transition-colors ${track.disabled ? "bg-background" : "bg-accent"}`}
        >
          <span className={`absolute top-0.5 size-3.5 rounded-full bg-white shadow transition-all dark:bg-zinc-950 ${track.disabled ? "left-0.5 bg-muted" : "left-[18px]"}`} aria-hidden />
        </button>
        <VolumeControl track={track} />
        <button onClick={() => void removeTrack(track.id)} aria-label={`${track.title} 삭제`} data-testid="music-remove" className="rounded p-1.5 text-muted hover:text-red-600">
          <Trash2 className="size-4" />
        </button>
      </div>
      {error && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-red-600" data-testid="music-track-error">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button onClick={() => enqueueDownload(track.id)} className="rounded border border-border px-2 py-0.5 text-foreground hover:bg-background" data-testid="music-retry">
            다시 시도
          </button>
          {rt.tool?.source === "app" && (
            <button onClick={() => void updateTool()} disabled={rt.toolBusy} className="rounded border border-border px-2 py-0.5 text-foreground hover:bg-background disabled:opacity-50">
              yt-dlp 업데이트
            </button>
          )}
        </div>
      )}
    </li>
  );
}
