"use client";

import { Component, useMemo, type ReactNode } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { WidgetCard } from "./WidgetCard";
import { BlockView } from "./blocks/registry";
import { useSourceData } from "@/lib/home-source-store";
import { toggleChecklist, validateWidget, type WidgetDef } from "@/lib/home-widget-core";

interface Props {
  id: string;
  def: unknown;
  /** 체크리스트를 눌렀을 때 (없으면 읽기 전용: 미리보기) */
  onChange?: (def: WidgetDef) => void;
  onRemove?: () => void;
  /** 수정 요청 열기 (연필 아이콘) */
  onEdit?: () => void;
  /** 아직 홈에 저장되지 않은 위젯의 미리보기 (외부 자료를 저장 전에도 받아 보여 준다) */
  preview?: boolean;
}

const ICON = "rounded p-1 text-muted hover:bg-background";

/** 위젯 하나가 그리다 예외를 내도 그 칸만 오류 카드가 되게 한다 */
class Boundary extends Component<{ fallback: (message: string) => ReactNode; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  render() {
    return this.state.error !== null ? this.props.fallback(this.state.error) : this.props.children;
  }
}

function ErrorCard({ id, title, messages, onRemove }: { id: string; title: string; messages: string[]; onRemove?: () => void }) {
  return (
    <WidgetCard
      id={id}
      title={title}
      subtitle="정의 오류"
      actions={
        onRemove && (
          <button type="button" onClick={onRemove} title="이 위젯 삭제" aria-label="이 위젯 삭제" data-testid={`widget-${id}-remove`} className={`${ICON} hover:text-red-600`}>
            <Trash2 className="size-4" aria-hidden />
          </button>
        )
      }
    >
      <ul className="space-y-1 text-xs text-red-600 dark:text-red-400" data-testid={`widget-${id}-errors`}>
        {messages.map((m, i) => (
          <li key={i} className="break-words">
            {m}
          </li>
        ))}
      </ul>
    </WidgetCard>
  );
}

/** 사용자 정의 위젯: 정의를 검사해 블록으로 그린다. 검사에 실패하면 이유를 담은 오류 카드와 삭제 아이콘만 보인다 */
export function CustomWidget({ id, def, onChange, onRemove, onEdit, preview = false }: Props) {
  const check = useMemo(() => validateWidget(def), [def]);
  const source = useSourceData(check.ok ? check.def : null, preview);
  if (!check.ok) return <ErrorCard id={id} title="알 수 없는 위젯" messages={check.errors} onRemove={onRemove} />;
  const widget = check.def;
  const data = source.data;
  const errorText = Object.values(source.errors)[0];
  const hasSources = (widget.sources?.length ?? 0) > 0;
  return (
    <Boundary fallback={(message) => <ErrorCard id={id} title={widget.title} messages={[`그리는 중 오류: ${message}`]} onRemove={onRemove} />}>
      <WidgetCard
        id={id}
        title={widget.title}
        subtitle={
          hasSources && (
            <span data-testid={`widget-${id}-status`}>
              {source.loading && source.updatedAt === null ? "자료를 받는 중…" : errorText ? <span className="text-red-600 dark:text-red-400">자료를 받지 못했습니다: {errorText}</span> : source.updatedAt ? `${new Date(source.updatedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 기준` : ""}
            </span>
          )
        }
        actions={
          (onEdit || onRemove) && (
            <>
              {onEdit && (
                <button type="button" onClick={onEdit} title="수정 요청" aria-label="수정 요청" data-testid={`widget-${id}-edit`} className={`${ICON} hover:text-foreground`}>
                  <Pencil className="size-4" aria-hidden />
                </button>
              )}
              {onRemove && (
                <button type="button" onClick={onRemove} title="이 위젯 삭제" aria-label="이 위젯 삭제" data-testid={`widget-${id}-remove`} className={`${ICON} hover:text-red-600`}>
                  <Trash2 className="size-4" aria-hidden />
                </button>
              )}
            </>
          )
        }
      >
        <div className="flex flex-col gap-3">
          {widget.blocks.map((block, i) => (
            <div key={i} className="min-w-0">
              <BlockView block={block} data={data} path={[i]} onToggle={(path, index) => onChange?.(toggleChecklist(widget, path, index))} />
            </div>
          ))}
        </div>
      </WidgetCard>
    </Boundary>
  );
}
