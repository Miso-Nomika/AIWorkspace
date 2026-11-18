import type { NextConfig } from "next";

// 정적 SPA 빌드: `next build` → out/ 폴더. Tauri가 이 결과물을 데스크톱 앱(Windows·Linux)에 넣는다.
// 정적 export와 함께 쓸 수 없는 기능(cacheComponents/PPR, 동적 라우트, Server Actions, Route Handlers 등)은 사용하지 않는다.
const nextConfig: NextConfig = {
  output: "export",
  // next dev가 루트에 AGENTS.md를 만들지 않게 한다 (Claude Code 전용 — Next.js 안내는 CLAUDE.md에 있다)
  agentRules: false,
  // /memory → /memory/index.html 로 생성. 리라이트 설정 없이 어떤 정적 호스트에서도 새로고침·직접 접속이 동작한다.
  trailingSlash: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
