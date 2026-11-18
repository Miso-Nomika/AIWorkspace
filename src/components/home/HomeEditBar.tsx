"use client";

import type { PointerEvent } from "react";
import { ArrowLeft, ArrowRight, Columns2, Columns3, Eye, EyeOff, GripVertical, LayoutPanelLeft, RectangleHorizontal } from "lucide-react";
import type { Size } from "@/lib/home-widget-core";

interface Props {
  id: string;
  size: Size;
  hidden: boolean;
  onShift: (delta: -1 | 1) => void;
  onSize: (size: Size) => void;
  onHidden: (hidden: boolean) => void;
  onDragStart: (event: PointerEvent<HTMLButtonElement>) => void;
  onDragMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onDragEnd: (event: PointerEvent<HTMLButtonElement>) => void;
  onDragCancel: () => void;
}

const BTN = "inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-background hover:text-foreground";

const SIZES: { size: Size; label: string; Icon: typeof Columns3 }[] = [
  { size: 1, label: "작게 (3분의 1 폭)", Icon: Columns3 },
  { size: 2, label: "중간 (절반 폭)", Icon: Columns2 },
  { size: 4, label: "넓게 (3분의 2 폭)", Icon: LayoutPanelLeft },
  { size: 3, label: "크게 (전체 폭)", Icon: RectangleHorizontal },
];

/** 편집 모드에서 위젯 카드 위에 붙는 줄: 끌어서 옮기기 · 앞으로·뒤로 · 크기 4단계 · 숨기기/보이기 */
export function HomeEditBar({ id, size, hidden, onShift, onSize, onHidden, onDragStart, onDragMove, onDragEnd, onDragCancel }: Props) {
  return (
    <div className="mb-1 flex flex-wrap items-center gap-1 rounded-lg border border-border bg-surface px-1 py-0.5" data-testid={`home-edit-${id}`}>
      <button
        type="button"
        title="끌어서 순서 바꾸기"
        aria-label="끌어서 순서 바꾸기"
        data-testid={`home-edit-${id}-drag`}
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragCancel}
        className={`${BTN} cursor-grab touch-none active:cursor-grabbing`}
      >
        <GripVertical className="size-4" aria-hidden />
      </button>
      <button type="button" onClick={() => onShift(-1)} title="앞으로" aria-label="앞으로" data-testid={`home-edit-${id}-prev`} className={BTN}>
        <ArrowLeft className="size-4" aria-hidden />
      </button>
      <button type="button" onClick={() => onShift(1)} title="뒤로" aria-label="뒤로" data-testid={`home-edit-${id}-next`} className={BTN}>
        <ArrowRight className="size-4" aria-hidden />
      </button>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <div role="group" aria-label="크기" className="inline-flex gap-0.5">
        {SIZES.map(({ size: s, label, Icon }) => (
          <button
            key={s}
            type="button"
            onClick={() => onSize(s)}
            title={label}
            aria-label={label}
            aria-pressed={size === s}
            data-testid={`home-edit-${id}-size-${s}`}
            className={`${BTN} ${size === s ? "bg-accent-soft text-accent" : ""}`}
          >
            <Icon className="size-4" aria-hidden />
          </button>
        ))}
      </div>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <button
        type="button"
        onClick={() => onHidden(!hidden)}
        title={hidden ? "홈에 다시 보이기" : "홈에서 숨기기"}
        aria-label={hidden ? "홈에 다시 보이기" : "홈에서 숨기기"}
        aria-pressed={hidden}
        data-testid={`home-edit-${id}-hide`}
        className={`${BTN} ${hidden ? "bg-accent-soft text-accent" : ""}`}
      >
        {hidden ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </button>
    </div>
  );
}
