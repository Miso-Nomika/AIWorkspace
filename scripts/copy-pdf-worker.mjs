// PDF 뷰어(pdf.js)에 필요한 파일을 public/ 으로 복사한다 (npm run dev / build 전에 자동 실행).
// 앱의 보안 정책(CSP)상 워커·데이터는 앱 자신('self')의 파일이어야 하므로 node_modules에서 꺼내 정적 파일로 둔다.
// - pdf.worker.min.mjs: 워커 (legacy 빌드: Linux WebKitGTK처럼 최신 JavaScript 기능이 부족한 환경에서도 동작)
// - pdfjs/cmaps · pdfjs/standard_fonts: 글꼴이 파일에 들어 있지 않은 한글(CJK) PDF를 그리는 데 필요
// - pdfjs/wasm: JPEG 2000(JPX)·JBIG2 이미지와 색 변환 디코더

import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";

const base = "node_modules/pdfjs-dist";
const worker = `${base}/legacy/build/pdf.worker.min.mjs`;
if (!existsSync(worker)) throw new Error(`${worker} 가 없습니다. npm install 을 먼저 실행하세요.`);
mkdirSync("public/pdfjs", { recursive: true });
copyFileSync(worker, "public/pdf.worker.min.mjs");

for (const [from, to, keep] of [
  ["cmaps", "cmaps", () => true],
  ["standard_fonts", "standard_fonts", (file) => !file.startsWith("LICENSE")],
  ["wasm", "wasm", (file) => file.endsWith(".wasm") && !file.startsWith("quickjs")],
]) {
  rmSync(`public/pdfjs/${to}`, { recursive: true, force: true });
  cpSync(`${base}/${from}`, `public/pdfjs/${to}`, {
    recursive: true,
    filter: (src) => statSync(src).isDirectory() || keep(src.split(/[\/]/).pop()),
  });
}
