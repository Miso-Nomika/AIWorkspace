// 파일 형식 판정 (순수 함수, 외부 의존 없음 — node로 직접 테스트 가능)
// 확장자로 어떤 뷰어를 쓸지 정한다. 실제로 텍스트인지는 Rust(read_project_file)가 최종 확인한다.

export type FileKind = "code" | "markdown" | "json" | "csv" | "image" | "pdf" | "sheet" | "text" | "unsupported";

/** 확장자 → highlight.js 언어 이름 (highlight.js/lib/common에 들어 있는 언어만) */
const LANGUAGES: Record<string, string> = {
  py: "python", pyw: "python",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  json5: "json", jsonc: "json",
  css: "css", scss: "scss", less: "less",
  html: "xml", htm: "xml", xml: "xml", vue: "xml", svelte: "xml", xhtml: "xml",
  java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", cs: "csharp",
  go: "go", rs: "rust", rb: "ruby", php: "php", pl: "perl", lua: "lua", r: "r",
  sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql", graphql: "graphql", gql: "graphql",
  yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini", properties: "ini",
  diff: "diff", patch: "diff",
  mk: "makefile",
};

/** 파일 이름 전체로 정해지는 언어 */
const NAMED_LANGUAGES: Record<string, string> = { makefile: "makefile", ".bashrc": "bash", ".zshrc": "bash", ".gitconfig": "ini" };

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"]);
const MARKDOWN = new Set(["md", "markdown"]);
const CSV = new Set(["csv", "tsv"]);
/** 엑셀 — Rust가 시트별 표로 읽어 준다 (xlsx·xlsm만. xls·ods는 읽지 않는다) */
const SHEET = new Set(["xlsx", "xlsm"]);
/** 텍스트로 읽을 수 없는 것이 확실한 형식 — 읽기를 시도하지 않고 바로 안내한다 */
const UNSUPPORTED = new Set([
  "zip", "gz", "tgz", "tar", "7z", "rar", "bz2", "xz",
  "exe", "dll", "so", "dylib", "dmg", "iso", "bin", "msi", "deb", "appimage",
  "docx", "doc", "xls", "pptx", "ppt", "hwp", "hwpx", "odt", "ods",
  "mp3", "wav", "flac", "ogg", "m4a", "mp4", "mkv", "avi", "mov", "webm",
  "woff", "woff2", "ttf", "otf", "eot", "class", "jar", "pyc", "o", "a", "lib", "wasm", "sqlite", "db",
]);

function baseName(path: string) {
  return (path.split(/[\\/]/).pop() ?? "").toLowerCase();
}

function extension(name: string) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1) : "";
}

export function fileKind(path: string): FileKind {
  const name = baseName(path);
  const ext = extension(name);
  if (ext === "pdf") return "pdf";
  if (IMAGE.has(ext)) return "image";
  if (SHEET.has(ext)) return "sheet";
  if (UNSUPPORTED.has(ext)) return "unsupported";
  if (MARKDOWN.has(ext)) return "markdown";
  if (CSV.has(ext)) return "csv";
  if (ext === "json") return "json";
  if (LANGUAGES[ext] || NAMED_LANGUAGES[name]) return "code";
  return "text";
}

/** 구문 강조에 쓸 highlight.js 언어. 없으면 null (일반 텍스트) */
export function languageOf(path: string): string | null {
  const name = baseName(path);
  return NAMED_LANGUAGES[name] ?? LANGUAGES[extension(name)] ?? null;
}

/** 텍스트로 읽어 보여 주는 형식인지 (이미지·PDF·엑셀·읽을 수 없는 형식은 제외) */
export function isTextKind(kind: FileKind): boolean {
  return kind !== "image" && kind !== "pdf" && kind !== "sheet" && kind !== "unsupported";
}
