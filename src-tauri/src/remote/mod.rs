//! SSH 원격 프로젝트: 원격 PC(Linux·Mac)의 폴더를 이 PC의 앱에서 로컬처럼 다룬다.
//!
//! 구조 (호스트마다 오래 유지하는 연결 2개 + 필요할 때 일회용):
//! - `ssh -s host sftp`  → 파일 읽기·쓰기·목록 (russh-sftp 클라이언트를 ssh 표준 입출력 위에 얹는다)
//! - `ssh host sh`       → 명령 셸 (git 등). 명령 끝에 표시 줄을 붙여 출력의 끝·종료 코드를 구분한다
//! 시스템 `ssh`를 그대로 쓰므로 `~/.ssh/config`·ssh-agent·ProxyJump·known_hosts가 동작한다. 접속은 키 인증만(BatchMode).
//! 프런트엔드가 넘기는 root 문자열이 `ssh://<hostId>/<원격 절대경로>`이면 원격 프로젝트다.

pub mod agent;
pub mod claude;
pub mod cmds;
pub mod ops;
pub mod watch;

use russh_sftp::client::SftpSession;
use serde::Deserialize;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex as AsyncMutex;

pub const ROOT_PREFIX: &str = "ssh://";

// ── 문자열 검사·셸 인용 ──

/// 셸에 넣을 인자를 작은따옴표로 감싼다 (`'`는 `'\''`). NUL은 거부한다.
pub fn sh_quote(text: &str) -> Result<String, String> {
    if text.contains('\0') {
        return Err("INVALID_ARGUMENT".into());
    }
    Ok(format!("'{}'", text.replace('\'', "'\\''")))
}

/// hostId는 앱이 만든 영문 소문자·숫자·하이픈만 허용한다
pub fn is_valid_host_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// ssh에 넘길 호스트 문자열: `-`로 시작하면 옵션으로 해석되므로 거부, 공백·제어 문자 거부
fn is_valid_host(host: &str) -> bool {
    !host.is_empty() && !host.starts_with('-') && host.len() <= 255 && !host.chars().any(|c| c.is_whitespace() || c.is_control() || c == '\'' || c == '"')
}

fn is_valid_user(user: &str) -> bool {
    !user.is_empty() && !user.starts_with('-') && user.len() <= 64 && user.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '@'))
}

/// `ssh://<hostId>/abs/path` → (hostId, "/abs/path")
pub fn parse_root(root: &str) -> Option<(String, String)> {
    let rest = root.strip_prefix(ROOT_PREFIX)?;
    let slash = rest.find('/')?;
    let (host, path) = rest.split_at(slash);
    if !is_valid_host_id(host) || path.contains('\0') {
        return None;
    }
    let path = path.trim_end_matches('/');
    // 루트("/") 자체는 프로젝트가 될 수 없다
    if path.is_empty() { None } else { Some((host.to_string(), path.to_string())) }
}

// ── 접속 정보 ──

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDef {
    pub id: String,
    pub host: String,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub identity_file: Option<String>,
}

impl HostDef {
    pub fn validate(&self) -> Result<(), String> {
        if !is_valid_host_id(&self.id) || !is_valid_host(&self.host) {
            return Err("INVALID_HOST".into());
        }
        if self.user.as_deref().is_some_and(|u| !is_valid_user(u)) {
            return Err("INVALID_HOST".into());
        }
        if self.identity_file.as_deref().is_some_and(|f| f.contains('\0') || f.starts_with('-') || f.chars().any(|c| c.is_control())) {
            return Err("INVALID_HOST".into());
        }
        Ok(())
    }

    /// ssh 공통 인자 (옵션 + 호스트 앞까지). strict: StrictHostKeyChecking 값 (yes | accept-new)
    pub fn ssh_options(&self, strict: &str) -> Vec<String> {
        let mut args: Vec<String> = Vec::new();
        for opt in ["BatchMode=yes", "ConnectTimeout=10", "ServerAliveInterval=15", "ServerAliveCountMax=3", "LogLevel=ERROR"] {
            args.push("-o".into());
            args.push(opt.into());
        }
        args.push("-o".into());
        args.push(format!("StrictHostKeyChecking={strict}"));
        if let Some(port) = self.port {
            args.push("-p".into());
            args.push(port.to_string());
        }
        if let Some(identity) = self.identity_file.as_deref().filter(|f| !f.is_empty()) {
            args.push("-i".into());
            args.push(identity.to_string());
            args.push("-o".into());
            args.push("IdentitiesOnly=yes".into());
        }
        if let Some(user) = self.user.as_deref().filter(|u| !u.is_empty()) {
            args.push("-l".into());
            args.push(user.to_string());
        }
        args
    }
}

/// 저장된 접속 정보를 찾는다 (프런트엔드가 `ssh-hosts` 키에 저장)
pub fn find_host(app: &AppHandle, host_id: &str) -> Result<HostDef, String> {
    let list = crate::data::load(app, "ssh-hosts").unwrap_or_default();
    let host = list
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| serde_json::from_value::<HostDef>(v.clone()).ok())
        .find(|h| h.id == host_id)
        .ok_or_else(|| "HOST_NOT_FOUND".to_string())?;
    host.validate()?;
    Ok(host)
}

/// ssh 프로세스를 만든다 (Windows는 콘솔 창을 띄우지 않는다)
pub fn ssh_command() -> Command {
    let mut cmd = Command::new("ssh");
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd
}

/// ssh가 낸 오류 문구를 앱이 다루는 오류 코드로 바꾼다
pub fn classify_ssh_error(stderr: &str) -> String {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("remote host identification has changed") || (lower.contains("host key for") && lower.contains("has changed")) {
        "HOST_KEY_CHANGED".into()
    } else if lower.contains("host key verification failed") {
        "HOST_KEY_UNKNOWN".into()
    } else if lower.contains("permission denied") || lower.contains("too many authentication failures") {
        "AUTH_FAILED".into()
    } else if lower.contains("could not resolve") || lower.contains("connection refused") || lower.contains("timed out") || lower.contains("no route") || lower.contains("network is unreachable") {
        format!("UNREACHABLE: {}", stderr.trim())
    } else if stderr.trim().is_empty() {
        "CONNECTION_FAILED".into()
    } else {
        format!("CONNECTION_FAILED: {}", stderr.trim())
    }
}

// ── 명령 셸 ──

pub struct ExecOut {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl ExecOut {
    pub fn success(&self) -> bool {
        self.code == 0
    }
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).to_string()
    }
    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).to_string()
    }
}

struct Shell {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: ChildStderr,
    /// 이전 명령 끝 표시 뒤에 이미 읽어 둔 바이트
    out_rest: Vec<u8>,
    err_rest: Vec<u8>,
}

fn find_sub(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// 출력 버퍼에서 끝 표시를 찾는다. 찾으면 (표시 앞의 내용, 표시 뒤에 남은 바이트, 표시에 적힌 숫자)
fn split_at_marker(buf: &[u8], marker: &[u8]) -> Option<(Vec<u8>, Vec<u8>, Option<i32>)> {
    let start = find_sub(buf, marker)?;
    let after = &buf[start + marker.len()..];
    let end = after.iter().position(|&b| b == b'\n')?; // 표시 줄이 끝까지 도착해야 한다
    let number = String::from_utf8_lossy(&after[..end]).trim().parse::<i32>().ok();
    Some((buf[..start].to_vec(), after[end + 1..].to_vec(), number))
}

static EXEC_SEQ: AtomicU64 = AtomicU64::new(1);

impl Shell {
    async fn run(&mut self, script: &str) -> Result<ExecOut, String> {
        let n = EXEC_SEQ.fetch_add(1, Ordering::Relaxed);
        let nonce = format!("{:x}{:x}", std::process::id(), n ^ (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0)));
        let out_marker = format!("\n__AIWS_O_{nonce}_");
        let err_marker = format!("\n__AIWS_E_{nonce}_");
        // 하위 셸에서 실행해 cd 같은 상태가 다음 명령에 남지 않게 하고, 입력은 비워 둔다 (명령이 셸의 입력을 먹지 않도록)
        let line = format!(
            "( {script}\n) </dev/null\n__c=$?\nprintf '\\n__AIWS_O_{nonce}_%d\\n' \"$__c\"\nprintf '\\n__AIWS_E_{nonce}_0\\n' >&2\n"
        );
        self.stdin.write_all(line.as_bytes()).await.map_err(|e| format!("CONNECTION_LOST: {e}"))?;
        self.stdin.flush().await.map_err(|e| format!("CONNECTION_LOST: {e}"))?;

        let mut out_buf = std::mem::take(&mut self.out_rest);
        let mut err_buf = std::mem::take(&mut self.err_rest);
        let mut out_done: Option<(Vec<u8>, Vec<u8>, Option<i32>)> = None;
        let mut err_done: Option<(Vec<u8>, Vec<u8>, Option<i32>)> = None;
        let mut chunk_o = vec![0u8; 16384];
        let mut chunk_e = vec![0u8; 16384];
        loop {
            if out_done.is_none() {
                out_done = split_at_marker(&out_buf, out_marker.as_bytes());
            }
            if err_done.is_none() {
                err_done = split_at_marker(&err_buf, err_marker.as_bytes());
            }
            if out_done.is_some() && err_done.is_some() {
                break;
            }
            tokio::select! {
                r = self.stdout.read(&mut chunk_o), if out_done.is_none() => {
                    let n = r.map_err(|e| format!("CONNECTION_LOST: {e}"))?;
                    if n == 0 { return Err("CONNECTION_LOST".into()); }
                    out_buf.extend_from_slice(&chunk_o[..n]);
                }
                r = self.stderr.read(&mut chunk_e), if err_done.is_none() => {
                    let n = r.map_err(|e| format!("CONNECTION_LOST: {e}"))?;
                    if n == 0 { return Err("CONNECTION_LOST".into()); }
                    err_buf.extend_from_slice(&chunk_e[..n]);
                }
            }
        }
        let (stdout, out_rest, code) = out_done.unwrap();
        let (stderr, err_rest, _) = err_done.unwrap();
        self.out_rest = out_rest;
        self.err_rest = err_rest;
        Ok(ExecOut { code: code.unwrap_or(-1), stdout, stderr })
    }
}

// ── 연결 ──

pub struct Conn {
    pub host: HostDef,
    pub sftp: SftpSession,
    shell: AsyncMutex<Shell>,
    sftp_child: Mutex<Child>,
    dead: AtomicBool,
}

impl Conn {
    pub fn mark_dead(&self) {
        self.dead.store(true, Ordering::SeqCst);
    }

    pub fn is_dead(&self) -> bool {
        if self.dead.load(Ordering::SeqCst) {
            return true;
        }
        let exited = self.sftp_child.lock().ok().is_some_and(|mut c| c.try_wait().map(|s| s.is_some()).unwrap_or(true));
        if exited {
            self.mark_dead();
        }
        exited
    }

    /// 명령 셸에서 스크립트를 실행한다 (시간 제한을 넘기면 셸을 끊고 연결을 죽은 것으로 표시한다)
    pub async fn exec(&self, script: &str, timeout: Duration) -> Result<ExecOut, String> {
        let mut shell = self.shell.lock().await;
        match tokio::time::timeout(timeout, shell.run(script)).await {
            Ok(Ok(out)) => Ok(out),
            Ok(Err(e)) => {
                self.mark_dead();
                Err(e)
            }
            Err(_) => {
                let _ = shell.child.start_kill();
                self.mark_dead();
                Err("TIMEOUT".into())
            }
        }
    }

    /// 새 ssh 접속으로 명령 하나를 실행한다 (오래 걸리는 푸시 등 — 명령 셸을 막지 않는다)
    pub async fn exec_oneshot(&self, script: &str, timeout: Duration) -> Result<ExecOut, String> {
        let mut cmd = ssh_command();
        cmd.args(self.host.ssh_options("yes")).arg("-T").arg("--").arg(&self.host.host).arg(agent::sh_wrap(script)?);
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let child = cmd.spawn().map_err(|e| format!("CONNECTION_FAILED: {e}"))?;
        match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Ok(Ok(out)) => Ok(ExecOut { code: out.status.code().unwrap_or(-1), stdout: out.stdout, stderr: out.stderr }),
            Ok(Err(e)) => Err(format!("CONNECTION_LOST: {e}")),
            Err(_) => Err("TIMEOUT".into()), // kill_on_drop으로 접속이 끊긴다
        }
    }
}

/// 새 연결을 맺는다. strict: "yes"(기본, 처음 보는 호스트는 거절) 또는 "accept-new"(사용자가 신뢰한 뒤 한 번)
pub async fn connect(host: &HostDef, strict: &str) -> Result<Conn, String> {
    host.validate()?;
    // sftp 하위 시스템
    let mut sftp_cmd = ssh_command();
    sftp_cmd.args(host.ssh_options(strict)).arg("-s").arg("--").arg(&host.host).arg("sftp");
    sftp_cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut sftp_child = sftp_cmd.spawn().map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "SSH_NOT_FOUND".to_string() } else { format!("CONNECTION_FAILED: {e}") })?;
    let stdin = sftp_child.stdin.take().ok_or("CONNECTION_FAILED")?;
    let stdout = sftp_child.stdout.take().ok_or("CONNECTION_FAILED")?;
    let mut sftp_err = sftp_child.stderr.take().ok_or("CONNECTION_FAILED")?;
    let session = match tokio::time::timeout(Duration::from_secs(20), SftpSession::new(tokio::io::join(stdout, stdin))).await {
        Ok(Ok(session)) => session,
        other => {
            // 연결에 실패했다: ssh가 낸 오류 문구로 원인을 구분한다
            let _ = sftp_child.start_kill();
            let mut text = String::new();
            let _ = tokio::time::timeout(Duration::from_secs(2), sftp_err.read_to_string(&mut text)).await;
            let classified = classify_ssh_error(&text);
            return Err(if classified == "CONNECTION_FAILED" {
                match other {
                    Ok(Err(e)) => format!("CONNECTION_FAILED: sftp {e}"),
                    _ => "CONNECTION_FAILED: 시간 초과".to_string(),
                }
            } else {
                classified
            });
        }
    };

    // 명령 셸 (호스트키는 위 접속에서 이미 확인됐으므로 yes로 충분하다)
    let mut shell_cmd = ssh_command();
    shell_cmd.args(host.ssh_options("yes")).arg("-T").arg("--").arg(&host.host).arg("sh");
    shell_cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut shell_child = shell_cmd.spawn().map_err(|e| format!("CONNECTION_FAILED: {e}"))?;
    let shell = Shell {
        stdin: shell_child.stdin.take().ok_or("CONNECTION_FAILED")?,
        stdout: shell_child.stdout.take().ok_or("CONNECTION_FAILED")?,
        stderr: shell_child.stderr.take().ok_or("CONNECTION_FAILED")?,
        child: shell_child,
        out_rest: Vec::new(),
        err_rest: Vec::new(),
    };
    let conn = Conn { host: host.clone(), sftp: session, shell: AsyncMutex::new(shell), sftp_child: Mutex::new(sftp_child), dead: AtomicBool::new(false) };
    // 셸이 실제로 응답하는지 확인한다
    let hello = conn.exec("echo ready", Duration::from_secs(20)).await?;
    if hello.stdout_text().trim() != "ready" {
        return Err("CONNECTION_FAILED: 원격 셸이 응답하지 않습니다".into());
    }
    Ok(conn)
}

// ── 연결 풀 ──

#[derive(Default)]
pub struct Remote {
    conns: Mutex<HashMap<String, Arc<Conn>>>,
    /// 진행 중인 원격 Claude Code 로그인 (loginId → 코드를 보내는 통로)
    pub(crate) logins: Mutex<HashMap<String, claude::LoginSession>>,
}

/// 로그인 같은 일회성 작업을 구분하는 번호
pub(crate) fn next_id() -> u64 {
    static N: AtomicU64 = AtomicU64::new(1);
    N.fetch_add(1, Ordering::Relaxed)
}

/// 연결 상태가 바뀌면 화면에 알린다 (`ssh-status`: { hostId, connected })
fn emit_status(app: &AppHandle, host_id: &str, connected: bool) {
    let _ = app.emit("ssh-status", serde_json::json!({ "hostId": host_id, "connected": connected }));
}

/// 호스트에 대한 살아 있는 연결을 돌려준다. 끊어졌으면 다시 맺는다 (한 번 연결됐던 호스트는 1·2·5초 간격으로 최대 3번)
pub async fn get_conn(app: &AppHandle, host_id: &str) -> Result<Arc<Conn>, String> {
    use tauri::Manager;
    let state = app.state::<Remote>();
    let existing = state.conns.lock().unwrap().get(host_id).cloned();
    if let Some(conn) = &existing {
        if !conn.is_dead() {
            return Ok(conn.clone());
        }
        emit_status(app, host_id, false);
    }
    let host = find_host(app, host_id)?;
    let delays: &[u64] = if existing.is_some() { &[0, 1, 2, 5] } else { &[0] };
    let mut last = "CONNECTION_FAILED".to_string();
    for delay in delays {
        if *delay > 0 {
            tokio::time::sleep(Duration::from_secs(*delay)).await;
        }
        match connect(&host, "yes").await {
            Ok(conn) => {
                let conn = Arc::new(conn);
                state.conns.lock().unwrap().insert(host_id.to_string(), conn.clone());
                emit_status(app, host_id, true);
                return Ok(conn);
            }
            Err(e) => {
                let permanent = e.starts_with("HOST_KEY") || e == "AUTH_FAILED" || e == "SSH_NOT_FOUND" || e == "INVALID_HOST";
                last = e;
                if permanent {
                    break;
                }
            }
        }
    }
    state.conns.lock().unwrap().remove(host_id);
    Err(last)
}

/// 연결을 풀에서 빼고 닫는다 (접속 정보를 지우거나 고쳤을 때)
pub fn drop_conn(app: &AppHandle, host_id: &str) {
    use tauri::Manager;
    let removed = app.state::<Remote>().conns.lock().unwrap().remove(host_id);
    if let Some(conn) = removed {
        conn.mark_dead();
    }
}

/// sftp·셸 오류를 코드로 바꾸고, 연결 문제면 연결을 죽은 것으로 표시해 다음 요청이 다시 연결하게 한다
pub fn map_sftp_error(conn: &Conn, error: impl std::fmt::Display) -> String {
    let text = error.to_string();
    let lower = text.to_ascii_lowercase();
    if lower.contains("no such file") {
        "NOT_FOUND".into()
    } else if lower.contains("permission denied") {
        "PERMISSION_DENIED".into()
    } else if ["timeout", "broken pipe", "channel", "eof", "closed", "dropped", "receiver", "connection reset", "not connected"].iter().any(|w| lower.contains(w)) {
        conn.mark_dead();
        "CONNECTION_LOST".into()
    } else {
        text
    }
}

#[cfg(test)]
#[path = "../tests/remote_mod.rs"]
mod tests;

#[cfg(test)]
#[path = "../tests/remote_mod_live.rs"]
mod live_tests;
