"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, ExternalLink, Loader2, LogIn, RefreshCw, TriangleAlert } from "lucide-react";
import { buttonGhost, buttonPrimary, inputClass } from "@/components/ui/styles";
import { desktop, errorMessage } from "@/lib/desktop";
import { cleanLoginCode, lastLines, type ClaudeStatus } from "@/lib/ssh-core";

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; status: ClaudeStatus }
  | { kind: "installing"; lines: string[] }
  | { kind: "login"; loginId: string | null; url: string | null; lines: string[]; sent: boolean }
  | { kind: "error"; message: string };

/** 원격 PC의 Claude Code 설치·로그인을 이 앱 안에서 처리한다 (원격에 직접 들어가지 않아도 된다) */
export function ClaudeSetup({ hostId, onChanged }: { hostId: string; onChanged?: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const loginRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      setPhase({ kind: "ready", status: await desktop.sshClaudeStatus(hostId) });
    } catch (error) {
      setPhase({ kind: "error", message: errorMessage(error) });
    }
  }, [hostId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    return () => {
      // 창을 닫으면 진행 중이던 로그인은 취소한다
      if (loginRef.current) void desktop.sshClaudeLoginCancel(loginRef.current).catch(() => {});
    };
  }, [refresh]);

  async function install() {
    setNote(null);
    setPhase({ kind: "installing", lines: [] });
    try {
      const status = await desktop.sshClaudeInstall(hostId, (text) =>
        setPhase((prev) => (prev.kind === "installing" ? { kind: "installing", lines: lastLines([...prev.lines, text]) } : prev)),
      );
      setPhase({ kind: "ready", status });
      onChanged?.();
    } catch (error) {
      setPhase({ kind: "error", message: errorMessage(error) });
    }
  }

  async function startLogin() {
    setNote(null);
    setCode("");
    setPhase({ kind: "login", loginId: null, url: null, lines: [], sent: false });
    try {
      const id = await desktop.sshClaudeLoginStart(hostId, (event) => {
        if (event.type === "url") {
          setPhase((prev) => (prev.kind === "login" ? { ...prev, url: event.url } : prev));
          void desktop.openExternalUrl(event.url).catch(() => {}); // 이 PC의 기본 브라우저로 로그인 화면을 연다
        } else if (event.type === "output") {
          setPhase((prev) => (prev.kind === "login" ? { ...prev, lines: lastLines([...prev.lines, event.text], 4) } : prev));
        } else {
          loginRef.current = null;
          if (event.ok) {
            setNote(event.message);
            void refresh();
            onChanged?.();
          } else {
            setPhase({ kind: "error", message: event.message });
          }
        }
      });
      loginRef.current = id;
      setPhase((prev) => (prev.kind === "login" ? { ...prev, loginId: id } : prev));
    } catch (error) {
      setPhase({ kind: "error", message: errorMessage(error) });
    }
  }

  async function sendCode() {
    const cleaned = cleanLoginCode(code);
    if (phase.kind !== "login" || !phase.loginId) return;
    if (!cleaned) return setNote("코드 모양이 올바르지 않습니다. 승인 화면에 나온 코드를 공백 없이 그대로 붙여 넣으세요.");
    setNote(null);
    try {
      await desktop.sshClaudeLoginCode(phase.loginId, cleaned);
      setPhase({ ...phase, sent: true });
    } catch (error) {
      setNote(errorMessage(error));
    }
  }

  async function cancelLogin() {
    if (loginRef.current) await desktop.sshClaudeLoginCancel(loginRef.current).catch(() => {});
    loginRef.current = null;
    void refresh();
  }

  return (
    <div className="flex flex-col gap-2 text-xs" data-testid={`claude-setup-${hostId}`}>
      {phase.kind === "loading" && (
        <p className="flex items-center gap-1.5 text-muted">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          원격 Claude Code 확인 중…
        </p>
      )}

      {phase.kind === "ready" && !phase.status.installed && (
        <div className="flex flex-wrap items-center gap-2" data-testid="claude-missing">
          <span className="flex items-center gap-1.5 text-amber-600">
            <TriangleAlert className="size-3.5" aria-hidden />
            원격 PC에 Claude Code가 없습니다.
          </span>
          <button type="button" onClick={install} className={buttonPrimary} data-testid="claude-install">
            <Download className="size-4" aria-hidden />
            원격에 설치
          </button>
          <span className="text-muted">공식 설치 프로그램(claude.ai/install.sh)을 원격 PC에서 실행합니다. 원격 PC의 인터넷이 필요합니다.</span>
        </div>
      )}

      {phase.kind === "ready" && phase.status.installed && phase.status.loggedIn === false && (
        <div className="flex flex-wrap items-center gap-2" data-testid="claude-needs-login">
          <span className="flex items-center gap-1.5 text-amber-600">
            <TriangleAlert className="size-3.5" aria-hidden />
            Claude Code {phase.status.version}는 설치되어 있지만 로그인되어 있지 않습니다.
          </span>
          <button type="button" onClick={startLogin} className={buttonPrimary} data-testid="claude-login">
            <LogIn className="size-4" aria-hidden />
            로그인
          </button>
        </div>
      )}

      {phase.kind === "ready" && phase.status.installed && phase.status.loggedIn !== false && (
        <p className="flex items-center gap-1.5 text-emerald-600" data-testid="claude-ready">
          <CheckCircle2 className="size-3.5" aria-hidden />
          Claude Code {phase.status.version} · {phase.status.loggedIn ? `로그인됨${phase.status.authMethod ? ` (${phase.status.authMethod})` : ""}` : "로그인 상태를 확인하지 못했습니다"}
          <button type="button" onClick={refresh} aria-label="다시 확인" title="다시 확인" className="rounded p-1 text-muted hover:text-foreground">
            <RefreshCw className="size-3.5" />
          </button>
        </p>
      )}

      {phase.kind === "installing" && (
        <div className="flex flex-col gap-1.5" data-testid="claude-installing">
          <p className="flex items-center gap-1.5">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            원격 PC에 설치하는 중… (1~2분 걸릴 수 있습니다)
          </p>
          {phase.lines.length > 0 && <pre className="max-h-32 overflow-auto rounded bg-background p-2 font-mono text-[11px] whitespace-pre-wrap text-muted">{phase.lines.join("\n")}</pre>}
        </div>
      )}

      {phase.kind === "login" && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3" data-testid="claude-login-panel">
          {!phase.url ? (
            <p className="flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              원격 PC에서 로그인 주소를 받는 중…
            </p>
          ) : (
            <>
              <p className="font-medium">① 열린 브라우저에서 Claude 계정으로 로그인·승인하세요.</p>
              <p className="flex flex-wrap items-center gap-2 text-muted">
                브라우저가 열리지 않았다면
                <button type="button" onClick={() => void desktop.openExternalUrl(phase.url!)} className="inline-flex items-center gap-1 text-accent hover:underline" data-testid="claude-login-open">
                  <ExternalLink className="size-3.5" aria-hidden />
                  로그인 화면 다시 열기
                </button>
              </p>
              <p className="font-medium">② 승인 뒤 화면에 나온 코드를 여기에 붙여 넣으세요.</p>
              <div className="flex gap-2">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void sendCode();
                    }
                  }}
                  placeholder="승인 화면의 코드"
                  disabled={phase.sent}
                  className={inputClass}
                  data-testid="claude-login-code"
                />
                <button type="button" onClick={sendCode} disabled={!code.trim() || phase.sent || !phase.loginId} className={buttonPrimary} data-testid="claude-login-send">
                  확인
                </button>
              </div>
              {phase.sent && (
                <p className="flex items-center gap-1.5 text-muted" data-testid="claude-login-wait">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  원격 PC가 코드를 확인하는 중…
                </p>
              )}
            </>
          )}
          {phase.lines.length > 0 && <p className="text-muted">{phase.lines[phase.lines.length - 1]}</p>}
          <div>
            <button type="button" onClick={cancelLogin} className={buttonGhost}>
              취소
            </button>
          </div>
        </div>
      )}

      {phase.kind === "error" && (
        <div className="flex flex-wrap items-center gap-2" role="alert" data-testid="claude-error">
          <span className="flex items-start gap-1.5 text-red-600">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {phase.message}
          </span>
          <button type="button" onClick={refresh} className={buttonGhost}>
            다시 확인
          </button>
        </div>
      )}

      {note && (
        <p className="text-muted" data-testid="claude-note">
          {note}
        </p>
      )}
    </div>
  );
}
