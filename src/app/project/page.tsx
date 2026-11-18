import type { Metadata } from "next";

export const metadata: Metadata = { title: "프로젝트 · AIWorkspace" };

// 프로젝트 화면은 AppShell의 ProjectHost가 그린다 (탭을 옮겨도 상태를 유지하려고 계속 살려 둠).
// 이 페이지는 /project/ 경로를 만들기 위한 빈 페이지다.
export default function ProjectPage() {
  return null;
}
