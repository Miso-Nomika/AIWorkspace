// 화면 경로는 여기서만 만든다.
// 프로젝트 URL은 정적 빌드를 위해 현재 `/project/?id=abc` 형태다.
// 나중에 프로젝트별 고유 URL(`/projects/abc` 등)로 바꿀 때는 이 파일의
// routes.project / isProjectPath / useProjectIdParam 과 app/project 라우트만 수정하면 된다.

import { useSearchParams } from "next/navigation";

export const routes = {
  /** 프로젝트 목록(앱 첫 화면). 개인 홈 화면은 myHome */
  home: "/",
  /** 개인 홈(위젯 화면) */
  myHome: "/home/",
  chat: "/chat/",
  music: "/music/",
  memory: "/memory/",
  dashboard: "/dashboard/",
  options: "/options/",
  project: (id: string) => `/project/?id=${encodeURIComponent(id)}`,
} as const;

/** 프로젝트 화면 경로인지 (내비게이션 활성 표시용) */
export function isProjectPath(pathname: string) {
  return pathname.startsWith("/project");
}

/** 현재 URL에서 프로젝트 ID를 읽는다. 호출하는 컴포넌트는 <Suspense> 안에 있어야 한다. */
export function useProjectIdParam(): string | null {
  return useSearchParams().get("id");
}
