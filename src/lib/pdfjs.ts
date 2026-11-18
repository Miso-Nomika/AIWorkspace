// pdf.js 불러오기 (PDF 뷰어와 채팅 첨부가 함께 쓴다). PDF를 처음 열 때만 불러온다 (legacy 빌드 + 앱 안의 워커 파일).

export type PdfJs = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<PdfJs> | null = null;
export function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((mod) => {
    mod.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    return mod as unknown as PdfJs;
  });
  return pdfjsPromise;
}

/**
 * 글꼴이 파일에 들어 있지 않은 한글(CJK) PDF는 cMap·표준 글꼴이, JPEG 2000(JPX)·JBIG2 이미지는 wasm 디코더가 필요하다.
 * 모두 앱 안의 정적 파일(public/pdfjs, scripts/copy-pdf-worker.mjs가 복사)을 쓴다 — 네트워크 접근 없음.
 */
export const PDFJS_ASSETS = {
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  wasmUrl: "/pdfjs/wasm/",
};
