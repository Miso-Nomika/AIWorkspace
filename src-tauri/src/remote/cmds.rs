//! 원격 접속 설정 화면과 원격 폴더 선택기가 쓰는 명령.
//! 접속 정보 자체(목록)는 프런트엔드가 `ssh-hosts` 키에 저장하고, 여기서는 시험·지문 확인·폴더 목록만 다룬다.

use super::{connect, drop_conn, get_conn, is_valid_host_id, ssh_command, HostDef};
use crate::workspace::is_valid_folder_name;
use serde::Serialize;
use std::process::Stdio;
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeInfo {
    path: String,
    version: String,
    /// 로그인되어 있는지 (읽지 못하면 None)
    logged_in: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestReport {
    os: String,
    git: Option<String>,
    claude: Option<ClaudeInfo>,
    /// 파일 변경을 알아내는 방식: inotify | fswatch | poll
    watch: String,
    home: String,
}

/// 연결을 시험한다. trust=true면 처음 보는 호스트의 키를 known_hosts에 추가하며 접속한다 (사용자가 지문을 확인한 뒤에만).
/// 오류 코드: HOST_KEY_UNKNOWN · HOST_KEY_CHANGED · AUTH_FAILED · UNREACHABLE: … · CONNECTION_FAILED: … · SSH_NOT_FOUND · UNSUPPORTED_OS: …
#[tauri::command]
pub async fn ssh_test(host: HostDef, trust: bool) -> Result<TestReport, String> {
    let conn = connect(&host, if trust { "accept-new" } else { "yes" }).await?;
    let t = Duration::from_secs(30);
    let os = conn.exec("uname -s", t).await?.stdout_text().trim().to_string();
    if os != "Linux" && os != "Darwin" {
        return Err(format!("UNSUPPORTED_OS: {}", if os.is_empty() { "알 수 없음" } else { &os }));
    }
    let git = conn.exec("git --version", t).await?;
    let git = git.success().then(|| git.stdout_text().trim().to_string());
    // claude 설치 위치를 PATH에 덧붙여 찾는다 (비대화형 ssh 명령은 PATH가 짧아 보이기 때문) — 설치·로그인 여부도 함께 읽는다
    let status = super::claude::read_status(&conn).await?;
    let claude = match (status.installed, status.path, status.version) {
        (true, Some(path), Some(version)) => Some(ClaudeInfo { path, version, logged_in: status.logged_in }),
        _ => None,
    };
    let has = |name: &str| format!("command -v {name} >/dev/null 2>&1 && echo yes || echo no");
    let watch = if conn.exec(&has("inotifywait"), t).await?.stdout_text().trim() == "yes" {
        "inotify"
    } else if conn.exec(&has("fswatch"), t).await?.stdout_text().trim() == "yes" {
        "fswatch"
    } else {
        "poll"
    };
    let home = conn.exec("cd && pwd -P", t).await?.stdout_text().trim().to_string();
    Ok(TestReport { os, git, claude, watch: watch.into(), home })
}

/// 처음 접속하는 호스트의 키 지문(SHA256)을 보여 주려고 가져온다. 키를 저장하지는 않는다.
#[tauri::command]
pub async fn ssh_host_fingerprint(host: HostDef) -> Result<String, String> {
    host.validate()?;
    // ~/.ssh/config의 별칭을 실제 주소·포트로 풀어 본다 (`ssh -G`)
    let mut g = ssh_command();
    g.args(host.ssh_options("yes")).arg("-G").arg("--").arg(&host.host);
    g.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let resolved = tokio::time::timeout(Duration::from_secs(10), g.output()).await.map_err(|_| "TIMEOUT".to_string())?.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&resolved.stdout).to_string();
    let field = |key: &str| text.lines().find_map(|l| l.strip_prefix(&format!("{key} "))).map(|v| v.trim().to_string());
    let address = field("hostname").unwrap_or_else(|| host.host.clone());
    let port = field("port").unwrap_or_else(|| "22".into());
    if address.starts_with('-') {
        return Err("INVALID_HOST".into());
    }

    // 주소 계열(IPv4·IPv6)을 가리지 않고 가장 먼저 답하는 쪽을 쓴다 (한쪽만 열려 있으면 ssh-keyscan이 기다리다 포기하는 환경이 있다)
    let scan = |family: Option<&str>| {
        let mut scan = tokio::process::Command::new("ssh-keyscan");
        scan.kill_on_drop(true);
        #[cfg(windows)]
        scan.creation_flags(0x0800_0000);
        if let Some(flag) = family {
            scan.arg(flag);
        }
        scan.args(["-T", "6", "-p", &port, "-t", "ed25519,ecdsa,rsa", "--", &address]);
        scan.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        async move { tokio::time::timeout(Duration::from_secs(15), scan.output()).await.ok().and_then(|r| r.ok()).map(|o| o.stdout).unwrap_or_default() }
    };
    let (any, v4, v6) = tokio::join!(scan(None), scan(Some("-4")), scan(Some("-6")));
    let keys = [any, v4, v6].into_iter().find(|k| !k.is_empty()).unwrap_or_default();
    if keys.is_empty() {
        return Err(format!("UNREACHABLE: {address}:{port}에서 호스트 키를 받지 못했습니다"));
    }

    let mut keygen = tokio::process::Command::new("ssh-keygen");
    keygen.kill_on_drop(true);
    #[cfg(windows)]
    keygen.creation_flags(0x0800_0000);
    keygen.args(["-l", "-f", "-"]);
    keygen.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = keygen.spawn().map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(&keys).await;
    }
    let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
    let line = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim().to_string();
    if line.is_empty() { Err("CONNECTION_FAILED".into()) } else { Ok(line) }
}

#[derive(Serialize)]
pub struct DirListing {
    path: String,
    dirs: Vec<String>,
}

/// 원격 폴더 선택기: path가 비어 있으면 홈에서 시작한다. 폴더 이름만 돌려준다 (숨김 폴더 포함).
#[tauri::command]
pub async fn ssh_list_dir(app: AppHandle, host_id: String, path: Option<String>) -> Result<DirListing, String> {
    if !is_valid_host_id(&host_id) {
        return Err("INVALID_HOST".into());
    }
    let conn = get_conn(&app, &host_id).await?;
    let start = path.filter(|p| !p.is_empty()).unwrap_or_else(|| ".".to_string());
    if start.contains('\0') {
        return Err("INVALID_PATH".into());
    }
    let resolved = conn.sftp.canonicalize(start).await.map_err(|e| super::map_sftp_error(&conn, e))?;
    let mut dirs: Vec<String> = Vec::new();
    for entry in conn.sftp.read_dir(resolved.clone()).await.map_err(|e| super::map_sftp_error(&conn, e))? {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        // 폴더를 가리키는 바로가기도 폴더로 보인다
        let is_dir = entry.file_type().is_dir()
            || (entry.file_type().is_symlink() && conn.sftp.metadata(format!("{}/{}", resolved.trim_end_matches('/'), name)).await.is_ok_and(|m| m.is_dir()));
        if is_dir {
            dirs.push(name);
        }
    }
    dirs.sort_by_key(|n| n.to_lowercase());
    Ok(DirListing { path: resolved, dirs })
}

/// 원격 폴더 선택기의 "새 폴더". 만든 폴더의 절대 경로를 돌려준다.
#[tauri::command]
pub async fn ssh_make_dir(app: AppHandle, host_id: String, parent: String, name: String) -> Result<String, String> {
    if !is_valid_host_id(&host_id) {
        return Err("INVALID_HOST".into());
    }
    if !is_valid_folder_name(&name) {
        return Err("INVALID_NAME".into());
    }
    if !parent.starts_with('/') || parent.contains('\0') {
        return Err("INVALID_PATH".into());
    }
    let conn = get_conn(&app, &host_id).await?;
    let target = format!("{}/{}", parent.trim_end_matches('/'), name);
    if conn.sftp.symlink_metadata(target.clone()).await.is_ok() {
        return Err("ALREADY_EXISTS".into());
    }
    conn.sftp.create_dir(target.clone()).await.map_err(|e| format!("CREATE_FAILED: {}", super::map_sftp_error(&conn, e)))?;
    Ok(target)
}

/// 연결이 살아 있는지 (화면 상단 "연결 끊김" 표시용)
#[tauri::command]
pub async fn ssh_reconnect(app: AppHandle, host_id: String) -> Result<(), String> {
    if !is_valid_host_id(&host_id) {
        return Err("INVALID_HOST".into());
    }
    drop_conn(&app, &host_id);
    get_conn(&app, &host_id).await.map(|_| ())
}

/// 접속 정보를 지우거나 고쳤을 때 열려 있던 연결을 닫는다
#[tauri::command]
pub fn ssh_forget(app: AppHandle, host_id: String) {
    drop_conn(&app, &host_id);
}
