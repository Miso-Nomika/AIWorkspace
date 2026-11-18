"use client";

import { useId } from "react";

/**
 * 디스코드 같은 알약 모양 On/Off 토글. 키보드(스페이스·엔터)로도 켜고 끌 수 있고, 라벨과 설명이 스크린 리더에 읽힌다.
 */
export function Switch({
  checked,
  onChange,
  label,
  description,
  testId,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: React.ReactNode;
  testId?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div id={`${id}-label`} className="text-sm font-medium">
          {label}
        </div>
        {description && (
          <div id={`${id}-desc`} className="mt-0.5 text-xs leading-5 text-muted">
            {description}
          </div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-desc` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        data-testid={testId}
        className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 ${
          checked ? "bg-accent" : "bg-zinc-300 dark:bg-zinc-600"
        }`}
      >
        <span
          aria-hidden
          className={`inline-block size-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[22px]" : "translate-x-0.5"}`}
        />
      </button>
    </div>
  );
}
