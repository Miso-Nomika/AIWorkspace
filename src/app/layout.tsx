import type { Metadata, Viewport } from "next";
import { AppShell } from "@/components/layout/AppShell";
import { BOOT_SCRIPT } from "@/lib/boot-script";
import "./globals.css";

export const metadata: Metadata = {
  title: "AIWorkspace",
  description: "Claude Code와 함께 쓰는 데스크톱 작업 공간",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // 부팅 스크립트가 class·data-sidebar를 바꾸므로 hydration 경고를 끈다
    <html lang="ko" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </head>
      <body className="h-full">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
