"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { desktop } from "@/lib/desktop";

// 에이전트 응답 마크다운 렌더링 (원시 HTML은 렌더링하지 않음 — react-markdown 기본값)
const STYLE = [
  "text-sm leading-6 break-words",
  "[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
  "[&_h1]:mt-3 [&_h1]:mb-1.5 [&_h1]:text-base [&_h1]:font-semibold",
  "[&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-[15px] [&_h2]:font-semibold",
  "[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:font-semibold",
  "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
  "[&_a]:text-accent [&_a]:underline",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted",
  "[&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12.5px]",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-surface [&_pre]:p-3",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_table]:text-xs",
  "[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1",
  "[&_hr]:my-3 [&_hr]:border-border",
].join(" ");

export function Markdown({ text }: { text: string }) {
  return (
    <div className={STYLE}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 링크는 앱 화면 안에서 이동하지 않고(앱이 사라진다) 기본 브라우저로 연다. http(s)만 연다
          a: ({ href, children }) => (
            <a
              href={href}
              title={href}
              onClick={(e) => {
                e.preventDefault();
                if (href && /^https?:\/\//i.test(href)) void desktop.openExternalUrl(href).catch(() => {});
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
