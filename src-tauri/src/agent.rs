//! AI 에이전트 CLI 감지·실행.
//! - 실행 인자는 Rust에서만 만든다 (웹뷰가 임의 인자/명령을 넘길 수 없음).
//! - Claude Code는 양방향 stream-json으로 실행한다: 표준 입력으로 사용자 메시지와 권한 응답을 보내고,
//!   표준 출력으로 이벤트(권한 요청 control_request 포함)를 받는다 — 터미널의 승인 절차와 같다.
//! - 작업 폴더는 등록된 프로젝트 폴더로 제한한다.
//! - 표준 출력은 줄 단위로 그대로 전달하고, 형식 해석은 프런트엔드 어댑터가 맡는다.

use crate::workspace::registered_root;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct AgentSpec {
    id: &'static str,
    executables: &'static [&'static str],
}

/// 지원 에이전트. 현재 Claude Code만.
/// 다른 에이전트를 추가하려면 여기에 항목을 넣고 build_args에 실행 인자를, 프런트엔드 backend/local.ts PARSERS에 출력 해석기를 추가한다.
const AGENTS: &[AgentSpec] = &[AgentSpec { id: "claude-code", executables: &["claude"] }];

/// default = 터미널 기본(변경·명령 전 확인), acceptEdits = 파일 수정 자동 허용, plan = 읽기·계획만
const PERMISSION_MODES: &[&str] = &["default", "acceptEdits", "plan"];
const MAX_ALLOWED_RULES: usize = 100;

type SharedStdin = Arc<Mutex<Option<ChildStdin>>>;

/// 실행 중인 에이전트 프로세스 (run_id → pid / 표준 입력)
#[derive(Default)]
pub struct AgentRuns {
    pids: Mutex<HashMap<String, u32>>,
    /// 원격 실행: run_id → (hostId, 원격 프로세스 PID — 원격이 첫 줄로 알려 준다)
    remote: Mutex<HashMap<String, (String, Arc<Mutex<Option<u32>>>)>>,
    stdins: Mutex<HashMap<String, SharedStdin>>,
    cancelled: Mutex<HashSet<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    id: &'static str,
    installed: bool,
    path: Option<String>,
    version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRequest {
    run_id: String,
    agent: String,
    root: String,
    prompt: String,
    session_id: Option<String>,
    permission_mode: String,
    /// "항상 허용"한 규칙 (예: "Bash(npm run build *)", "Edit")
    #[serde(default)]
    allowed_tools: Vec<String>,
    /// 실제 작업을 하는 메인 모델 (haiku · sonnet · opus). 없으면 sonnet
    #[serde(default)]
    main_model: Option<String>,
    /// 기획(planner)을 맡는 모델 (opus · fable). 없으면 opus
    #[serde(default)]
    planner_model: Option<String>,
    /// 첨부 이미지 (base64)
    #[serde(default)]
    images: Vec<ImageInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    media_type: String,
    data: String,
}

impl ImageInput {
    pub(crate) fn new(media_type: &str, data: String) -> Self {
        Self { media_type: media_type.into(), data }
    }
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentEvent {
    Stdout { line: String },
    Stderr { line: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExit {
    code: Option<i32>,
    cancelled: bool,
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    // 바탕화면 아이콘으로 실행하면 최근 추가된 PATH가 반영되지 않을 수 있어 대표 설치 위치를 함께 본다.
    #[cfg(windows)]
    {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            dirs.push(PathBuf::from(&home).join(".local").join("bin"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
    }
    #[cfg(not(windows))]
    {
        // 데스크톱 환경에서 실행하면 셸 설정(~/.bashrc 등)의 PATH가 빠지는 경우가 많다
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            for sub in [".local/bin", ".npm-global/bin", ".cargo/bin", "bin"] {
                dirs.push(home.join(sub));
            }
        }
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
    }
    dirs
}

pub(crate) fn find_executable(names: &[&str]) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat"] } else { &[""] };
    for dir in search_dirs() {
        for name in names {
            for ext in exts {
                let candidate = dir.join(format!("{name}{ext}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// .cmd/.bat(npm 설치형)는 cmd를 거쳐 실행한다. 콘솔 창은 띄우지 않는다.
pub(crate) fn base_command(exe: &Path) -> Command {
    let is_script = exe
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    let mut cmd = if is_script {
        let mut c = Command::new("cmd");
        c.args(["/D", "/C"]).arg(exe);
        c
    } else {
        Command::new(exe)
    };
    // 상위 Claude Code 세션의 환경 변수가 있으면 독립 실행되도록 제거한다 (일반 실행에서는 없음).
    for (key, _) in std::env::vars_os() {
        let k = key.to_string_lossy();
        if k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") || k == "CLAUDE_PID" || k == "CLAUDE_JOB_DIR" {
            cmd.env_remove(&key);
        }
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        cmd.process_group(0);
    }
    cmd
}

fn read_version(exe: &Path) -> Option<String> {
    let mut child = base_command(exe)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let mut out = String::new();
    std::io::Read::read_to_string(child.stdout.as_mut()?, &mut out).ok()?;
    out.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
}

/// 설치된 에이전트 CLI와 버전을 찾는다.
#[tauri::command]
pub async fn agent_detect() -> Vec<AgentStatus> {
    tauri::async_runtime::spawn_blocking(|| {
        AGENTS
            .iter()
            .map(|spec| {
                let path = find_executable(spec.executables);
                let version = path.as_deref().and_then(read_version);
                AgentStatus {
                    id: spec.id,
                    installed: path.is_some(),
                    path: path.map(|p| p.to_string_lossy().to_string()),
                    version,
                }
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// 허용 규칙 형식: `도구이름` 또는 `도구이름(내용)` — 줄바꿈·제어 문자 불가
fn is_safe_rule(rule: &str) -> bool {
    if rule.is_empty() || rule.len() > 300 || rule.chars().any(|c| c.is_control()) {
        return false;
    }
    let (name, rest) = match rule.find('(') {
        Some(i) => (&rule[..i], &rule[i..]),
        None => (rule, ""),
    };
    let name_ok = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == ':');
    name_ok && (rest.is_empty() || (rest.starts_with('(') && rest.ends_with(')') && rest.len() > 2))
}

// ── 역할 분담: 메인 모델(기본 Sonnet) + Planner 서브에이전트(기본 Opus) ──
// 메인 에이전트는 일반 개발·수정·테스트·문서 갱신을 맡고,
// 새 기능 기획이나 복잡한 아키텍처 결정이 필요할 때만 planner를 부른다 (토큰 절약).
// planner는 읽기 도구만 가진다 — 코드를 수정할 수 없다. 두 모델은 사용자가 프로젝트별로 고른다.

/// 메인 모델 선택지 (Claude Code 별칭)
const MAIN_MODELS: [&str; 3] = ["haiku", "sonnet", "opus"];
const DEFAULT_MAIN_MODEL: &str = "sonnet";
/// 기획(planner) 모델 선택지
const PLANNER_MODELS: [&str; 2] = ["opus", "fable"];
const DEFAULT_PLANNER_MODEL: &str = "opus";

fn pick_model<'a>(choice: &'a Option<String>, allowed: &[&str], default: &'a str) -> Result<&'a str, String> {
    match choice.as_deref() {
        None => Ok(default),
        Some(m) if allowed.contains(&m) => Ok(m),
        Some(_) => Err("INVALID_MODEL".into()),
    }
}

/// planner 정의 (Claude Code --agents 형식). description은 메인 에이전트가 호출 여부를 판단하는 기준이다.
/// (__PLANNER_MODEL__ 자리에 선택한 기획 모델이 들어간다)
const AGENTS_JSON: &str = r#"{
  "planner": {
    "description": "고성능 모델 기반 설계 전용. 새로운 기능 기획이나 여러 모듈에 걸친 복잡한 아키텍처 결정이 필요할 때만 한 번 호출한다. 버그 수정, 작은 변경, 테스트, TODO.md·기능명세서.md 같은 문서 갱신에는 호출하지 않는다. 코드를 수정하지 않는다.",
    "prompt": "당신은 설계 전용 Planner입니다. 코드를 수정하지 않습니다(읽기 도구만 사용).\n- 먼저 메인 에이전트가 넘긴 맥락을 읽고, TODO.md·기능명세서.md가 있으면 현재 구현과 남은 작업을 확인합니다.\n- 새 기능이나 여러 모듈에 걸친 변경을 기획할 때는 맥락만 믿지 말고, 영향받는 모듈과 비슷한 기존 구현을 Glob·Grep으로 직접 찾아 읽어 기존 구조·규칙에 맞춥니다. 필요하면 프로젝트 전체 구조를 훑어도 됩니다. 단, 생성물·node_modules·빌드 산출물·대용량 파일은 읽지 않고 같은 파일을 되풀이해 읽지 않습니다.\n- 출력(한국어, 간결하게):\n  1. 목표와 범위(포함/제외)\n  2. 핵심 설계 결정 — 근거와 검토한 대안 1~2개\n  3. 작업 단계 — 파일 단위, 구현 순서대로\n  4. 위험·확인할 점\n  5. TODO.md·기능명세서.md에 반영할 항목 제안(직접 수정하지 않음) — TODO 항목마다 한 줄 요약, `완료 기준`(사용자가 확인할 수 있는 동작), `범위·결정`(정한 방식·건드릴 파일·하지 않을 것)을 모두 포함하세요. 다른 모델이 그 항목만 보고 작업하므로 열린 결정을 남기지 말고 당신이 정해 적습니다.\n- 기존 구조를 유지하는 가장 단순한 설계를 우선하고, 전체 분량은 짧게 유지합니다.",
    "tools": ["Read", "Glob", "Grep"],
    "model": "__PLANNER_MODEL__"
  }
}"#;

fn agents_json(planner_model: &str) -> String {
    AGENTS_JSON.replace("__PLANNER_MODEL__", planner_model)
}

/// planner 정의 파일 경로 (앱 데이터 폴더). 내용이 바뀔 때만 다시 쓴다.
fn agents_file(app: &AppHandle, planner_model: &str) -> Option<PathBuf> {
    let dir = crate::memory::export_path(app).ok()?.parent()?.parent()?.join("agents");
    let path = dir.join(format!("aiworkspace-agents-{planner_model}.json"));
    let json = agents_json(planner_model);
    if std::fs::read_to_string(&path).map_or(true, |old| old != json) {
        std::fs::create_dir_all(&dir).ok()?;
        std::fs::write(&path, json).ok()?;
    }
    Some(path)
}

/// memory_file: 공통 메모리 파일 (있으면 시스템 프롬프트에 덧붙여 에이전트가 항상 참고하게 한다)
/// agents_file: planner 서브에이전트 정의 파일
fn build_args(agent: &str, req: &AgentRunRequest, memory_file: Option<&Path>, agents_file: Option<&Path>) -> Result<Vec<String>, String> {
    match agent {
        "claude-code" => {
            if !PERMISSION_MODES.contains(&req.permission_mode.as_str()) {
                return Err("INVALID_PERMISSION_MODE".into());
            }
            pick_model(&req.planner_model, &PLANNER_MODELS, DEFAULT_PLANNER_MODEL)?;
            validate_images(&req.images)?;
            let mut args: Vec<String> = [
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                // 권한 확인이 필요한 작업은 AIWorkspace(호스트)가 표준 입출력으로 사용자에게 묻고 답한다
                "--permission-prompt-tool",
                "stdio",
                "--permission-mode",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect();
            args.push(req.permission_mode.clone());
            args.push("--model".into());
            args.push(pick_model(&req.main_model, &MAIN_MODELS, DEFAULT_MAIN_MODEL)?.into());
            if let Some(file) = agents_file {
                args.push("--agents".into());
                args.push(file.to_string_lossy().to_string());
            }
            if let Some(file) = memory_file {
                args.push("--append-system-prompt-file".into());
                args.push(file.to_string_lossy().to_string());
            }
            if let Some(sid) = req.session_id.as_deref().filter(|s| is_safe_session_id(s)) {
                args.push("--resume".into());
                args.push(sid.into());
            }
            let rules: Vec<&String> = req.allowed_tools.iter().filter(|r| is_safe_rule(r)).take(MAX_ALLOWED_RULES).collect();
            if !rules.is_empty() {
                // 가변 인자 옵션이므로 반드시 마지막에 둔다
                args.push("--allowedTools".into());
                args.extend(rules.into_iter().cloned());
            }
            Ok(args)
        }
        _ => Err("AGENT_NOT_SUPPORTED".into()),
    }
}

const MAX_IMAGES: usize = 5;
const MAX_IMAGE_BYTES_TOTAL: usize = 20 * 1024 * 1024;
const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// 첨부 이미지 검사: 개수·형식·크기·base64 문자만 허용
fn validate_images(images: &[ImageInput]) -> Result<(), String> {
    if images.len() > MAX_IMAGES {
        return Err("TOO_MANY_IMAGES".into());
    }
    let mut total = 0;
    for image in images {
        let base64_only = image.data.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='));
        if !IMAGE_TYPES.contains(&image.media_type.as_str()) || image.data.is_empty() || !base64_only {
            return Err("INVALID_IMAGE".into());
        }
        total += image.data.len();
    }
    if total > MAX_IMAGE_BYTES_TOTAL {
        return Err("IMAGE_TOO_LARGE".into());
    }
    Ok(())
}

/// 사용자 메시지(JSON 한 줄). 이미지가 있으면 이미지 블록 뒤에 글을 붙인 배열 형식
pub(crate) fn user_message(prompt: &str, images: &[ImageInput]) -> String {
    let content = if images.is_empty() {
        serde_json::json!(prompt)
    } else {
        let mut blocks: Vec<Value> = images
            .iter()
            .map(|i| serde_json::json!({ "type": "image", "source": { "type": "base64", "media_type": i.media_type, "data": i.data } }))
            .collect();
        blocks.push(serde_json::json!({ "type": "text", "text": prompt }));
        Value::Array(blocks)
    };
    serde_json::json!({ "type": "user", "message": { "role": "user", "content": content } }).to_string()
}

fn write_line(stdin: &SharedStdin, line: &str) -> Result<(), String> {
    let mut guard = stdin.lock().unwrap();
    let pipe = guard.as_mut().ok_or("RUN_INPUT_CLOSED")?;
    pipe.write_all(line.as_bytes()).and_then(|_| pipe.write_all(b"\n")).and_then(|_| pipe.flush()).map_err(|e| e.to_string())
}

pub(crate) fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        // 실행 시 새 프로세스 그룹으로 띄우므로 그룹 전체(-pid)를 종료한다
        let _ = Command::new("kill").args(["-9", &format!("-{pid}")]).status();
    }
}

/// 표준 입력을 언제 닫을지 정한다. CLI는 입력이 닫혀야 종료하므로 한 번의 요청이 끝나면 닫는데,
/// 백그라운드 작업(Bash run_in_background 등)이 남아 있으면 작업이 끝난 뒤 같은 프로세스가 다음 턴을 이어가며
/// 권한을 다시 물을 수 있다. 그때까지 입력을 열어 둬야 권한 응답이 "Stream closed"로 실패하지 않는다.
#[derive(Default)]
struct StdinGate {
    running_tasks: bool,
    result_seen: bool,
}

#[derive(Debug, PartialEq)]
enum GateAction {
    None,
    /// 지금 닫는다
    Close,
    /// 잠시 새 활동이 없으면 닫는다 (남은 작업이 끝났지만 다음 턴이 시작되지 않는 경우 대비)
    CloseIfIdle,
}

impl StdinGate {
    fn on_event(&mut self, event: &Value) -> GateAction {
        match event["type"].as_str() {
            Some("result") => {
                self.result_seen = true;
                if self.running_tasks { GateAction::None } else { GateAction::Close }
            }
            Some("system") if event["subtype"] == "background_tasks_changed" => {
                self.running_tasks = event["tasks"].as_array().is_some_and(|t| !t.is_empty());
                if !self.running_tasks && self.result_seen { GateAction::CloseIfIdle } else { GateAction::None }
            }
            _ => GateAction::None,
        }
    }
}

/// 마지막 작업이 끝난 뒤 다음 턴이 시작되길 기다리는 시간
const IDLE_CLOSE_DELAY: Duration = Duration::from_secs(10);

/// close_on_result: 요청이 끝나면(백그라운드 작업이 남았으면 그 작업까지) 표준 입력을 닫아 CLI가 종료되게 한다
fn spawn_reader<R: std::io::Read + Send + 'static>(
    reader: R,
    channel: Channel<AgentEvent>,
    stderr: bool,
    close_on_result: Option<SharedStdin>,
    remote_pid: Option<Arc<Mutex<Option<u32>>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut gate = StdinGate::default();
        let activity = Arc::new(AtomicUsize::new(0));
        for line in BufReader::new(reader).split(b'\n').map_while(Result::ok) {
            let text = String::from_utf8_lossy(&line).trim_end_matches('\r').to_string();
            if text.is_empty() {
                continue;
            }
            if let (true, Some(sink)) = (stderr, &remote_pid) {
                if let Some(pid) = crate::remote::agent::parse_pid_line(&text) {
                    *sink.lock().unwrap() = Some(pid);
                    continue; // 앱 내부용 줄이라 화면에는 보내지 않는다
                }
            }
            activity.fetch_add(1, Ordering::Relaxed);
            if let Some(stdin) = &close_on_result {
                match serde_json::from_str::<Value>(&text).map(|v| gate.on_event(&v)) {
                    Ok(GateAction::Close) => {
                        stdin.lock().unwrap().take();
                    }
                    Ok(GateAction::CloseIfIdle) => {
                        let (stdin, activity) = (stdin.clone(), activity.clone());
                        std::thread::spawn(move || {
                            let seen = activity.load(Ordering::Relaxed);
                            std::thread::sleep(IDLE_CLOSE_DELAY);
                            if activity.load(Ordering::Relaxed) == seen {
                                stdin.lock().unwrap().take();
                            }
                        });
                    }
                    _ => {}
                }
            }
            let event = if stderr { AgentEvent::Stderr { line: text } } else { AgentEvent::Stdout { line: text } };
            if channel.send(event).is_err() {
                break;
            }
        }
    })
}

/// 에이전트를 프로젝트 폴더에서 실행한다. 출력은 channel로 줄 단위 전달, 종료되면 결과를 돌려준다.
#[tauri::command]
pub async fn agent_run(
    app: AppHandle,
    runs: State<'_, AgentRuns>,
    request: AgentRunRequest,
    on_event: Channel<AgentEvent>,
) -> Result<AgentExit, String> {
    let spec = AGENTS.iter().find(|a| a.id == request.agent).ok_or("AGENT_NOT_SUPPORTED")?;
    let planner_model = pick_model(&request.planner_model, &PLANNER_MODELS, DEFAULT_PLANNER_MODEL)?;
    let remote = crate::remote::ops::resolve(&app, &request.root).await?;
    let remote_pid: Option<Arc<Mutex<Option<u32>>>> = remote.as_ref().map(|_| Arc::new(Mutex::new(None)));

    let mut child: Child = if let Some(remote) = &remote {
        // 원격 프로젝트: 지침 파일을 원격에 올리고, 이 PC에서 ssh를 띄워 원격 claude의 표준 입출력을 그대로 잇는다
        let memory = crate::memory::export_path(&app).ok().and_then(|p| std::fs::read_to_string(p).ok());
        let planner_json = (format!("aiworkspace-agents-{planner_model}.json"), agents_json(planner_model));
        let (memory_path, agents_path, remote_home) = crate::remote::agent::upload_support_files(&app, remote, memory, Some(planner_json)).await?;
        let mut args = build_args(spec.id, &request, memory_path.as_deref().map(Path::new), agents_path.as_deref().map(Path::new))?;
        // 원격 PC 사용자의 전역 지침(~/.claude/CLAUDE.md)은 읽지 않는다 — 공통 메모리는 항상 이 PC의 것만 쓴다.
        // (--setting-sources만으로는 전역 CLAUDE.md가 막히지 않아 claudeMdExcludes를 함께 쓴다. 프로젝트 폴더의 CLAUDE.md는 그대로 읽힌다)
        let at = args.iter().position(|a| a == "--allowedTools").unwrap_or(args.len());
        args.splice(
            at..at,
            [
                "--setting-sources".to_string(),
                "project,local".to_string(),
                "--settings".to_string(),
                crate::remote::agent::user_instructions_exclude_settings(&remote_home),
            ],
        );
        let script = crate::remote::agent::run_script(&remote.path, &args)?;
        let mut cmd = Command::new("ssh");
        cmd.args(remote.conn.host.ssh_options("yes")).arg("-T").arg("--").arg(&remote.conn.host.host).arg(script);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt as _;
            cmd.process_group(0);
        }
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("SPAWN_FAILED: {e}"))?
    } else {
        let root = registered_root(&app, &request.root)?;
        let exe = find_executable(spec.executables).ok_or("AGENT_NOT_INSTALLED")?;
        let memory_file = crate::memory::export_path(&app).ok().filter(|p| p.is_file());
        let args = build_args(spec.id, &request, memory_file.as_deref(), agents_file(&app, planner_model).as_deref())?;
        base_command(&exe)
            .args(&args)
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("SPAWN_FAILED: {e}"))?
    };

    let pid = child.id();
    runs.pids.lock().unwrap().insert(request.run_id.clone(), pid);
    if let (Some(remote), Some(sink)) = (&remote, &remote_pid) {
        runs.remote.lock().unwrap().insert(request.run_id.clone(), (remote.host_id.clone(), sink.clone()));
    }

    // 표준 입력은 실행이 끝날 때까지 열어 두고 권한 응답(agent_respond)에 쓴다
    let stdin: SharedStdin = Arc::new(Mutex::new(child.stdin.take()));
    runs.stdins.lock().unwrap().insert(request.run_id.clone(), stdin.clone());
    if let Err(e) = write_line(&stdin, &user_message(&request.prompt, &request.images)) {
        kill_tree(pid);
        runs.pids.lock().unwrap().remove(&request.run_id);
        runs.stdins.lock().unwrap().remove(&request.run_id);
        runs.remote.lock().unwrap().remove(&request.run_id);
        return Err(format!("SPAWN_FAILED: {e}"));
    }
    let out = spawn_reader(child.stdout.take().unwrap(), on_event.clone(), false, Some(stdin), None);
    let err = spawn_reader(child.stderr.take().unwrap(), on_event.clone(), true, None, remote_pid.clone());

    let status = tauri::async_runtime::spawn_blocking(move || {
        let status = child.wait();
        let _ = out.join();
        let _ = err.join();
        status
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    runs.pids.lock().unwrap().remove(&request.run_id);
    runs.stdins.lock().unwrap().remove(&request.run_id);
    let remote_entry = runs.remote.lock().unwrap().remove(&request.run_id);
    let cancelled = runs.cancelled.lock().unwrap().remove(&request.run_id);
    if let Some((host_id, sink)) = remote_entry {
        let remote_pid = *sink.lock().unwrap();
        // 정상 종료가 아니면(연결 끊김·중지) 원격에 남은 프로세스를 정리한다 (연결이 살아 있을 때만 닿는다)
        if status.code() != Some(0) {
            if let Some(remote_pid) = remote_pid {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { crate::remote::agent::kill_remote(&app, &host_id, remote_pid).await });
            }
        }
        if status.code() == Some(127) && !cancelled {
            let _ = on_event.send(AgentEvent::Stderr { line: "원격 PC에서 claude를 찾지 못했습니다. 원격 PC에 Claude Code를 설치하고 `claude`를 한 번 실행해 로그인하세요. (설정의 원격 접속에서 \"연결 시험\"으로 확인할 수 있습니다)".into() });
        }
        if status.code() == Some(255) && !cancelled {
            let _ = on_event.send(AgentEvent::Stderr { line: "CONNECTION_LOST: 원격 연결이 끊겼습니다. 다시 보내면 마지막 상태에서 이어서 진행합니다.".into() });
        }
    }
    Ok(AgentExit { code: status.code(), cancelled })
}

/// 실행 중인 에이전트의 권한 요청(control_request)에 답한다.
/// 웹뷰가 임의 입력을 보내지 못하도록 control_response 형식만 허용한다.
#[tauri::command]
pub fn agent_respond(runs: State<'_, AgentRuns>, run_id: String, message: Value) -> Result<(), String> {
    if message["type"] != "control_response" || !message["response"]["request_id"].is_string() {
        return Err("INVALID_RESPONSE".into());
    }
    let stdin = runs.stdins.lock().unwrap().get(&run_id).cloned().ok_or("RUN_NOT_FOUND")?;
    write_line(&stdin, &message.to_string())
}

/// 실행 중인 에이전트를 중지한다 (하위 프로세스 포함).
#[tauri::command]
pub async fn agent_cancel(app: AppHandle, runs: State<'_, AgentRuns>, run_id: String) -> Result<bool, String> {
    let pid = runs.pids.lock().unwrap().get(&run_id).copied();
    let remote = runs.remote.lock().unwrap().get(&run_id).cloned();
    Ok(match pid {
        Some(pid) => {
            runs.cancelled.lock().unwrap().insert(run_id);
            // 원격 실행이면 원격 claude와 하위 프로세스를 먼저 끝낸다 (이 PC의 ssh만 끊으면 원격에 남을 수 있다)
            if let Some((host_id, sink)) = remote {
                let remote_pid = *sink.lock().unwrap();
                if let Some(remote_pid) = remote_pid {
                    crate::remote::agent::kill_remote(&app, &host_id, remote_pid).await;
                }
            }
            kill_tree(pid);
            true
        }
        None => false,
    })
}

// ── 구독 플랜 · 사용량 확인 (상단 사용량 막대) ──

/** CLI를 실행해 표준 출력을 모은다. 시간이 넘으면 중단하고 None. 입력은 받지 않는다. */
pub(crate) fn capture(exe: &Path, cwd: Option<&Path>, args: &[&str], timeout: Duration) -> Option<String> {
    let mut cmd = base_command(exe);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut text);
        text
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                kill_tree(child.id());
                let _ = child.wait();
                return None;
            }
        }
    }
    reader.join().ok()
}

/// 구독 플랜: subscriptionType(예: "pro")과 세부 등급 planTier(Max의 5x·20x 구분이 들어 있을 수 있음)
#[derive(Serialize, PartialEq, Debug)]
pub struct PlanInfo {
    subscription: String,
    tier: Option<String>,
}

/// 플랜 값 하나: 64자 이하, 영문·숫자·_·- 만 (화면에 그대로 보여 주므로 낯선 문자는 받지 않는다)
fn plan_field(value: &Value, key: &str) -> Option<String> {
    let text = value.get(key)?.as_str()?.trim();
    let valid = !text.is_empty() && text.len() <= 64 && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    valid.then(|| text.to_string())
}

/// `claude auth status` 출력(JSON)에서 구독 플랜(subscriptionType·planTier)만 꺼낸다. 이메일·조직 등 다른 정보는 읽지도 저장하지도 않는다.
fn parse_plan(json: &str) -> Option<PlanInfo> {
    let value: Value = serde_json::from_str(json).ok()?;
    Some(PlanInfo { subscription: plan_field(&value, "subscriptionType")?, tier: plan_field(&value, "planTier") })
}

/// 구독 플랜 (예: pro). 로그인하지 않았거나 API 키 사용이면 None.
#[tauri::command]
pub async fn claude_plan() -> Option<PlanInfo> {
    tauri::async_runtime::spawn_blocking(|| {
        let exe = find_executable(&["claude"])?;
        parse_plan(&capture(&exe, None, &["auth", "status"], Duration::from_secs(10))?)
    })
    .await
    .ok()
    .flatten()
}

/// 사용량 확인 실행이 겹치지 않게 한다 (화면의 새로고침·트레이 메뉴·자동 새로고침이 동시에 CLI를 띄우지 않도록).
pub static PROBE_LOCK: Mutex<()> = Mutex::new(());

/// 가장 작은 모델로 한 번 실행해 rate_limit_event 한 줄을 얻는다 (블로킹, 비용은 거의 없다). 호출하는 쪽이 PROBE_LOCK을 잡는다.
pub fn probe_line(app: &AppHandle) -> Option<String> {
    let cwd = crate::data::base_dir(app).ok()?;
    std::fs::create_dir_all(&cwd).ok()?;
    let exe = find_executable(&["claude"])?;
    let args = ["-p", ".", "--model", "haiku", "--tools", "", "--no-session-persistence", "--output-format", "stream-json", "--verbose"];
    let output = capture(&exe, Some(&cwd), &args, Duration::from_secs(60))?;
    output.lines().find(|line| line.contains("\"type\":\"rate_limit_event\"")).map(str::to_string)
}

/// 사용량 확인: 가장 작은 모델로 한 번 실행해 rate_limit_event 한 줄을 돌려준다 (사용자가 누를 때·처음 한 번만 — 비용은 거의 없다).
#[tauri::command]
pub async fn claude_usage_probe(app: AppHandle) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = PROBE_LOCK.lock().ok()?;
        probe_line(&app)
    })
    .await
    .ok()
    .flatten()
}

// ── 대화 기록에서 개인 취향 학습 (공통 메모리) ──

const ANALYZE_SYSTEM_PROMPT: &str = "You analyze a user's past messages to AI coding agents and extract long-term personal preferences and working style. Output only the lines in the exact format the user requests. Do not use tools. Do not add explanations.";
const ANALYZE_TIMEOUT: Duration = Duration::from_secs(240);
const MAX_ANALYZE_PROMPT: usize = 80_000;

/// 분석 전용 실행 인자: 도구 없음, 세션 저장 안 함, 기본 시스템 프롬프트 대신 분석 지시만 사용.
/// 프롬프트(대화 기록)는 표준 입력으로 넘긴다 — 인자 주입 불가.
fn analyze_args() -> Vec<String> {
    ["-p", "--output-format", "text", "--tools", "", "--no-session-persistence", "--model", "sonnet", "--system-prompt", ANALYZE_SYSTEM_PROMPT]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

fn run_analyze(exe: &Path, cwd: &Path, prompt: &str) -> Result<String, String> {
    let mut child = base_command(exe)
        .args(analyze_args())
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("SPAWN_FAILED: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("SPAWN_FAILED: stdin")?;
    let input = prompt.to_string();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(input.as_bytes());
        // 여기서 stdin이 닫혀 CLI가 입력 끝을 안다
    });
    let mut stdout = child.stdout.take().ok_or("SPAWN_FAILED: stdout")?;
    let mut stderr = child.stderr.take().ok_or("SPAWN_FAILED: stderr")?;
    let out = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut s);
        s
    });
    let err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut stderr, &mut s);
        s
    });
    let deadline = Instant::now() + ANALYZE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                kill_tree(child.id());
                let _ = child.wait();
                return Err("ANALYZE_TIMEOUT".into());
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    let _ = writer.join();
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    if !status.success() {
        let detail = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
        let tail: String = detail.chars().rev().take(300).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(format!("ANALYZE_FAILED: {tail}"));
    }
    Ok(stdout)
}

/// 대화 기록 분석 (Claude Code). 결과 텍스트의 학습 태그 해석은 프런트엔드(memory-learn.ts)가 맡는다.
#[tauri::command]
pub async fn memory_analyze(app: AppHandle, prompt: String) -> Result<String, String> {
    if prompt.trim().is_empty() || prompt.len() > MAX_ANALYZE_PROMPT {
        return Err("INVALID_PROMPT".into());
    }
    let exe = find_executable(&["claude"]).ok_or("AGENT_NOT_INSTALLED")?;
    // 프로젝트 폴더가 아닌 앱 데이터 폴더에서 실행한다 (도구가 없으므로 파일에 접근하지 않음)
    let cwd = crate::memory::export_path(&app)?.parent().map(Path::to_path_buf).ok_or("INVALID_PATH")?;
    std::fs::create_dir_all(&cwd).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || run_analyze(&exe, &cwd, &prompt))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
#[path = "tests/agent.rs"]
mod tests;
