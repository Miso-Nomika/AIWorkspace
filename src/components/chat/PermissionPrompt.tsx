"use client";

import { useState } from "react";
import { HelpCircle, ShieldQuestion } from "lucide-react";
import { Markdown } from "./Markdown";
import type { PermissionDecision, PermissionRequest } from "@/lib/backend";

interface Props {
  agentName: string;
  request: PermissionRequest;
  onDecide: (decision: PermissionDecision) => void;
}

/** 실행 중 권한 요청 (터미널의 "Do you want to proceed?"와 같음) 또는 에이전트의 질문 */
export function PermissionPrompt({ agentName, request, onDecide }: Props) {
  if (request.questions?.length) return <QuestionPrompt agentName={agentName} request={request} onDecide={onDecide} />;

  const { summary } = request;
  const isPlan = request.toolName === "ExitPlanMode";
  return (
    <div role="alertdialog" aria-label="권한 요청" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
      <div className="mb-2 flex items-center gap-1.5 font-medium">
        <ShieldQuestion className="size-4 text-amber-600" aria-hidden />
        {isPlan ? `${agentName}가 계획을 실행해도 되는지 묻습니다` : `${agentName}가 다음 작업을 하려고 합니다`}
      </div>
      <div className="mb-1 text-xs text-muted">{request.toolName}</div>
      <div className="mb-2 font-medium" data-testid="permission-label">
        {summary.label}
      </div>
      {request.description && !isPlan && !summary.label.includes(request.description) && (
        <p className="mb-2 text-xs text-muted">{request.description}</p>
      )}
      {summary.detail &&
        (isPlan ? (
          <div className="mb-2 max-h-72 overflow-auto rounded-md border border-border bg-background p-2">
            <Markdown text={summary.detail} />
          </div>
        ) : (
          <pre className="mb-2 max-h-56 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-xs whitespace-pre-wrap">
            {summary.detail}
          </pre>
        ))}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onDecide({ behavior: "allow" })}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white dark:text-zinc-950"
        >
          {isPlan ? "계획대로 진행" : "허용"}
        </button>
        {request.suggestedRule && (
          <button
            onClick={() => onDecide({ behavior: "allow", rememberRule: request.suggestedRule })}
            title={`이 프로젝트에서 '${request.suggestedRule}'는 다시 묻지 않습니다`}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
          >
            항상 허용 <span className="font-mono text-muted">{request.suggestedRule}</span>
          </button>
        )}
        <button
          onClick={() => onDecide({ behavior: "deny", message: "사용자가 거부했습니다. 다른 방법을 제안하거나 지시를 기다리세요." })}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-red-600"
        >
          거부
        </button>
      </div>
    </div>
  );
}

function QuestionPrompt({ agentName, request, onDecide }: Props) {
  const questions = request.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});

  const answerOf = (q: string) => (custom[q]?.trim() ? [custom[q].trim()] : (answers[q] ?? []));
  const complete = questions.every((q) => answerOf(q.question).length > 0);

  const toggle = (question: string, label: string, multi: boolean) =>
    setAnswers((prev) => {
      const current = prev[question] ?? [];
      const next = multi ? (current.includes(label) ? current.filter((l) => l !== label) : [...current, label]) : [label];
      return { ...prev, [question]: next };
    });

  const submit = () => {
    const result: Record<string, string> = {};
    for (const q of questions) result[q.question] = answerOf(q.question).join(", ");
    onDecide({ behavior: "allow", updatedInput: { ...request.input, answers: result } });
  };

  return (
    <div role="alertdialog" aria-label="에이전트 질문" className="rounded-xl border border-accent bg-accent-soft p-3 text-sm">
      <div className="mb-2 flex items-center gap-1.5 font-medium">
        <HelpCircle className="size-4 text-accent" aria-hidden />
        {agentName}의 질문
      </div>
      {questions.map((q) => (
        <fieldset key={q.question} className="mb-3">
          <legend className="mb-1.5 font-medium">{q.question}</legend>
          <div className="flex flex-col gap-1.5">
            {q.options.map((o) => {
              const selected = (answers[q.question] ?? []).includes(o.label) && !custom[q.question]?.trim();
              return (
                <button
                  key={o.label}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggle(q.question, o.label, q.multiSelect)}
                  className={`rounded-lg border px-3 py-1.5 text-left ${selected ? "border-accent bg-background" : "border-border bg-background/60"}`}
                >
                  <div className="text-xs font-medium">{o.label}</div>
                  {o.description && <div className="text-xs text-muted">{o.description}</div>}
                </button>
              );
            })}
            <input
              value={custom[q.question] ?? ""}
              onChange={(e) => setCustom((prev) => ({ ...prev, [q.question]: e.target.value }))}
              placeholder="직접 입력 (선택)"
              aria-label={`${q.question} 직접 입력`}
              className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs outline-none focus:border-accent"
            />
          </div>
        </fieldset>
      ))}
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={!complete}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:text-zinc-950"
        >
          답변 보내기
        </button>
        <button
          onClick={() => onDecide({ behavior: "deny", message: "사용자가 질문에 답하지 않았습니다." })}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
        >
          건너뛰기
        </button>
      </div>
    </div>
  );
}
