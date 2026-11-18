"use client";

import { useEffect, useMemo, useState } from "react";
import { splitHighlightedLines } from "@/lib/highlight-lines";

/** 이보다 큰 파일은 구문 강조를 하지 않는다 (느려지고 화면이 멈출 수 있음) */
const HIGHLIGHT_MAX_CHARS = 200_000;

interface Highlighted {
  text: string;
  language: string;
  lines: string[];
}

/**
 * 줄 번호가 있는 코드 보기. language가 있으면 구문 강조(highlight.js)를 입힌다 — 필요할 때 불러오므로
 * 처음엔 일반 텍스트로 보이다가 곧 색이 입혀진다. 편집 기능은 없다.
 */
export function CodeView({ text, language, lineNumbers = true, zoom = 100 }: { text: string; language: string | null; lineNumbers?: boolean; zoom?: number }) {
  const [highlighted, setHighlighted] = useState<Highlighted | null>(null);
  const body = useMemo(() => text.replace(/\n$/, ""), [text]);
  const canHighlight = !!language && body.length <= HIGHLIGHT_MAX_CHARS;

  useEffect(() => {
    if (!canHighlight || !language) return;
    let cancelled = false;
    void import("highlight.js/lib/common").then(({ default: hljs }) => {
      if (cancelled || !hljs.getLanguage(language)) return;
      const html = hljs.highlight(body, { language, ignoreIllegals: true }).value;
      setHighlighted({ text: body, language, lines: splitHighlightedLines(html) });
    });
    return () => {
      cancelled = true;
    };
  }, [body, language, canHighlight]);

  const current = highlighted && highlighted.text === body && highlighted.language === language ? highlighted : null;
  const plain = useMemo(() => (current ? [] : body.split("\n")), [current, body]);

  return (
    <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[13px] leading-6" data-testid="viewer-code">
      <div style={{ zoom: zoom / 100 }} data-testid="viewer-zoomed" data-zoom-content>
      {current
        ? current.lines.map((html, i) => (
            <div key={i} className="flex">
              {lineNumbers && <span className="w-10 shrink-0 pr-3 text-right text-muted select-none">{i + 1}</span>}
              {/* hljs가 HTML 특수문자를 이스케이프한 결과라 안전하다 */}
              <code className="hljs whitespace-pre" dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          ))
        : plain.map((line, i) => (
            <div key={i} className="flex">
              {lineNumbers && <span className="w-10 shrink-0 pr-3 text-right text-muted select-none">{i + 1}</span>}
              <code className="whitespace-pre">{line}</code>
            </div>
          ))}
      </div>
    </pre>
  );
}
