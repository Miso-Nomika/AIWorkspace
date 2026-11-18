"use client";

import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from "@/lib/zoom-core";

interface Props {
  zoom: number;
  onChange: (zoom: number) => void;
  label?: string;
  testId?: string;
}

/** 확대·축소 막대: 막대를 끌어 50~300%, 비율 숫자를 누르면 100%로 되돌린다 */
export function ZoomControl({ zoom, onChange, label = "확대·축소", testId = "zoom" }: Props) {
  const percent = Math.round(zoom);
  return (
    <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted" data-testid={testId}>
      <input
        type="range"
        min={ZOOM_MIN}
        max={ZOOM_MAX}
        step={ZOOM_STEP}
        value={Math.round(zoom / ZOOM_STEP) * ZOOM_STEP}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        title={`${label} (Ctrl+휠)`}
        data-testid={`${testId}-range`}
        className="h-1 w-20 cursor-pointer accent-accent"
      />
      <button
        type="button"
        onClick={() => onChange(ZOOM_DEFAULT)}
        title="100%로 되돌리기 (Ctrl+0)"
        data-testid={`${testId}-reset`}
        className="min-w-9 rounded px-1 py-0.5 text-right tabular-nums hover:bg-background hover:text-foreground"
      >
        {percent}%
      </button>
    </div>
  );
}
