//! 5시간 세션 자동 새로고침.
//! Claude의 5시간 세션은 끝난 뒤 첫 요청을 보내야 새로 시작한다. 옵션(autoSession)이 켜져 있으면 세션이 끝난 직후
//! 가장 작은 모델을 한 번 실행해(사용량 확인과 같은 호출) 새 세션을 시작한다.
//! 웹뷰는 창이 숨겨지면 타이머가 늦어지므로 스케줄러는 Rust 스레드에서 돌린다. 매번 벽시계 시각과 비교하므로
//! 절전·앱 재시작 뒤에도 다음 확인에서 처리된다. 결과는 `usage-probed` 이벤트로 화면에 알리고, 저장은 화면(웹뷰)이 기존 경로로 한다.

use crate::{agent, data, options};
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// 앱을 켠 뒤 첫 확인까지 기다리는 시간 (시작 직후 사용량 조회와 겹치지 않게)
const FIRST_DELAY: Duration = Duration::from_secs(30);
const TICK: Duration = Duration::from_secs(60);
/// 세션이 끝난 뒤 이 시간이 지나야 실행한다 (끝나는 순간의 경계 오차 방지)
const GRACE_SECS: i64 = 60;
const MAX_BACKOFF_SECS: i64 = 3600;

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// 지금 확인 실행을 해야 하는지. reset_at = 5시간 세션이 끝나는 시각(epoch 초), next_try_at = 실패 뒤 재시도 허용 시각
fn should_probe(now: i64, reset_at: Option<i64>, next_try_at: i64) -> bool {
    matches!(reset_at, Some(reset) if now >= reset + GRACE_SECS) && now >= next_try_at
}

/// 연속 실패 횟수에 따른 재시도 대기 시간: 1·2·4…분, 상한 60분
fn backoff_secs(fails: u32) -> i64 {
    (60i64 << fails.saturating_sub(1).min(10)).min(MAX_BACKOFF_SECS)
}

/// rate_limit_event 한 줄에서 5시간 세션 종료 시각을 꺼낸다
fn five_hour_reset(line: &str) -> Option<i64> {
    let event: Value = serde_json::from_str(line).ok()?;
    let window = &event["rate_limit_info"]["unifiedWindows"]["five_hour"];
    window["resetsAt"].as_i64().or_else(|| window["resetsAt"].as_f64().map(|f| f as i64))
}

/// 화면이 저장해 둔 5시간 세션 종료 시각 (usage.json의 limits.fiveHour.resetsAt)
fn stored_reset(app: &AppHandle) -> Option<i64> {
    let usage = data::load(app, "usage")?;
    let value = &usage["limits"]["fiveHour"]["resetsAt"];
    value.as_i64().or_else(|| value.as_f64().map(|f| f as i64))
}

/// 확인 실행을 한 번 하고 결과를 화면에 알린다. 성공(새 세션 종료 시각이 미래)이면 그 시각을 돌려준다.
/// wait: 이미 다른 확인이 실행 중일 때 기다릴지(수동 요청) 건너뛸지(스케줄러)
fn run_probe(app: &AppHandle, wait: bool) -> Result<Option<i64>, ()> {
    let _guard = if wait {
        agent::PROBE_LOCK.lock().map_err(|_| ())?
    } else {
        agent::PROBE_LOCK.try_lock().map_err(|_| ())?
    };
    let Some(line) = agent::probe_line(app) else { return Ok(None) };
    let reset = five_hour_reset(&line);
    let _ = app.emit("usage-probed", line);
    Ok(reset.filter(|r| *r > now_secs()))
}

/// 트레이 메뉴 "세션 지금 새로고침": 백그라운드로 한 번 실행한다.
pub fn refresh_now(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = run_probe(&app, true);
    });
}

/// 스케줄러 시작 (앱 시작 시 한 번). 옵션이 꺼져 있으면 아무것도 하지 않는다.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_DELAY);
        let mut known_reset: Option<i64> = None; // 이 스레드가 마지막으로 확인한 세션 종료 시각
        let mut fails: u32 = 0;
        let mut next_try_at: i64 = 0;
        loop {
            if options::auto_session(&app) {
                let now = now_secs();
                // 화면이 저장한 값과 직접 받은 값 중 더 나중 시각을 쓴다 (사용자가 Claude를 쓰면 미래 시각이 되어 건너뛴다)
                let reset_at = stored_reset(&app).into_iter().chain(known_reset).max();
                if should_probe(now, reset_at, next_try_at) {
                    match run_probe(&app, false) {
                        Ok(Some(reset)) => {
                            known_reset = Some(reset);
                            fails = 0;
                            next_try_at = 0;
                        }
                        // 실패: 로그인 안 됨·한도 소진·CLI 없음 등 — 간격을 늘려 다시 시도 (실행 중이라 건너뛴 경우는 실패로 세지 않음)
                        Ok(None) => {
                            fails += 1;
                            next_try_at = now + backoff_secs(fails);
                        }
                        Err(()) => {}
                    }
                }
            }
            std::thread::sleep(TICK);
        }
    });
}

#[cfg(test)]
#[path = "tests/session.rs"]
mod tests;
