"use client";

import { Suspense, useEffect } from "react";
import { Moon, PanelLeftClose, PanelLeftOpen, Sparkles, Sun } from "lucide-react";
import { ActiveNavLinks, NavLinks } from "./NavLinks";
import { useTheme, useUiState } from "@/lib/ui-prefs";

const footerButton =
  "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-background hover:text-foreground collapsed:justify-center collapsed:px-0";

/**
 * 왼쪽 사이드바. 접으면 아이콘만 남는다 (Ctrl+B).
 * 접힘 여부는 <html data-sidebar>로 스타일을 바꾸므로 첫 화면부터 깜빡이지 않는다 (boot-script.ts).
 */
export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useUiState();
  const { resolved, toggle } = useTheme();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  const ThemeIcon = resolved === "dark" ? Sun : Moon;
  const themeLabel = resolved === "dark" ? "라이트 모드" : "다크 모드";
  const CollapseIcon = sidebarCollapsed ? PanelLeftOpen : PanelLeftClose;
  const collapseLabel = sidebarCollapsed ? "사이드바 펼치기" : "사이드바 접기";

  return (
    <aside
      className="flex w-56 shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-150 collapsed:w-14"
      aria-label="사이드바"
    >
      <div className="flex h-14 items-center gap-2 overflow-hidden px-5 font-semibold whitespace-nowrap collapsed:justify-center collapsed:px-0">
        <Sparkles className="size-5 shrink-0 text-accent" aria-hidden />
        <span className="collapsed:hidden">AIWorkspace</span>
      </div>
      <nav aria-label="주 메뉴" className="flex flex-col gap-1 px-3 collapsed:px-2">
        <Suspense fallback={<NavLinks pathname="" />}>
          <ActiveNavLinks />
        </Suspense>
      </nav>

      <div className="mt-auto flex flex-col gap-1 border-t border-border px-3 py-3 collapsed:px-2">
        <button onClick={toggle} className={footerButton} title={`${themeLabel}로 전환`} aria-label={`${themeLabel}로 전환`} data-testid="theme-toggle">
          <ThemeIcon className="size-4 shrink-0" aria-hidden />
          <span className="whitespace-nowrap collapsed:hidden">{themeLabel}</span>
        </button>
        <button
          onClick={toggleSidebar}
          className={footerButton}
          title={`${collapseLabel} (Ctrl+B)`}
          aria-label={collapseLabel}
          aria-expanded={!sidebarCollapsed}
          data-testid="sidebar-toggle"
        >
          <CollapseIcon className="size-4 shrink-0" aria-hidden />
          <span className="whitespace-nowrap collapsed:hidden">사이드바 접기</span>
        </button>
      </div>
    </aside>
  );
}
