//! 원격에서 Claude Code를 실행하기 위한 조립: 실행 스크립트, 지침 파일 업로드, 원격 프로세스 정리.
//! 실제 프로세스 관리(입출력 연결·권한 응답·취소)는 로컬 `agent.rs`가 그대로 한다 — 이 PC에서 `ssh`를 띄우고
//! 그 표준 입출력이 원격 claude의 표준 입출력이 되므로, 로컬 실행과 같은 stream-json 경로를 쓴다.

use super::ops::{write_replace, RemoteRoot};
use super::{get_conn, sh_quote};
use std::time::Duration;
use tauri::AppHandle;

/// 원격 셸이 어떤 로그인 셸이든(bash·zsh·fish) 같은 문법으로 해석되도록 `sh -c`로 감싼다
pub fn sh_wrap(script: &str) -> Result<String, String> {
    Ok(format!("sh -c {}", sh_quote(script)?))
}

/// 원격에서 실행할 스크립트: 프로젝트 폴더로 이동 → 첫 줄에 PID를 표준 오류로 알림 → 로그인 셸의 PATH로 claude 실행(exec이라 PID가 claude의 것)
pub fn run_script(root_path: &str, claude_args: &[String]) -> Result<String, String> {
    let mut inner = format!("{}exec claude", super::claude::PATH_PREFIX);
    for arg in claude_args {
        inner.push(' ');
        inner.push_str(&sh_quote(arg)?);
    }
    let script = format!("cd {} && echo \"AIWS_PID $$\" >&2 && exec \"${{SHELL:-sh}}\" -lc {}", sh_quote(root_path)?, sh_quote(&inner)?);
    sh_wrap(&script)
}

/// 원격 PC 사용자의 전역 지침(`~/.claude/CLAUDE.md`·`~/.claude/rules/`)을 읽지 않게 하는 `--settings` 값.
/// `--setting-sources project,local`만으로는 전역 CLAUDE.md가 막히지 않는 것을 실제 Claude Code(2.1.x)로 확인했다 — `claudeMdExcludes`가 막는다.
/// 프로젝트 폴더의 CLAUDE.md는 그대로 읽힌다 (프로젝트 메모리).
pub fn user_instructions_exclude_settings(home: &str) -> String {
    let home = home.trim_end_matches('/');
    serde_json::json!({ "claudeMdExcludes": [format!("{home}/.claude/CLAUDE.md"), format!("{home}/.claude/rules/**")] }).to_string()
}

/// 원격 프로세스와 그 하위 프로세스를 모두 종료하는 스크립트 (`ps`의 이 옵션은 Linux·Mac 공통)
pub fn kill_script(pid: u32) -> String {
    format!(
        "kill_tree() {{ for c in $(ps -A -o pid= -o ppid= | awk -v p=\"$1\" '$2==p {{print $1}}'); do kill_tree \"$c\"; done; kill -TERM \"$1\" 2>/dev/null; }}; kill_tree {pid}"
    )
}

/// 로컬 ssh 출력에서 원격 PID 줄을 해석한다 (`AIWS_PID 1234`)
pub fn parse_pid_line(line: &str) -> Option<u32> {
    line.trim().strip_prefix("AIWS_PID ")?.trim().parse().ok()
}

/// 원격 프로세스 트리를 종료한다 (연결이 살아 있으면). 실패해도 무시한다
pub async fn kill_remote(app: &AppHandle, host_id: &str, pid: u32) {
    if let Ok(conn) = get_conn(app, host_id).await {
        let _ = conn.exec_oneshot(&kill_script(pid).replace('\n', " "), Duration::from_secs(15)).await;
    }
}

/// 지침 파일(공통 메모리·planner 정의)을 원격 `~/.cache/aiworkspace/<기기 id>/`에 올린다. 내용이 같으면 올리지 않는다.
/// 돌려주는 값: (공통 메모리 원격 경로, planner 정의 원격 경로, 원격 홈 폴더)
pub async fn upload_support_files(app: &AppHandle, remote: &RemoteRoot, memory: Option<String>, agents_json: Option<(String, String)>) -> Result<(Option<String>, Option<String>, String), String> {
    let device = crate::data::load(app, "device").and_then(|v| v.get("id").and_then(|i| i.as_str().map(String::from))).unwrap_or_else(|| "local".into());
    let device: String = device.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    let home = remote.conn.sftp.canonicalize(".").await.map_err(|e| super::map_sftp_error(&remote.conn, e))?;
    let dir = format!("{}/.cache/aiworkspace/{device}", home.trim_end_matches('/'));
    let made = remote.conn.exec(&format!("mkdir -p -- {}", sh_quote(&dir)?), Duration::from_secs(20)).await?;
    if !made.success() {
        return Err(format!("CONNECTION_FAILED: {}", made.stderr_text().trim()));
    }
    let put = |name: String, text: String| {
        let path = format!("{dir}/{name}");
        let conn = remote.conn.clone();
        async move {
            let same = match conn.sftp.read(path.clone()).await {
                Ok(old) => old == text.as_bytes(),
                Err(_) => false,
            };
            if !same {
                write_replace(&conn, &path, text.as_bytes()).await?;
            }
            Ok::<String, String>(path)
        }
    };
    let memory_path = match memory {
        Some(text) => Some(put("AIWORKSPACE_MEMORY.md".to_string(), text).await?),
        None => None,
    };
    let agents_path = match agents_json {
        Some((name, text)) => Some(put(name, text).await?),
        None => None,
    };
    Ok((memory_path, agents_path, home))
}

#[cfg(test)]
#[path = "../tests/remote_agent.rs"]
mod tests;

/// 실제 ssh 서버와 가짜 claude(`~/.local/bin/claude`)로 실행·PID 알림·입출력·중지를 확인한다 (`AIWS_SSH_TEST_PORT` 지정 시).
#[cfg(test)]
#[path = "../tests/remote_agent_live.rs"]
mod live_tests;
