// Next.js 16.4.6 정적 export의 Windows 전용 버그 보정 (npm run build 후 postbuild로 자동 실행).
//
// 원인: next/dist/export/index.js 가 세그먼트 경로를 path.relative 로 만들어 Windows에서 "\" 가 들어가는데,
//       파일명 변환(convertSegmentPathToStaticExportFilename)은 "/" 만 "." 으로 바꾼다.
//       그 결과 클라이언트가 요청하는 `memory/__next.memory.__PAGE__.txt` 대신
//       `memory/__next.memory/__PAGE__.txt` 가 생성되어 프리페치 요청이 404가 된다.
// 동작: out/ 아래 "__next." 로 시작하는 폴더를 찾아 내부 파일을 `폴더명.하위경로(. 구분).txt` 로 평탄화한다.
//       Linux 빌드에서는 그런 폴더가 없으므로 아무것도 하지 않는다.
// Next.js에서 수정되면 이 스크립트와 package.json의 postbuild를 제거한다.

import { readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const OUT = "out";

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );
}

let fixed = 0;
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (entry.name.startsWith("__next.")) {
      for (const file of filesUnder(full)) {
        const flat = `${entry.name}.${relative(full, file).split(sep).join(".")}`;
        renameSync(file, join(dir, flat));
        fixed++;
      }
      rmSync(full, { recursive: true, force: true });
    } else if (entry.name !== "_next") {
      walk(full);
    }
  }
}

try {
  statSync(OUT);
} catch {
  process.exit(0); // 정적 export 결과가 없으면 할 일 없음
}
walk(OUT);
if (fixed > 0) console.log(`fix-export-segments: 세그먼트 파일 ${fixed}개 경로 보정`);
// Windows에서 보정할 폴더가 하나도 없으면 Next.js가 버그를 고친 것이다 → 이 스크립트를 지워도 되는지 알려 준다
if (fixed === 0 && process.platform === "win32") {
  console.log("fix-export-segments: 보정할 세그먼트 폴더가 없습니다. Next.js가 이 버그를 고친 것 같으면 이 스크립트와 package.json의 postbuild를 제거하세요.");
}
