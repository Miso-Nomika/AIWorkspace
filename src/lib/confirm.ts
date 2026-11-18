// 확인 대화상자. 데스크톱 기본 대화상자를 쓰고, 개발 중 일반 브라우저에서는 window.confirm.
// (Tauri dialog 플러그인은 window.confirm을 비동기 함수로 바꾸므로 항상 이 함수를 await 해서 쓴다)

import { confirm } from "@tauri-apps/plugin-dialog";
import { isDesktop } from "./desktop";

export async function confirmAction(message: string): Promise<boolean> {
  if (isDesktop()) {
    return confirm(message, { title: "AIWorkspace", kind: "warning", okLabel: "확인", cancelLabel: "취소" });
  }
  return window.confirm(message);
}
