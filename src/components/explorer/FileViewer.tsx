"use client";

import { useMemo, useState } from "react";
import { FileCode, FileQuestion, Loader2 } from "lucide-react";
import { Markdown } from "@/components/chat/Markdown";
import { CodeView } from "./CodeView";
import { ImageView } from "./ImageView";
import { PdfView } from "./PdfView";
import { DataTable } from "./DataTable";
import { SheetView } from "./SheetView";
import { parseDelimited } from "@/lib/csv";
import { fileKind, languageOf, type FileKind } from "@/lib/file-kind";
import { useZoom } from "@/lib/use-zoom";
import { ZoomControl } from "@/components/ZoomControl";
import type { SheetBook } from "@/lib/desktop";

interface Props {
  path: string | null;
  content?: string;
  /** 이미지·PDF의 바이트 */
  bytes?: ArrayBuffer;
  /** 엑셀(xlsx·xlsm)을 읽은 결과 */
  sheet?: SheetBook;
  loading?: boolean;
  error?: string;
  /** Git 변경 내용 보기: 변경된 파일이면 전환 버튼을 보여 주고, active일 때 diff를 보여 준다 */
  diff?: { active: boolean; hasChange: boolean; text?: string; loading?: boolean; error?: string; onChange: (on: boolean) => void };
  /** 헤더 오른쪽에 둘 버튼 (패널 접기 등) */
  action?: React.ReactNode;
}

const CSV_MAX_ROWS = 1000;

/** 선택한 파일을 형식에 맞게 보여 준다 (읽기 전용): 코드 구문 강조 · 마크다운 · JSON · CSV 표 · 일반 텍스트 */
export function FileViewer({ path, content, bytes, sheet, loading, error, diff, action }: Props) {
  if (!path) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex min-h-[37px] items-center justify-end border-b border-border px-4 py-1">{action}</div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted">
          <FileCode className="size-8" aria-hidden />
          파일을 선택하면 내용이 표시됩니다.
        </div>
      </div>
    );
  }
  // 파일이 바뀌면 보기 상태(원문 보기 등)를 처음으로 되돌린다
  return <Viewer key={path} path={path} content={content} bytes={bytes} sheet={sheet} loading={loading} error={error} diff={diff} action={action} />;
}

const TOGGLE = "inline-flex shrink-0 rounded-md border border-border p-0.5 text-xs";
const toggleButton = (on: boolean) => `rounded px-2 py-0.5 ${on ? "bg-accent text-white dark:text-zinc-950" : "text-muted hover:text-foreground"}`;

/** 확대·축소 비율을 따로 저장하는 묶음 (변경 내용은 코드와 같은 묶음) */
function zoomGroup(kind: FileKind, diffActive: boolean): string | null {
  if (diffActive) return "code";
  switch (kind) {
    case "code":
    case "json":
    case "text":
      return "code";
    case "markdown":
      return "markdown";
    case "csv":
    case "sheet":
      return "table";
    case "image":
      return "image";
    case "pdf":
      return "pdf";
    default:
      return null; // 미리 볼 수 없는 형식
  }
}

function Viewer({ path, content, bytes, sheet, loading, error, diff, action }: Props & { path: string }) {
  const kind = fileKind(path);
  const [raw, setRaw] = useState(false);
  const group = zoomGroup(kind, !!diff?.active);
  const { zoom, setZoom, bind } = useZoom(`viewer.${group ?? "none"}`);

  return (
    <div ref={bind} className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{path}</span>
        {diff?.active ? (
          <div role="group" aria-label="변경 내용 보기 방식" className={TOGGLE}>
            <button aria-pressed onClick={() => diff.onChange(true)} className={toggleButton(true)}>
              변경 내용
            </button>
            <button aria-pressed={false} onClick={() => diff.onChange(false)} className={toggleButton(false)}>
              전체 파일
            </button>
          </div>
        ) : (
          diff?.hasChange && (
            <button onClick={() => diff.onChange(true)} className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-accent hover:bg-background" data-testid="show-diff">
              변경 내용 보기
            </button>
          )
        )}
        {!diff?.active && kind === "markdown" && content !== undefined && (
          <div role="group" aria-label="마크다운 보기 방식" className={TOGGLE}>
            {[
              { id: false, label: "보기" },
              { id: true, label: "원문" },
            ].map((o) => (
              <button
                key={o.label}
                aria-pressed={raw === o.id}
                onClick={() => setRaw(o.id)}
                className={`rounded px-2 py-0.5 ${raw === o.id ? "bg-accent text-white dark:text-zinc-950" : "text-muted hover:text-foreground"}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
        {group && <ZoomControl zoom={zoom} onChange={setZoom} label="뷰어 확대·축소" testId="viewer-zoom" />}
        {action}
      </div>
      {diff?.active ? <DiffBody diff={diff} zoom={zoom} /> : <Body zoom={zoom} kind={kind} path={path} content={content} bytes={bytes} sheet={sheet} loading={loading} error={error} raw={raw} />}
    </div>
  );
}

/** 변경 내용(unified diff): 추가된 줄은 초록, 지워진 줄은 빨강 (highlight.js의 diff 강조) */
function DiffBody({ diff, zoom }: { diff: NonNullable<Props["diff"]>; zoom: number }) {
  if (diff.loading) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        불러오는 중…
      </p>
    );
  }
  if (diff.error) return <p className="p-4 text-sm text-muted">{diff.error}</p>;
  if (!diff.text?.trim()) return <p className="p-4 text-sm text-muted">변경 내용이 없습니다.</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="viewer-diff">
      <CodeView text={diff.text} language="diff" lineNumbers={false} zoom={zoom} />
    </div>
  );
}

function Body({ kind, path, content, bytes, sheet, loading, error, raw, zoom }: Props & { path: string; kind: ReturnType<typeof fileKind>; raw: boolean; zoom: number }) {
  if (kind === "unsupported") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted" data-testid="viewer-unsupported">
        <FileQuestion className="size-8" aria-hidden />
        이 형식은 미리 볼 수 없습니다.
      </div>
    );
  }
  if (loading) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        불러오는 중…
      </p>
    );
  }
  if (error) return <p className="p-4 text-sm text-muted">{error}</p>;
  if (kind === "image") return bytes ? <ImageView bytes={bytes} path={path} zoom={zoom} /> : null;
  if (kind === "pdf") return bytes ? <PdfView bytes={bytes} zoom={zoom} /> : null;
  if (kind === "sheet") return sheet ? <SheetView book={sheet} zoom={zoom} /> : null;
  if (content === undefined) return null;

  if (kind === "markdown" && !raw) {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-5" data-testid="viewer-markdown">
        <div style={{ zoom: zoom / 100 }} data-testid="viewer-zoomed" data-zoom-content>
          <Markdown text={content} />
        </div>
      </div>
    );
  }
  if (kind === "csv") return <CsvView text={content} tab={path.toLowerCase().endsWith(".tsv")} zoom={zoom} />;
  if (kind === "json") return <CodeView text={prettyJson(content)} language="json" zoom={zoom} />;
  return <CodeView text={content} language={kind === "markdown" ? "markdown" : languageOf(path)} zoom={zoom} />;
}

/** JSON이면 보기 좋게 정렬하고, 형식이 틀리면 원문 그대로 보여 준다 */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function CsvView({ text, tab, zoom }: { text: string; tab: boolean; zoom: number }) {
  const table = useMemo(() => parseDelimited(text, tab ? "	" : ",", CSV_MAX_ROWS), [text, tab]);
  if (!table.rows[0]) return <p className="p-4 text-sm text-muted">비어 있는 파일입니다.</p>;
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="viewer-csv">
      <DataTable rows={table.rows} zoom={zoom} />
      {table.truncated && <p className="p-3 text-xs text-muted">앞쪽 {CSV_MAX_ROWS.toLocaleString("ko-KR")}행만 표시합니다.</p>}
    </div>
  );
}
