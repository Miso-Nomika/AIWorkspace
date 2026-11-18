//! 프로젝트 폴더 실시간 감시.
//! 화면에 보이는 프로젝트 하나만 감시하고, 바뀐 파일 경로를 모아(0.4초 묶음) `project-fs-changed` 이벤트로 알린다.
//! 탐색기 목록과 같은 제외 폴더(node_modules, .git 등)의 변경은 걸러 낸다.
//! 감시를 시작하지 못하는 환경(Linux inotify 한도 초과, Google Drive 마운트 폴더 등)에서는 false를 돌려주고,
//! 프런트엔드가 5초 간격 확인으로 대신한다.

use crate::workspace::{is_ignored_dir, registered_root};
use notify_debouncer_mini::notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// 한 번에 알리는 경로 수 상한. 이 이상이면 프런트엔드는 "열린 파일도 바뀌었을 수 있음"으로 취급한다.
const MAX_PATHS: usize = 500;

/// 지금 감시 중인 프로젝트 (프런트엔드가 넘긴 root 문자열, 감시기). 감시기를 버리면 감시가 멈춘다.
/// 감시를 멈추려면 버린다 (로컬은 감시기, 원격은 감시 작업(ssh 프로세스))
type Guard = Box<dyn Send>;

#[derive(Default)]
pub struct Watching(Mutex<Option<(String, Guard)>>);

pub(crate) fn emit_changed(app: &AppHandle, root: &str, paths: Vec<String>) {
    let _ = app.emit("project-fs-changed", Changed { root: root.to_string(), paths });
}

#[derive(Serialize, Clone)]
struct Changed {
    root: String,
    /// 프로젝트 폴더 기준 상대 경로 ("/" 구분)
    paths: Vec<String>,
}

/// 바뀐 경로를 프로젝트 기준 상대 경로로 바꾸고, 제외 폴더 안의 것은 뺀다.
pub(crate) fn relative_paths(root: &Path, changed: impl Iterator<Item = PathBuf>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for path in changed {
        let Ok(rel) = path.strip_prefix(root) else { continue };
        if rel.components().any(|c| is_ignored_dir(&c.as_os_str().to_string_lossy())) {
            continue;
        }
        let text = rel.to_string_lossy().replace('\\', "/");
        if !text.is_empty() && !out.contains(&text) {
            out.push(text);
            if out.len() >= MAX_PATHS {
                break;
            }
        }
    }
    out
}

/// 프로젝트 폴더 감시 시작 (이전 감시는 교체). 시작하지 못하면 false.
#[tauri::command]
pub async fn watch_project(app: AppHandle, state: State<'_, Watching>, root: String) -> Result<bool, String> {
    if let Some(remote) = crate::remote::ops::resolve(&app, &root).await? {
        let Some(guard) = crate::remote::watch::start(&app, &remote, root.clone()).await? else { return Ok(false) };
        *state.0.lock().unwrap() = Some((root, Box::new(guard)));
        return Ok(true);
    }
    let canonical = registered_root(&app, &root)?;
    let emit_app = app.clone();
    let key = root.clone();
    let base = canonical.clone();
    let debouncer = new_debouncer(Duration::from_millis(400), move |result: DebounceEventResult| {
        let Ok(events) = result else { return };
        let paths = relative_paths(&base, events.into_iter().map(|e| e.path));
        if !paths.is_empty() {
            let _ = emit_app.emit("project-fs-changed", Changed { root: key.clone(), paths });
        }
    });
    let Ok(mut debouncer) = debouncer else { return Ok(false) };
    if debouncer.watcher().watch(&canonical, RecursiveMode::Recursive).is_err() {
        return Ok(false);
    }
    *state.0.lock().unwrap() = Some((root, Box::new(debouncer)));
    Ok(true)
}

/// 감시 중지. 지금 감시 중인 프로젝트가 root와 같을 때만 멈춘다 (다른 프로젝트로 바뀐 뒤의 늦은 호출이 새 감시를 끄지 않게).
#[tauri::command]
pub fn unwatch_project(state: State<'_, Watching>, root: String) {
    let mut guard = state.0.lock().unwrap();
    if guard.as_ref().is_some_and(|(current, _)| *current == root) {
        *guard = None;
    }
}

#[cfg(test)]
#[path = "tests/watch.rs"]
mod tests;
