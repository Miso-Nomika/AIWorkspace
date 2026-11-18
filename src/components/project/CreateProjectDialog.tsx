"use client";

import { useEffect, useRef, useState } from "react";
import { FolderOpen, FolderPlus, Monitor, Server, X } from "lucide-react";
import { HostManager } from "@/components/remote/HostManager";
import { ClaudeSetup } from "@/components/remote/ClaudeSetup";
import { RemoteFolderPicker } from "@/components/remote/RemoteFolderPicker";
import { buttonGhost, buttonPrimary, inputClass } from "@/components/ui/styles";
import { desktop, errorMessage } from "@/lib/desktop";
import type { Platform } from "@/lib/platform";
import { remoteBaseName } from "@/lib/ssh-core";
import { useSshHosts } from "@/lib/ssh-hosts";
import type { Project } from "@/lib/types";

type FolderMode = "new" | "existing";

interface Props {
  open: boolean;
  platform: Platform;
  onClose: () => void;
  onCreate: (input: Omit<Project, "id" | "createdAt">) => void;
  /** 이미 다른 프로젝트로 등록된 폴더인지 */
  isPathRegistered: (path: string) => boolean;
  /** 같은 원격 접속의 같은 폴더가 이미 다른 프로젝트로 등록되어 있는지 */
  isRemoteRegistered: (hostId: string, path: string) => boolean;
}

function baseName(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

export function CreateProjectDialog({ open, platform, onClose, onCreate, isPathRegistered, isRemoteRegistered }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<FolderMode>("new");
  const [parentDir, setParentDir] = useState<string | null>(null); // null → 기본 위치
  const [existingPath, setExistingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 원격(SSH): 프로젝트 폴더가 다른 PC에 있다
  const { hosts } = useSshHosts();
  const [where, setWhere] = useState<"local" | "remote">("local");
  const [hostId, setHostId] = useState<string | null>(null);
  const [remotePath, setRemotePath] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const host = hosts.find((h) => h.id === (hostId ?? hosts[0]?.id));

  const parent = parentDir ?? platform.defaultProjectsDir ?? "";

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function reset() {
    setName("");
    setDescription("");
    setMode("new");
    setParentDir(null);
    setExistingPath(null);
    setError(null);
    setWhere("local");
    setHostId(null);
    setRemotePath(null);
    setManaging(false);
  }

  async function chooseParent() {
    const picked = await desktop.pickFolder(parent || undefined);
    if (picked) setParentDir(picked);
  }

  async function chooseExisting() {
    const picked = await desktop.pickFolder(platform.defaultProjectsDir ?? undefined);
    if (!picked) return;
    setExistingPath(picked);
    setError(null);
    if (!name.trim()) setName(baseName(picked));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setError(null);

    if (!platform.deviceId) return setError("기기 정보를 불러오는 중입니다. 잠시 후 다시 시도하세요.");
    let location: Project["location"];
    if (where === "remote") {
      if (!host) return setError("원격 PC를 먼저 추가하세요.");
      if (!remotePath) return setError("프로젝트로 사용할 원격 폴더를 선택하세요.");
      if (isRemoteRegistered(host.id, remotePath)) return setError("이미 다른 프로젝트로 등록된 폴더입니다.");
      onCreate({
        name: trimmed,
        description: description.trim(),
        agent: "claude-code",
        location: { deviceId: platform.deviceId, deviceName: platform.deviceName ?? undefined, path: remotePath, remote: { hostId: host.id } },
      });
      reset();
      return;
    }
    setBusy(true);
    try {
      let path: string;
      if (mode === "new") {
        path = await desktop.createProjectDir(parent, trimmed);
      } else {
        if (!existingPath) return setError("프로젝트로 사용할 폴더를 선택하세요.");
        if (isPathRegistered(existingPath)) return setError("이미 다른 프로젝트로 등록된 폴더입니다.");
        path = existingPath;
      }
      location = { deviceId: platform.deviceId, deviceName: platform.deviceName ?? undefined, path };
    } catch (err) {
      return setError(errorMessage(err));
    } finally {
      setBusy(false);
    }

    onCreate({ name: trimmed, description: description.trim(), agent: "claude-code", location });
    reset();
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border border-border bg-surface p-0 text-foreground backdrop:bg-black/40"
    >
      <form onSubmit={submit} className="flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">새 프로젝트</h2>
          <button type="button" onClick={onClose} aria-label="닫기" className="rounded p-1 text-muted hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <label className="flex flex-col gap-1.5 text-sm">
          이름
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-project"
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          설명 <span className="text-xs text-muted">(선택)</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="프로젝트에 대한 짧은 설명"
            className={inputClass}
          />
        </label>

        <div role="radiogroup" aria-label="프로젝트가 있는 곳" className="grid grid-cols-2 gap-2 text-sm">
          {(
            [
              { id: "local", label: "이 PC", icon: Monitor },
              { id: "remote", label: "원격(SSH)", icon: Server },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={where === id}
              onClick={() => {
                setWhere(id);
                setError(null);
              }}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${where === id ? "border-accent bg-accent-soft" : "border-border hover:bg-background"}`}
              data-testid={`where-${id}`}
            >
              <Icon className="size-4 text-accent" aria-hidden />
              {label}
            </button>
          ))}
        </div>

        {where === "remote" && (
          <fieldset className="flex flex-col gap-2 text-sm" data-testid="remote-section">
            <legend className="mb-1.5">원격 PC와 폴더</legend>
            {hosts.length === 0 ? (
              <p className="text-xs text-muted">등록된 원격 PC가 없습니다. 아래 “접속 관리”에서 추가하세요.</p>
            ) : (
              <select
                value={host?.id ?? ""}
                onChange={(e) => {
                  setHostId(e.target.value);
                  setRemotePath(null);
                }}
                className={inputClass}
                aria-label="원격 PC"
                data-testid="remote-host-select"
              >
                {hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.label} ({h.user ? `${h.user}@` : ""}
                    {h.host})
                  </option>
                ))}
              </select>
            )}
            {host && (
              <RemoteFolderPicker
                key={host.id}
                hostId={host.id}
                picked={remotePath}
                onPick={(path) => {
                  setRemotePath(path);
                  setError(null);
                  if (!name.trim()) setName(remoteBaseName(path));
                }}
              />
            )}
            {host && <ClaudeSetup key={host.id} hostId={host.id} />}
            <button type="button" onClick={() => setManaging((v) => !v)} className="self-start text-xs text-accent hover:underline" data-testid="manage-hosts">
              {managing ? "접속 관리 닫기" : "접속 관리 (원격 PC 추가·시험)"}
            </button>
            {managing && <HostManager />}
          </fieldset>
        )}

        {where === "local" && (
          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="mb-1.5">프로젝트 폴더</legend>
            <div role="radiogroup" aria-label="프로젝트 폴더" className="grid grid-cols-2 gap-2">
              {(
                [
                  { id: "new", label: "새 폴더 만들기", icon: FolderPlus },
                  { id: "existing", label: "기존 폴더 선택", icon: FolderOpen },
                ] as const
              ).map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={mode === id}
                  onClick={() => {
                    setMode(id);
                    setError(null);
                  }}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                    mode === id ? "border-accent bg-accent-soft" : "border-border hover:bg-background"
                  }`}
                >
                  <Icon className="size-4 text-accent" aria-hidden />
                  {label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 rounded-lg bg-background px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs" data-testid="folder-path">
                {mode === "new"
                  ? `${parent}\\${name.trim() || "이름"}`
                  : (existingPath ?? "선택한 폴더 없음")}
              </span>
              <button
                type="button"
                onClick={mode === "new" ? chooseParent : chooseExisting}
                className="shrink-0 text-xs text-accent hover:underline"
              >
                {mode === "new" ? "위치 변경" : "폴더 선택…"}
              </button>
            </div>
          </fieldset>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className={buttonGhost}>
            취소
          </button>
          <button type="submit" disabled={!name.trim() || busy || (where === "remote" && !remotePath)} className={buttonPrimary} data-testid="create-submit">
            {busy ? "만드는 중…" : "생성"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
