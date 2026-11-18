"use client";

// 확대·축소 (Ctrl+휠·터치패드 핀치·막대·Ctrl+0/=/-). 영역(패널)마다 따로 두고 이 PC에만 저장한다.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStoredState } from "./storage";
import { ZOOM_DEFAULT, clampZoom, fractionOf, keyZoom, scrollShift, wheelZoom } from "./zoom-core";

const SAVE_DELAY_MS = 300;
const EMPTY: Record<string, number> = {};

/**
 * `bind`를 확대·축소를 받을 영역(패널) 바깥 요소의 ref로 건다:
 * 그 안에서 Ctrl+휠을 굴리거나 Ctrl+0/=/-를 누르면 이 영역의 비율만 바뀌고 앱 전체는 변하지 않는다.
 * `zoom`(%)은 안쪽 내용에 CSS zoom으로 적용한다. 저장은 300ms 모아서 한다.
 *
 * 확대·축소는 커서 위치 기준이다: 영역 안에서 `data-zoom-content`가 붙은 요소(비율이 적용되는 내용)를 찾아,
 * 바꾸기 전에 커서가 그 내용의 어느 지점을 가리키는지 기억했다가 바꾼 뒤 같은 지점이 커서 아래에 오도록 스크롤한다.
 * 막대·키보드처럼 커서가 없을 때는 보이는 영역의 가운데 기준이다. stickBottom이면(채팅) 맨 아래를 보고 있을 때 맨 아래를 유지한다.
 */
interface Anchor {
  scroller: HTMLElement;
  content: HTMLElement;
  x: number;
  y: number;
  fx: number;
  fy: number;
  bottom: boolean;
}

/** content에서 위로 올라가며 처음 만나는 스크롤 영역 (root까지) */
function scrollParent(content: HTMLElement, root: HTMLElement): HTMLElement | null {
  for (let node = content.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowX + style.overflowY)) return node;
    if (node === root) break;
  }
  return null;
}

export function useZoom(key: string, options: { stickBottom?: boolean } = {}) {
  const stickBottom = !!options.stickBottom;
  const [stored, setStored] = useStoredState<Record<string, number>>("zoom", EMPTY);
  const [draft, setDraft] = useState<number | null>(null);
  const zoom = draft ?? (typeof stored[key] === "number" ? clampZoom(stored[key]) : ZOOM_DEFAULT);
  const latest = useRef(zoom);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const root = useRef<HTMLElement | null>(null);
  const anchor = useRef<Anchor | null>(null);

  /** 비율을 바꾸기 전: 커서(없으면 보이는 영역의 가운데)가 내용의 어느 지점인지 기억한다 */
  const remember = useCallback(
    (point?: { x: number; y: number }) => {
      const el = root.current;
      const content = el?.querySelector<HTMLElement>("[data-zoom-content]");
      const scroller = el && content ? scrollParent(content, el) : null;
      if (!content || !scroller) return;
      const view = scroller.getBoundingClientRect();
      const x = point?.x ?? view.left + view.width / 2;
      const y = point?.y ?? view.top + view.height / 2;
      const box = content.getBoundingClientRect();
      anchor.current = {
        scroller,
        content,
        x,
        y,
        fx: fractionOf(box.left, box.width, x),
        fy: fractionOf(box.top, box.height, y),
        bottom: stickBottom && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 4,
      };
    },
    [stickBottom],
  );

  // 비율이 화면에 반영된 직후(그리기 전) 기억해 둔 지점이 같은 자리에 오도록 스크롤을 맞춘다
  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    if (!a || !a.content.isConnected) return;
    if (a.bottom) {
      a.scroller.scrollTop = a.scroller.scrollHeight;
      return;
    }
    const box = a.content.getBoundingClientRect();
    a.scroller.scrollLeft += scrollShift(box.left, box.width, a.fx, a.x);
    a.scroller.scrollTop += scrollShift(box.top, box.height, a.fy, a.y);
  }, [zoom]);

  useEffect(() => {
    latest.current = zoom;
  }, [zoom]);
  // 화면을 떠날 때(파일을 바꿔 뷰어가 다시 만들어질 때 등) 아직 저장 전인 값은 바로 저장한다
  const latestKey = useRef(key);
  const setStoredRef = useRef(setStored);
  useEffect(() => {
    latestKey.current = key;
    setStoredRef.current = setStored;
  }, [key, setStored]);
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        const value = latest.current;
        setStoredRef.current((prev) => ({ ...prev, [latestKey.current]: value }));
      }
      cleanup.current?.();
    },
    [],
  );

  const setZoom = useCallback(
    (next: number, point?: { x: number; y: number }) => {
      const value = clampZoom(next);
      if (value !== latest.current) remember(point);
      latest.current = value;
      setDraft(value);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        setStored((prev) => ({ ...prev, [key]: latest.current }));
        setDraft(null);
      }, SAVE_DELAY_MS);
    },
    [key, remember, setStored],
  );

  const bind = useCallback(
    (el: HTMLElement | null) => {
      cleanup.current?.();
      cleanup.current = null;
      root.current = el;
      if (!el) return;
      const onWheel = (e: WheelEvent) => {
        if (!e.ctrlKey) return;
        e.preventDefault(); // 브라우저 기본 확대를 막고 이 영역만 바꾼다
        setZoom(wheelZoom(latest.current, e.deltaY), { x: e.clientX, y: e.clientY });
      };
      const onKey = (e: KeyboardEvent) => {
        if (!e.ctrlKey || e.altKey || e.isComposing) return;
        const next = keyZoom(latest.current, e.key);
        if (next === null) return;
        e.preventDefault();
        setZoom(next);
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      el.addEventListener("keydown", onKey);
      cleanup.current = () => {
        el.removeEventListener("wheel", onWheel);
        el.removeEventListener("keydown", onKey);
      };
    },
    [setZoom],
  );

  return { zoom, setZoom, bind };
}
