"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { usePanDrag } from "@/lib/use-pan-drag";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  avif: "image/avif",
};

/** 이미지 보기. SVG도 <img>로 보여 주므로 파일 안의 스크립트는 실행되지 않는다. 100%는 화면에 맞춘 크기이고, 키우면 스크롤로 본다. */
export function ImageView({ bytes, path, zoom = 100 }: { bytes: ArrayBuffer; path: string; zoom?: number }) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes], { type: MIME[ext] ?? "application/octet-stream" })), [bytes, ext]);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  usePanDrag(box);
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setArea({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, [failed]);

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  if (failed) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-sm text-muted">
        <ImageOff className="size-8" aria-hidden />
        이미지를 표시할 수 없습니다.
      </div>
    );
  }
  // 화면에 맞춘 크기(100%)를 기준으로 비율을 곱한다. 원래 크기를 모르면(일부 SVG) CSS로 맞춘다
  const fit = natural.w > 0 && area.w > 0 ? Math.min(1, (area.w - 32) / natural.w, (area.h - 32) / natural.h) : 0;
  const sized = fit > 0 ? { width: Math.max(8, natural.w * fit * (zoom / 100)) } : undefined;
  return (
    <div ref={box} className="flex min-h-0 flex-1 overflow-auto bg-background p-4" data-testid="viewer-image">
      {/* eslint-disable-next-line @next/next/no-img-element -- 정적 앱 안의 로컬 Blob 이미지라 next/image가 필요 없다 */}
      <img
        src={url}
        alt={path}
        onError={() => setFailed(true)}
        onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        style={sized}
        data-testid="viewer-image-img"
        data-zoom-content
        className={`m-auto ${sized ? "max-w-none shrink-0" : "max-h-full max-w-full object-contain"}`}
      />
    </div>
  );
}
