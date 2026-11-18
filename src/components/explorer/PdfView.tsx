"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Search } from "lucide-react";
import type { PDFDocumentProxy, TextLayer } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { KEEP_MARGIN, pixelLimitScale } from "@/lib/pdf-core";
import { loadPdfJs, PDFJS_ASSETS } from "@/lib/pdfjs";
import { usePanDrag } from "@/lib/use-pan-drag";

interface Match {
  page: number;
  /** 그 쪽의 텍스트 조각 번호 (글자 겹침 레이어의 span과 같은 순서) */
  item: number;
}

// 문서별 쪽 텍스트 (검색용, 소문자). 문서를 닫으면 함께 사라진다
const pageTexts = new WeakMap<PDFDocumentProxy, Map<number, string[]>>();

async function textsOfPage(doc: PDFDocumentProxy, pageNumber: number): Promise<string[]> {
  let cache = pageTexts.get(doc);
  if (!cache) pageTexts.set(doc, (cache = new Map()));
  const cached = cache.get(pageNumber);
  if (cached) return cached;
  const content = await (await doc.getPage(pageNumber)).getTextContent();
  const texts = content.items.filter((i): i is TextItem => "str" in i).map((i) => i.str.toLowerCase());
  cache.set(pageNumber, texts);
  return texts;
}

/**
 * PDF 보기: 폭에 맞춰 모든 페이지를 세로로 보여 주고(화면에 가까운 페이지만 그림), 글자 검색이 있다. 확대·축소(%)는 뷰어 상단의 공용 막대가 정해 넘겨 준다.
 * 글자는 드래그해서 복사할 수 있다. 편집은 없다.
 */
export function PdfView({ bytes, zoom }: { bytes: ArrayBuffer; zoom: number }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  usePanDrag(scroller);

  // 문서 열기 (bytes가 바뀌면 다시)
  useEffect(() => {
    let cancelled = false;
    let task: { destroy: () => Promise<void> } | null = null;
    loadPdfJs()
      .then((pdfjs) => {
        const loading = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), ...PDFJS_ASSETS });
        task = loading;
        return loading.promise;
      })
      .then((d) => {
        if (cancelled) return;
        setDoc(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const name = e instanceof Error ? e.name : "";
        setDoc(null);
        setError(name === "PasswordException" ? "암호가 걸린 PDF는 열 수 없습니다." : "PDF를 열 수 없습니다. 손상된 파일일 수 있습니다.");
      });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [bytes]);

  // 보이는 영역의 폭에 맞춘다 (창·패널 크기가 바뀌면 다시)
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 검색: 입력이 멈춘 뒤 모든 쪽의 글자를 훑어 찾은 곳을 모은다
  const needle = query.trim().toLowerCase();
  useEffect(() => {
    if (!doc || !needle) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      const found: Match[] = [];
      for (let page = 1; page <= doc.numPages; page++) {
        const texts = await textsOfPage(doc, page);
        if (cancelled) return;
        texts.forEach((text, item) => {
          if (text.includes(needle)) found.push({ page, item });
        });
      }
      setMatches(found);
      setActive(0);
      setSearching(false);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc, needle]);

  const shown = needle ? matches : [];
  const current = shown[active];

  function go(delta: number) {
    if (shown.length === 0) return;
    const next = (active + delta + shown.length) % shown.length;
    setActive(next);
    // 아직 그려지지 않은 쪽이면 먼저 그 쪽으로 이동한다 (그려진 뒤 찾은 글자 위치로 다시 맞춘다)
    scroller.current?.querySelector(`[data-page="${shown[next].page}"]`)?.scrollIntoView({ block: "center" });
  }

  const scale = zoom / 100;
  // 확대·축소를 계속하는 동안에는 기존 그림을 늘려 보여 주고, 멈춘 뒤에 선명하게 다시 그린다
  const [settled, setSettled] = useState(scale);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(scale), 150);
    return () => clearTimeout(timer);
  }, [scale]);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="viewer-pdf">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-1.5 text-xs text-muted">
        {doc ? <span>{doc.numPages}쪽</span> : <span>PDF</span>}
        <div className="inline-flex items-center gap-1">
          <Search className="size-3.5" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                go(e.shiftKey ? -1 : 1);
              }
            }}
            disabled={!doc}
            placeholder="글자 검색"
            aria-label="PDF 글자 검색"
            data-testid="pdf-search"
            className="w-28 rounded border border-border bg-background px-1.5 py-0.5 text-foreground outline-none focus:border-accent disabled:opacity-50"
          />
          {needle && (
            <>
              <span className="min-w-14 tabular-nums" data-testid="pdf-search-count">
                {searching ? "검색 중…" : shown.length === 0 ? "없음" : `${active + 1} / ${shown.length}`}
              </span>
              <button onClick={() => go(-1)} disabled={shown.length === 0} aria-label="이전 검색 결과" className="rounded p-1 hover:bg-background hover:text-foreground disabled:opacity-40">
                <ChevronUp className="size-3.5" />
              </button>
              <button onClick={() => go(1)} disabled={shown.length === 0} aria-label="다음 검색 결과" data-testid="pdf-next" className="rounded p-1 hover:bg-background hover:text-foreground disabled:opacity-40">
                <ChevronDown className="size-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto bg-background p-4">
        {error ? (
          <p className="text-sm text-muted">{error}</p>
        ) : !doc ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            PDF를 여는 중…
          </p>
        ) : (
          <div className="mx-auto flex w-fit flex-col gap-3" data-zoom-content>
            {Array.from({ length: doc.numPages }, (_, i) => (
              <PdfPage
                key={i}
                doc={doc}
                pageNumber={i + 1}
                cssWidth={Math.max(120, (width - 32) * scale)}
                renderWidth={Math.max(120, (width - 32) * settled)}
                scroller={scroller}
                needle={needle}
                activeItem={current?.page === i + 1 ? current.item : null}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 한 페이지. 화면 가까이 왔을 때만 그린다 (페이지가 많은 PDF도 가볍게). 그림 위에 투명한 글자 층을 겹쳐 선택·검색 표시를 한다. */
function PdfPage({
  doc,
  pageNumber,
  cssWidth,
  renderWidth,
  scroller,
  needle,
  activeItem,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  cssWidth: number;
  /** 실제로 그릴 폭 (확대·축소가 멈춘 뒤의 값) */
  renderWidth: number;
  scroller: React.RefObject<HTMLDivElement | null>;
  needle: string;
  activeItem: number | null;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textBox = useRef<HTMLDivElement>(null);
  const layerRef = useRef<TextLayer | null>(null);
  const [near, setNear] = useState(false);
  const [keep, setKeep] = useState(false); // 화면에서 멀어지면 false — 그림 메모리를 돌려준다
  const [layerVersion, setLayerVersion] = useState(0); // 글자 층을 새로 만들 때마다 올라간다
  const [aspect, setAspect] = useState(1.414); // 그리기 전 자리 표시용 (A4 비율), 그린 뒤 실제 비율

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const root = scroller.current;
    const nearObserver = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { root, rootMargin: "600px 0px" });
    const keepObserver = new IntersectionObserver(([entry]) => setKeep(entry.isIntersecting), { root, rootMargin: KEEP_MARGIN });
    nearObserver.observe(el);
    keepObserver.observe(el);
    return () => {
      nearObserver.disconnect();
      keepObserver.disconnect();
    };
  }, [scroller]);

  // 화면에서 멀어진 쪽은 그림(캔버스)과 글자 층을 비운다. 쪽이 수백 장인 PDF를 끝까지 내려도 메모리가 계속 늘지 않게 하려는 것이다
  // (예전에는 한 번 그린 쪽을 끝까지 들고 있어서 PDF를 내릴수록 그림 메모리가 쪽 수만큼 쌓였다). 다시 가까워지면 새로 그린다.
  useEffect(() => {
    if (keep) return;
    const target = canvas.current;
    if (target) {
      target.width = 0;
      target.height = 0;
    }
    textBox.current?.replaceChildren();
  }, [keep]);

  useEffect(() => {
    const target = canvas.current;
    const box = textBox.current;
    if (!near || !target || !box || renderWidth <= 0) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    // 새 그림은 보이지 않는 캔버스에 먼저 그린 뒤 한 번에 바꿔 넣는다 — 그리는 동안 화면의 캔버스를 비우지 않아 깜빡이지 않는다
    const buffer = document.createElement("canvas");
    void doc.getPage(pageNumber).then(async (page) => {
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const cssScale = renderWidth / base.width;
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: cssScale * dpr * pixelLimitScale(base.width * cssScale * dpr, base.height * cssScale * dpr) });
      buffer.width = Math.floor(viewport.width);
      buffer.height = Math.floor(viewport.height);
      setAspect(base.height / base.width);
      task = page.render({ canvas: buffer, viewport });
      try {
        await task.promise;
      } catch {
        return; // 확대·축소·스크롤로 그리기가 취소된 경우
      }
      if (cancelled) return;
      target.width = buffer.width;
      target.height = buffer.height;
      target.getContext("2d")?.drawImage(buffer, 0, 0);
      buffer.width = 0;
      buffer.height = 0;
      // 글자 층: 같은 크기(CSS 기준)로 투명한 글자를 겹쳐 둔다 — 드래그해서 복사하고 검색 결과를 표시한다
      const pdfjs = await loadPdfJs();
      if (cancelled) return;
      box.replaceChildren();
      box.style.setProperty("--total-scale-factor", String(cssScale));
      const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: box, viewport: page.getViewport({ scale: cssScale }) });
      layerRef.current = layer;
      try {
        await layer.render();
      } catch {
        return; // 취소된 경우
      }
      if (!cancelled) setLayerVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
      task?.cancel();
      buffer.width = 0;
      buffer.height = 0;
      layerRef.current?.cancel();
      layerRef.current = null;
    };
  }, [near, doc, pageNumber, renderWidth]);

  // 검색어와 맞는 글자 조각을 표시하고, 지금 보고 있는 결과로 스크롤한다
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.textDivs.forEach((div, i) => {
      div.classList.toggle("pdf-hit", !!needle && (layer.textContentItemsStr[i] ?? "").toLowerCase().includes(needle));
      div.classList.toggle("pdf-hit-active", i === activeItem);
    });
    if (activeItem !== null) layer.textDivs[activeItem]?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [needle, activeItem, layerVersion]);

  return (
    <div ref={holder} data-page={pageNumber} data-testid="pdf-page" className="relative bg-white shadow-sm ring-1 ring-border" style={{ width: cssWidth, height: cssWidth * aspect }}>
      <canvas ref={canvas} style={{ width: "100%", height: "100%" }} aria-label={`${pageNumber}쪽`} />
      <div ref={textBox} className="pdf-text-layer" data-testid="pdf-text-layer" />
    </div>
  );
}
