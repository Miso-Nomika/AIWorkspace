"use client";

import { useRef } from "react";

interface Props {
  label: string;
  /** 아래 패널의 현재 높이(px) */
  value: number;
  min: number;
  max: number;
  /** 드래그 중: 새 높이(px) — 화면에만 반영 */
  onResize: (height: number) => void;
  /** 드래그·키보드 조작이 끝났을 때 — 저장 */
  onCommit: () => void;
  /** 더블클릭: 기본 높이로 */
  onReset: () => void;
}

const KEY_STEP = 24;

/** 위·아래 패널 사이의 가로 구분선(아래 패널 높이를 조절). 마우스 드래그·키보드(↑/↓)로 높이를 조절한다. */
export function ResizeHandleY({ label, value, min, max, onResize, onCommit, onReset }: Props) {
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      title={`${label} (더블클릭: 기본 높이)`}
      className="group relative z-10 -my-1 h-2 shrink-0 cursor-row-resize touch-none outline-none"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startY: e.clientY, startHeight: value };
        document.documentElement.setAttribute("data-resizing", "");
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        onResize(drag.current.startHeight - (e.clientY - drag.current.startY)); // 위로 끌면 아래 패널이 커진다
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        document.documentElement.removeAttribute("data-resizing");
        onCommit();
      }}
      onLostPointerCapture={() => {
        if (!drag.current) return;
        drag.current = null;
        document.documentElement.removeAttribute("data-resizing");
        onCommit();
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        onResize(value + (e.key === "ArrowUp" ? 1 : -1) * KEY_STEP);
      }}
      onKeyUp={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") onCommit();
      }}
    >
      <div className="my-auto h-px w-full bg-border transition-colors group-hover:h-0.5 group-hover:bg-accent group-focus-visible:h-0.5 group-focus-visible:bg-accent" style={{ marginTop: 3 }} />
    </div>
  );
}
