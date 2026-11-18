// "항상 허용" 규칙 정리 (순수 함수, 외부 의존 없음 — node로 직접 테스트 가능)
// Claude Code는 일회성 명령 전체(여러 줄 스크립트 포함)를 규칙으로 제안하는데, 그대로 저장하면 목록이 지저분해지고
// 한 번 쓴 명령은 다시 매칭되지도 않는다. 짧고 단순한 명령은 그대로 두고, 긴 명령은 `Bash(명령 하위명령 *)`로 줄인다.

/** 이 길이를 넘는 단일 명령은 줄인다 */
const MAX_EXACT_LENGTH = 80;

/** 명령을 이어 붙이거나 방향을 바꾸는 구문 (줄바꿈 포함) — 규칙으로 일반화하면 위험하다 */
const COMPOUND = /[;&|<>`\n\r]|\$\(/;

/** 아무 코드나 실행할 수 있는 실행기 — `Bash(node *)`처럼 넓히면 사실상 모든 것을 허용하게 된다 */
const RUNNERS = new Set([
  "node", "python", "python3", "py", "bash", "sh", "zsh", "fish", "cmd", "powershell", "pwsh",
  "perl", "ruby", "php", "deno", "bun", "npx", "eval", "exec", "sudo", "env", "xargs", "ssh", "docker",
]);

/**
 * 저장할 규칙으로 바꾼다. 줄일 수 없으면(여러 명령을 이은 스크립트, 임의 코드 실행기) undefined —
 * 이 경우 "항상 허용"은 제안하지 않고 이번 한 번만 허용하게 한다.
 * Bash 외 도구 규칙(`Edit` 등)은 그대로 둔다.
 */
export function shortenRule(rule: string): string | undefined {
  const match = /^Bash\(([\s\S]*)\)$/.exec(rule);
  if (!match) return rule;
  const command = match[1].trim();
  if (!command || COMPOUND.test(command)) return undefined;

  const words = command.split(/\s+/);
  const first = words[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
  if (RUNNERS.has(first) || first.includes("=")) return undefined;
  if (command.length <= MAX_EXACT_LENGTH) return `Bash(${command})`;

  const sub = words[1] && /^[a-z][a-z0-9:_-]*$/i.test(words[1]) ? ` ${words[1]}` : "";
  return `Bash(${words[0]}${sub} *)`;
}
