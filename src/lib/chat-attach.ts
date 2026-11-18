// 채팅 첨부 준비: 이미지·텍스트·PDF를 구분하고, 글은 모델에 보낼 \`<첨부>\` 블록으로 만든다.
// 순수 함수(분류·글 읽기·상한·블록 만들기)는 node로 테스트할 수 있고, PDF 글자 추출은 브라우저(WebView)에서만 동작한다.
// 이미지는 기존 image-attach.ts의 prepareImage를 그대로 쓴다. PDF는 두 서비스 모두 글자를 추출해 보낸다 (스캔 PDF는 글자가 없어 안내).

import { MAX_ATTACHMENTS } from "./image-attach.ts";

export type AttachKind = "image" | "text" | "pdf";

/** 이미지·파일을 합쳐 한 번에 첨부할 수 있는 개수 (Rust의 이미지 상한과 같게 유지) */
export const MAX_CHAT_ATTACHMENTS = MAX_ATTACHMENTS;
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;
export const MAX_PDF_BYTES = 30 * 1024 * 1024;
/** 한 번에 모델에 보내는 첨부 글의 합계 (넘으면 뒤쪽을 자른다) */
export const MAX_ATTACH_TEXT_CHARS = 100_000;
/** PDF에서 이 글자 수보다 적게 뽑히면 스캔본(글자가 없는 PDF)으로 본다 */
const SCANNED_PDF_CHARS = 20;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "log", "xml", "html", "htm", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "sql", "srt", "vtt",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bat", "ps1", "css", "scss", "vue", "svelte", "r", "lua", "tex",
]);
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** 파일 종류. 첨부할 수 없는 형식이면 null */
export function classifyFile(name: string, mime = ""): AttachKind | null {
  if (IMAGE_TYPES.test(mime)) return "image";
  const ext = extensionOf(name);
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (TEXT_EXTENSIONS.has(ext) || mime.startsWith("text/")) return "text";
  return null;
}

/** 종류별 파일 크기 상한 (이미지는 prepareImage가 줄이므로 원본 20MB까지 받는다) */
export function maxBytesOf(kind: AttachKind): number {
  return kind === "pdf" ? MAX_PDF_BYTES : kind === "text" ? MAX_TEXT_FILE_BYTES : 20 * 1024 * 1024;
}

/** 첨부를 받을 수 없는 이유 (받을 수 있으면 null) */
export function attachProblem(file: { name: string; size: number; type?: string }, currentCount: number): string | null {
  if (currentCount >= MAX_CHAT_ATTACHMENTS) return `첨부는 최대 ${MAX_CHAT_ATTACHMENTS}개까지 할 수 있습니다.`;
  const kind = classifyFile(file.name, file.type);
  if (!kind) return `${file.name}: 첨부할 수 없는 형식입니다. 이미지·PDF·텍스트 파일(txt·md·csv·json·코드 등)만 올릴 수 있습니다.`;
  if (file.size > maxBytesOf(kind)) return `${file.name}: 파일이 너무 큽니다. (${kind === "pdf" ? "PDF 30MB" : kind === "text" ? "텍스트 1MB" : "이미지 20MB"}까지)`;
  if (file.size === 0) return `${file.name}: 빈 파일입니다.`;
  return null;
}

/** 글 파일 읽기: UTF-8로 엄격하게 읽고 안 되면 EUC-KR(한국어 윈도우 메모장·엑셀 CSV)로 읽는다. 바이너리면 null */
export function decodeText(bytes: Uint8Array): { text: string; encoding: "utf-8" | "euc-kr" } | null {
  if (bytes.subarray(0, 8000).includes(0)) return null;
  let body = bytes;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) body = body.subarray(3);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), encoding: "utf-8" };
  } catch {
    try {
      return { text: new TextDecoder("euc-kr").decode(body), encoding: "euc-kr" };
    } catch {
      return null;
    }
  }
}

export function isScannedPdf(text: string): boolean {
  return text.replace(/\s+/g, "").length < SCANNED_PDF_CHARS;
}

export const SCANNED_PDF_MESSAGE = "PDF에서 글자를 찾지 못했습니다 (스캔한 PDF일 수 있습니다). 이미지로 캡처해 첨부해 주세요.";

export interface AttachText {
  name: string;
  text: string;
}

export interface LimitedText extends AttachText {
  truncated: boolean;
}

/** 첨부 글들을 합계 maxChars 안으로 맞춘다. 앞의 첨부부터 채우고 모자라면 그 첨부의 뒤쪽을 자르고 이후 첨부는 빈 글로 둔다 (빈 글은 이름만 전달됨). */
export function limitAttachmentTexts(items: AttachText[], maxChars = MAX_ATTACH_TEXT_CHARS): { items: LimitedText[]; truncated: boolean } {
  let left = maxChars;
  let any = false;
  const out = items.map((item) => {
    if (item.text.length <= left) {
      left -= item.text.length;
      return { ...item, truncated: false };
    }
    any = true;
    const text = item.text.slice(0, Math.max(0, left));
    left = 0;
    return { name: item.name, text, truncated: true };
  });
  return { items: out, truncated: any };
}

function safeName(name: string): string {
  return name.replace(/["<>\r\n]/g, "'").trim() || "첨부";
}

/** 모델에 보낼 \`<첨부 이름="…">…</첨부>\` 블록들. 잘린 첨부는 그 사실을 본문 끝에 적는다 */
export function buildAttachmentBlocks(items: LimitedText[]): string {
  return items
    .map((item) => {
      const note = item.truncated ? "\n(… 분량이 길어 여기까지만 전달됨)" : "";
      return `<첨부 이름="${safeName(item.name)}">\n${item.text}${note}\n</첨부>`;
    })
    .join("\n\n");
}

/** 질문 앞에 첨부 블록을 붙인다 (첨부 글이 없으면 질문 그대로) */
export function buildUserPrompt(question: string, blocks: string): string {
  return blocks ? `${blocks}\n\n${question}` : question;
}

/** 대화에 기록할 첨부 정보 (파일 내용은 넣지 않는다 — 큰 데이터는 채팅 파일 폴더에 따로 둔다) */
export interface AttachmentRecord {
  id: string;
  kind: AttachKind;
  name: string;
  size: number;
  /** 이미지 미리보기(작은 data URL) */
  preview?: string;
  /** 글·PDF에서 뽑은 글자 수 */
  chars?: number;
  /** 길어서 일부만 전달했는지 */
  truncated?: boolean;
  /** 이 PC의 채팅 파일 폴더에 저장한 파일 경로 (이미지는 보낼 때, 글은 "다시 보내기" 때 쓴다) */
  path?: string;
}

/** PDF에서 글자를 뽑는다 (브라우저 전용). 쪽 사이는 빈 줄로 구분한다 */
export async function extractPdfText(bytes: ArrayBuffer): Promise<{ text: string; pages: number }> {
  const { loadPdfJs, PDFJS_ASSETS } = await import("./pdfjs");
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), ...PDFJS_ASSETS });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join(" ").replace(/[ \t]+\n/g, "\n"));
    }
    return { text: pages.join("\n\n").trim(), pages: doc.numPages };
  } finally {
    void task.destroy();
  }
}
