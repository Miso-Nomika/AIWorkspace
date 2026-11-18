// 홈 위젯 생성: 사용자의 요청을 Claude에게 보내 위젯 정의(JSON)를 받는 흐름의 순수 부분 (외부 의존은 home-widget-core뿐 — node로 직접 테스트 가능).
import { blockPromptDocs, validateWidget, type WidgetDef } from "./home-widget-core.ts";

/** 위젯 정의를 만들 때 쓰는 Claude 모델 */
export const WIDGET_MODEL = "sonnet";

export function buildWidgetSystemPrompt(): string {
  return `당신은 개인 홈 화면의 위젯 정의를 만드는 도구입니다. 사용자의 요청을 읽고 위젯 정의 JSON 하나를 만듭니다.

출력 규칙:
- 답은 \`\`\`json 코드 블록 하나만 쓰고 그 밖의 설명은 쓰지 않습니다.
- 정의 모양: {"schema":2,"title":"위젯 제목(60자 이내)","sources":[…선택…],"blocks":[블록…]}. 이 밖의 키는 쓰지 않습니다.
- 글은 한국어로 씁니다. 블록은 50개 이하, 글 하나는 2,000자 이하입니다.
- 코드·스크립트·HTML·이미지 주소·링크·API 키·비밀번호는 정의에 넣지 않습니다. 글은 글자로만 표시됩니다.
- 외부 자료가 필요하면(날씨·환율·시세·뉴스 등) sources로 공개 API 주소를 적습니다(아래 설명). 주소는 키·로그인·토큰이 필요 없는 공개 API여야 하고 확실히 아는 것만 씁니다. 주소를 지어내거나 키가 필요한 서비스, POST가 필요한 서비스는 위젯을 만들지 말고 {"unsupported":"만들 수 없는 이유를 한 문장으로"} JSON만 출력합니다. 외부 자료가 필요 없으면 값은 정의 안에 직접 적습니다(시계처럼 앱이 계산하는 것은 clock 블록).
- 수정 요청에는 현재 정의를 바탕으로 요청한 부분만 고친 전체 정의를 다시 출력합니다.

외부 자료(sources): [{"id":"영문 소문자로 시작하는 소문자·숫자·_ 1~20자","url":"https://… (https 도메인 주소, GET만, 키 불필요)","query":{"이름":"값"}(선택),"format":"json|csv|text|xml"(선택, 기본 json),"refreshMin":15 이상 1440 이하 정수(분, 선택, 기본 30),"transform":[단계…](선택)}] 최대 5개. 헤더·본문·인증은 지원하지 않고 주소나 query에 key·token 같은 이름을 쓰면 거부됩니다. 블록의 값 자리(text·stat의 value·label·sub, table의 rows, line·bar의 points, when의 path)에서 "{{id.경로}}"로 받은 자료를 씁니다. 경로는 점·[0]·[*]만 씁니다(예: "{{w.current.temperature_2m}}", 목록 전체는 "{{r.items[*].price}}"). 글 안에 끼우면 글자로만 들어가고, "{{…}}" 하나만 쓰면 숫자·목록이 그대로 들어갑니다. 아직 못 받았거나 실패하면 "-"로 보입니다.
transform 단계(소스 결과를 다듬음, 순서대로): {"op":"pick","path":"a.b"}·{"op":"map","path":"x"}(목록의 각 항목에서 x)·{"op":"filter","path":"x","is":"eq|ne|gt|lt|gte|lte|exists","value":값}·{"op":"sort","path":"x","dir":"asc|desc"}·{"op":"limit","n":개수}·{"op":"group","path":"x"}({key,items,count} 목록)·{"op":"agg","fn":"sum|avg|min|max|count","path":"x"}.
xml(RSS 등)은 루트 요소 안쪽부터이고, 자식 요소가 있는 요소는 항상 배열(하나뿐이어도), 글만 있는 요소는 문자열입니다. 예: RSS는 "{{n.channel[0].item[*].title}}".
예(서울 날씨): "sources":[{"id":"w","url":"https://api.open-meteo.com/v1/forecast","query":{"latitude":37.57,"longitude":126.98,"current":"temperature_2m,relative_humidity_2m"}}], "blocks":[{"type":"stat","label":"서울 기온","value":"{{w.current.temperature_2m}}","format":{"type":"unit","unit":"°C","digits":1}}]

사용할 수 있는 블록 (type과 키는 정확히 이대로만):
${blockPromptDocs()}

모든 블록에 공통으로 쓸 수 있는 키: format({"type":"number|percent|currency|date|relative|unit","digits":0~6,"unit":"단위","currency":"KRW"}), thresholds([{"lt|lte|gt|gte":숫자,"color":"good|warn|bad|muted|accent"}]), when({"path":"경로","op":"exists|eq|ne|gt|lt|gte|lte","value":값}).
체크리스트 항목은 사용자가 눌러서 체크할 수 있고 상태가 저장됩니다. 잘 모르는 요청은 가장 단순한 블록(text·stat·checklist)으로 만듭니다.`;
}

export function buildCreatePrompt(request: string): string {
  return `새 위젯을 만들어 주세요.\n요청: ${request.trim()}`;
}

export function buildEditPrompt(def: unknown, request: string): string {
  return `아래 위젯 정의를 요청에 맞게 고쳐 주세요.\n현재 정의:\n\`\`\`json\n${JSON.stringify(def)}\n\`\`\`\n요청: ${request.trim()}`;
}

export function buildRetryPrompt(errors: string[]): string {
  return `방금 정의를 앱이 받아들이지 않았습니다. 아래 이유를 모두 고쳐서 전체 정의를 \`\`\`json 코드 블록 하나로 다시 출력하세요.\n${errors.map((e) => `- ${e}`).join("\n")}`;
}

/** API 키·토큰처럼 보이는 값이 들어 있는지 (요청 글을 AI에게 보내기 전, 그리고 AI가 낸 정의를 받기 전에 확인한다) */
export function looksLikeSecret(text: string): boolean {
  if (/\bsk-[A-Za-z0-9_-]{16,}/.test(text)) return true;
  if (/\bgh[pousr]_[A-Za-z0-9]{20,}/.test(text)) return true;
  if (/\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i.test(text)) return true;
  if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) return true;
  if (/\bxox[baprs]-[A-Za-z0-9-]{10,}/.test(text)) return true;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return true;
  for (const token of text.match(/[A-Za-z0-9_-]{32,}/g) ?? []) {
    if (/\d/.test(token) && /[a-z]/.test(token) && /[A-Z]/.test(token)) return true;
  }
  return false;
}

export type Extracted = { ok: true; value: unknown } | { ok: false; error: string };

/** 답에서 JSON 하나를 꺼낸다: \`\`\`json 블록이 있으면 그것, 없으면 첫 { 부터 마지막 } 까지 */
export function extractWidgetJson(text: string): Extracted {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  let body = fenced ? fenced[1].trim() : "";
  if (!body) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return { ok: false, error: "답에 JSON이 없습니다" };
    body = text.slice(start, end + 1);
  }
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (error) {
    return { ok: false, error: `JSON을 읽지 못했습니다 (${error instanceof Error ? error.message : String(error)})` };
  }
}

export interface RunReply {
  text: string;
  sessionId?: string;
  isError: boolean;
  error?: string;
  cancelled: boolean;
}
export type GenResult = { ok: true; def: WidgetDef } | { ok: false; error: string; cancelled?: boolean };

/** 답 한 번을 정의로 바꾼다. 거절(unsupported)·검증 실패는 이유를 돌려준다 */
function interpret(reply: RunReply): { def: WidgetDef } | { errors: string[]; final?: boolean } {
  if (looksLikeSecret(reply.text)) return { errors: ["답에 API 키처럼 보이는 값이 있어 버렸습니다"], final: true };
  const extracted = extractWidgetJson(reply.text);
  if (!extracted.ok) return { errors: [extracted.error] };
  const value = extracted.value as Record<string, unknown> | null;
  if (value && typeof value === "object" && typeof value.unsupported === "string") return { errors: [value.unsupported.slice(0, 200)], final: true };
  const check = validateWidget(value);
  return check.ok ? { def: check.def } : { errors: check.errors };
}

/**
 * 요청 한 번으로 정의를 만든다. 검증에 실패하면 이유를 붙여 같은 세션으로 한 번만 다시 요청한다.
 * run은 실제로 Claude를 부르는 함수(테스트에서는 가짜)다.
 */
export async function generateWidget(run: (prompt: string, session?: string) => Promise<RunReply>, prompt: string): Promise<GenResult> {
  const first = await run(prompt);
  if (first.cancelled) return { ok: false, error: "취소했습니다", cancelled: true };
  if (first.isError && !first.text) return { ok: false, error: first.error || "응답을 받지 못했습니다" };
  const a = interpret(first);
  if ("def" in a) return { ok: true, def: a.def };
  if (a.final) return { ok: false, error: a.errors[0] };
  const second = await run(buildRetryPrompt(a.errors), first.sessionId);
  if (second.cancelled) return { ok: false, error: "취소했습니다", cancelled: true };
  if (second.isError && !second.text) return { ok: false, error: second.error || "응답을 받지 못했습니다" };
  const b = interpret(second);
  if ("def" in b) return { ok: true, def: b.def };
  return { ok: false, error: `위젯을 만들지 못했습니다: ${b.errors.slice(0, 3).join(" / ")}` };
}
