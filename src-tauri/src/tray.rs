//! 시스템 트레이: 창을 닫아도 계속 실행할 때(옵션) 다시 열거나 종료하는 통로 (메뉴: 열기 · 세션 지금 새로고침 · 종료).
//! 트레이는 옵션과 상관없이 실행 내내 하나 만든다. 만들지 못하면(예: Linux에서 트레이 라이브러리 없음) 앱은 그대로 동작하고
//! 창 닫기는 평소처럼 종료한다 — 창이 숨겨진 채 돌아오지 못하는 사고를 막는다.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

pub const MAIN_WINDOW: &str = "main";

/// 트레이를 실제로 만들었는지
#[derive(Default)]
pub struct TrayState(AtomicBool);

impl TrayState {
    pub fn available(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// 메인 창을 보이게 한다 (숨김·최소화 상태에서도).
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 트레이 아이콘과 메뉴(열기·종료)를 만든다. 실패하면 로그만 남기고 계속한다.
pub fn setup(app: &AppHandle) {
    let result = (|| -> tauri::Result<()> {
        let open = MenuItem::with_id(app, "open", "열기", true, None::<&str>)?;
        let refresh = MenuItem::with_id(app, "refresh", "세션 지금 새로고침", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&open, &refresh, &quit])?;
        let mut builder = TrayIconBuilder::with_id("main")
            .tooltip("AIWorkspace")
            .menu(&menu)
            // Linux 트레이는 메뉴만 지원하므로 왼쪽 클릭은 Windows에서만 창 열기로 쓴다
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "open" => show_main_window(app),
                "refresh" => crate::session::refresh_now(app),
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    show_main_window(tray.app_handle());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(app)?;
        Ok(())
    })();
    match result {
        Ok(()) => app.state::<TrayState>().0.store(true, Ordering::Relaxed),
        Err(error) => log::warn!("트레이 아이콘을 만들지 못했습니다 (창 닫기는 평소처럼 종료합니다): {error}"),
    }
}
