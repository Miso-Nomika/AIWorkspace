"use client";

import { useMemo } from "react";

interface Props {
  /** 첫 줄은 머리글로 보여 준다 */
  rows: string[][];
  /** 병합 셀: [시작 행, 시작 열, 끝 행, 끝 열] (0부터, rows 기준) */
  merges?: [number, number, number, number][];
  /** 확대·축소 (%) */
  zoom?: number;
}

/** 표 보기 (CSV·엑셀 공용, 읽기 전용): 첫 줄은 머리글, 왼쪽에 줄 번호 */
export function DataTable({ rows, merges, zoom = 100 }: Props) {
  const [header, ...body] = rows;
  // 병합: 시작 칸에는 span을 주고, 가려지는 칸은 건너뛴다
  const { starts, hidden } = useMemo(() => {
    const starts = new Map<string, { rowSpan: number; colSpan: number }>();
    const hidden = new Set<string>();
    for (const [r1, c1, r2, c2] of merges ?? []) {
      starts.set(`${r1}:${c1}`, { rowSpan: r2 - r1 + 1, colSpan: c2 - c1 + 1 });
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) hidden.add(`${r}:${c}`);
    }
    return { starts, hidden };
  }, [merges]);
  if (!header) return null;
  const cell = (r: number, c: number, text: string | undefined, className: string, Tag: "td" | "th") => {
    const key = `${r}:${c}`;
    if (hidden.has(key)) return null;
    const span = starts.get(key);
    return (
      <Tag key={c} rowSpan={span?.rowSpan} colSpan={span?.colSpan} className={className} title={text}>
        {text ?? ""}
      </Tag>
    );
  };
  return (
    <table className="min-w-full border-collapse text-xs" style={{ zoom: zoom / 100 }} data-zoom-content>
      <thead className="sticky top-0 bg-surface">
        <tr>
          <th className="w-10 border-b border-border px-2 py-1.5 text-right font-normal text-muted">#</th>
          {header.map((text, c) => cell(0, c, text, "max-w-xs truncate border-b border-border px-3 py-1.5 text-left font-semibold", "th"))}
        </tr>
      </thead>
      <tbody>
        {body.map((row, i) => (
          <tr key={i} className="odd:bg-background/60">
            <td className="px-2 py-1 text-right text-muted select-none">{i + 1}</td>
            {header.map((_, c) => cell(i + 1, c, row[c], `max-w-xs truncate px-3 py-1${starts.has(`${i + 1}:${c}`) ? " border border-border text-center" : ""}`, "td"))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
