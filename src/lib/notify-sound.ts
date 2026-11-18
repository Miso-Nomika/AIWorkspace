"use client";

// 채팅이 끝났을 때 알림음 (옵션 "채팅이 끝나면 알림음"). 오디오 파일 없이 Web Audio로 짧은 두 음을 만든다.

import { CHAT_DONE_CHIME, chimeGain, chimeLength, shouldPlayChatSound, soundVolumeOf, type ChatOutcome, type SoundSource } from "./notify-core";
import { DEFAULT_OPTIONS, type Options } from "./options";
import { getStored } from "./storage";

let context: AudioContext | null = null;

/** 주어진 음량(0~1)으로 알림음을 낸다. 소리를 낼 수 없는 환경이면 조용히 건너뛴다 */
export function playChime(volume: number) {
  const peak = chimeGain(volume);
  if (typeof window === "undefined" || peak <= 0) return;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    context ??= new Ctor();
    const ctx = context;
    void ctx.resume().catch(() => {});
    const t0 = ctx.currentTime + 0.02;
    for (const note of CHAT_DONE_CHIME) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = note.freq;
      const start = t0 + note.start;
      // 딱딱한 소리가 나지 않게 짧게 올렸다가 서서히 줄인다
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + note.duration + 0.05);
    }
    // 너무 오래 열어 두지 않는다 (다음에 필요하면 다시 만든다)
    window.setTimeout(() => {
      if (context === ctx && ctx.state !== "closed") {
        void ctx.close().catch(() => {});
        context = null;
      }
    }, (chimeLength() + 1) * 1000);
  } catch {
    // 소리를 낼 수 없어도 채팅에는 영향이 없다
  }
}

/** 채팅 한 번이 끝났을 때 부른다. 옵션이 꺼져 있거나 음량이 0이면 아무것도 하지 않는다 */
export function playChatDoneSound(outcome: ChatOutcome = "done", source: SoundSource = "chat") {
  const options = getStored<Partial<Options>>("options", DEFAULT_OPTIONS);
  if (!shouldPlayChatSound(options, outcome, source)) return;
  playChime(soundVolumeOf(options, source));
}
