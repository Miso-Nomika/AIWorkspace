"use client";

import { Ban, CircleAlert, Wrench } from "lucide-react";
import type { ActivityItem } from "@/lib/types";

/** 에이전트 도구 사용 기록. 명령·diff·출력이 있으면 펼쳐서 볼 수 있다. */
export function ActivityList({ items }: { items: (ActivityItem | string)[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mb-2 space-y-0.5 border-l-2 border-border pl-2 text-xs text-muted">
      {items.map((raw, i) => {
        const item: ActivityItem = typeof raw === "string" ? { id: String(i), label: raw } : raw;
        const Icon = item.denied ? Ban : item.isError ? CircleAlert : Wrench;
        const hasDetail = !!(item.detail || item.output);
        const head = (
          <span className="flex min-w-0 items-center gap-1">
            <Icon className={`size-3 shrink-0 ${item.denied || item.isError ? "text-red-600" : ""}`} aria-hidden />
            <span className="truncate">{item.label}</span>
            {item.denied && <span className="shrink-0 text-red-600">(거부됨)</span>}
          </span>
        );
        if (!hasDetail) return <li key={item.id}>{head}</li>;
        return (
          <li key={item.id}>
            <details className="group">
              <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">{head}</summary>
              {item.detail && <Block text={item.detail} diff={/^[-+] /m.test(item.detail)} />}
              {item.output !== undefined && item.output !== "" && <Block text={item.output} error={item.isError || item.denied} />}
            </details>
          </li>
        );
      })}
    </ul>
  );
}

function Block({ text, diff, error }: { text: string; diff?: boolean; error?: boolean }) {
  return (
    <pre
      className={`my-1 max-h-72 overflow-auto rounded-md border p-2 font-mono text-[11.5px] leading-5 whitespace-pre-wrap ${
        error ? "border-red-200 text-red-700 dark:border-red-900 dark:text-red-300" : "border-border text-foreground"
      }`}
    >
      {diff
        ? text.split("\n").map((line, i) => (
            <div
              key={i}
              className={
                line.startsWith("+ ")
                  ? "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-300"
                  : line.startsWith("- ")
                    ? "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300"
                    : ""
              }
            >
              {line}
            </div>
          ))
        : text}
    </pre>
  );
}
