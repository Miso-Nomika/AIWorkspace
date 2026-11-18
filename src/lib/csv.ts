// CSV/TSV 파서 (순수 함수 — node로 직접 테스트 가능). 따옴표 안의 구분자·줄바꿈·"" 이스케이프를 처리한다.

export interface Table {
  rows: string[][];
  /** maxRows를 넘어 뒷부분을 자른 경우 */
  truncated: boolean;
}

export function parseDelimited(text: string, delimiter: "," | "\t", maxRows: number): Table {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let truncated = false;

  const endRow = () => {
    row.push(field);
    field = "";
    // 완전히 빈 줄은 건너뛴다
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
      if (rows.length >= maxRows) {
        truncated = i < text.length - 1 && text.slice(i + 1).trim() !== "";
        return { rows, truncated };
      }
    } else field += c;
  }
  if (field !== "" || row.length) endRow();
  return { rows, truncated };
}
