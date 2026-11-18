"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brain, FolderKanban, House, LayoutDashboard, MessagesSquare, Music, Settings } from "lucide-react";
import { useLastProject } from "@/lib/active-project";
import { isProjectPath, routes } from "@/lib/routes";
import { useProjects } from "@/lib/store";

const NAV = [
  { href: routes.myHome, label: "홈", icon: House },
  { href: routes.home, label: "프로젝트", icon: FolderKanban },
  { href: routes.chat, label: "채팅", icon: MessagesSquare },
  { href: routes.music, label: "음악", icon: Music },
  { href: routes.memory, label: "메모리", icon: Brain },
  { href: routes.dashboard, label: "대시보드", icon: LayoutDashboard },
  { href: routes.options, label: "옵션", icon: Settings },
];

function isActive(pathname: string, href: string) {
  if (href === routes.home) return pathname === "/" || isProjectPath(pathname);
  return pathname.startsWith(href.replace(/\/$/, ""));
}

const s = {
  base: "flex items-center gap-3 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors collapsed:justify-center collapsed:px-0",
  active: "bg-accent-soft font-medium text-accent",
  idle: "text-muted hover:bg-background hover:text-foreground",
  icon: "size-4 shrink-0",
  label: "collapsed:sr-only",
};

export function NavLinks({ pathname }: { pathname: string }) {
  // "프로젝트" 탭은 마지막으로 보던 프로젝트로 돌아간다 (목록은 프로젝트 화면의 ← 버튼). 없어졌으면 목록으로.
  const lastProject = useLastProject();
  const { projects } = useProjects();
  const resume = lastProject && projects.some((p) => p.id === lastProject) ? routes.project(lastProject) : null;

  return NAV.map(({ href: baseHref, label, icon: Icon }) => {
    const href = baseHref === routes.home && resume ? resume : baseHref;
    const active = isActive(pathname, baseHref);
    return (
      <Link
        key={href}
        href={href}
        aria-current={active ? "page" : undefined}
        title={label}
        className={`${s.base} ${active ? s.active : s.idle}`}
      >
        <Icon className={s.icon} aria-hidden />
        <span className={s.label}>{label}</span>
      </Link>
    );
  });
}

export function ActiveNavLinks() {
  return <NavLinks pathname={usePathname()} />;
}
