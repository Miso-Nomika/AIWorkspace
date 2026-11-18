"use client";

// 원격(SSH) 접속 정보 목록: 이 PC의 앱 데이터(`ssh-hosts`)에 저장한다 (Drive 동기화 안 함 — 키 경로 등 PC마다 다르다)

import { useCallback, useMemo } from "react";
import { desktop } from "./desktop";
import { normalizeHosts, type SshHost } from "./ssh-core";
import { useStoredState } from "./storage";

const KEY = "ssh-hosts";
const EMPTY: unknown[] = [];

export function useSshHosts() {
  const [raw, setRaw] = useStoredState<unknown[]>(KEY, EMPTY);
  const hosts = useMemo(() => normalizeHosts(raw), [raw]);

  /** 같은 id가 있으면 바꾸고 없으면 추가한다. 고친 접속의 열려 있던 연결은 닫는다 */
  const saveHost = useCallback(
    (host: SshHost) => {
      setRaw((prev) => {
        const list = normalizeHosts(prev);
        return list.some((h) => h.id === host.id) ? list.map((h) => (h.id === host.id ? host : h)) : [...list, host];
      });
      void desktop.sshForget(host.id).catch(() => {});
    },
    [setRaw],
  );

  const removeHost = useCallback(
    (id: string) => {
      setRaw((prev) => normalizeHosts(prev).filter((h) => h.id !== id));
      void desktop.sshForget(id).catch(() => {});
    },
    [setRaw],
  );

  return { hosts, saveHost, removeHost };
}
