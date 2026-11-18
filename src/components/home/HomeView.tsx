"use client";

import { useState, type PointerEvent } from "react";
import { Check, LayoutGrid } from "lucide-react";
import { CustomWidget } from "./CustomWidget";
import { HomeCreator, type EditTarget } from "./HomeCreator";
import { HomeEditBar } from "./HomeEditBar";
import { PageHeader } from "@/components/ui/PageHeader";
import { useHome } from "@/lib/home-store";
import { HOME_MAX_ITEMS, moveItem, setItemHidden, setItemSize, shiftItem, type Size, type WidgetDef } from "@/lib/home-widget-core";
import { newId } from "@/lib/storage";

// 크기 → 넓은 화면(6칸)에서 차지하는 칸. 1 = 3분의 1, 2 = 절반, 3 = 전체 폭 (좁은 창은 크기와 관계없이 1열)
const SPAN: Record<Size, string> = { 1: "md:col-span-2", 2: "md:col-span-3", 3: "md:col-span-6" };

/** 개인 홈: home.json의 위젯 목록을 카드로 보여 준다 (모두 선언형 정의로 만든 사용자 위젯, 처음에는 비어 있다). 위쪽 입력창으로 새 위젯을 만들고, 편집 모드에서 순서·크기·숨김을 바꾼다 */
export function HomeView() {
  const { home, update } = useHome();
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [arranging, setArranging] = useState(false);
  const [drag, setDrag] = useState<{ id: string; over: string | null } | null>(null);
  // 편집 모드에서는 숨긴 위젯도 (흐리게) 보여 다시 보이게 할 수 있다
  const items = arranging ? home.items : home.items.filter((item) => !item.hidden);

  /**
   * 미리보기에서 [추가]/[적용]: 새 위젯은 맨 아래에 붙이고, 수정은 그 자리의 정의만 바꾼다. 못 하면 이유를 돌려준다.
   * 고치는 동안 그 위젯이 다른 PC에서 지워졌으면(동기화) 수정 내용을 잃지 않게 새 위젯으로 추가한다.
   */
  function accept(def: WidgetDef, editingId: string | null): string | null {
    const stillThere = editingId !== null && home.items.some((i) => i.id === editingId);
    if (!stillThere && home.items.length >= HOME_MAX_ITEMS) return `위젯은 ${HOME_MAX_ITEMS}개까지 둘 수 있습니다. 하나를 지운 뒤 추가하세요`;
    update((h) =>
      editingId !== null && h.items.some((i) => i.id === editingId)
        ? { ...h, items: h.items.map((i) => (i.id === editingId ? { ...i, def } : i)) }
        : { ...h, items: [...h.items, { id: `u${newId()}`, size: 2, hidden: false, def }] },
    );
    return null;
  }

  // 끌어서 옮기기: 손잡이를 잡고 다른 카드 위에서 놓으면 그 카드의 자리로 간다 (라이브러리 없이 포인터 이벤트로 처리)
  const overId = (event: PointerEvent) => {
    for (const node of document.elementsFromPoint(event.clientX, event.clientY)) {
      const id = (node as HTMLElement).closest?.("[data-home-id]")?.getAttribute("data-home-id");
      if (id) return id;
    }
    return null;
  };
  function dragStart(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id, over: null });
  }
  function dragMove(event: PointerEvent<HTMLButtonElement>) {
    if (!drag) return;
    const over = overId(event);
    const next = over === drag.id ? null : over;
    if (next !== drag.over) setDrag({ ...drag, over: next });
  }
  function dragEnd(event: PointerEvent<HTMLButtonElement>) {
    if (!drag) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const { id, over } = drag;
    setDrag(null);
    if (over) update((h) => moveItem(h, id, h.items.findIndex((i) => i.id === over)));
  }

  const onlyHidden = !arranging && home.items.length > 0 && items.length === 0;
  return (
    <div className={`mx-auto max-w-5xl p-4 md:p-8 ${drag ? "select-none" : ""}`} data-testid="home-view">
      <PageHeader
        title="홈"
        description="원하는 정보를 모아 보는 화면입니다."
        action={
          home.items.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setArranging((v) => !v);
                setDrag(null);
              }}
              title={arranging ? "편집 끝내기" : "홈 편집"}
              aria-label={arranging ? "편집 끝내기" : "홈 편집"}
              aria-pressed={arranging}
              data-testid="home-arrange-toggle"
              className={`inline-flex size-9 items-center justify-center rounded-lg border ${arranging ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-background hover:text-foreground"}`}
            >
              {arranging ? <Check className="size-4" aria-hidden /> : <LayoutGrid className="size-4" aria-hidden />}
            </button>
          )
        }
      />
      <HomeCreator key={editing?.id ?? "new"} editing={editing} onStopEditing={() => setEditing(null)} onAccept={accept} />
      {home.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted" data-testid="home-empty">
          아직 위젯이 없습니다. 위 입력창에 원하는 위젯을 말해 보세요 (예: 오늘 할 일 목록, 크리스마스 D-day, 서울 날씨).
        </p>
      ) : onlyHidden ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted" data-testid="home-all-hidden">
          위젯을 모두 숨겼습니다. 오른쪽 위 편집 아이콘에서 다시 보이게 할 수 있습니다.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-6">
          {items.map((item) => {
            const title = typeof (item.def as { title?: unknown } | undefined)?.title === "string" ? (item.def as { title: string }).title : "위젯";
            const dragging = drag?.id === item.id;
            const target = drag?.over === item.id;
            return (
              <div
                key={item.id}
                data-home-id={item.id}
                data-testid={`home-item-${item.id}`}
                className={`min-w-0 rounded-xl ${SPAN[item.size]} ${item.hidden ? "opacity-40" : ""} ${dragging ? "opacity-50" : ""} ${target ? "ring-2 ring-accent" : ""}`}
              >
                {arranging && (
                  <HomeEditBar
                    id={item.id}
                    size={item.size}
                    hidden={item.hidden}
                    onShift={(delta) => update((h) => shiftItem(h, item.id, delta))}
                    onSize={(size) => update((h) => setItemSize(h, item.id, size))}
                    onHidden={(hidden) => update((h) => setItemHidden(h, item.id, hidden))}
                    onDragStart={(e) => dragStart(e, item.id)}
                    onDragMove={dragMove}
                    onDragEnd={dragEnd}
                    onDragCancel={() => setDrag(null)}
                  />
                )}
                <CustomWidget
                  id={item.id}
                  def={item.def}
                  onChange={(def) => update((h) => ({ ...h, items: h.items.map((i) => (i.id === item.id ? { ...i, def } : i)) }))}
                  onRemove={() => {
                    if (editing?.id === item.id) setEditing(null);
                    update((h) => ({ ...h, items: h.items.filter((i) => i.id !== item.id) }));
                  }}
                  onEdit={() => setEditing({ id: item.id, title, def: item.def })}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
