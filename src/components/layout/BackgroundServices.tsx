"use client";

import { useEffect } from "react";
import { startAutoLearn } from "@/lib/memory-learn";
import { startMemorySync } from "@/lib/memory-sync";
import { startUpdateChecks } from "@/lib/updater";
import { startMusic } from "@/lib/music-store";
import { startHomeSync } from "@/lib/home-sync";
import { startMusicSync } from "@/lib/music-sync";
import { startUsage } from "@/lib/usage";
import { cleanupLegacyData } from "@/lib/store";
import { startUiPrefs } from "@/lib/ui-prefs";

/** 앱 전체에서 한 번만 실행되는 백그라운드 작업: 이전 데이터 정리, 화면 설정 반영, 공통 메모리·음악·홈 위젯 동기화, 대화 기록 자동 학습, 새 버전 확인, 플랜·사용량 확인 */
export function BackgroundServices() {
  useEffect(() => {
    void cleanupLegacyData();
    startUiPrefs();
    startMemorySync();
    startAutoLearn();
    startUpdateChecks();
    startUsage();
    startMusic();
    startMusicSync();
    startHomeSync();
  }, []);
  return null;
}
