//! 음악: 사용자가 등록한 유튜브 링크의 음원만 yt-dlp로 내려받아 앱 데이터 폴더에 두고, 재생할 때 바이트로 읽어 준다.
//! - 유튜브 임베드 대신 내려받아 재생한다 (임베드는 Tauri 출처에서 막히고 광고가 나오며 보안 정책을 풀어야 한다).
//! - ffmpeg로 변환하지 않는다. 원본 음원(m4a)을 그대로 쓴다.
//! - yt-dlp는 앱 설치 파일에 넣지 않는다. PATH에 있으면 그것을 쓰고, 없으면 사용자가 버튼을 눌렀을 때 공식 릴리즈를 받아 앱 데이터 폴더(tools)에 둔다 (SHA256 확인).
//! - 웹뷰가 임의 명령·URL을 넘기지 못하게, 받을 주소는 영상 ID(11자)로만 만든다.

use crate::{agent, data};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::AppHandle;

/// 재생용으로 읽을 수 있는 음원 크기 상한
const MAX_AUDIO_BYTES: u64 = 300 * 1024 * 1024;
/// 곡 하나를 받는 데 걸릴 수 있는 시간 상한
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// 내려받는 yt-dlp 실행 파일 크기 상한 (정상은 약 25MB)
const TOOL_MAX_BYTES: usize = 120 * 1024 * 1024;
const RELEASE_BASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";

/// 곡을 한 번에 하나씩만 받는다 (여러 곡은 화면이 차례로 요청한다)
static DOWNLOAD_LOCK: Mutex<()> = Mutex::new(());

/// 유튜브 영상 ID: 11자 영숫자·`-`·`_`
pub fn is_video_id(id: &str) -> bool {
    id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn music_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data::base_dir(app)?.join("music");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn tools_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data::base_dir(app)?.join("tools"))
}

/// 릴리즈 파일 이름 (Windows exe, Linux 단일 실행 파일)
fn tool_asset() -> &'static str {
    if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp_linux" }
}

/// SHA2-256SUMS 내용에서 파일의 해시를 찾는다 (줄 형식: "<해시>  <파일이름>", 파일 이름 앞에 `*`가 붙을 수 있음)
fn expected_sha256(sums: &str, asset: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let (hash, name) = (parts.next()?, parts.next()?);
        (name.trim_start_matches('*') == asset && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())).then(|| hash.to_lowercase())
    })
}

// ── yt-dlp 도구 ──

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    /// 찾은 경로 (없으면 null)
    path: Option<String>,
    /// "path"(PC에 이미 설치됨) | "app"(앱이 받아 둔 사본)
    source: Option<&'static str>,
    version: Option<String>,
}

fn app_tool(app: &AppHandle) -> Option<PathBuf> {
    let path = tools_dir(app).ok()?.join(tool_asset());
    path.is_file().then_some(path)
}

/// PATH의 yt-dlp를 먼저, 없으면 앱이 받아 둔 사본
fn find_tool(app: &AppHandle) -> Option<(PathBuf, &'static str)> {
    agent::find_executable(&["yt-dlp"]).map(|p| (p, "path")).or_else(|| app_tool(app).map(|p| (p, "app")))
}

fn tool_status(app: &AppHandle) -> ToolStatus {
    match find_tool(app) {
        Some((path, source)) => {
            let version = agent::capture(&path, None, &["--version"], Duration::from_secs(15)).and_then(|t| t.lines().next().map(|l| l.trim().to_string()));
            ToolStatus { path: Some(path.to_string_lossy().to_string()), source: Some(source), version }
        }
        None => ToolStatus { path: None, source: None, version: None },
    }
}

/// yt-dlp가 있는지·버전 확인
#[tauri::command]
pub async fn music_tool_status(app: AppHandle) -> ToolStatus {
    tauri::async_runtime::spawn_blocking(move || tool_status(&app)).await.unwrap_or(ToolStatus { path: None, source: None, version: None })
}

/// 공식 릴리즈에서 yt-dlp를 받아 앱 데이터 폴더(tools)에 둔다. SHA2-256SUMS와 해시가 맞아야 저장한다.
#[tauri::command]
pub async fn music_tool_install(app: AppHandle) -> Result<ToolStatus, String> {
    if crate::data::external_blocked() {
        return Err("점검용 실행에서는 외부 서버를 부르지 않습니다.".into());
    }
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let asset = tool_asset();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(300)).build().map_err(|e| e.to_string())?;
    let fetch = |name: &'static str| {
        let client = client.clone();
        async move {
            let response = client.get(format!("{RELEASE_BASE}/{name}")).send().await.map_err(|e| format!("내려받지 못했습니다: {e}"))?;
            if !response.status().is_success() {
                return Err(format!("내려받지 못했습니다 (HTTP {})", response.status().as_u16()));
            }
            response.bytes().await.map_err(|e| format!("내려받지 못했습니다: {e}"))
        }
    };
    let (binary, sums) = (fetch(asset).await?, fetch("SHA2-256SUMS").await?);
    if binary.len() > TOOL_MAX_BYTES {
        return Err("내려받은 파일이 예상보다 큽니다.".into());
    }
    let expected = expected_sha256(&String::from_utf8_lossy(&sums), asset).ok_or("공식 해시 목록에서 파일을 찾지 못했습니다.")?;
    let actual: String = Sha256::digest(&binary).iter().map(|b| format!("{b:02x}")).collect();
    if actual != expected {
        return Err("내려받은 파일이 공식 해시와 달라 저장하지 않았습니다.".into());
    }
    let dir = tools_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(asset);
    let tmp = dir.join(format!("{asset}.tmp"));
    fs::write(&tmp, &binary).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    Ok(tauri::async_runtime::spawn_blocking(move || tool_status(&app)).await.map_err(|e| e.to_string())?)
}

/// 앱이 받아 둔 yt-dlp를 최신으로 올린다 (`-U`). PC에 따로 설치된 것은 건드리지 않는다.
#[tauri::command]
pub async fn music_tool_update(app: AppHandle) -> Result<ToolStatus, String> {
    if crate::data::external_blocked() {
        return Err("점검용 실행에서는 외부 서버를 부르지 않습니다.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let path = app_tool(&app).ok_or("NOT_APP_TOOL")?;
        agent::capture(&path, None, &["-U"], Duration::from_secs(180)).ok_or("업데이트하지 못했습니다.")?;
        Ok(tool_status(&app))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── 내려받기 ──

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MusicProgress {
    percent: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicDownload {
    id: String,
    title: String,
    /// 초 (모르면 null)
    duration: Option<f64>,
    ext: String,
    bytes: u64,
}

/// `PROGRESS|  42.3%|   9.80MiB|00:05` → 42.3
fn parse_progress(line: &str) -> Option<f64> {
    let rest = line.strip_prefix("PROGRESS|")?;
    rest.split('|').next()?.trim().trim_end_matches('%').trim().parse().ok()
}

/// `META|<id>|<초>|<제목>` (제목에 `|`가 들어 있어도 되도록 제목을 마지막에 둔다)
fn parse_meta(line: &str) -> Option<(String, Option<f64>, String)> {
    let mut parts = line.strip_prefix("META|")?.splitn(3, '|');
    let id = parts.next()?.to_string();
    let duration = parts.next()?.trim().parse::<f64>().ok();
    let title = parts.next()?.trim().to_string();
    is_video_id(&id).then_some((id, duration, title))
}

/// 내려받은 음원 파일 (id로 시작하고 임시 파일이 아닌 것)
fn find_audio(dir: &Path, id: &str) -> Option<PathBuf> {
    fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| {
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        name.starts_with(&format!("{id}.")) && ![".part", ".ytdl", ".tmp", ".temp"].iter().any(|s| name.ends_with(s)) && p.is_file()
    })
}

/// 실패하거나 취소된 뒤 남은 임시 파일을 지운다
fn remove_partials(dir: &Path, id: &str) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&format!("{id}.")) && [".part", ".ytdl", ".tmp", ".temp"].iter().any(|s| name.ends_with(s)) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/// 영상 정보(제목·길이)를 받아 두는 임시 파일. 제목은 한글·일본어 등이 들어 있고, yt-dlp는 화면(stdout)에는 Windows 기본 문자 인코딩(cp949 등)으로 내보내므로
/// UTF-8로 쓰는 파일(--print-to-file)로 받는다. (stdout으로 받으면 제목이 UTF-8이 아니라서 깨진다)
fn meta_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.meta.tmp"))
}

/// yt-dlp 실행 인자.
fn download_args(id: &str, dir: &Path) -> Vec<String> {
    [
        "-f",
        "bestaudio[ext=m4a]/bestaudio",
        "--no-playlist",
        "--progress",
        "--newline",
        "--no-colors",
        "--progress-template",
        "download:PROGRESS|%(progress._percent_str)s|%(progress._total_bytes_str)s|%(progress._eta_str)s",
        "--print-to-file",
        "before_dl:META|%(id)s|%(duration)s|%(title)s",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([
        meta_path(dir, id).to_string_lossy().to_string(),
        "-o".to_string(),
        dir.join("%(id)s.%(ext)s").to_string_lossy().to_string(),
        format!("https://www.youtube.com/watch?v={id}"),
    ])
    .collect()
}

/// 줄 단위로 읽되 UTF-8이 아닌 바이트가 있어도 멈추지 않는다 (깨진 글자로 바꿔 계속 읽는다).
/// 멈추면 파이프를 닫게 되어 yt-dlp가 쓰다가 [Errno 22]로 실패한다 — 끝까지 읽는 것이 중요하다.
fn lossy_lines<R: Read>(reader: R) -> impl Iterator<Item = String> {
    BufReader::new(reader).split(b'\n').map_while(Result::ok).map(|bytes| String::from_utf8_lossy(&bytes).trim_end_matches('\r').to_string())
}

/// 임시 파일에서 영상 정보를 읽고 파일은 지운다
fn read_meta(path: &Path) -> Option<(String, Option<f64>, String)> {
    let text = fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).to_string());
    let _ = fs::remove_file(path);
    text?.lines().find_map(parse_meta)
}

/// 영상 ID의 음원을 받는다. 진행률은 on_event로 알리고, 끝나면 제목·길이·파일 정보를 돌려준다. 실패하면 yt-dlp가 낸 오류 문장으로 거절한다.
#[tauri::command]
pub async fn music_download(app: AppHandle, id: String, on_event: Channel<MusicProgress>) -> Result<MusicDownload, String> {
    if !is_video_id(&id) {
        return Err("INVALID_VIDEO_ID".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (exe, _) = find_tool(&app).ok_or("TOOL_NOT_INSTALLED")?;
        let dir = music_dir(&app)?;
        let _guard = DOWNLOAD_LOCK.lock().map_err(|_| "내부 오류".to_string())?;
        let mut child = agent::base_command(&exe)
            .args(download_args(&id, &dir))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("yt-dlp를 실행하지 못했습니다: {e}"))?;
        let pid = child.id();
        // 너무 오래 걸리면 중단한다
        let finished = Arc::new(AtomicBool::new(false));
        {
            let finished = finished.clone();
            std::thread::spawn(move || {
                std::thread::sleep(DOWNLOAD_TIMEOUT);
                if !finished.load(Ordering::Relaxed) {
                    agent::kill_tree(pid);
                }
            });
        }
        let stderr = child.stderr.take().ok_or("출력을 읽지 못했습니다")?;
        let errors = std::thread::spawn(move || {
            lossy_lines(stderr).filter(|l| l.starts_with("ERROR")).collect::<Vec<_>>()
        });
        for line in lossy_lines(child.stdout.take().ok_or("출력을 읽지 못했습니다")?) {
            if let Some(percent) = parse_progress(&line) {
                let _ = on_event.send(MusicProgress { percent });
            }
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        finished.store(true, Ordering::Relaxed);
        let meta = read_meta(&meta_path(&dir, &id));
        let errors = errors.join().unwrap_or_default();
        if !status.success() {
            remove_partials(&dir, &id);
            return Err(errors.last().cloned().unwrap_or_else(|| "내려받지 못했습니다. 링크와 네트워크를 확인하세요.".into()));
        }
        let path = find_audio(&dir, &id).ok_or("내려받은 파일을 찾지 못했습니다.")?;
        let (title, duration) = meta.map(|(_, d, t)| (t, d)).unwrap_or_else(|| (id.clone(), None));
        Ok(MusicDownload {
            id,
            title,
            duration,
            ext: path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default(),
            bytes: fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 이 PC에 내려받아 둔 음원의 영상 ID 목록
#[tauri::command]
pub fn music_files(app: AppHandle) -> Vec<String> {
    let Ok(dir) = music_dir(&app) else { return Vec::new() };
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let (id, _) = name.split_once('.')?;
                    (is_video_id(id) && find_audio(&e.path().parent()?.to_path_buf(), id).is_some()).then(|| id.to_string())
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 재생용으로 음원 바이트를 읽는다.
#[tauri::command]
pub fn music_read(app: AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    if !is_video_id(&id) {
        return Err("INVALID_VIDEO_ID".into());
    }
    let path = find_audio(&music_dir(&app)?, &id).ok_or("NOT_FOUND")?;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_AUDIO_BYTES {
        return Err("TOO_LARGE_MEDIA".into());
    }
    Ok(tauri::ipc::Response::new(fs::read(&path).map_err(|e| e.to_string())?))
}

/// 내려받아 둔 음원 파일을 지운다 (없으면 그냥 성공)
#[tauri::command]
pub fn music_delete_file(app: AppHandle, id: String) -> Result<(), String> {
    if !is_video_id(&id) {
        return Err("INVALID_VIDEO_ID".into());
    }
    let dir = music_dir(&app)?;
    while let Some(path) = find_audio(&dir, &id) {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    remove_partials(&dir, &id);
    Ok(())
}

#[cfg(test)]
#[path = "tests/music.rs"]
mod tests;
