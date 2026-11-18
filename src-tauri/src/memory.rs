//! 공통(개인) 메모리: Google Drive 동기화 폴더 입출력 + 에이전트용 메모리 파일 내보내기.
//!
//! 동기화 방식: Google Drive가 PC의 폴더로 연결되어 있다고 보고(Windows: Google Drive for desktop,
//! Linux: rclone mount / google-drive-ocamlfuse / GNOME 온라인 계정 등) 사용자가 고른 폴더 안에
//! 전용 폴더 .AIWorkspace 를 (없으면) 만들고 그 바로 아래에
//!   <폴더>/.AIWorkspace/memory-<deviceId>.json
//! 을 기기마다 하나씩 쓴다. (이전 버전 위치 <폴더>/AIWorkspace/memory/devices/ 의 파일은 처음 동기화할 때 복사해 온다.)
//! 각 기기는 자기 파일만 쓰고 다른 기기 파일은 읽기만 하므로
//! Drive 쪽 쓰기 충돌(사본 생성)이 생기지 않는다. 병합(마지막 수정 우선 + 삭제 기록)은 프런트엔드가 맡는다.

use crate::data;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// 공통 메모리 전용 폴더 이름 (사용자가 고른 폴더 안에 자동으로 만든다. 이미 있으면 대소문자가 달라도 그대로 쓴다)
const DEDICATED_FOLDER: &str = ".AIWorkspace";
/// 기기별 스냅샷 파일 이름: memory-<deviceId>.json (다른 파일과 섞여도 구분하기 위한 접두사)
const SNAPSHOT_PREFIX: &str = "memory-";
/// 이전 버전의 저장 위치 (고른 폴더 기준)
const LEGACY_SUBDIR: [&str; 3] = ["AIWorkspace", "memory", "devices"];
const BLOCK_BEGIN: &str = "<!-- AIWorkspace:memory:begin (AIWorkspace가 자동 관리하는 영역입니다. 직접 수정하지 마세요) -->";
const BLOCK_END: &str = "<!-- AIWorkspace:memory:end -->";
/// 프로젝트 메모리: 프로젝트 폴더의 CLAUDE.md 안에 앱이 덧붙이는 관리 영역 (Claude가 CLAUDE.md를 원래 자동으로 읽는다)
const PROJECT_BEGIN: &str = "<!-- AIWorkspace:project-memory:begin (AIWorkspace가 학습한 이 프로젝트의 메모리입니다. 항목 줄은 직접 고치거나 지워도 되고, 이 주석 줄은 그대로 두세요) -->";
const PROJECT_END: &str = "<!-- AIWorkspace:project-memory:end -->";
const PROJECT_TITLE: &str = "## 프로젝트 메모리";
/// 프로젝트 메모리의 줄 수 상한 (넘으면 오래된 줄부터 지운다) · 줄당 글자 수 상한 · 한 번에 받는 줄 수 상한
const PROJECT_MAX_LINES: usize = 40;
const PROJECT_MAX_LINE_CHARS: usize = 300;
const PROJECT_MAX_ADD: usize = 10;

fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 설정(sync.json)에 저장된 동기화 폴더와 같은지 확인한다. 웹뷰가 임의 경로를 쓰지 못하게 한다.
fn configured_folder(app: &AppHandle, folder: &str) -> Result<PathBuf, String> {
    let configured = data::load(app, "sync")
        .and_then(|v| v.get("folder").and_then(|f| f.as_str()).map(String::from))
        .ok_or("SYNC_NOT_CONFIGURED")?;
    if configured != folder {
        return Err("SYNC_NOT_CONFIGURED".into());
    }
    let path = PathBuf::from(folder);
    if !path.is_dir() {
        // Drive가 꺼져 있거나 마운트되지 않음 → 오프라인으로 취급
        return Err("SYNC_FOLDER_UNAVAILABLE".into());
    }
    Ok(path)
}

/// parent 안의 전용 폴더 (대소문자 무시)
fn find_dedicated(parent: &Path) -> Option<PathBuf> {
    fs::read_dir(parent)
        .ok()?
        .flatten()
        .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(DEDICATED_FOLDER) && e.path().is_dir())
        .map(|e| e.path())
}

/// 스냅샷을 두는 폴더. 고른 폴더가 전용 폴더이면 그대로, 아니면 그 안의 전용 폴더(없으면 만든다).
fn sync_dir(selected: &Path) -> Result<PathBuf, String> {
    let is_dedicated = selected.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(DEDICATED_FOLDER));
    if is_dedicated {
        return Ok(selected.to_path_buf());
    }
    if let Some(dir) = find_dedicated(selected) {
        return Ok(dir);
    }
    let dir = selected.join(DEDICATED_FOLDER);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 이전 버전 위치의 스냅샷을 새 위치로 복사한다 (원본은 지우지 않는다). 새 파일이 없거나 이전 파일이 더 최신일 때만 —
/// 아직 업데이트하지 않은 다른 PC가 쓴 내용도 이어받는다.
fn migrate_legacy(selected: &Path, dir: &Path) {
    let legacy = LEGACY_SUBDIR.iter().fold(selected.to_path_buf(), |p, s| p.join(s));
    let Ok(entries) = fs::read_dir(&legacy) else { return };
    let newer = |a: &Path, b: &Path| match (fs::metadata(a).and_then(|m| m.modified()), fs::metadata(b).and_then(|m| m.modified())) {
        (Ok(a), Ok(b)) => a > b,
        _ => false,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") || name.starts_with('.') {
            continue;
        }
        let target = dir.join(format!("{SNAPSHOT_PREFIX}{name}"));
        if !target.exists() || newer(&entry.path(), &target) {
            let _ = fs::copy(entry.path(), &target);
        }
    }
}

/// 폴더 안에서 이름이 `prefix`로 시작하는 모든 기기 스냅샷(JSON)을 읽는다.
/// Drive가 만드는 충돌 사본("x (1).json")도 읽어 병합한다 — 내용은 같은 형식이므로 손실이 없다. 깨진 파일은 건너뛴다.
fn read_snapshots(dir: &Path, prefix: &str) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.starts_with(prefix) && name.ends_with(".json")
        })
        .filter_map(|entry| serde_json::from_str::<Value>(&fs::read_to_string(entry.path()).ok()?).ok())
        .collect()
}

/// 이 기기의 스냅샷 `<prefix><기기ID>.json`을 쓴다 (임시 파일 → 교체). 내용이 같으면 쓰지 않는다 (Drive 업로드·수정 시각 변경 최소화).
fn write_snapshot(dir: &Path, prefix: &str, device_id: &str, snapshot: &Value) -> Result<(), String> {
    if !is_safe_id(device_id) {
        return Err("INVALID_DEVICE_ID".into());
    }
    let target = dir.join(format!("{prefix}{device_id}.json"));
    let tmp = dir.join(format!(".{prefix}{device_id}.json.tmp"));
    let text = serde_json::to_string_pretty(snapshot).map_err(|e| e.to_string())?;
    if fs::read_to_string(&target).is_ok_and(|old| old == text) {
        return Ok(());
    }
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &target).map_err(|e| e.to_string())
}

/// 동기화 폴더의 모든 기기 메모리 스냅샷을 읽는다.
#[tauri::command]
pub fn memory_sync_pull(app: AppHandle, folder: String) -> Result<Vec<Value>, String> {
    let root = configured_folder(&app, &folder)?;
    let dir = sync_dir(&root)?;
    migrate_legacy(&root, &dir);
    Ok(read_snapshots(&dir, SNAPSHOT_PREFIX))
}

/// 이 기기의 메모리 스냅샷을 쓴다.
#[tauri::command]
pub fn memory_sync_push(app: AppHandle, folder: String, device_id: String, snapshot: Value) -> Result<(), String> {
    let root = configured_folder(&app, &folder)?;
    write_snapshot(&sync_dir(&root)?, SNAPSHOT_PREFIX, &device_id, &snapshot)
}

/// 음악 목록 스냅샷 파일 접두사: music-<기기ID>.json (링크·제목·곡별 음량만 — 음원 파일은 올리지 않는다)
const MUSIC_PREFIX: &str = "music-";

/// 동기화 폴더의 모든 기기 음악 목록 스냅샷을 읽는다.
#[tauri::command]
pub fn music_sync_pull(app: AppHandle, folder: String) -> Result<Vec<Value>, String> {
    let root = configured_folder(&app, &folder)?;
    Ok(read_snapshots(&sync_dir(&root)?, MUSIC_PREFIX))
}

/// 이 기기의 음악 목록 스냅샷을 쓴다.
#[tauri::command]
pub fn music_sync_push(app: AppHandle, folder: String, device_id: String, snapshot: Value) -> Result<(), String> {
    let root = configured_folder(&app, &folder)?;
    write_snapshot(&sync_dir(&root)?, MUSIC_PREFIX, &device_id, &snapshot)
}

/// 홈 위젯 스냅샷 파일 접두사: home-<기기ID>.json (위젯 정의·체크 상태·크기·순서·삭제 기록 — 받은 자료와 물가 캐시는 올리지 않는다)
const HOME_PREFIX: &str = "home-";

/// 동기화 폴더의 모든 기기 홈 위젯 스냅샷을 읽는다.
#[tauri::command]
pub fn home_sync_pull(app: AppHandle, folder: String) -> Result<Vec<Value>, String> {
    let root = configured_folder(&app, &folder)?;
    Ok(read_snapshots(&sync_dir(&root)?, HOME_PREFIX))
}

/// 이 기기의 홈 위젯 스냅샷을 쓴다.
#[tauri::command]
pub fn home_sync_push(app: AppHandle, folder: String, device_id: String, snapshot: Value) -> Result<(), String> {
    let root = configured_folder(&app, &folder)?;
    write_snapshot(&sync_dir(&root)?, HOME_PREFIX, &device_id, &snapshot)
}

/// 실제로 스냅샷을 두는 폴더 경로 (화면에 보여 준다). 없으면 만든다.
#[tauri::command]
pub fn memory_sync_location(app: AppHandle, folder: String) -> Result<String, String> {
    let root = configured_folder(&app, &folder)?;
    Ok(sync_dir(&root)?.to_string_lossy().to_string())
}

/// Google Drive 동기화 폴더 후보를 찾는다.
#[tauri::command]
pub fn memory_sync_candidates() -> Vec<String> {
    let mut found: Vec<PathBuf> = Vec::new();
    let names = ["My Drive", "내 드라이브"];
    #[cfg(windows)]
    {
        // Google Drive for desktop은 가상 드라이브(G: 등) 아래 "My Drive"/"내 드라이브"를 만든다
        for letter in b'D'..=b'Z' {
            for name in names {
                found.push(PathBuf::from(format!("{}:\\{}", letter as char, name)));
            }
        }
        if let Some(home) = std::env::var_os("USERPROFILE") {
            for name in ["Google Drive", "My Drive", "내 드라이브"] {
                found.push(PathBuf::from(&home).join(name));
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            for name in ["GoogleDrive", "Google Drive", "google-drive", "gdrive", "My Drive"] {
                found.push(home.join(name));
            }
            for name in names {
                found.push(home.join("GoogleDrive").join(name));
            }
        }
        // GNOME 온라인 계정(gvfs) 마운트
        if let Ok(uid) = fs::read_to_string("/proc/self/loginuid") {
            if let Ok(entries) = fs::read_dir(format!("/run/user/{}/gvfs", uid.trim())) {
                for e in entries.flatten() {
                    if e.file_name().to_string_lossy().starts_with("google-drive") {
                        found.push(e.path());
                    }
                }
            }
        }
    }
    // 이미 만들어 둔 전용 폴더(.AIWorkspace)가 있으면 먼저 보여 준다 (홈 폴더 바로 아래도 포함)
    #[allow(unused_mut)] // Windows에서는 홈 폴더 항목을 더하지 않는다
    let mut parents = found.clone();
    #[cfg(not(windows))]
    if let Some(home) = std::env::var_os("HOME") {
        parents.push(PathBuf::from(home));
    }
    let dedicated: Vec<PathBuf> = parents.iter().filter_map(|p| find_dedicated(p)).collect();
    dedicated
        .into_iter()
        .chain(found)
        .filter(|p| p.is_dir())
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    path: String,
    claude_global: Option<String>,
}

pub fn export_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data::base_dir(app)?.join("memory").join("AIWORKSPACE_MEMORY.md"))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// Claude Code의 설정 폴더 (CLAUDE_CONFIG_DIR 또는 ~/.claude)
pub(crate) fn claude_config_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).or_else(|| home_dir().map(|h| h.join(".claude")))
}

fn claude_global_file() -> Option<PathBuf> {
    Some(claude_config_dir()?.join("CLAUDE.md"))
}

/// 이전 버전의 Codex 연동 파일. 지원을 중단했으므로 남아 있는 관리 영역만 지운다.
fn legacy_codex_global_file() -> Option<PathBuf> {
    let dir = std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(|| home_dir().map(|h| h.join(".codex")))?;
    Some(dir.join("AGENTS.md"))
}

/// 파일 안의 AIWorkspace 관리 영역(공통 메모리)만 교체(또는 제거)한다. 사용자가 쓴 나머지 내용은 그대로 둔다.
pub fn apply_managed_block(existing: &str, content: Option<&str>) -> String {
    apply_block(existing, BLOCK_BEGIN, BLOCK_END, content)
}

/// begin·end 표시 사이의 관리 영역만 교체(content=None이면 제거)한다. 영역이 없으면 파일 끝에 덧붙인다.
fn apply_block(existing: &str, begin: &str, end_mark: &str, content: Option<&str>) -> String {
    // 기존 관리 영역을 뺀 사용자 내용
    let outside = match (existing.find(begin), existing.find(end_mark)) {
        (Some(start), Some(end)) if end > start => {
            let before = existing[..start].trim_end();
            let after = existing[end + end_mark.len()..].trim();
            match (before.is_empty(), after.is_empty()) {
                (_, true) => before.to_string(),
                (true, false) => after.to_string(),
                (false, false) => format!("{before}\n\n{after}"),
            }
        }
        _ => existing.to_string(),
    };
    match content {
        None => {
            if outside.is_empty() { String::new() } else { format!("{}\n", outside.trim_end()) }
        }
        Some(body) => {
            let block = format!("{begin}\n{}\n{end_mark}\n", body.trim());
            if outside.trim().is_empty() { block } else { format!("{}\n\n{block}", outside.trim_end()) }
        }
    }
}

fn sync_global(path: Option<PathBuf>, content: Option<&str>) -> Result<Option<String>, String> {
    let Some(path) = path else { return Ok(None) };
    let existing = fs::read_to_string(&path).unwrap_or_default();
    // 연동을 끈 상태이고 관리 영역도 없으면 파일을 건드리지 않는다
    if content.is_none() && !existing.contains(BLOCK_BEGIN) {
        return Ok(None);
    }
    let next = apply_managed_block(&existing, content);
    if next != existing {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&path, next).map_err(|e| e.to_string())?;
    }
    Ok(content.map(|_| path.to_string_lossy().to_string()))
}

/// 줄을 비교용으로 정리한다: "- " 불릿 제거, 공백 정리, 소문자.
fn normalize_line(line: &str) -> String {
    let text = line.trim();
    let text = text.strip_prefix("- ").or_else(|| text.strip_prefix('-')).unwrap_or(text);
    text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// CLAUDE.md 내용(existing)의 프로젝트 메모리 영역에 줄을 덧붙인 새 내용과, 실제로 추가된 줄 수 · 영역의 전체 줄 수를 돌려준다.
/// - 영역 밖(사용자가 쓴 내용)은 그대로 둔다. 영역이 없으면 파일 끝에 만든다.
/// - 이미 있는 줄(불릿·공백 무시)과 같은 줄은 건너뛰고, 한 번에 PROJECT_MAX_ADD줄까지만 받는다. 줄은 PROJECT_MAX_LINE_CHARS자로 자른다.
/// - 전체가 PROJECT_MAX_LINES줄을 넘으면 오래된(위쪽) 줄부터 지운다.
/// - 파일이 CRLF(윈도우 줄바꿈)면 결과도 CRLF로 쓴다.
pub fn add_project_memory(existing: &str, lines: &[String]) -> (String, usize, usize) {
    let crlf = existing.contains("\r\n");
    let text = existing.replace("\r\n", "\n");
    // 현재 영역의 불릿 줄
    let mut current: Vec<String> = match (text.find(PROJECT_BEGIN), text.find(PROJECT_END)) {
        (Some(start), Some(end)) if end > start => text[start + PROJECT_BEGIN.len()..end]
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with("- "))
            .map(String::from)
            .collect(),
        _ => Vec::new(),
    };
    let mut seen: Vec<String> = current.iter().map(|l| normalize_line(l)).collect();
    let mut added = 0;
    for line in lines {
        if added >= PROJECT_MAX_ADD {
            break;
        }
        let key = normalize_line(line);
        if key.is_empty() || seen.contains(&key) {
            continue;
        }
        let body: String = line.trim().trim_start_matches("- ").split_whitespace().collect::<Vec<_>>().join(" ");
        let body: String = body.chars().take(PROJECT_MAX_LINE_CHARS).collect();
        current.push(format!("- {body}"));
        seen.push(key);
        added += 1;
    }
    if current.len() > PROJECT_MAX_LINES {
        current.drain(..current.len() - PROJECT_MAX_LINES);
    }
    let total = current.len();
    let next = if added == 0 {
        text.clone()
    } else {
        let body = format!("{PROJECT_TITLE}\n\n{}", current.join("\n"));
        apply_block(&text, PROJECT_BEGIN, PROJECT_END, Some(&body))
    };
    (if crlf { next.replace('\n', "\r\n") } else { next }, added, total)
}

#[derive(Serialize)]
pub struct ProjectMemoryResult {
    path: String,
    added: usize,
    total: usize,
}

/// 프로젝트 메모리(프로젝트 폴더 CLAUDE.md의 앱 관리 영역)에 학습한 줄을 덧붙인다. 파일이 없으면 만든다.
#[tauri::command]
pub async fn project_memory_add(app: AppHandle, root: String, lines: Vec<String>) -> Result<ProjectMemoryResult, String> {
    if let Some(remote) = crate::remote::ops::resolve(&app, &root).await? {
        // 원격 프로젝트: 원격 폴더의 CLAUDE.md에 쓴다 (공통 메모리는 이 PC에 그대로 있다)
        let existing = crate::remote::ops::read_optional(&remote, "CLAUDE.md").await?.unwrap_or_default();
        let (next, added, total) = add_project_memory(&existing, &lines);
        let path = format!("{}/CLAUDE.md", remote.path);
        if next != existing {
            crate::remote::ops::write_replace(&remote.conn, &path, next.as_bytes()).await?;
        }
        return Ok(ProjectMemoryResult { path, added, total });
    }
    let root = crate::workspace::registered_root(&app, &root)?;
    let path = root.join("CLAUDE.md");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let (next, added, total) = add_project_memory(&existing, &lines);
    if next != existing {
        fs::write(&path, next).map_err(|e| e.to_string())?;
    }
    Ok(ProjectMemoryResult { path: path.to_string_lossy().to_string(), added, total })
}

/// 에이전트가 참고할 메모리 파일을 쓴다.
/// - 항상: 앱 데이터 폴더의 AIWORKSPACE_MEMORY.md (AIWorkspace에서 실행하는 Claude Code에 전달)
/// - 선택: ~/.claude/CLAUDE.md 의 관리 영역 (AIWorkspace 밖에서 Claude Code를 써도 참고)
/// - 정리: 이전 버전이 ~/.codex/AGENTS.md에 남긴 관리 영역이 있으면 지운다 (나머지 내용은 그대로)
/// global_markdown: 전역 파일용 (AIWorkspace 밖에서는 학습 태그를 처리할 수 없으므로 학습 지시가 빠진 버전)
#[tauri::command]
pub fn memory_export(
    app: AppHandle,
    markdown: String,
    global_markdown: String,
    claude_global: bool,
) -> Result<ExportResult, String> {
    let path = export_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if fs::read_to_string(&path).map_or(true, |old| old != markdown) {
        fs::write(&path, &markdown).map_err(|e| e.to_string())?;
    }
    let body = global_markdown.as_str();
    // 실패해도 메모리 내보내기에는 영향 없음
    let _ = sync_global(legacy_codex_global_file(), None);
    Ok(ExportResult {
        path: path.to_string_lossy().to_string(),
        claude_global: sync_global(claude_global_file(), claude_global.then_some(body))?,
    })
}

#[cfg(test)]
#[path = "tests/memory.rs"]
mod tests;
