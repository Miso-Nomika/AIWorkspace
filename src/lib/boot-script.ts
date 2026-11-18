// 첫 화면을 그리기 전에 테마·사이드바 상태를 적용하는 인라인 스크립트 (깜빡임 방지).
// 실제 설정은 저장소(prefs, ui)에 있고, ui-prefs.ts가 바뀔 때마다 localStorage에 사본(BOOT_KEY)을 남긴다.
// 데스크톱 CSP: Tauri가 빌드 시 인라인 스크립트 해시를 자동으로 추가한다.

export const BOOT_KEY = "aiws-boot";

export const BOOT_SCRIPT = `(function(){try{var b=JSON.parse(localStorage.getItem("${BOOT_KEY}")||"{}");var d=document.documentElement;var dark=b.theme==="dark"||(b.theme!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);d.classList.toggle("dark",dark);if(b.sidebarCollapsed)d.setAttribute("data-sidebar","collapsed");}catch(e){}})();`;
