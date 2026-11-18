"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { sameHome, stampHome } from "./home-merge";
import { defaultHome, migrateHome, type HomeFile } from "./home-widget-core";
import { getStored, setStored, useStoredState } from "./storage";

const KEY = "home"; // 앱 데이터 폴더의 home.json
const BROKEN_KEY = "home-broken";
const NONE = null; // 저장된 적 없음 (참조가 고정된 fallback)

/**
 * 홈의 위젯 목록. 저장된 파일이 없으면 빈 홈을 보여 주고, 바꿀 때 처음 저장한다. 바꿀 때마다(update 한 곳에서) 수정 시각·삭제 기록·순서 시각을 찍어
 * 여러 PC의 홈을 합칠 수 있게 한다 (src/lib/home-merge.ts, 동기화는 home-sync.ts).
 * 모양이 아예 틀린 파일이면 원본을 home-broken으로 한 번 따로 보관한 뒤 기본 홈을 쓴다.
 */
export function useHome() {
  const [raw, setRaw] = useStoredState<unknown>(KEY, NONE);
  const migrated = useMemo(() => (raw === NONE ? null : migrateHome(raw)), [raw]);
  const broken = raw !== NONE && migrated === null;
  const kept = useRef(false);
  useEffect(() => {
    if (broken && !kept.current) {
      kept.current = true;
      setStored(BROKEN_KEY, raw);
    }
  }, [broken, raw]);
  const home = useMemo(() => migrated ?? defaultHome(), [migrated]);
  const update = useCallback(
    (fn: (home: HomeFile) => HomeFile) =>
      setRaw((prev: unknown) => {
        const before = migrateHome(prev) ?? defaultHome();
        return stampHome(before, fn(before), new Date().toISOString());
      }),
    [setRaw],
  );
  return { home, update, broken };
}

/** 지금 저장된 홈 (훅 밖에서 읽는다: 동기화) */
export function getHome(): HomeFile {
  return migrateHome(getStored<unknown>(KEY, NONE)) ?? defaultHome();
}

/** 합친 홈을 저장한다. 내용이 같으면 저장하지 않는다 (저장 → 동기화 → 저장이 끝없이 도는 것을 막는다). 수정 시각은 합친 값 그대로 둔다 */
export function applyMergedHome(merged: HomeFile) {
  if (!sameHome(getHome(), merged)) setStored(KEY, merged);
}
