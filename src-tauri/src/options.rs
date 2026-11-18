//! 앱 옵션 읽기. 옵션 화면(options 탭)이 앱 데이터 폴더의 options.json에 저장하고, Rust는 필요한 순간마다 직접 읽는다 (캐시하지 않음).
//! 파일이 없거나 값이 없으면 꺼짐(false) — 새 옵션은 기본이 꺼짐이다.

use crate::data;
use serde_json::Value;
use tauri::AppHandle;

/// options.json의 값에서 불리언 옵션을 읽는다 (없거나 불리언이 아니면 false)
fn flag(options: Option<&Value>, key: &str) -> bool {
    options.and_then(|v| v.get(key)).and_then(Value::as_bool).unwrap_or(false)
}

/// 창을 닫을 때 종료하지 않고 트레이로 숨길지
pub fn close_to_tray(app: &AppHandle) -> bool {
    flag(data::load(app, "options").as_ref(), "closeToTray")
}

/// 5시간 세션이 끝나면 자동으로 새 세션을 시작할지
pub fn auto_session(app: &AppHandle) -> bool {
    flag(data::load(app, "options").as_ref(), "autoSession")
}

/// 컴퓨터를 켜면 자동으로 실행할지 (운영체제 쪽 등록은 set_autostart가 한다 — 이 값은 앱을 켤 때 등록이 맞는지 다시 맞추는 데 쓴다)
pub fn autostart(app: &AppHandle) -> bool {
    flag(data::load(app, "options").as_ref(), "autostart")
}

#[cfg(test)]
#[path = "tests/options.rs"]
mod tests;
