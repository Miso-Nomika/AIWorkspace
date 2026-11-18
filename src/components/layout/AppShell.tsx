import { Suspense } from "react";
import { BackgroundServices } from "./BackgroundServices";
import { ProjectHost } from "./ProjectHost";
import { SetupDialog } from "./SetupDialog";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

// 왼쪽 사이드바(접기 가능) + 위쪽 바 + 본문. 프로젝트 화면은 ProjectHost가 계속 살려 두고, 다른 화면은 children으로 바뀐다.
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh">
      <Sidebar />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Suspense fallback={null}>
            <ProjectHost />
          </Suspense>
          {children}
        </main>
      </div>
      <BackgroundServices />
      <SetupDialog />
    </div>
  );
}
