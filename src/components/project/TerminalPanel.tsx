"use client";

import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw, SquareTerminal } from "lucide-react";
import type { Terminal } from "@xterm/xterm";
import { desktop, isDesktop } from "@/lib/desktop";
import { useTheme } from "@/lib/ui-prefs";

const THEMES = {
  dark: { background: "#18181b", foreground: "#e4e4e7", cursor: "#e4e4e7", selectionBackground: "#3f3f46" },
  light: { background: "#ffffff", foreground: "#1f2937", cursor: "#1f2937", selectionBackground: "#bfdbfe" },
};

interface Props {
  /** 셸 이름표: 프로젝트 선택 화면은 "home", 프로젝트 화면은 "p-<프로젝트 id>" (이름표마다 셸이 하나, 화면을 닫아도 셸은 남는다) */
  sessionKey: string;
  /** 셸을 시작할 프로젝트 폴더 (원격(SSH) 프로젝트는 ssh://… 형태로 ssh 접속). 없으면 홈 폴더 */
  root: string | null;
  title: string;
  /** 점검에서 찾는 data-testid 이름들 */
  ids: { section: string; host: string; restart: string; error: string };
  /** 처음 열릴 때 입력 칸을 잡는다 */
  autoFocus?: boolean;
  /** 머리줄·테두리 없이 터미널 화면만 보인다 (프로젝트 뷰어 아래). 셸이 끝났을 때의 [다시 시작]만 화면 오른쪽 위에 겹쳐 나온다 */
  bare?: boolean;
}

/**
 * 앱 안의 터미널 창. 셸(Windows는 PowerShell, Linux는 사용자 셸)은 이름표마다 하나이고, 프로젝트 선택 화면은 홈 폴더에서,
 * 프로젝트 화면의 뷰어 아래는 그 프로젝트 폴더에서 시작한다(원격 프로젝트는 ssh로 접속한 원격 폴더).
 * 다른 화면에 갔다 돌아와도 셸과 최근 출력이 남아 있다. 입력은 사용자가 키보드로 친 글자만 셸로 전달된다.
 */
export function TerminalPanel({ sessionKey, root, title, ids, autoFocus = false, bare = false }: Props) {
  const { resolved } = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<{ fit: () => void } | null>(null);
  const [status, setStatus] = useState<"loading" | "running" | "ended" | "error">("loading");
  const [message, setMessage] = useState("");
  const themeRef = useRef(resolved);

  useEffect(() => {
    themeRef.current = resolved;
    if (term.current) term.current.options.theme = THEMES[resolved];
  }, [resolved]);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;
    void (async () => {
      if (!isDesktop()) {
        setStatus("error");
        setMessage("터미널은 데스크톱 앱에서만 쓸 수 있습니다.");
        return;
      }
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      const el = host.current;
      if (disposed || !el) return;
      const t = new Terminal({
        fontFamily: '"Cascadia Mono", Consolas, "Malgun Gothic", "Noto Sans Mono CJK KR", monospace',
        fontSize: 13,
        cursorBlink: true,
        scrollback: 5000,
        theme: THEMES[themeRef.current],
      });
      const fitAddon = new FitAddon();
      t.loadAddon(fitAddon);
      t.open(el);
      fitAddon.fit();
      term.current = t;
      fit.current = fitAddon;

      const copySelection = () => {
        const text = t.getSelection();
        if (text) void navigator.clipboard.writeText(text).catch(() => {});
        return !!text;
      };
      const paste = () => void navigator.clipboard.readText().then((text) => text && t.paste(text)).catch(() => {});
      // 복사·붙여넣기: Ctrl+Shift+C/V. 글자를 선택한 상태의 Ctrl+C는 복사, 선택이 없으면 실행 중인 명령 중단(셸로 전달)
      t.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown" || !e.ctrlKey || e.altKey) return true;
        const key = e.key.toLowerCase();
        if (e.shiftKey && key === "c") {
          copySelection();
          return false;
        }
        if (e.shiftKey && key === "v") {
          paste();
          return false;
        }
        if (!e.shiftKey && key === "c" && t.hasSelection()) {
          copySelection();
          return false;
        }
        return true;
      });
      const onContextMenu = (e: MouseEvent) => {
        e.preventDefault(); // 선택이 있으면 복사, 없으면 붙여넣기 (Windows Terminal과 같은 방식)
        if (!copySelection()) paste();
      };
      el.addEventListener("contextmenu", onContextMenu);

      const input = t.onData((data) => void desktop.terminalWrite(sessionKey, data).catch(() => {}));
      let pending = 0;
      const onResize = () => {
        cancelAnimationFrame(pending);
        pending = requestAnimationFrame(() => {
          if (!el.clientWidth || !el.clientHeight) return;
          fitAddon.fit();
          void desktop.terminalResize(sessionKey, t.cols, t.rows).catch(() => {});
        });
      };
      const observer = new ResizeObserver(onResize);
      observer.observe(el);
      const off = await desktop.onTerminalExit(sessionKey, () => {
        setStatus("ended");
        t.write("\r\n\x1b[2m[셸이 종료되었습니다]\x1b[0m\r\n");
      });
      cleanup = () => {
        off();
        observer.disconnect();
        cancelAnimationFrame(pending);
        el.removeEventListener("contextmenu", onContextMenu);
        input.dispose();
        void desktop.terminalDetach(sessionKey).catch(() => {});
        t.dispose();
        term.current = null;
        fit.current = null;
      };
      if (disposed) return cleanup();
      try {
        const alive = await desktop.terminalAttach(sessionKey, root, t.cols, t.rows, (bytes) => t.write(bytes));
        setStatus(alive ? "running" : "ended");
        if (!alive) t.write("\r\n\x1b[2m[셸이 종료되었습니다]\x1b[0m\r\n");
        else if (autoFocus) t.focus();
      } catch (e) {
        setStatus("error");
        setMessage(`터미널을 시작하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => {
      disposed = true;
      cleanup?.();
    };
    // 이름표나 시작 폴더가 바뀌면(다른 프로젝트) 그 셸에 다시 연결한다. 글자 크기·자동 포커스는 처음 열릴 때만 쓴다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, root]);

  const restart = useCallback(async () => {
    const t = term.current;
    if (!t) return;
    t.reset();
    setStatus("loading");
    try {
      const alive = await desktop.terminalRestart(sessionKey, root, t.cols, t.rows, (bytes) => t.write(bytes));
      setStatus(alive ? "running" : "ended");
      t.focus();
    } catch (e) {
      setStatus("error");
      setMessage(`터미널을 시작하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [sessionKey, root]);

  return (
    <section className={`relative flex h-full min-h-0 flex-col overflow-hidden ${bare ? "" : "rounded-xl border border-border bg-surface"}`} aria-label={title} data-testid={ids.section}>
      {bare ? (
        status === "ended" && (
          <button
            onClick={() => void restart()}
            data-testid={ids.restart}
            className="absolute right-3 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-surface"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            종료됨 · 다시 시작
          </button>
        )
      ) : (
        <header className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted">
          <SquareTerminal className="size-3.5" aria-hidden />
          <span className="font-medium text-foreground">{title}</span>
          <span className="hidden truncate sm:inline">복사·붙여넣기: Ctrl+Shift+C / V</span>
          {status === "ended" && (
            <button
              onClick={() => void restart()}
              data-testid={ids.restart}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-foreground hover:bg-surface"
            >
              <RotateCcw className="size-3.5" aria-hidden />
              종료됨 · 다시 시작
            </button>
          )}
        </header>
      )}
      {status === "error" ? (
        <p className="p-4 text-sm text-muted" data-testid={ids.error}>
          {message}
        </p>
      ) : (
        <div ref={host} className="min-h-0 flex-1 p-2" data-testid={ids.host} style={{ background: THEMES[resolved].background }} />
      )}
    </section>
  );
}
