"use client";

import { useRef, useState } from "react";
import { DataTable } from "./DataTable";
import type { SheetBook } from "@/lib/desktop";
import { usePanDrag } from "@/lib/use-pan-drag";

/** 엑셀 보기 (읽기 전용): 시트 탭 + 표. 수식은 저장된 계산값, 날짜는 YYYY-MM-DD */
export function SheetView({ book, zoom = 100 }: { book: SheetBook; zoom?: number }) {
  const [active, setActive] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  usePanDrag(body); // 가운데 버튼으로 끌어 이동 (CSV 표에는 적용하지 않음)
  const sheet = book.sheets[Math.min(active, book.sheets.length - 1)];
  if (!sheet) return <p className="p-4 text-sm text-muted">시트가 없는 파일입니다.</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="viewer-sheet">
      <div role="tablist" aria-label="시트" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 pt-1.5">
        {book.sheets.map((s, i) => (
          <button
            key={i}
            role="tab"
            aria-selected={i === active}
            onClick={() => setActive(i)}
            title={s.name}
            className={`max-w-48 shrink-0 truncate rounded-t px-3 py-1 text-xs ${
              i === active ? "bg-accent-soft font-semibold text-accent" : "text-muted hover:text-foreground"
            } ${s.hidden ? "opacity-60" : ""}`}
          >
            {s.name}
            {s.hidden && " (숨김)"}
          </button>
        ))}
      </div>
      <div ref={body} className="min-h-0 flex-1 overflow-auto" data-testid="sheet-body">
        {sheet.skipped ? (
          <p className="p-4 text-sm text-muted">파일이 너무 커서 이 시트는 불러오지 않았습니다.</p>
        ) : sheet.rows.length === 0 ? (
          <p className="p-4 text-sm text-muted">비어 있는 시트입니다.</p>
        ) : (
          <DataTable rows={sheet.rows} merges={sheet.merges} zoom={zoom} />
        )}
        {sheet.truncated && !sheet.skipped && (
          <p className="p-3 text-xs text-muted" data-testid="sheet-truncated">
            앞쪽 2,000행·100열만 표시합니다 (전체 셀이 너무 많으면 더 일찍 잘립니다).
          </p>
        )}
      </div>
    </div>
  );
}
