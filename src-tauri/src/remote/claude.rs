//! 원격 PC의 Claude Code 상태 확인·설치·로그인을 이 PC 앱 안에서 처리한다 (사용자가 원격에 직접 들어가지 않아도 된다).
//! - 상태: `claude auth status`(JSON)로 설치·로그인 여부를 읽는다.
//! - 설치: 공식 설치 스크립트(`https://claude.ai/install.sh`)를 원격에서 실행하고 출력 줄을 화면으로 흘려 보낸다.
//! - 로그인: 원격에서 `claude auth login`을 TTY 없이 실행하면 로그인 주소를 출력하고 "Paste code here"로 코드를 표준 입력에서 기다린다.
//!   앱이 그 주소를 이 PC 브라우저로 열어 주고, 사용자가 승인 뒤 받은 코드를 앱 입력칸에 붙이면 원격 표준 입력으로 보낸다.

use super::{agent::{kill_remote, parse_pid_line, sh_wrap}, find_host, get_conn, is_valid_host_id, ssh_command, Remote};
use std::sync::{Arc, Mutex};
use serde::Serialize;
use std::process::Stdio;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// 원격 셸의 PATH에 claude 설치 위치를 덧붙인다 (비대화형 ssh 명령은 PATH가 짧다). `agent::run_script`와 같은 목록
pub const PATH_PREFIX: &str = "PATH=\"$PATH:$HOME/.local/bin:$HOME/.claude/local:/usr/local/bin:/opt/homebrew/bin\"; export PATH; ";

/// 공식 설치 스크립트 주소
const INSTALL_URL: &str = "https://claude.ai/install.sh";
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);
/// 붙여 넣는 인증 코드의 최대 길이
const MAX_CODE_LEN: usize = 2048;

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// 설치되어 있을 때만 (로그인 여부를 읽지 못하면 None)
    pub logged_in: Option<bool>,
    pub auth_method: Option<String>,
}

/// `command -v claude` → `claude --version` → `claude auth status` 출력 해석
pub fn parse_status(text: &str) -> ClaudeStatus {
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let Some(path) = lines.next().filter(|p| p.starts_with('/')) else { return ClaudeStatus::default() };
    let version = lines.next().filter(|v| !v.starts_with('{')).map(str::to_string);
    let json: String = text.lines().skip_while(|l| !l.trim_start().starts_with('{')).collect::<Vec<_>>().join("\n");
    let parsed = serde_json::from_str::<serde_json::Value>(&json).ok();
    ClaudeStatus {
        installed: true,
        path: Some(path.to_string()),
        version,
        logged_in: parsed.as_ref().and_then(|v| v["loggedIn"].as_bool()),
        auth_method: parsed.as_ref().and_then(|v| v["authMethod"].as_str()).filter(|m| *m != "none").map(str::to_string),
    }
}

pub fn status_script() -> String {
    format!("{PATH_PREFIX}p=$(command -v claude) || exit 0; echo \"$p\"; \"$p\" --version 2>/dev/null | head -n 1; \"$p\" auth status 2>/dev/null")
}

pub async fn read_status(conn: &super::Conn) -> Result<ClaudeStatus, String> {
    let out = conn.exec(&status_script(), Duration::from_secs(60)).await?;
    Ok(parse_status(&out.stdout_text()))
}

/// 원격 PC의 Claude Code 설치·로그인 상태
#[tauri::command]
pub async fn ssh_claude_status(app: AppHandle, host_id: String) -> Result<ClaudeStatus, String> {
    if !is_valid_host_id(&host_id) {
        return Err("INVALID_HOST".into());
    }
    let conn = get_conn(&app, &host_id).await?;
    read_status(&conn).await
}

// ── 설치 ──

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InstallEvent {
    /// 설치 스크립트가 낸 한 줄
    Line { text: String },
}

/// 설치 스크립트: curl이 있으면 curl, 없으면 wget으로 받아 bash로 실행한다. 둘 다 없으면 종료 코드 3
pub fn install_script() -> String {
    format!(
        "{PATH_PREFIX}if command -v curl >/dev/null 2>&1; then curl -fsSL {INSTALL_URL} | bash; elif command -v wget >/dev/null 2>&1; then wget -qO- {INSTALL_URL} | bash; else echo 'curl 또는 wget이 필요합니다' >&2; exit 3; fi"
    )
}

/// 원격 PC에 Claude Code를 설치한다 (공식 설치 스크립트). 진행 줄은 on_event로 흘려 보내고, 끝나면 설치 확인 결과를 돌려준다.
/// 오류: INSTALL_NO_DOWNLOADER · INSTALL_FAILED: 마지막 출력 · INSTALL_TIMEOUT
#[tauri::command]
pub async fn ssh_claude_install(app: AppHandle, host_id: String, on_event: Channel<InstallEvent>) -> Result<ClaudeStatus, String> {
    if !is_valid_host_id(&host_id) {
        return Err("INVALID_HOST".into());
    }
    let host = find_host(&app, &host_id)?;
    let mut cmd = ssh_command();
    cmd.args(host.ssh_options("yes")).arg("-T").arg("--").arg(&host.host).arg(sh_wrap(&format!("{} 2>&1", install_script()))?);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("CONNECTION_FAILED: {e}"))?;
    let stdout = child.stdout.take().ok_or("CONNECTION_FAILED")?;
    let mut lines = BufReader::new(stdout).lines();
    let mut tail: Vec<String> = Vec::new();
    let run = async {
        while let Ok(Some(line)) = lines.next_line().await {
            let text = strip_ansi(&line);
            if text.trim().is_empty() {
                continue;
            }
            tail.push(text.clone());
            if tail.len() > 8 {
                tail.remove(0);
            }
            let _ = on_event.send(InstallEvent::Line { text });
        }
        child.wait().await
    };
    let status = match tokio::time::timeout(INSTALL_TIMEOUT, run).await {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => return Err(format!("INSTALL_FAILED: {e}")),
        Err(_) => return Err("INSTALL_TIMEOUT".into()),
    };
    if status.code() == Some(3) {
        return Err("INSTALL_NO_DOWNLOADER".into());
    }
    if !status.success() {
        return Err(format!("INSTALL_FAILED: {}", tail.join(" / ")));
    }
    let conn = get_conn(&app, &host_id).await?;
    let state = read_status(&conn).await?;
    if state.installed { Ok(state) } else { Err(format!("INSTALL_FAILED: 설치가 끝났지만 claude를 찾지 못했습니다 ({})", tail.join(" / "))) }
}

/// 터미널 색 코드(ESC[…m)를 지운다
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else if c != '\r' {
            out.push(c);
        }
    }
    out
}

// ── 로그인 ──

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LoginEvent {
    /// 로그인 주소 (이 PC 브라우저로 열어 승인한다)
    Url { url: String },
    /// 그 밖의 출력 한 줄
    Output { text: String },
    /// 끝남: ok면 로그인됨, 아니면 message에 이유
    Done { ok: bool, message: String },
}

/// 한 줄에서 로그인 주소를 찾는다 (`If the browser didn't open, visit: https://…`)
pub fn find_login_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let url: String = line[start..].chars().take_while(|c| !c.is_whitespace()).collect();
    (url.contains("oauth/authorize") || url.contains("/authorize")).then_some(url)
}

/// 붙여 넣은 코드가 쓸 수 있는 모양인지 (한 줄, 길이 제한, 제어 문자 없음)
pub fn clean_code(code: &str) -> Option<String> {
    let code = code.trim();
    (!code.is_empty() && code.len() <= MAX_CODE_LEN && !code.chars().any(|c| c.is_control() || c.is_whitespace())).then(|| code.to_string())
}

/// 진행 중인 로그인: 코드를 보내는 통로와 중단 손잡이
pub struct LoginSession {
    codes: mpsc::Sender<String>,
    task: tokio::task::JoinHandle<()>,
    host_id: String,
    /// 원격 `claude auth login` 프로세스의 PID (원격이 첫 줄로 알려 준다) — 취소할 때 원격에서도 끝낸다
    pid: Arc<Mutex<Option<u32>>>,
}

/// 원격에서 `claude auth login`을 시작한다. 로그인 주소·출력·결과는 on_event로 알리고, 돌려주는 값(loginId)으로 코드를 보낸다.
#[tauri::command]
pub async fn ssh_claude_login_start(app: AppHandle, state: State<'_, Remote>, host_id: String, on_event: Channel<LoginEvent>) -> Result<String, String> {
    if !is_valid_host_id(&host_id) {
        return Err("INVALID_HOST".into());
    }
    let host = find_host(&app, &host_id)?;
    let mut cmd = ssh_command();
    cmd.args(host.ssh_options("yes")).arg("-T").arg("--").arg(&host.host).arg(sh_wrap(&format!("{PATH_PREFIX}echo \"AIWS_PID $$\"; exec claude auth login 2>&1"))?);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("CONNECTION_FAILED: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("CONNECTION_FAILED")?;
    let stdout = child.stdout.take().ok_or("CONNECTION_FAILED")?;
    let (codes, mut code_rx) = mpsc::channel::<String>(4);
    let login_id = format!("login-{}", super::next_id());
    let (app2, host_id2) = (app.clone(), host_id.clone());
    let pid: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
    let pid2 = pid.clone();
    let task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut sent_url = false;
        let mut tail: Vec<String> = Vec::new();
        let run = async {
            loop {
                tokio::select! {
                    line = lines.next_line() => match line {
                        Ok(Some(line)) => {
                            let text = strip_ansi(&line);
                            if text.trim().is_empty() { continue; }
                            if let Some(remote_pid) = parse_pid_line(&text) {
                                *pid2.lock().unwrap() = Some(remote_pid); // 앱 내부용 줄이라 화면에는 보내지 않는다
                                continue;
                            }
                            if !sent_url {
                                if let Some(url) = find_login_url(&text) {
                                    sent_url = true;
                                    let _ = on_event.send(LoginEvent::Url { url });
                                    continue;
                                }
                            }
                            tail.push(text.clone());
                            if tail.len() > 6 { tail.remove(0); }
                            let _ = on_event.send(LoginEvent::Output { text });
                        }
                        _ => break,
                    },
                    code = code_rx.recv() => {
                        let Some(code) = code else { break };
                        if stdin.write_all(format!("{code}\n").as_bytes()).await.is_err() || stdin.flush().await.is_err() { break; }
                    }
                }
            }
            child.wait().await
        };
        let outcome = tokio::time::timeout(LOGIN_TIMEOUT, run).await;
        // 시간이 다 되어 끝난 경우 원격에 남은 로그인 프로세스를 정리한다
        if outcome.is_err() {
            let remote_pid = *pid2.lock().unwrap();
            if let Some(remote_pid) = remote_pid {
                kill_remote(&app2, &host_id2, remote_pid).await;
            }
        }
        // 끝난 뒤 실제 로그인 상태로 판단한다 (종료 코드만 믿지 않는다)
        let logged_in = match get_conn(&app2, &host_id2).await {
            Ok(conn) => read_status(&conn).await.ok().and_then(|s| s.logged_in).unwrap_or(false),
            Err(_) => false,
        };
        let message = match (&outcome, logged_in) {
            (_, true) => "로그인되었습니다.".to_string(),
            (Err(_), false) => "시간이 너무 오래 걸려 로그인을 중단했습니다. 다시 시도하세요.".to_string(),
            (Ok(_), false) => format!("로그인하지 못했습니다. {}", tail.last().cloned().unwrap_or_default()).trim().to_string(),
        };
        let _ = on_event.send(LoginEvent::Done { ok: logged_in, message });
        let remote = app2.state::<Remote>();
        remote.logins.lock().unwrap().retain(|_, s| !s.task.is_finished());
    });
    let mut logins = state.logins.lock().unwrap();
    logins.retain(|_, s| !s.task.is_finished());
    logins.insert(login_id.clone(), LoginSession { codes, task, host_id: host_id.clone(), pid });
    Ok(login_id)
}

/// 사용자가 붙여 넣은 인증 코드를 원격 `claude auth login`에 보낸다
#[tauri::command]
pub async fn ssh_claude_login_code(state: State<'_, Remote>, login_id: String, code: String) -> Result<(), String> {
    let code = clean_code(&code).ok_or("INVALID_CODE")?;
    let sender = state.logins.lock().unwrap().get(&login_id).map(|s| s.codes.clone()).ok_or("LOGIN_NOT_FOUND")?;
    sender.send(code).await.map_err(|_| "LOGIN_NOT_FOUND".to_string())
}

/// 진행 중인 로그인을 취소한다 (원격의 `claude auth login` 프로세스도 끝낸다)
#[tauri::command]
pub async fn ssh_claude_login_cancel(app: AppHandle, state: State<'_, Remote>, login_id: String) -> Result<(), String> {
    let session = state.logins.lock().unwrap().remove(&login_id);
    if let Some(session) = session {
        session.task.abort();
        let remote_pid = *session.pid.lock().unwrap();
        if let Some(remote_pid) = remote_pid {
            kill_remote(&app, &session.host_id, remote_pid).await;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "../tests/remote_claude.rs"]
mod tests;
