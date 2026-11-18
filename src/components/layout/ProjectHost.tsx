"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ProjectWorkspace } from "@/components/project/ProjectWorkspace";
import { setLastProject } from "@/lib/active-project";
import { isProjectPath, useProjectIdParam } from "@/lib/routes";
import { useHydrated } from "@/lib/storage";
import { useProjects } from "@/lib/store";

/**
 * 프로젝트 화면을 한 번 열면 계속 살려 두고, 다른 탭(메모리·대시보드)으로 가면 가리기만 한다.
 * → 열어 둔 파일·펼친 폴더·입력 중인 글·진행 중인 실행과 권한 카드가 이동해도 그대로 유지된다.
 * - 가릴 때 display:none을 쓰면 스크롤 위치가 초기화되므로, 레이아웃은 그대로 두고 투명 처리한다
 *   (visibility:hidden 이라 클릭·포커스는 받지 않는다).
 * - 프로젝트를 삭제하면 화면을 닫는다. 앱을 다시 시작하면 처음 상태로 돌아간다.
 * 호출하는 쪽에서 <Suspense>로 감싸야 한다 (URL 검색 값을 읽음).
 */
export function ProjectHost() {
  const pathname = usePathname();
  const currentId = useProjectIdParam();
  const hydrated = useHydrated();
  const { projects } = useProjects();
  const [visited, setVisited] = useState<string[]>([]);

  const onProject = isProjectPath(pathname) && !!currentId;

  // 처음 여는 프로젝트를 목록에 추가 (렌더링 중 상태 조정 — React가 커밋 전에 바로 다시 그려 깜빡임이 없다)
  if (onProject && currentId && !visited.includes(currentId)) setVisited([...visited, currentId]);

  // 마지막으로 보던 프로젝트 기억 (사이드바 "프로젝트" 탭이 여기로 돌아옴)
  useEffect(() => {
    if (onProject) setLastProject(currentId);
  }, [onProject, currentId]);

  // 삭제된 프로젝트는 닫는다 (지금 보고 있는 것은 "찾을 수 없음" 안내를 위해 유지)
  const alive = visited.filter((id) => !hydrated || id === currentId || projects.some((p) => p.id === id));

  return (
    <>
      {alive.map((id) => {
        const active = onProject && id === currentId;
        return (
          <div
            key={id}
            className={active ? "h-full" : "pointer-events-none invisible absolute inset-0"}
            aria-hidden={!active}
          >
            <ProjectWorkspace id={id} active={active} />
          </div>
        );
      })}
    </>
  );
}
