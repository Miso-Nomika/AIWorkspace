// 채팅 입력창의 슬래시 명령 (순수 함수, 외부 의존 없음 — node로 직접 테스트 가능)
// 앱이 직접 처리하는 명령만 지원한다. Claude Code 자체 명령(/compact 등)은 `-p` 모드에서 동작이 불확실해 제외.

export interface SlashCommand {
  name: string;
  usage: string;
  hint: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "model", usage: "/model [haiku|sonnet|opus]", hint: "작업 모델 확인·변경" },
  { name: "plan", usage: "/plan 요청 내용", hint: "코드는 바꾸지 않고 기획만 요청 (TODO에 정리)" },
  { name: "help", usage: "/help", hint: "명령 목록" },
];

export type SlashAction =
  | { type: "none" }
  | { type: "help" }
  | { type: "model"; arg: string }
  | { type: "plan"; arg: string }
  | { type: "unknown"; name: string };

/** 입력 전체를 해석한다. 슬래시로 시작하지 않으면 일반 메시지(none) */
export function parseSlash(input: string): SlashAction {
  const text = input.trim();
  if (!text.startsWith("/")) return { type: "none" };
  const [head, ...rest] = text.slice(1).split(/\s+/);
  const name = head.toLowerCase();
  const arg = rest.join(" ").trim();
  if (name === "help") return { type: "help" };
  if (name === "model") return { type: "model", arg: arg.toLowerCase() };
  if (name === "plan") return { type: "plan", arg };
  return { type: "unknown", name: head };
}

/** 입력 중인 명령 이름(공백 전)에 맞는 후보. 슬래시만 있으면 전부 */
export function matchSlash(input: string): SlashCommand[] {
  const m = /^\/([a-z]*)$/i.exec(input);
  if (!m) return [];
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(m[1].toLowerCase()));
}

/** /plan 요청을 에이전트에 보낼 문장으로 (지침의 "기획만" 규칙이 적용된다) */
export function planPrompt(request: string): string {
  return `기획만 해줘. 코드는 바꾸지 말고 계획과 TODO 정리만 해줘: ${request}`;
}

export function helpText(): string {
  return ["사용할 수 있는 명령:", ...SLASH_COMMANDS.map((c) => `- \`${c.usage}\` — ${c.hint}`)].join("\n");
}
