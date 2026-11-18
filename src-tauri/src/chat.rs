//! 일반 채팅: 프로젝트와 무관한 대화를 공식 CLI(Claude Code · OpenAI Codex)로 실행한다.
//!
//! 웹의 claude.ai·chatgpt.com 채팅과 같은 결과를 목표로 웹 검색과 이미지·파일 첨부를 지원한다 (구독 계정으로 로그인한 CLI를 쓰므로 API 키는 저장하지 않는다).
//! - 작업 폴더는 빈 `<앱 데이터>/chat-work` — 프로젝트 파일·`CLAUDE.md`를 읽지 않는다.
//! - Claude: 읽기 전용 웹 도구(`WebSearch`·`WebFetch`)만 켜고 미리 허용한다(권한 요청을 받지 않는다). 사용자 설정·MCP 서버는 읽지 않는다.
//! - Codex: 읽기 전용 샌드박스, 웹 검색은 최상위 `--search`, 사용자 설정은 읽지 않는다. 지침은 첫 턴 입력 앞의 `[지침]…[/지침]` 블록.
//! - 맥락은 CLI 세션 재개가 기본이다 (`session`에 이전 세션 id를 주면 이어서 실행).
//! - 출력은 줄 단위로 그대로 전달하고(파싱은 화면 쪽 `chat-parse.ts`), 10분을 넘기거나 180초 동안 출력이 없으면 중단한다.
//!
//! 인자는 실제 CLI로 확인한 것이다.

use crate::agent::{base_command, capture, find_executable, kill_tree};
use crate::data;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

/// Claude 모델 (프로젝트 채팅과 같은 이름)
const CLAUDE_MODELS: [&str; 3] = ["haiku", "sonnet", "opus"];
const DEFAULT_CLAUDE_MODEL: &str = "sonnet";
/// 한 번의 요청이 걸릴 수 있는 최대 시간 / 출력이 없는 채로 기다릴 최대 시간
const TOTAL_TIMEOUT: Duration = Duration::from_secs(600);
const IDLE_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_PROMPT_BYTES: usize = 1_500_000;
const MAX_IMAGES: usize = 5;
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
/// 도구를 쓰는 응답이 한없이 이어지지 않게 하는 Claude의 최대 턴 수
const CLAUDE_MAX_TURNS: &str = "8";

/// 실행 중인 채팅 프로세스 (request_id → pid)
#[derive(Default)]
pub struct ChatRuns {
    pids: Mutex<HashMap<String, u32>>,
    cancelled: Mutex<HashSet<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    request_id: String,
    /// "claude" | "codex"
    provider: String,
    /// Claude는 haiku·sonnet·opus(없으면 sonnet), Codex는 모델 이름(없으면 Codex 기본 모델)
    #[serde(default)]
    model: Option<String>,
    /// 지침 (공통 메모리 + 학습 규칙 + 오늘 날짜 등)
    system: String,
    prompt: String,
    /// 첨부 이미지 파일 경로 — \`<앱 데이터>/data/chat-files\` 안의 파일만 받는다
    #[serde(default)]
    images: Vec<String>,
    /// 웹 검색·페이지 읽기를 켤지
    #[serde(default)]
    web: bool,
    /// 이어 갈 이전 세션 id (Claude 세션 id 또는 Codex 스레드 id)
    #[serde(default)]
    session: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatEvent {
    Stdout { line: String },
    Stderr { line: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatExit {
    code: Option<i32>,
    cancelled: bool,
    timed_out: bool,
}

fn is_safe_id(id: &str, hex_only: bool) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| if hex_only { c.is_ascii_hexdigit() || c == '-' } else { c.is_ascii_alphanumeric() || c == '-' || c == '_' })
}

/// 사용할 모델 이름. Claude는 허용 목록 안에서만, Codex는 안전한 글자로 된 이름이면 CLI에 맡긴다(계정이 못 쓰는 모델은 CLI가 거절한다).
fn pick_model(provider: &str, model: &Option<String>) -> Result<Option<String>, String> {
    match (provider, model.as_deref().map(str::trim).filter(|m| !m.is_empty())) {
        ("claude", None) => Ok(Some(DEFAULT_CLAUDE_MODEL.into())),
        ("claude", Some(m)) if CLAUDE_MODELS.contains(&m) => Ok(Some(m.into())),
        ("claude", Some(_)) => Err("INVALID_MODEL".into()),
        ("codex", None) => Ok(None),
        ("codex", Some(m)) if m.len() <= 64 && m.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) => Ok(Some(m.into())),
        ("codex", Some(_)) => Err("INVALID_MODEL".into()),
        _ => Err("INVALID_PROVIDER".into()),
    }
}

/// Claude 인자: 읽기 전용 웹 도구 둘만(--tools) 켜고 그 둘은 미리 허용(--allowedTools — 권한 요청을 받지 않는다), 기본 시스템 프롬프트는 지침 파일로 대체,
/// MCP 서버·사용자 전역 설정(~/.claude/CLAUDE.md 등)은 읽지 않는다. 웹이 꺼져 있으면 도구를 하나도 주지 않는다.
fn claude_args(model: &str, system_file: &Path, session: Option<&str>, web: bool) -> Vec<String> {
    let mut args: Vec<String> = ["-p", "--verbose", "--output-format", "stream-json", "--input-format", "stream-json", "--model", model, "--system-prompt-file"].map(String::from).into();
    args.push(system_file.to_string_lossy().to_string());
    if web {
        args.extend(["--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch", "WebFetch"].map(String::from));
    } else {
        args.extend(["--tools", ""].map(String::from));
    }
    args.extend(["--strict-mcp-config", "--setting-sources", "local", "--max-turns", CLAUDE_MAX_TURNS].map(String::from));
    if let Some(id) = session {
        args.extend(["--resume".into(), id.into()]);
    }
    args
}

/// Codex 인자: 웹 검색은 최상위 --search(exec 앞), 읽기 전용 샌드박스, 사용자 설정은 읽지 않는다.
/// 재개(`exec resume`)는 -s를 받지 않으므로 같은 뜻의 설정값(sandbox_mode)으로 넘긴다. 프롬프트는 stdin(이미지가 있으면 - 로 표시).
fn codex_args(model: Option<&str>, session: Option<&str>, web: bool, images: &[PathBuf]) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if web {
        args.push("--search".into());
    }
    args.push("exec".into());
    if let Some(id) = session {
        args.extend(["resume".into(), id.into()]);
    }
    args.extend(["--json", "--skip-git-repo-check", "--ignore-user-config"].map(String::from));
    if session.is_some() {
        args.extend(["-c".into(), "sandbox_mode=\"read-only\"".into()]);
    } else {
        args.extend(["-s".into(), "read-only".into()]);
    }
    if let Some(m) = model {
        args.extend(["-m".into(), m.into()]);
    }
    for path in images {
        args.extend(["-i".into(), path.to_string_lossy().to_string()]);
    }
    if !images.is_empty() {
        args.push("-".into());
    }
    args
}

/// Codex에 보낼 입력. 지침은 새 세션의 첫 턴에만 앞에 붙인다 (재개할 때는 첫 턴의 지침이 세션에 남아 있다).
fn codex_stdin(system: &str, prompt: &str, first_turn: bool) -> String {
    if first_turn { format!("[지침]\n{}\n[/지침]\n\n{prompt}", system.trim()) } else { prompt.to_string() }
}

fn image_media_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// 첨부 이미지 경로 검사: 개수·형식·크기, 그리고 채팅 파일 폴더(`chat-files`) 안의 파일만
fn resolve_images(allowed_dir: &Path, images: &[String]) -> Result<Vec<PathBuf>, String> {
    if images.len() > MAX_IMAGES {
        return Err("TOO_MANY_IMAGES".into());
    }
    let allowed = fs::canonicalize(allowed_dir).map_err(|_| "INVALID_IMAGE".to_string())?;
    let mut out = Vec::new();
    for image in images {
        let path = fs::canonicalize(image).map_err(|_| "INVALID_IMAGE".to_string())?;
        let meta = fs::metadata(&path).map_err(|_| "INVALID_IMAGE".to_string())?;
        if !path.starts_with(&allowed) || !meta.is_file() || image_media_type(&path).is_none() || meta.len() > MAX_IMAGE_BYTES {
            return Err("INVALID_IMAGE".into());
        }
        out.push(path);
    }
    Ok(out)
}

/// 채팅의 작업 폴더·지침 파일·첨부 파일 위치
fn chat_work_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data::base_dir(app)?.join("chat-work");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub(crate) fn chat_files_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data::data_dir(app)?.join("chat-files");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn spawn_lines<R: std::io::Read + Send + 'static>(reader: R, channel: Channel<ChatEvent>, stderr: bool, activity: Arc<AtomicU64>, started: Instant) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).split(b'\n').map_while(Result::ok) {
            let text = String::from_utf8_lossy(&line).trim_end_matches('\r').to_string();
            if text.is_empty() {
                continue;
            }
            activity.store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
            let event = if stderr { ChatEvent::Stderr { line: text } } else { ChatEvent::Stdout { line: text } };
            if channel.send(event).is_err() {
                break;
            }
        }
    })
}

/// 시간 제한에 걸렸는지: 시작한 뒤 전체 시간(elapsed)이 10분을 넘었거나, 마지막 출력(last_output은 시작 기준 시각) 이후 180초가 지났으면 true
fn timeout_reached(elapsed: Duration, last_output: Duration) -> bool {
    elapsed > TOTAL_TIMEOUT || elapsed.saturating_sub(last_output) > IDLE_TIMEOUT
}

/// 채팅 한 번 실행. 출력은 on_event로 줄 단위 전달하고, 프로세스가 끝나면 결과를 돌려준다.
#[tauri::command]
pub async fn chat_send(app: AppHandle, runs: State<'_, ChatRuns>, request: ChatRequest, on_event: Channel<ChatEvent>) -> Result<ChatExit, String> {
    if !is_safe_id(&request.request_id, false) {
        return Err("INVALID_REQUEST".into());
    }
    if request.prompt.len() > MAX_PROMPT_BYTES || request.system.len() > MAX_PROMPT_BYTES {
        return Err("PROMPT_TOO_LONG".into());
    }
    let session = request.session.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if session.is_some_and(|s| !is_safe_id(s, true)) {
        return Err("INVALID_SESSION".into());
    }
    let model = pick_model(&request.provider, &request.model)?;
    let exe = find_executable(&[request.provider.as_str()]).ok_or("CLI_NOT_FOUND")?;
    let work = chat_work_dir(&app)?;
    let images = resolve_images(&chat_files_dir(&app)?, &request.images)?;

    // 입력과 인자
    let mut system_file: Option<PathBuf> = None;
    let (args, stdin_text) = if request.provider == "claude" {
        let memory_dir = data::base_dir(&app)?.join("memory");
        fs::create_dir_all(&memory_dir).map_err(|e| e.to_string())?;
        let path = memory_dir.join(format!("chat-system-{}.md", request.request_id));
        fs::write(&path, &request.system).map_err(|e| e.to_string())?;
        system_file = Some(path.clone());
        let blocks = images
            .iter()
            .map(|p| {
                let bytes = fs::read(p).map_err(|_| "INVALID_IMAGE".to_string())?;
                Ok(crate::agent::ImageInput::new(image_media_type(p).unwrap_or("image/png"), base64::engine::general_purpose::STANDARD.encode(bytes)))
            })
            .collect::<Result<Vec<_>, String>>()?;
        (claude_args(model.as_deref().unwrap_or(DEFAULT_CLAUDE_MODEL), &path, session, request.web), crate::agent::user_message(&request.prompt, &blocks))
    } else {
        (codex_args(model.as_deref(), session, request.web, &images), codex_stdin(&request.system, &request.prompt, session.is_none()))
    };

    let started = Instant::now();
    let spawned = base_command(&exe).args(&args).current_dir(&work).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();
    let mut child: Child = match spawned {
        Ok(child) => child,
        Err(e) => {
            if let Some(f) = &system_file {
                let _ = fs::remove_file(f);
            }
            return Err(format!("SPAWN_FAILED: {e}"));
        }
    };
    let pid = child.id();
    runs.pids.lock().unwrap().insert(request.request_id.clone(), pid);

    // 입력을 보내고 닫는다 (두 CLI 모두 입력이 닫히면 한 번의 요청을 처리하고 끝난다)
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(stdin_text.as_bytes()).and_then(|_| stdin.write_all(b"\n")) {
            kill_tree(pid);
            runs.pids.lock().unwrap().remove(&request.request_id);
            if let Some(f) = &system_file {
                let _ = fs::remove_file(f);
            }
            return Err(format!("SPAWN_FAILED: {e}"));
        }
    }

    let activity = Arc::new(AtomicU64::new(0));
    let out = spawn_lines(child.stdout.take().unwrap(), on_event.clone(), false, activity.clone(), started);
    let err = spawn_lines(child.stderr.take().unwrap(), on_event, true, activity.clone(), started);

    // 시간 제한: 전체 10분 / 출력 없이 180초
    let done = Arc::new(AtomicBool::new(false));
    let timed_out = Arc::new(AtomicBool::new(false));
    {
        let (done, timed_out, activity) = (done.clone(), timed_out.clone(), activity.clone());
        std::thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(500));
                if timeout_reached(started.elapsed(), Duration::from_millis(activity.load(Ordering::Relaxed))) {
                    timed_out.store(true, Ordering::Relaxed);
                    kill_tree(pid);
                    break;
                }
            }
        });
    }

    let status = tauri::async_runtime::spawn_blocking(move || {
        let status = child.wait();
        let _ = out.join();
        let _ = err.join();
        status
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string());
    done.store(true, Ordering::Relaxed);

    runs.pids.lock().unwrap().remove(&request.request_id);
    if let Some(f) = &system_file {
        let _ = fs::remove_file(f);
    }
    let cancelled = runs.cancelled.lock().unwrap().remove(&request.request_id);
    Ok(ChatExit { code: status?.code(), cancelled, timed_out: timed_out.load(Ordering::Relaxed) })
}

/// 실행 중인 채팅을 중지한다 (하위 프로세스 포함). 이미 받은 출력은 그대로 남는다.
#[tauri::command]
pub fn chat_cancel(runs: State<'_, ChatRuns>, request_id: String) -> bool {
    let pid = runs.pids.lock().unwrap().get(&request_id).copied();
    match pid {
        Some(pid) => {
            runs.cancelled.lock().unwrap().insert(request_id);
            kill_tree(pid);
            true
        }
        None => false,
    }
}

// ── 첨부 파일 저장·정리 ──

/// 첨부 파일 이름: `<영문·숫자·-·_ 최대 64자>.<png|jpg|jpeg|gif|webp|txt>` — 경로를 만들 수 없는 이름만 받는다
fn is_valid_attachment_name(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else { return false };
    !stem.is_empty() && stem.len() <= 64 && stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') && ["png", "jpg", "jpeg", "gif", "webp", "txt"].contains(&ext)
}

/// 첨부 파일 하나의 최대 크기: 이미지 20MB, 글(PDF에서 뽑은 글 포함) 3MB
fn attachment_limit(name: &str) -> usize {
    if name.ends_with(".txt") { 3 * 1024 * 1024 } else { MAX_IMAGE_BYTES as usize }
}

/// 첨부 파일(base64)을 이 대화의 채팅 파일 폴더에 저장하고 파일 경로를 돌려준다. 이미지는 `chat_send`의 images에 이 경로를 넘긴다.
#[tauri::command]
pub fn chat_attach_save(app: AppHandle, chat_id: String, name: String, data: String) -> Result<String, String> {
    if !is_safe_id(&chat_id, false) || !is_valid_attachment_name(&name) {
        return Err("INVALID_ATTACHMENT".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|_| "INVALID_ATTACHMENT".to_string())?;
    if bytes.is_empty() || bytes.len() > attachment_limit(&name) {
        return Err("INVALID_ATTACHMENT".into());
    }
    let dir = chat_files_dir(&app)?.join(&chat_id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// 첨부로 저장해 둔 글(.txt, PDF에서 뽑은 글 포함)을 읽는다 (인터럽트된 질문을 다시 보낼 때 첨부 글을 되살리는 용도)
#[tauri::command]
pub fn chat_attach_read(app: AppHandle, chat_id: String, name: String) -> Result<String, String> {
    if !is_safe_id(&chat_id, false) || !is_valid_attachment_name(&name) || !name.ends_with(".txt") {
        return Err("INVALID_ATTACHMENT".into());
    }
    fs::read_to_string(chat_files_dir(&app)?.join(&chat_id).join(&name)).map_err(|_| "NOT_FOUND".to_string())
}

#[derive(Deserialize)]
pub struct ChatSessionRef {
    provider: String,
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteReport {
    files_removed: bool,
    sessions_removed: usize,
}

/// Claude가 작업 폴더별로 세션을 저장하는 폴더 이름: 작업 폴더 경로의 영문·숫자가 아닌 글자를 -로 바꾼 것
fn claude_project_dir_name(work_dir: &Path) -> String {
    work_dir.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// 대화를 지울 때 함께 정리한다: 이 대화의 첨부 파일 폴더(chat_id가 없으면 모든 대화의 첨부)와 CLI가 남긴 세션 파일.
/// Claude는 `<설정 폴더>/projects/<작업 폴더 이름>/<세션 id>.jsonl`(과 같은 이름의 폴더)을, Codex는 `codex delete --force <스레드 id>`로 지운다.
/// 일부가 실패해도 나머지는 계속하며, 실제로 지운 세션 수를 돌려준다.
#[tauri::command]
pub async fn chat_delete_files(app: AppHandle, chat_id: Option<String>, sessions: Vec<ChatSessionRef>) -> Result<DeleteReport, String> {
    let files_dir = chat_files_dir(&app)?;
    let work = chat_work_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut files_removed = false;
        match chat_id.as_deref() {
            Some(id) if is_safe_id(id, false) => {
                files_removed = fs::remove_dir_all(files_dir.join(id)).is_ok();
            }
            Some(_) => return Err("INVALID_REQUEST".to_string()),
            None => {
                for entry in fs::read_dir(&files_dir).map_err(|e| e.to_string())?.flatten() {
                    files_removed |= fs::remove_dir_all(entry.path()).is_ok();
                }
            }
        }
        let mut sessions_removed = 0;
        for session in &sessions {
            if !is_safe_id(&session.id, true) {
                continue;
            }
            let removed = match session.provider.as_str() {
                "claude" => crate::memory::claude_config_dir().is_some_and(|config| {
                    let dir = config.join("projects").join(claude_project_dir_name(&work));
                    let file = fs::remove_file(dir.join(format!("{}.jsonl", session.id))).is_ok();
                    let _ = fs::remove_dir_all(dir.join(&session.id));
                    file
                }),
                "codex" => find_executable(&["codex"])
                    .and_then(|exe| capture(&exe, None, &["delete", "--force", &session.id], Duration::from_secs(20)))
                    .is_some_and(|out| out.contains("Deleted")),
                _ => false,
            };
            if removed {
                sessions_removed += 1;
            }
        }
        Ok(DeleteReport { files_removed, sessions_removed })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
    slug: String,
    display_name: String,
    /// 맥락 창 크기(토큰). 목록에 없으면 None
    context_window: Option<u64>,
}

/// `codex debug models`의 JSON에서 선택 목록에 보이는(visibility=list) 모델을 우선순위 순으로 뽑는다.
fn parse_codex_models(json: &str) -> Vec<CodexModel> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else { return Vec::new() };
    let mut models: Vec<(i64, CodexModel)> = value["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["visibility"] == "list")
        .filter_map(|m| {
            let slug = m["slug"].as_str()?.to_string();
            let display_name = m["display_name"].as_str().unwrap_or(&slug).to_string();
            Some((m["priority"].as_i64().unwrap_or(i64::MAX), CodexModel { slug, display_name, context_window: m["context_window"].as_u64() }))
        })
        .collect();
    models.sort_by_key(|(priority, _)| *priority);
    models.into_iter().map(|(_, m)| m).collect()
}

/// 이 계정의 Codex가 보여 주는 ChatGPT 모델 목록. Codex가 없거나 실패하면 빈 목록(화면은 기본 모델만 보여 준다).
#[tauri::command]
pub async fn chat_codex_models() -> Vec<CodexModel> {
    tauri::async_runtime::spawn_blocking(|| {
        find_executable(&["codex"])
            .and_then(|exe| capture(&exe, None, &["debug", "models"], Duration::from_secs(20)))
            .map(|json| parse_codex_models(&json))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
#[path = "tests/chat.rs"]
mod tests;
