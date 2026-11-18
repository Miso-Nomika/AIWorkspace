"use client";

import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Clock3, Download, Loader2, Maximize2, Minimize2, TriangleAlert } from "lucide-react";
import { confirmAction } from "@/lib/confirm";
import { isDesktop } from "@/lib/desktop";
import { formatClockDate, formatClockParts } from "@/lib/clock-core";
import { checkForUpdate, installUpdate, useUpdateState } from "@/lib/updater";
import { useClockDate } from "@/lib/use-clock";
import { UsageBar } from "./UsageBar";

/** 화면 위쪽 얇은 바: 가운데 작은 현재 시각(자리가 모자라면 왼쪽 끝) · 오른쪽 정렬된 플랜·사용량 막대 · 새 버전 알림 · 전체화면 버튼 */
export function TopBar() {
  const box = useRef<HTMLDivElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const [centered, setCentered] = useState(true);

  // 시계는 바의 정확히 가운데에 둔다. 오른쪽 묶음(사용량 막대 등)과 겹칠 만큼 창이 좁으면 겹치지 않게 왼쪽 끝으로 옮긴다.
  useEffect(() => {
    const el = box.current;
    const right = group.current;
    if (!el || !right) return;
    const update = () => {
      const clockWidth = clock.current?.offsetWidth ?? 60;
      const center = el.clientWidth / 2;
      const rightEdgeOfClock = center + clockWidth / 2 + 12; // 가운데에 놓았을 때 시계의 오른쪽 끝 + 여유
      setCentered(right.offsetLeft > rightEdgeOfClock);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    observer.observe(right);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={box} className="relative flex min-h-10 shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 border-b border-border bg-surface px-3 py-1" data-testid="top-bar">
      <TopClock ref={clock} centered={centered} />
      <div ref={group} className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1" data-testid="top-bar-right">
        <UsageBar />
        <UpdateNotice />
        <FullscreenButton />
      </div>
    </div>
  );
}

/** 위쪽 바의 현재 시각 (이 PC 시간대): 시계 아이콘 + 작은 "오전/오후" + 큰 "3:07". 마우스를 올리면 날짜·요일이 보인다 */
function TopClock({ centered, ref }: { centered: boolean; ref: React.Ref<HTMLSpanElement> }) {
  const date = useClockDate();
  const parts = date ? formatClockParts(date) : null;
  return (
    <span
      ref={ref}
      title={date ? formatClockDate(date) : undefined}
      data-testid="top-clock"
      data-centered={centered}
      style={centered ? { left: "50%", transform: "translate(-50%, -50%)" } : { left: 12, transform: "translateY(-50%)" }}
      className="absolute top-1/2 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-0.5 whitespace-nowrap shadow-sm"
      suppressHydrationWarning
    >
      <Clock3 className="size-3.5 text-accent" aria-hidden />
      <span className="text-[11px] font-medium text-muted" data-testid="top-clock-period">
        {parts?.period ?? "--"}
      </span>
      <span className="text-sm leading-none font-semibold tracking-tight text-foreground tabular-nums" data-testid="top-clock-time">
        {parts ? `${parts.hour}:${parts.minute}` : "-:--"}
      </span>
    </span>
  );
}

function UpdateNotice() {
  const update = useUpdateState();
  if (update.status === "idle") return null;

  if (update.status === "available") {
    return (
      <button
        onClick={async () => {
          if (await confirmAction(`${update.version} 버전으로 업데이트합니다.\n설치 후 앱이 다시 시작되며, 진행 중인 작업은 중단됩니다. 계속할까요?`)) {
            void installUpdate();
          }
        }}
        className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 dark:text-zinc-950"
        data-testid="update-available"
      >
        <Download className="size-3.5" aria-hidden />
        새 버전 {update.version} · 지금 업데이트
      </button>
    );
  }
  if (update.status === "downloading") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted" role="status">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        내려받는 중{update.progress > 0 ? ` ${Math.round(update.progress * 100)}%` : "…"}
      </span>
    );
  }
  if (update.status === "manual") {
    return (
      <span className="text-xs text-muted" title="이 설치 방식(.deb)은 앱이 스스로 업데이트할 수 없습니다. GitHub Releases에서 새 .deb를 내려받아 설치하세요.">
        새 버전 {update.version}이 있습니다 — GitHub Releases에서 내려받아 설치하세요
      </span>
    );
  }
  return (
    <button
      onClick={() => void checkForUpdate().then(() => void installUpdate())}
      className="inline-flex items-center gap-1.5 text-xs text-red-600 hover:underline"
      title={update.message ?? undefined}
    >
      <TriangleAlert className="size-3.5" aria-hidden />
      업데이트 실패 — 다시 시도
    </button>
  );
}

/** OS 전체화면(제목 표시줄·작업표시줄까지 가림). F11로 전환, Esc로 종료. 앱은 항상 일반 창으로 시작한다. */
function FullscreenButton() {
  const [full, setFull] = useState(false);

  useEffect(() => {
    if (!isDesktop()) return;
    const win = getCurrentWindow();
    const sync = () => void win.isFullscreen().then(setFull);
    sync();
    const unlisten = win.onResized(sync);

    const toggle = async () => {
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      setFull(next);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        void toggle();
      } else if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("dialog[open]")) {
        // 전체화면일 때만 종료 (대화상자 닫기·실행 중지 등 다른 Esc 처리와 겹치지 않게)
        void win.isFullscreen().then((now) => {
          if (now) void win.setFullscreen(false).then(() => setFull(false));
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      void unlisten.then((f) => f());
    };
  }, []);

  const label = full ? "전체화면 종료 (F11 · Esc)" : "전체화면 (F11)";
  const Icon = full ? Minimize2 : Maximize2;
  return (
    <button
      onClick={async () => {
        const win = getCurrentWindow();
        const next = !(await win.isFullscreen());
        await win.setFullscreen(next);
        setFull(next);
      }}
      title={label}
      aria-label={label}
      aria-pressed={full}
      className="rounded p-1.5 text-muted hover:bg-background hover:text-foreground"
      data-testid="fullscreen-toggle"
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}
