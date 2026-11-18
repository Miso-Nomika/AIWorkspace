//! 원격 폴더 실시간 갱신: 원격에서 파일 변경을 알려 주는 프로세스 하나를 오래 띄우고, 바뀐 경로를 0.4초 단위로 모아
//! 로컬 감시와 같은 `project-fs-changed` 이벤트로 알린다.
//! 방식 우선순위: inotifywait(Linux) → fswatch(Mac) → 3초마다 find로 확인하는 폴링.

use super::ops::RemoteRoot;
use super::{sh_quote, ssh_command};
use crate::workspace::is_ignored_dir;
use std::process::Stdio;
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};

/// 한 번에 알리는 경로 수 상한 (로컬 감시와 같다)
const MAX_PATHS: usize = 500;
/// 폴링 간격(초)
const POLL_SECS: u32 = 3;

/// 감시를 멈추려면 버린다 (작업이 중단되면서 ssh 프로세스가 함께 끝난다)
pub struct RemoteWatchGuard(tokio::task::JoinHandle<()>);

impl Drop for RemoteWatchGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// 제외 폴더를 find의 `-prune` 조건으로
fn prune_expr() -> String {
    let names = [".git", "node_modules", ".next", "target", "__pycache__", ".venv", "venv", ".turbo", ".cache"];
    let list: Vec<String> = names.iter().map(|n| format!("-name {n}")).collect();
    format!("\\( {} \\) -prune", list.join(" -o "))
}

/// 감시 프로세스가 돌릴 스크립트. mode: inotify | fswatch | poll
pub fn watch_script(mode: &str, root: &str) -> Result<String, String> {
    let q = sh_quote(root)?;
    Ok(match mode {
        "inotify" => format!(
            "exec inotifywait -m -r -q --format '%w%f' -e create,delete,moved_to,moved_from,close_write --exclude '/(\\.git|node_modules|\\.next|target|__pycache__|\\.venv|venv|\\.turbo|\\.cache)(/|$)' {q}"
        ),
        "fswatch" => format!("exec fswatch -r -e '/\\.git(/|$)' -e '/node_modules(/|$)' -e '/\\.next(/|$)' -e '/target(/|$)' -e '/__pycache__(/|$)' -e '/\\.venv(/|$)' -e '/venv(/|$)' -e '/\\.turbo(/|$)' -e '/\\.cache(/|$)' {q}"),
        _ => format!(
            "ref=\"${{TMPDIR:-/tmp}}/aiws-watch-$$\"; : > \"$ref\"; trap 'rm -f \"$ref\"' EXIT HUP INT TERM; while :; do sleep {POLL_SECS}; find {q} {} -o -newer \"$ref\" -print 2>/dev/null; : > \"$ref\"; done",
            prune_expr()
        ),
    })
}

/// 출력된 절대 경로를 프로젝트 기준 상대 경로로 바꾸고 제외 폴더 안의 것은 뺀다
pub fn relative_paths(root: &str, lines: impl Iterator<Item = String>) -> Vec<String> {
    let prefix = format!("{}/", root.trim_end_matches('/'));
    let mut out: Vec<String> = Vec::new();
    for line in lines {
        let Some(rel) = line.trim_end().strip_prefix(&prefix) else { continue };
        let rel = rel.trim_end_matches('/');
        if rel.is_empty() || rel.split('/').any(is_ignored_dir) {
            continue;
        }
        if !out.iter().any(|p| p == rel) {
            out.push(rel.to_string());
            if out.len() >= MAX_PATHS {
                break;
            }
        }
    }
    out
}

/// 감시를 시작한다. 시작하지 못하면 None (프런트엔드가 5초 간격 확인으로 대신한다)
pub async fn start(app: &AppHandle, remote: &RemoteRoot, key: String) -> Result<Option<RemoteWatchGuard>, String> {
    let has = |name: &str| format!("command -v {name} >/dev/null 2>&1 && echo yes || echo no");
    let t = Duration::from_secs(20);
    let mode = if remote.conn.exec(&has("inotifywait"), t).await?.stdout_text().trim() == "yes" {
        "inotify"
    } else if remote.conn.exec(&has("fswatch"), t).await?.stdout_text().trim() == "yes" {
        "fswatch"
    } else {
        "poll"
    };
    let script = watch_script(mode, &remote.path)?;
    let mut cmd = ssh_command();
    cmd.args(remote.conn.host.ssh_options("yes")).arg("-T").arg("--").arg(&remote.conn.host.host).arg(super::agent::sh_wrap(&script)?);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("CONNECTION_FAILED: {e}"))?;
    let stdout = child.stdout.take().ok_or("CONNECTION_FAILED")?;
    let (app, root_path) = (app.clone(), remote.path.clone());
    let task = tokio::spawn(async move {
        let _child = child; // 작업이 끝나거나 중단되면 함께 종료(kill_on_drop)
        let mut lines = BufReader::new(stdout).lines();
        let mut pending: Vec<String> = Vec::new();
        loop {
            let next = if pending.is_empty() {
                lines.next_line().await
            } else {
                match tokio::time::timeout(Duration::from_millis(400), lines.next_line()).await {
                    Ok(line) => line,
                    Err(_) => {
                        let paths = relative_paths(&root_path, std::mem::take(&mut pending).into_iter());
                        if !paths.is_empty() {
                            crate::watch::emit_changed(&app, &key, paths);
                        }
                        continue;
                    }
                }
            };
            match next {
                Ok(Some(line)) => {
                    if pending.len() < MAX_PATHS * 4 {
                        pending.push(line);
                    }
                }
                _ => break,
            }
        }
        let paths = relative_paths(&root_path, pending.into_iter());
        if !paths.is_empty() {
            crate::watch::emit_changed(&app, &key, paths);
        }
    });
    Ok(Some(RemoteWatchGuard(task)))
}

#[cfg(test)]
#[path = "../tests/remote_watch.rs"]
mod tests;
