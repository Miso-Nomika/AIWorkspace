"use client";

interface Props {
  id: string;
  title: string;
  /** 제목 아래 보조 문구 (예: 갱신 시각) */
  subtitle?: React.ReactNode;
  /** 제목 줄 오른쪽 (버튼 등) */
  actions?: React.ReactNode;
  children: React.ReactNode;
}

/** 홈 위젯 공통 카드: 제목 · 보조 문구 · 오른쪽 버튼 자리 · 내용 */
export function WidgetCard({ id, title, subtitle, actions, children }: Props) {
  return (
    <section className="flex min-w-0 flex-col rounded-xl border border-border bg-surface p-4" aria-labelledby={`widget-${id}-title`} data-testid={`widget-${id}`}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={`widget-${id}-title`} className="text-sm font-semibold">
            {title}
          </h2>
          {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}
