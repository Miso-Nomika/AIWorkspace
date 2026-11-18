"use client";

import { useEffect, useState } from "react";
import { Loader2, WifiOff } from "lucide-react";
import { desktop, errorMessage } from "@/lib/desktop";

/** 원격(SSH) 프로젝트 화면 위의 "연결 끊김" 표시. 끊기면 나타나고, 다시 연결되면 사라진다 */
export function ConnectionBanner({ hostId, onReconnected }: { hostId: string; onReconnected: () => void }) {
  const [lost, setLost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void desktop
      .onSshStatus((status) => {
        if (status.hostId !== hostId) return;
        setLost(!status.connected);
        if (status.connected) setError(null);
      })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else off = unlisten;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      off?.();
    };
  }, [hostId]);

  if (!lost) return null;

  async function reconnect() {
    setBusy(true);
    setError(null);
    try {
      await desktop.sshReconnect(hostId);
      setLost(false);
      onReconnected();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm" data-testid="ssh-lost">
      <WifiOff className="size-4 text-amber-600" aria-hidden />
      <span className="min-w-0 flex-1">원격 연결이 끊겼습니다. 진행 중이던 작업은 중단되었고, 다시 연결한 뒤 이어서 보낼 수 있습니다.</span>
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button type="button" onClick={reconnect} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-xs hover:bg-background disabled:opacity-50" data-testid="ssh-reconnect">
        {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        다시 연결
      </button>
    </div>
  );
}
