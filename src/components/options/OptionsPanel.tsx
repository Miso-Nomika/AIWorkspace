"use client";

import { useState } from "react";
import { Volume2 } from "lucide-react";
import { HostManager } from "@/components/remote/HostManager";
import { PageHeader } from "@/components/ui/PageHeader";
import { Switch } from "@/components/ui/Switch";
import { desktop, errorMessage } from "@/lib/desktop";
import { percentToVolume, volumeToPercent, type SoundSource } from "@/lib/notify-core";
import { playChime } from "@/lib/notify-sound";
import { useOptions } from "@/lib/options";

const SOUND_TABS: { id: SoundSource; label: string; switchLabel: string; hint: string }[] = [
  { id: "chat", label: "채팅", switchLabel: "채팅에서 알림음 켜기", hint: "사이드바 \"채팅\"(일반 채팅)이 답을 끝냈을 때" },
  { id: "project", label: "프로젝트", switchLabel: "프로젝트에서 알림음 켜기", hint: "프로젝트 화면의 AI 채팅이 작업을 끝냈을 때" },
];

/** 옵션 탭: 프로그램을 닫을 때의 동작 등 앱 동작 설정 (On/Off 토글) */
export function OptionsPanel() {
  const { options, setOption } = useOptions();
  const [autostartError, setAutostartError] = useState<string | null>(null);
  const [soundTab, setSoundTab] = useState<SoundSource>("chat");
  const tab = SOUND_TABS.find((t) => t.id === soundTab) ?? SOUND_TABS[0];
  const tabOn = tab.id === "chat" ? options.soundChat : options.soundProject;
  const tabVolume = tab.id === "chat" ? options.soundChatVolume : options.soundProjectVolume;

  /** 자동 시작은 운영체제 등록이 성공했을 때만 저장한다 (실패하면 켜지지 않고 이유를 보여 준다) */
  async function changeAutostart(value: boolean) {
    setAutostartError(null);
    try {
      await desktop.setAutostart(value);
      setOption("autostart", value);
    } catch (error) {
      setAutostartError(errorMessage(error));
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <PageHeader title="옵션" description="앱이 동작하는 방식을 설정합니다. 바꾸면 바로 저장됩니다." />

      <section className="rounded-xl border border-border bg-surface px-4" aria-label="실행 옵션">
        <Switch
          label="창을 닫을 때 백그라운드에서 계속 실행"
          testId="option-close-to-tray"
          checked={options.closeToTray}
          onChange={(value) => setOption("closeToTray", value)}
          description={
            <>
              끄면 창을 닫을 때 프로그램이 종료됩니다. 켜면 창만 숨기고 계속 실행되며, 화면 구석의 트레이 아이콘에서 다시 열거나 종료할 수 있습니다. Linux에서 트레이
              아이콘이 보이지 않으면 앱을 한 번 더 실행하면 숨은 창이 열립니다.
            </>
          }
        />
        <div className="border-t border-border" />
        <Switch
          label="5시간 세션이 끝나면 자동으로 새 세션 시작"
          testId="option-auto-session"
          checked={options.autoSession}
          onChange={(value) => setOption("autoSession", value)}
          description={
            <>
              Claude의 5시간 세션이 끝나면 가장 작은 모델을 한 번 실행해 새 세션을 바로 시작하고, 상단 사용량 막대를 새로 고칩니다. 앱이 켜져 있으면(창을 숨겨도) 동작하며, 이미
              세션이 살아 있으면 실행하지 않습니다. 공식 Claude Code로 5시간에 한 번 아주 작은 요청(사실상 사용량 0)만 보내지만, 세션이 일찍 시작되므로 실제 작업을 시작했을 때
              남은 세션 시간이 짧아질 수 있습니다. 예약 호출이 약관상 허용되는지는 확실하지 않아 기본은 꺼짐입니다.
            </>
          }
        />
        <div className="border-t border-border" />
        <Switch
          label="채팅이 끝나면 알림음"
          testId="option-chat-sound"
          checked={options.chatSound}
          onChange={(value) => setOption("chatSound", value)}
          description={<>채팅이 답을 끝내면(오류로 끝난 경우 포함, 직접 멈춘 경우는 제외) 짧은 알림음을 냅니다. 다른 창을 보고 있어도 들립니다. 켜면 아래에서 채팅·프로젝트별로 켜고 끄기, 음량, 미리 듣기를 정할 수 있습니다. 기본은 켜짐입니다.</>}
        />
        {options.chatSound && (
          <div className="mb-3 rounded-lg border border-border bg-background" data-testid="sound-settings">
            <div role="tablist" aria-label="알림음 세부 설정" className="flex gap-1 border-b border-border px-2 pt-2">
              {SOUND_TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={soundTab === t.id}
                  onClick={() => setSoundTab(t.id)}
                  data-testid={`sound-tab-${t.id}`}
                  className={`rounded-t-md px-3 py-1.5 text-sm ${soundTab === t.id ? "bg-surface font-medium text-accent" : "text-muted hover:text-foreground"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div role="tabpanel" className="px-3" data-testid={`sound-panel-${tab.id}`}>
              <Switch
                label={tab.switchLabel}
                testId={`option-sound-${tab.id}`}
                checked={tabOn}
                onChange={(value) => setOption(tab.id === "chat" ? "soundChat" : "soundProject", value)}
                description={tab.hint}
              />
              <div className="flex flex-wrap items-center gap-3 border-t border-border py-3">
                <label className="flex min-w-0 flex-1 items-center gap-3 text-sm">
                  <span className="shrink-0">음량</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={volumeToPercent(tabVolume)}
                    onChange={(e) => setOption(tab.id === "chat" ? "soundChatVolume" : "soundProjectVolume", percentToVolume(Number(e.target.value)))}
                    aria-label={`${tab.label} 알림음 음량`}
                    data-testid={`sound-volume-${tab.id}`}
                    className="min-w-24 flex-1 accent-[var(--accent)]"
                  />
                  <span className="w-10 text-right tabular-nums text-muted" data-testid={`sound-volume-text-${tab.id}`}>
                    {volumeToPercent(tabVolume)}%
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => playChime(tabVolume)}
                  data-testid={`sound-preview-${tab.id}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm hover:bg-background"
                >
                  <Volume2 className="size-4" aria-hidden />
                  미리 듣기
                </button>
              </div>
            </div>
          </div>
        )}
        <div className="border-t border-border" />
        <Switch
          label="컴퓨터를 켜면 자동 실행"
          testId="option-autostart"
          checked={options.autostart}
          onChange={(value) => void changeAutostart(value)}
          description={
            <>
              컴퓨터에 로그인하면 앱이 창 없이 트레이로만 실행됩니다(트레이를 쓸 수 없는 환경에서는 창이 열립니다). 창을 닫으면 종료되는 규칙은 위 옵션을 따릅니다.
              {autostartError && <span className="mt-1 block text-red-600">{autostartError}</span>}
            </>
          }
        />
      </section>

      <section className="mt-6 rounded-xl border border-border bg-surface p-4" aria-label="원격 접속" data-testid="remote-hosts">
        <h2 className="text-sm font-semibold">원격 접속 (SSH)</h2>
        <p className="mt-1 mb-3 text-xs text-muted">
          SSH로 다른 PC(Linux·Mac)의 폴더를 프로젝트로 열어 이 PC와 같은 방식으로 작업합니다. 새 프로젝트에서 “원격(SSH)”을 고르면 여기 등록한 PC를 쓸 수 있습니다. 키 인증만 지원하며, 원격 PC에는 Claude Code가
          설치되어 있고 로그인되어 있어야 합니다. 공통 메모리는 항상 이 PC의 것을 씁니다.
        </p>
        <HostManager />
      </section>
    </div>
  );
}
