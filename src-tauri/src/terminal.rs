//! 터미널 — 앱 안의 셸 창. 셸을 PTY(Windows ConPTY·Linux openpty)로 띄운다.
//!
//! - 셸은 이름표(key)마다 하나씩이다: 프로젝트 선택 화면의 터미널("home", 홈 폴더에서 시작)과 프로젝트 화면 뷰어 아래의
//!   프로젝트별 터미널("p-<프로젝트 id>", 그 프로젝트 폴더에서 시작, 원격(SSH) 프로젝트는 ssh로 접속한 원격 폴더). 동시에 8개까지이고
//!   넘으면 화면에서 떼어 둔 가장 오래된 셸부터 끈다.
//! - 셸 종류·인자·시작 폴더는 여기서 고정한다. 화면(웹뷰)은 입력 글자, 창 크기만 보낼 수 있고, 시작 폴더는 등록된 프로젝트만 쓸 수 있다.
//! - 출력은 바이트 그대로 화면에 넘기고, 최근 256KB만 메모리에 보관한다(다른 화면에 갔다 돌아오면 다시 그려 줌).
//!   디스크·로그에는 입력도 출력도 남기지 않는다.
//! - 웹뷰가 보낸 글자가 사람이 친 것인지 스크립트가 넣은 것인지는 여기서 구별할 수 없다(웹뷰를 믿는 구조).

use crate::remote::{self, sh_quote};
use crate::data;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

/// 다시 그리기용으로 보관하는 최근 출력의 최대 크기
const MAX_BUFFER: usize = 256 * 1024;

/// 출력을 화면에 넘기는 함수. false를 돌려주면(화면이 사라짐) 더 보내지 않는다
type Sink = Box<dyn FnMut(&[u8]) -> bool + Send>;

#[derive(Default)]
struct Shared {
    buffer: Vec<u8>,
    sink: Option<Sink>,
    alive: bool,
}

impl Shared {
    /// 출력을 보관하고(최근 MAX_BUFFER만) 화면으로 넘긴다
    fn push(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() > MAX_BUFFER {
            let cut = self.buffer.len() - MAX_BUFFER;
            self.buffer.drain(..cut);
        }
        if let Some(sink) = self.sink.as_mut() {
            if !sink(bytes) {
                self.sink = None;
            }
        }
    }
}

/// 다시 그릴 때는 터미널이 답을 보내게 만드는 질문(커서 위치 ESC[6n, 장치 속성 ESC[c·ESC[0c)을 뺀다 —
/// 이미 지난 질문에 화면이 또 답하면 그 답이 글자로 셸 입력에 섞여 들어간다.
fn strip_queries(bytes: &[u8]) -> Vec<u8> {
    const QUERIES: [&[u8]; 3] = [b"[6n", b"[0c", b"[c"];
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if let Some(q) = QUERIES.iter().find(|q| bytes[i..].starts_with(q)) {
            i += q.len();
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

/// 셸 하나와 연결된 PTY
pub struct Session {
    /// 셸을 띄울 때마다 올라가는 번호 (옛 셸의 종료 알림이 새 셸에 섞이지 않게 구별한다)
    id: u64,
    shared: Arc<Mutex<Shared>>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl Session {
    /// 셸을 띄운다. 셸이 끝나면 on_exit가 한 번 불린다.
    pub fn start(cmd: CommandBuilder, cols: u16, rows: u16, on_exit: impl Fn() + Send + 'static) -> Result<Session, String> {
        let pair = native_pty_system()
            .openpty(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("PTY_FAILED: {e}"))?;
        let mut child: Box<dyn Child + Send + Sync> = pair.slave.spawn_command(cmd).map_err(|e| format!("SHELL_FAILED: {e}"))?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| format!("PTY_FAILED: {e}"))?;
        let writer = pair.master.take_writer().map_err(|e| format!("PTY_FAILED: {e}"))?;
        let killer = child.clone_killer();
        let shared = Arc::new(Mutex::new(Shared { alive: true, ..Default::default() }));

        let out = shared.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        out.lock().unwrap().push(&chunk[..n]);
                    }
                }
            }
        });
        // 셸이 끝나기를 기다린다 (ConPTY는 셸이 끝나도 읽기 쪽이 바로 닫히지 않는다)
        let state = shared.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            state.lock().unwrap().alive = false;
            on_exit();
        });
        Ok(Session { id: 0, shared, master: pair.master, writer, killer })
    }

    pub fn alive(&self) -> bool {
        self.shared.lock().unwrap().alive
    }

    /// 화면에 연결되어 있는지 (연결이 없으면 셸만 살아 있는 상태)
    fn attached(&self) -> bool {
        self.shared.lock().unwrap().sink.is_some()
    }

    /// 출력을 받을 곳을 바꾼다. 그동안 쌓인 출력을 먼저 보내고(순서가 섞이지 않게 같은 잠금 안에서) 이어서 새 출력을 보낸다.
    pub fn set_sink(&self, mut sink: Sink) {
        let mut s = self.shared.lock().unwrap();
        if !s.buffer.is_empty() && !sink(&strip_queries(&s.buffer)) {
            return;
        }
        s.sink = Some(sink);
    }

    pub fn clear_sink(&self) {
        self.shared.lock().unwrap().sink = None;
    }

    pub fn write(&mut self, data: &[u8]) -> Result<(), String> {
        if !self.alive() {
            return Err("TERMINAL_ENDED".into());
        }
        self.writer.write_all(data).and_then(|_| self.writer.flush()).map_err(|e| format!("TERMINAL_WRITE_FAILED: {e}"))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("PTY_FAILED: {e}"))
    }

    pub fn kill(&mut self) {
        let _ = self.killer.kill();
    }

    #[cfg(test)]
    fn buffered(&self) -> Vec<u8> {
        self.shared.lock().unwrap().buffer.clone()
    }
}

/// 동시에 둘 수 있는 셸 수 (넘으면 화면에서 떼어 둔 가장 오래된 셸부터 끈다)
const MAX_SESSIONS: usize = 8;

#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<String, Session>>,
    /// 셸을 새로 띄울 때마다 올라간다
    next_id: Arc<AtomicU64>,
}

impl TerminalState {
    /// 앱을 끌 때 셸 프로세스도 함께 끈다
    pub fn shutdown(&self) {
        for (_, mut s) in self.sessions.lock().unwrap().drain() {
            s.kill();
        }
    }
}

/// 셸 이름표: 영문·숫자·-·_ 64자 이하 ("home" 또는 "p-<프로젝트 id>")
pub(crate) fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 64 && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 셸이 8개를 넘을 때 끌 셸: 화면에 연결되지 않은 것 중 가장 오래된(번호가 작은) 것. (이름표, 번호, 화면 연결 여부) 목록에서 고른다
pub(crate) fn pick_eviction(sessions: &[(String, u64, bool)]) -> Option<String> {
    sessions.iter().filter(|(_, _, attached)| !attached).min_by_key(|(_, id, _)| *id).map(|(key, _, _)| key.clone())
}

fn home_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().home_dir().ok().filter(|p| p.is_dir())
}

/// 이 PC에서 쓸 셸 명령. Windows: pwsh(PowerShell 7)가 PATH에 있으면 그것, 없으면 PowerShell 5.1. Linux: $SHELL(없으면 /bin/bash)
pub fn shell_command(home: Option<PathBuf>) -> CommandBuilder {
    #[cfg(windows)]
    let mut cmd = {
        let has_pwsh = std::env::var_os("PATH")
            .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join("pwsh.exe").is_file()))
            .unwrap_or(false);
        let mut c = CommandBuilder::new(if has_pwsh { "pwsh.exe" } else { "powershell.exe" });
        // 한글·일본어가 외부 프로그램 출력에서도 깨지지 않도록 입출력을 UTF-8로 맞춘다
        c.args([
            "-NoLogo",
            "-NoExit",
            "-Command",
            "[Console]::InputEncoding=[Console]::OutputEncoding=$OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
        ]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = CommandBuilder::new(std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/bash".into()));
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(dir) = home {
        cmd.cwd(dir);
    }
    cmd
}

// ── 프로젝트 터미널: 시작 폴더(로컬) 또는 ssh 접속(원격) ──

/// `\\?\C:\…` → `C:\…` (네트워크 `\\?\UNC\…`는 그대로 둔다). 확장 경로 접두사는 셸의 시작 폴더로 쓸 수 없다
pub(crate) fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// 원격 폴더에서 로그인 셸을 시작하는 명령 (경로는 sh_quote 처리)
fn remote_command(path: &str) -> Result<String, String> {
    Ok(format!("cd {} && exec ${{SHELL:-sh}} -l", sh_quote(path)?))
}

/// ssh로 원격 셸을 여는 인자: 비밀번호·확인 질문을 터미널에서 받아야 하므로 BatchMode는 뺀다. 첫 칸은 프로그램 이름
pub(crate) fn ssh_args(options: &[String], host: &str, path: &str) -> Result<Vec<String>, String> {
    let mut args = vec![if cfg!(windows) { "ssh.exe" } else { "ssh" }.to_string()];
    let mut skip = false;
    for (i, a) in options.iter().enumerate() {
        if skip {
            skip = false;
            continue;
        }
        if a == "-o" && options.get(i + 1).is_some_and(|v| v == "BatchMode=yes") {
            skip = true;
            continue;
        }
        args.push(a.clone());
    }
    args.push("-t".into());
    args.push("--".into());
    args.push(host.into());
    args.push(remote_command(path)?);
    Ok(args)
}

/// ssh 셸 명령 (args[0]이 프로그램)
fn ssh_shell_command(args: &[String]) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(&args[0]);
    cmd.args(&args[1..]);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd
}

/// 등록된 프로젝트 폴더에서 시작하는 셸 명령을 만든다. 로컬은 그 폴더, 원격(SSH)은 접속 정보로 ssh (접속은 이 터미널 안에서 이뤄진다)
fn project_command(app: &AppHandle, root: &str) -> Result<CommandBuilder, String> {
    if root.starts_with(remote::ROOT_PREFIX) {
        let (host_id, path) = remote::parse_root(root).ok_or("NOT_REGISTERED")?;
        let projects = data::load(app, "projects").unwrap_or_default();
        let registered = projects.as_array().into_iter().flatten().any(|p| {
            p.pointer("/location/remote/hostId").and_then(|v| v.as_str()) == Some(host_id.as_str())
                && p.pointer("/location/path").and_then(|v| v.as_str()).is_some_and(|stored| stored.trim_end_matches('/') == path)
        });
        if !registered {
            return Err("NOT_REGISTERED".into());
        }
        let host = remote::find_host(app, &host_id)?;
        return Ok(ssh_shell_command(&ssh_args(&host.ssh_options("yes"), &host.host, &path)?));
    }
    let dir = crate::workspace::registered_root(app, root)?;
    Ok(shell_command(Some(strip_verbatim(&dir))))
}

fn start_session(app: &AppHandle, state: &TerminalState, key: &str, root: Option<&str>, cols: u16, rows: u16) -> Result<Session, String> {
    let cmd = match root {
        Some(root) => project_command(app, root)?,
        None => shell_command(home_dir(app)),
    };
    let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = app.clone();
    let name = key.to_string();
    let mut session = Session::start(cmd, cols, rows, move || {
        // 지금 이 이름표의 셸이 이 셸일 때만 알린다 (다시 시작하거나 끈 옛 셸의 종료는 알리지 않는다)
        let current = handle.state::<TerminalState>().sessions.lock().ok().and_then(|m| m.get(&name).map(|s| s.id));
        if current == Some(id) {
            let _ = handle.emit("terminal-exit", name.clone());
        }
    })?;
    session.id = id;
    Ok(session)
}

/// 새 셸을 둘 자리를 만든다: 8개가 차 있으면 화면에서 떼어 둔 가장 오래된 셸을 끈다
fn make_room(sessions: &mut HashMap<String, Session>) -> Result<(), String> {
    if sessions.len() < MAX_SESSIONS {
        return Ok(());
    }
    let list: Vec<(String, u64, bool)> = sessions.iter().map(|(k, s)| (k.clone(), s.id, s.attached())).collect();
    let victim = pick_eviction(&list).ok_or("TERMINAL_LIMIT")?;
    if let Some(mut old) = sessions.remove(&victim) {
        old.kill();
    }
    Ok(())
}

fn make_sink(on_data: Channel<InvokeResponseBody>) -> Sink {
    Box::new(move |bytes| on_data.send(InvokeResponseBody::Raw(bytes.to_vec())).is_ok())
}

/// 화면을 연결한다. 그 이름표의 셸이 없으면 시작하고(root가 있으면 그 프로젝트 폴더, 없으면 홈 폴더), 보관해 둔 최근 출력을 먼저 보낸다. 셸이 살아 있으면 true
#[tauri::command]
pub fn terminal_attach(app: AppHandle, state: State<'_, TerminalState>, key: String, root: Option<String>, cols: u16, rows: u16, on_data: Channel<InvokeResponseBody>) -> Result<bool, String> {
    if !valid_key(&key) {
        return Err("INVALID_TERMINAL".into());
    }
    let mut guard = state.sessions.lock().unwrap();
    if !guard.contains_key(&key) {
        make_room(&mut guard)?;
        let session = start_session(&app, &state, &key, root.as_deref(), cols, rows)?;
        guard.insert(key.clone(), session);
    }
    let session = guard.get(&key).unwrap();
    let _ = session.resize(cols, rows);
    session.set_sink(make_sink(on_data));
    Ok(session.alive())
}

/// 화면이 사라질 때 연결만 끊는다 (셸은 계속 살아 있다)
#[tauri::command]
pub fn terminal_detach(state: State<'_, TerminalState>, key: String) {
    if let Some(s) = state.sessions.lock().unwrap().get(&key) {
        s.clear_sink();
    }
}

/// 사용자가 친 글자를 셸에 보낸다
#[tauri::command]
pub fn terminal_write(state: State<'_, TerminalState>, key: String, data: String) -> Result<(), String> {
    match state.sessions.lock().unwrap().get_mut(&key) {
        Some(s) => s.write(data.as_bytes()),
        None => Err("TERMINAL_ENDED".into()),
    }
}

#[tauri::command]
pub fn terminal_resize(state: State<'_, TerminalState>, key: String, cols: u16, rows: u16) -> Result<(), String> {
    match state.sessions.lock().unwrap().get(&key) {
        Some(s) => s.resize(cols, rows),
        None => Ok(()),
    }
}

/// 그 이름표의 셸을 끄고 새로 시작한다 ("종료됨 · 다시 시작")
#[tauri::command]
pub fn terminal_restart(app: AppHandle, state: State<'_, TerminalState>, key: String, root: Option<String>, cols: u16, rows: u16, on_data: Channel<InvokeResponseBody>) -> Result<bool, String> {
    if !valid_key(&key) {
        return Err("INVALID_TERMINAL".into());
    }
    let mut guard = state.sessions.lock().unwrap();
    if let Some(mut old) = guard.remove(&key) {
        old.kill();
    }
    make_room(&mut guard)?;
    let session = start_session(&app, &state, &key, root.as_deref(), cols, rows)?;
    session.set_sink(make_sink(on_data));
    let alive = session.alive();
    guard.insert(key, session);
    Ok(alive)
}

#[cfg(test)]
#[path = "tests/terminal.rs"]
mod tests;
