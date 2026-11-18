"use client";

import { useEffect, type RefObject } from "react";

/**
 * 마우스 가운데 버튼(휠 클릭)을 누른 채 끌면 확대된 화면(스크롤 영역)이 끄는 만큼 따라 움직인다.
 * 왼쪽 버튼은 건드리지 않아 글자 선택·복사가 그대로다. 가운데 버튼을 누르는 동안은 글자 선택·이미지 끌기·휠 클릭 자동 스크롤을 막는다.
 * 스크롤할 내용이 없으면(100% 이하) 아무 일도 하지 않는다.
 */
export function usePanDrag(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let drag: { id: number; x: number; y: number; left: number; top: number; cursor: string } | null = null;

    const scrollable = () => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
    const end = () => {
      if (!drag) return;
      el.style.cursor = drag.cursor;
      if (el.hasPointerCapture(drag.id)) el.releasePointerCapture(drag.id);
      drag = null;
    };
    // 가운데 버튼의 기본 동작(자동 스크롤 아이콘·글자 선택)을 막는다
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      if (!scrollable()) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, cursor: el.style.cursor };
      el.setPointerCapture(e.pointerId); // 창 밖으로 나가도 끌기가 이어지고, 그 밖에서 떼도 끝난다
      el.style.cursor = "grabbing";
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!(e.buttons & 4)) return end(); // 버튼을 이미 뗐다
      el.scrollLeft = drag.left - (e.clientX - drag.x);
      el.scrollTop = drag.top - (e.clientY - drag.y);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (drag && e.pointerId === drag.id) end();
    };
    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    return () => {
      end();
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
    };
  }, [ref]);
}
