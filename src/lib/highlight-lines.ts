// highlight.js가 만든 HTML을 줄 단위로 나눈다 (순수 함수 — node로 직접 테스트 가능).
// 여러 줄에 걸친 주석·문자열은 <span>이 줄을 가로지르므로, 줄 끝에서 열린 태그를 닫고 다음 줄 처음에 다시 연다.

export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = []; // 지금 열려 있는 <span ...> 시작 태그
  let current = "";
  for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (part === "\n") {
      lines.push(current + "</span>".repeat(open.length));
      current = open.join("");
    } else {
      current += part;
      if (part.startsWith("<span")) open.push(part);
      else if (part === "</span>") open.pop();
    }
  }
  lines.push(current + "</span>".repeat(open.length));
  return lines;
}
