"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, Pencil, Plug, Plus, ShieldAlert, Trash2, TriangleAlert } from "lucide-react";
import { buttonGhost, buttonPrimary, inputClass } from "@/components/ui/styles";
import { desktop, errorMessage } from "@/lib/desktop";
import { ClaudeSetup } from "./ClaudeSetup";
import { buildHost, describeHost, newHostId, watchModeLabel, type SshHost, type SshTestReport } from "@/lib/ssh-core";
import { useSshHosts } from "@/lib/ssh-hosts";
import { useProjects } from "@/lib/store";

type TestState =
  | { status: "testing" }
  | { status: "ok"; report: SshTestReport }
  | { status: "error"; message: string }
  | { status: "trust"; fingerprint: string };

interface Form {
  id: string | null; // null이면 새 접속
  label: string;
  host: string;
  user: string;
  port: string;
  identityFile: string;
}

const EMPTY_FORM: Form = { id: null, label: "", host: "", user: "", port: "", identityFile: "" };

/** 설정의 "원격 접속": SSH로 접속할 다른 PC를 등록하고 연결을 시험한다. 새 프로젝트 화면의 "접속 관리"에서도 쓴다 */
export function HostManager({ onChanged }: { onChanged?: () => void }) {
  const { hosts, saveHost, removeHost } = useSshHosts();
  const { projects } = useProjects();
  const [form, setForm] = useState<Form | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const inUse = (id: string) => projects.some((p) => p.location?.remote?.hostId === id);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const id = form.id ?? newHostId(form.label || form.host, hosts.map((h) => h.id));
    const built = buildHost(form, id);
    if (typeof built === "string") return setFormError(built);
    saveHost(built);
    setForm(null);
    setFormError(null);
    onChanged?.();
  }

  async function runTest(host: SshHost, trust = false) {
    setTests((t) => ({ ...t, [host.id]: { status: "testing" } }));
    try {
      const report = await desktop.sshTest(host, trust);
      setTests((t) => ({ ...t, [host.id]: { status: "ok", report } }));
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      if (code === "HOST_KEY_UNKNOWN" && !trust) {
        try {
          const fingerprint = await desktop.sshHostFingerprint(host);
          return setTests((t) => ({ ...t, [host.id]: { status: "trust", fingerprint } }));
        } catch (fingerError) {
          return setTests((t) => ({ ...t, [host.id]: { status: "error", message: errorMessage(fingerError) } }));
        }
      }
      setTests((t) => ({ ...t, [host.id]: { status: "error", message: errorMessage(error) } }));
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="host-manager">
      {hosts.length === 0 && !form && <p className="text-sm text-muted">등록된 원격 PC가 없습니다. 키 인증으로 SSH 접속이 되는 Linux·Mac을 추가하세요.</p>}

      <ul className="flex flex-col gap-2">
        {hosts.map((host) => {
          const test = tests[host.id];
          return (
            <li key={host.id} className="rounded-lg border border-border bg-background p-3" data-testid={`host-${host.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{host.label}</p>
                  <p className="truncate font-mono text-xs text-muted">{describeHost(host)}</p>
                </div>
                <button type="button" onClick={() => runTest(host)} disabled={test?.status === "testing"} className={buttonGhost} data-testid={`host-test-${host.id}`}>
                  {test?.status === "testing" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plug className="size-4" aria-hidden />}
                  연결 시험
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setForm({ id: host.id, label: host.label, host: host.host, user: host.user ?? "", port: host.port ? String(host.port) : "", identityFile: host.identityFile ?? "" });
                    setFormError(null);
                  }}
                  aria-label={`${host.label} 수정`}
                  title="수정"
                  className="rounded p-1.5 text-muted hover:text-foreground"
                >
                  <Pencil className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (inUse(host.id)) return setTests((t) => ({ ...t, [host.id]: { status: "error", message: "이 접속을 쓰는 프로젝트가 있어 지울 수 없습니다. 프로젝트를 먼저 삭제하세요." } }));
                    removeHost(host.id);
                    onChanged?.();
                  }}
                  aria-label={`${host.label} 삭제`}
                  title="삭제"
                  className="rounded p-1.5 text-muted hover:text-red-600"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>

              {test?.status === "trust" && (
                <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" role="alert" data-testid={`host-trust-${host.id}`}>
                  <p className="flex items-center gap-1.5 font-medium">
                    <ShieldAlert className="size-4 text-amber-600" aria-hidden />
                    처음 접속하는 PC입니다
                  </p>
                  <p className="mt-1 text-xs text-muted">아래 지문이 접속하려는 PC의 것과 같을 때만 신뢰하세요. (원격 PC에서 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`로 확인할 수 있습니다)</p>
                  <p className="mt-2 font-mono text-xs break-all" data-testid="host-fingerprint">
                    {test.fingerprint}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" onClick={() => runTest(host, true)} className={buttonPrimary} data-testid={`host-trust-ok-${host.id}`}>
                      신뢰하고 연결
                    </button>
                    <button type="button" onClick={() => setTests((t) => ({ ...t, [host.id]: { status: "error", message: "신뢰하지 않아 연결하지 않았습니다." } }))} className={buttonGhost}>
                      취소
                    </button>
                  </div>
                </div>
              )}

              {test?.status === "error" && (
                <p className="mt-2 flex items-start gap-1.5 text-sm text-red-600" role="alert" data-testid={`host-error-${host.id}`}>
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {test.message}
                </p>
              )}

              {test?.status === "ok" && (
                <ul className="mt-2 flex flex-col gap-1 text-xs" data-testid={`host-report-${host.id}`}>
                  <li className="flex items-center gap-1.5 text-emerald-600">
                    <CheckCircle2 className="size-3.5" aria-hidden />
                    연결됨 · {test.report.os} · 홈 {test.report.home}
                  </li>
                  <li className="text-muted">{test.report.git ? `git: ${test.report.git}` : "git이 없어 변경 탭을 쓸 수 없습니다. 원격 PC에 git을 설치하세요."}</li>
                  <li>
                    <ClaudeSetup hostId={host.id} />
                  </li>
                  <li className="text-muted">파일 변경 감지: {watchModeLabel(test.report.watch)}</li>
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {form ? (
        <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-border bg-background p-3" data-testid="host-form">
          <label className="flex flex-col gap-1 text-sm">
            이름 <span className="text-xs text-muted">(선택 — 목록에 보일 이름)</span>
            <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="연구실 서버" className={inputClass} data-testid="host-label" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            호스트 주소 <span className="text-xs text-muted">(주소 또는 ~/.ssh/config의 별칭)</span>
            <input required autoFocus value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="192.168.0.10 또는 my-server" className={inputClass} data-testid="host-address" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              사용자 <span className="text-xs text-muted">(선택)</span>
              <input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} placeholder="ubuntu" className={inputClass} data-testid="host-user" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              포트 <span className="text-xs text-muted">(기본 22)</span>
              <input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} inputMode="numeric" placeholder="22" className={inputClass} data-testid="host-port" />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            키 파일 경로 <span className="text-xs text-muted">(선택 — 비우면 ssh 설정·ssh-agent의 키를 씁니다. 비밀번호 로그인은 지원하지 않습니다)</span>
            <input value={form.identityFile} onChange={(e) => setForm({ ...form, identityFile: e.target.value })} placeholder="C:\Users\나\.ssh\id_ed25519" className={inputClass} data-testid="host-key" />
          </label>
          {formError && (
            <p role="alert" className="text-sm text-red-600" data-testid="host-form-error">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setForm(null)} className={buttonGhost}>
              취소
            </button>
            <button type="submit" className={buttonPrimary} data-testid="host-save">
              저장
            </button>
          </div>
        </form>
      ) : (
        <div>
          <button
            type="button"
            onClick={() => {
              setForm(EMPTY_FORM);
              setFormError(null);
            }}
            className={buttonGhost}
            data-testid="host-add"
          >
            <Plus className="size-4" aria-hidden />
            원격 PC 추가
          </button>
        </div>
      )}
    </div>
  );
}
