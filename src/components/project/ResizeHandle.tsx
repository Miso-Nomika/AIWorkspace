"use client";

import { useRef } from "react";

interface Props {
  label: string;
  /** 현재 패널 너비(px) */
  value: number;
  min: number;
  max: number;
  /** 드래그 중: 새 너비(px) — 화면에만 반영 */
  onResize: (width: number) => void;
  /** 드래그·키보드 조작이 끝났을 때 — 저장 */
  onCommit: () => void;
  /** 더블클릭: 기본 너비로 */
  onReset: () => void;
  /** 오른쪽 패널을 조절하면 드래그 방향이 반대 */
  side: "left" | "right";
}

const KEY_STEP = 24;

/** 패널 사이의 세로 구분선. 마우스 드래그·키보드(←/→)로 너비를 조절한다. */
export function ResizeHandle({ label, value, min, max, onResize, onCommit, onReset, side }: Props) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const sign = side === "left" ? 1 : -1;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      title={`${label} (더블클릭: 기본 너비)`}
      className="group relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none outline-none"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startWidth: value };
        document.documentElement.setAttribute("data-resizing", "");
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        onResize(drag.current.startWidth + sign * (e.clientX - drag.current.startX));
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
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        onResize(value + (e.key === "ArrowRight" ? sign : -sign) * KEY_STEP);
      }}
      onKeyUp={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") onCommit();
      }}
    >
      <div className="mx-auto h-full w-px bg-border transition-colors group-hover:w-0.5 group-hover:bg-accent group-focus-visible:w-0.5 group-focus-visible:bg-accent" />
    </div>
  );
}
