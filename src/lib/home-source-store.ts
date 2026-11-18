"use client";

import { useEffect, useMemo, useState } from "react";
import { desktop, errorMessage } from "./desktop";
import { DEFAULT_REFRESH_MIN, parseCsv, runTransforms, xmlElementToValue, type SourceDef, type WidgetDef, type XmlLike } from "./home-widget-core";
import { flushStorage } from "./storage";

export interface SourceData {
  /** 소스 id → 변환까지 끝낸 값 (아직 못 받았으면 없음) */
  data: Record<string, unknown>;
  /** 소스 id → 받지 못한 이유 */
  errors: Record<string, string>;
  loading: boolean;
  /** 마지막으로 하나라도 받은 시각 */
  updatedAt: number | null;
}

const EMPTY: SourceData = { data: {}, errors: {}, loading: false, updatedAt: null };

/** 받은 글을 형식대로 값으로 바꾼다 (xml은 루트 요소 안쪽부터, 자식 요소가 있으면 항상 배열) */
export function parseSourceText(format: SourceDef["format"], text: string): unknown {
  switch (format ?? "json") {
    case "json":
      return JSON.parse(text);
    case "csv":
      return parseCsv(text);
    case "text":
      return text;
    case "xml": {
      const doc = new DOMParser().parseFromString(text, "application/xml");
      if (doc.getElementsByTagName("parsererror").length) throw new Error("XML을 읽지 못했습니다");
      return xmlElementToValue(doc.documentElement as unknown as XmlLike);
    }
  }
}

async function fetchSource(source: SourceDef, preview: boolean): Promise<unknown> {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(source.query ?? {})) query[k] = String(v);
  const text = await desktop.homeFetch(source.url, query, preview);
  let parsed: unknown;
  try {
    parsed = parseSourceText(source.format, text);
  } catch (error) {
    throw new Error(`받은 자료를 ${source.format ?? "json"}로 읽지 못했습니다 (${error instanceof Error ? error.message : String(error)})`);
  }
  return runTransforms(parsed, source.transform);
}

/**
 * 위젯 정의의 sources를 받아 {{id.경로}}에 쓸 값으로 만든다. 처음 한 번 받고, 가장 짧은 refreshMin(기본 30분)마다 다시 받되
 * 화면이 숨겨져 있으면 쉬었다가 다시 보일 때 오래됐으면 바로 받는다. 점검용 실행에서는 Rust가 거부해 오류로 보인다.
 * preview는 아직 홈에 저장되지 않은 위젯(미리보기)이다.
 */
export function useSourceData(def: WidgetDef | null, preview: boolean): SourceData {
  const sources = def?.sources;
  const key = JSON.stringify(sources ?? []);
  const [state, setState] = useState<{ key: string; value: SourceData }>({ key: "", value: EMPTY });
  const intervalMs = useMemo(() => Math.min(...(sources ?? []).map((s) => s.refreshMin ?? DEFAULT_REFRESH_MIN), DEFAULT_REFRESH_MIN * 100) * 60_000, [sources]);

  useEffect(() => {
    const list: SourceDef[] = JSON.parse(key);
    if (list.length === 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastAt = 0;

    async function load() {
      lastAt = Date.now();
      setState((s) => ({ key, value: { ...(s.key === key ? s.value : EMPTY), loading: true } }));
      if (!preview) await flushStorage(); // 방금 저장한 홈을 Rust가 읽을 수 있게
      const results = await Promise.allSettled(list.map((s) => fetchSource(s, preview)));
      if (cancelled) return;
      setState((s) => {
        const prev = s.key === key ? s.value : EMPTY;
        const data = { ...prev.data };
        const errors: Record<string, string> = {};
        let got = false;
        results.forEach((r, i) => {
          if (r.status === "fulfilled") {
            data[list[i].id] = r.value;
            got = true;
          } else errors[list[i].id] = errorMessage(r.reason);
        });
        return { key, value: { data, errors, loading: false, updatedAt: got ? Date.now() : prev.updatedAt } };
      });
      schedule();
    }
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.hidden) return; // 다시 보일 때 onVisible이 받는다
        void load();
      }, intervalMs);
    }
    function onVisible() {
      if (!document.hidden && !cancelled && Date.now() - lastAt >= intervalMs) void load();
    }
    void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, preview, intervalMs]);

  return state.key === key ? state.value : EMPTY;
}
