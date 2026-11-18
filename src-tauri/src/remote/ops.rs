//! 원격 프로젝트의 파일·git 동작. 로컬 `workspace.rs`의 같은 이름 함수와 같은 규칙(이름 검증·제외 폴더·덮어쓰기 금지·심볼릭 링크 제외)과
//! 같은 오류 코드를 쓰고, 파일은 sftp로 명령은 원격 셸로 처리한다.

use super::{get_conn, map_sftp_error, parse_root, sh_quote, Conn, ExecOut};
use crate::workspace::{binary_limit, is_ignored_dir, is_safe_relative, is_valid_folder_name, join_rel, normalize_rel, FileListing, FileNode, page_entries, MAX_DEPTH, MAX_FILE_BYTES, MAX_LIST_LIMIT, MAX_SCAN_PER_DIR, PROJECT_DOCS};
use russh_sftp::protocol::OpenFlags;
use std::collections::HashSet;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

const MAX_IMPORT_ENTRIES: usize = 20_000;
const SHELL_TIMEOUT: Duration = Duration::from_secs(60);

pub struct RemoteRoot {
    pub conn: Arc<Conn>,
    pub host_id: String,
    /// 원격 절대 경로 (끝에 "/" 없음)
    pub path: String,
}

/// root 문자열이 원격 프로젝트면 등록 여부를 확인하고 연결을 돌려준다. 로컬 경로면 None.
pub async fn resolve(app: &AppHandle, root: &str) -> Result<Option<RemoteRoot>, String> {
    if !root.starts_with(super::ROOT_PREFIX) {
        return Ok(None);
    }
    let (host_id, path) = parse_root(root).ok_or("NOT_REGISTERED")?;
    let projects = crate::data::load(app, "projects").unwrap_or_default();
    let registered = projects.as_array().into_iter().flatten().any(|p| {
        p.pointer("/location/remote/hostId").and_then(|v| v.as_str()) == Some(host_id.as_str())
            && p.pointer("/location/path").and_then(|v| v.as_str()).is_some_and(|stored| stored.trim_end_matches('/') == path)
    });
    if !registered {
        return Err("NOT_REGISTERED".into());
    }
    let conn = get_conn(app, &host_id).await?;
    Ok(Some(RemoteRoot { conn, host_id, path }))
}

impl RemoteRoot {
    fn abs(&self, rel: &str) -> String {
        let rel = normalize_rel(rel);
        if rel.is_empty() { self.path.clone() } else { format!("{}/{rel}", self.path) }
    }

    fn err(&self, e: impl std::fmt::Display) -> String {
        map_sftp_error(&self.conn, e)
    }

    /// 실제 경로(심볼릭 링크를 따라간 결과)가 프로젝트 안인지 확인하고 돌려준다
    async fn canon_inside(&self, full: &str) -> Result<String, String> {
        let canonical = self.conn.sftp.canonicalize(full).await.map_err(|e| self.err(e))?;
        let canonical = canonical.trim_end_matches('/').to_string();
        if canonical == self.path || canonical.starts_with(&format!("{}/", self.path)) {
            Ok(canonical)
        } else {
            Err("OUTSIDE_PROJECT".into())
        }
    }

    async fn exists(&self, full: &str) -> bool {
        self.conn.sftp.symlink_metadata(full).await.is_ok()
    }

    /// 폴더 상대 경로("" = 프로젝트 최상위)를 실제 폴더로 바꾼다
    async fn resolve_dir(&self, rel: &str) -> Result<String, String> {
        let rel = normalize_rel(rel);
        if rel.is_empty() {
            return Ok(self.path.clone());
        }
        if !is_safe_relative(&rel) {
            return Err("OUTSIDE_PROJECT".into());
        }
        if rel.split('/').any(is_ignored_dir) {
            return Err("IGNORED_DIR".into());
        }
        let dir = self.canon_inside(&self.abs(&rel)).await?;
        let meta = self.conn.sftp.metadata(&dir).await.map_err(|e| self.err(e))?;
        if meta.is_dir() { Ok(dir) } else { Err("NOT_A_DIR".into()) }
    }
}

// ── 파일 트리 ──

fn walk<'a>(root: &'a RemoteRoot, rel: String, depth: usize, expanded: &'a HashSet<String>, truncated: &'a mut bool) -> Pin<Box<dyn Future<Output = (Vec<FileNode>, usize)> + Send + 'a>> {
    Box::pin(async move {
        let entries = match root.conn.sftp.read_dir(root.abs(&rel)).await {
            Ok(entries) => entries,
            Err(e) => {
                root.err(e); // 연결이 끊긴 것이면 죽은 연결로 표시해 다음 요청이 다시 연결하게 한다
                return (Vec::new(), 0);
            }
        };
        let mut listed: Vec<(String, bool)> = Vec::new();
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            if listed.len() >= MAX_SCAN_PER_DIR {
                *truncated = true; // 항목이 너무 많아 일부는 세지도 못했다
                break;
            }
            let file_type = entry.file_type();
            // 심볼릭 링크는 따라가지 않는다 (순환·폴더 밖 접근 방지)
            if file_type.is_symlink() {
                continue;
            }
            let is_dir = file_type.is_dir();
            if is_dir && is_ignored_dir(&name) {
                continue;
            }
            if !is_dir && !file_type.is_file() {
                continue; // 소켓·장치 파일 등
            }
            listed.push((name, is_dir));
        }
        // 폴더 먼저·이름순으로 정렬해 앞에서부터 한도만큼만 담는다 (로컬과 같은 규칙, 전체 개수는 total로 알린다)
        let (listed, total) = page_entries(listed, MAX_LIST_LIMIT);
        let mut nodes = Vec::with_capacity(listed.len());
        for (name, is_dir) in listed {
            if !is_dir {
                nodes.push(FileNode::file(name));
                continue;
            }
            let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let (children, child_total) = if expanded.contains(&path) {
                if depth < MAX_DEPTH {
                    let (kids, kid_total) = walk(root, path, depth + 1, expanded, truncated).await;
                    (Some(kids), kid_total)
                } else {
                    *truncated = true;
                    (Some(Vec::new()), 0)
                }
            } else {
                (None, 0)
            };
            nodes.push(FileNode::folder(name, children, child_total));
        }
        (nodes, total)
    })
}

pub async fn list_tree(root: &RemoteRoot, expanded: Vec<String>) -> Result<FileListing, String> {
    // 최상위가 읽히는지 먼저 확인해 연결·권한 문제를 오류로 알린다
    root.conn.sftp.read_dir(root.path.clone()).await.map_err(|e| root.err(e))?;
    let expanded: HashSet<String> = expanded.into_iter().collect();
    let mut truncated = false;
    let (nodes, total) = walk(root, String::new(), 0, &expanded, &mut truncated).await;
    Ok(FileListing::new(nodes, truncated, total))
}

// ── 읽기 ──

pub async fn read_text(root: &RemoteRoot, path: &str) -> Result<String, String> {
    if !is_safe_relative(&normalize_rel(path)) {
        return Err("OUTSIDE_PROJECT".into());
    }
    let target = root.canon_inside(&root.abs(path)).await?;
    let meta = root.conn.sftp.metadata(&target).await.map_err(|e| root.err(e))?;
    if !meta.file_type().is_file() {
        return Err("NOT_A_FILE".into());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err("TOO_LARGE".into());
    }
    let bytes = root.conn.sftp.read(target).await.map_err(|e| root.err(e))?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err("BINARY".into());
    }
    String::from_utf8(bytes).map_err(|_| "BINARY".into())
}

/// 이미지·PDF·엑셀 등 바이트 그대로 읽는다 (크기 상한은 호출한 쪽이 정한다)
pub async fn read_bytes_limited(root: &RemoteRoot, path: &str, limit: u64, too_large: &str) -> Result<Vec<u8>, String> {
    if !is_safe_relative(&normalize_rel(path)) {
        return Err("OUTSIDE_PROJECT".into());
    }
    let target = root.canon_inside(&root.abs(path)).await?;
    let meta = root.conn.sftp.metadata(&target).await.map_err(|e| root.err(e))?;
    if !meta.file_type().is_file() {
        return Err("NOT_A_FILE".into());
    }
    if meta.len() > limit {
        return Err(too_large.into());
    }
    root.conn.sftp.read(target).await.map_err(|e| root.err(e))
}

pub async fn read_media(root: &RemoteRoot, path: &str) -> Result<Vec<u8>, String> {
    let limit = binary_limit(Path::new(path)).ok_or("UNSUPPORTED_TYPE")?;
    read_bytes_limited(root, path, limit, "TOO_LARGE_MEDIA").await
}

// ── 만들기·옮기기·이름 바꾸기·삭제 ──

pub async fn create_entry(root: &RemoteRoot, parent: &str, name: &str, kind: &str) -> Result<String, String> {
    if !is_valid_folder_name(name) {
        return Err("INVALID_NAME".into());
    }
    let dir = root.resolve_dir(parent).await?;
    let target = format!("{dir}/{name}");
    if root.exists(&target).await {
        return Err("ALREADY_EXISTS".into());
    }
    match kind {
        "dir" => root.conn.sftp.create_dir(target).await.map_err(|e| format!("CREATE_FAILED: {}", root.err(e)))?,
        "file" => {
            let file = root.conn.sftp.open_with_flags(target, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE).await.map_err(|e| format!("CREATE_FAILED: {}", root.err(e)))?;
            file.close().await.map_err(|e| format!("CREATE_FAILED: {e}"))?;
        }
        _ => return Err("INVALID_KIND".into()),
    }
    Ok(join_rel(parent, name))
}

pub async fn move_entry(root: &RemoteRoot, from: &str, to_dir: &str) -> Result<String, String> {
    let from = normalize_rel(from);
    if !is_safe_relative(&from) {
        return Err("OUTSIDE_PROJECT".into());
    }
    let source_abs = root.abs(&from);
    let meta = root.conn.sftp.symlink_metadata(&source_abs).await.map_err(|_| "NOT_FOUND".to_string())?;
    if meta.is_symlink() {
        return Err("SYMLINK".into());
    }
    let source = root.canon_inside(&source_abs).await?;
    let dest_dir = root.resolve_dir(to_dir).await?;
    if meta.is_dir() && (dest_dir == source || dest_dir.starts_with(&format!("{source}/"))) {
        return Err("MOVE_INTO_SELF".into());
    }
    let name = source.rsplit('/').next().filter(|n| !n.is_empty()).ok_or("NOT_FOUND")?.to_string();
    let target = format!("{dest_dir}/{name}");
    if target == source {
        return Ok(from);
    }
    if root.exists(&target).await {
        return Err("ALREADY_EXISTS".into());
    }
    root.conn.sftp.rename(source, target).await.map_err(|e| format!("MOVE_FAILED: {}", root.err(e)))?;
    Ok(join_rel(to_dir, &name))
}

pub async fn rename_entry(root: &RemoteRoot, path: &str, new_name: &str) -> Result<String, String> {
    let rel = normalize_rel(path);
    if !is_safe_relative(&rel) {
        return Err("OUTSIDE_PROJECT".into());
    }
    if !is_valid_folder_name(new_name) {
        return Err("INVALID_NAME".into());
    }
    if rel.split('/').any(is_ignored_dir) {
        return Err("IGNORED_DIR".into());
    }
    let source_abs = root.abs(&rel);
    let meta = root.conn.sftp.symlink_metadata(&source_abs).await.map_err(|_| "NOT_FOUND".to_string())?;
    if meta.is_symlink() {
        return Err("SYMLINK".into());
    }
    if meta.is_dir() && is_ignored_dir(new_name) {
        return Err("IGNORED_DIR".into());
    }
    let source = root.canon_inside(&source_abs).await?;
    let old_name = source.rsplit('/').next().unwrap_or("").to_string();
    let parent_rel = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("").to_string();
    if old_name == new_name {
        return Ok(rel);
    }
    let parent_abs = source.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default();
    let target = format!("{parent_abs}/{new_name}");
    if root.exists(&target).await && root.conn.sftp.canonicalize(target.clone()).await.ok().as_deref() != Some(source.as_str()) {
        return Err("ALREADY_EXISTS".into());
    }
    root.conn.sftp.rename(source, target).await.map_err(|e| format!("RENAME_FAILED: {}", root.err(e)))?;
    Ok(join_rel(&parent_rel, new_name))
}

pub async fn delete_entry(root: &RemoteRoot, rel: &str) -> Result<usize, String> {
    let rel = normalize_rel(rel);
    if !is_safe_relative(&rel) {
        return Err("OUTSIDE_PROJECT".into());
    }
    if rel.split('/').any(is_ignored_dir) {
        return Err("IGNORED_DIR".into());
    }
    // 부모 폴더를 실제 경로로 확인한 뒤 이름을 붙인다 (대상이 바로가기여도 따라가지 않는다)
    let (parent_rel, name) = rel.rsplit_once('/').unwrap_or(("", rel.as_str()));
    let parent = if parent_rel.is_empty() { root.path.clone() } else { root.canon_inside(&root.abs(parent_rel)).await? };
    let target = format!("{parent}/{name}");
    let meta = root.conn.sftp.symlink_metadata(&target).await.map_err(|_| "NOT_FOUND".to_string())?;
    let fail = |e: String| format!("DELETE_FAILED: {e}");
    if meta.is_symlink() {
        root.conn.sftp.remove_file(target).await.map_err(|e| fail(root.err(e)))?;
        return Ok(1);
    }
    if meta.is_dir() {
        let quoted = sh_quote(&target)?;
        let counted = root.conn.exec(&format!("find {quoted} 2>/dev/null | wc -l"), SHELL_TIMEOUT).await?;
        let count = counted.stdout_text().trim().parse::<usize>().unwrap_or(1).max(1);
        let out = root.conn.exec(&format!("rm -rf -- {quoted}"), Duration::from_secs(300)).await?;
        if !out.success() {
            return Err(fail(out.stderr_text().trim().to_string()));
        }
        return Ok(count);
    }
    root.conn.sftp.remove_file(target).await.map_err(|e| fail(root.err(e)))?;
    Ok(1)
}

// ── 이 PC의 파일을 원격 폴더로 복사해 넣기 ──

/// dir 안에서 쓸 수 있는 이름: 같은 이름이 있으면 "이름 (1).확장자"… (폴더는 확장자 없이 "이름 (1)")
async fn unique_name(root: &RemoteRoot, dir: &str, name: &str, is_dir: bool) -> String {
    if !root.exists(&format!("{dir}/{name}")).await {
        return name.to_string();
    }
    let (stem, ext) = match (is_dir, name.rfind('.')) {
        (false, Some(i)) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 1..10_000 {
        let candidate = format!("{stem} ({n}){ext}");
        if !root.exists(&format!("{dir}/{candidate}")).await {
            return candidate;
        }
    }
    format!("{stem} (copy){ext}")
}

async fn upload_file(root: &RemoteRoot, local: &Path, remote: &str) -> Result<(), String> {
    let mut source = tokio::fs::File::open(local).await.map_err(|e| e.to_string())?;
    let mut target = root.conn.sftp.open_with_flags(remote.to_string(), OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE).await.map_err(|e| root.err(e))?;
    tokio::io::copy(&mut source, &mut target).await.map_err(|e| e.to_string())?;
    target.shutdown().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// 폴더 내용을 원격으로 복사한다 (심볼릭 링크는 건너뜀). 센 항목 수를 budget에서 뺀다.
fn upload_tree<'a>(root: &'a RemoteRoot, local: &'a Path, remote: &'a str, budget: &'a mut usize) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        root.conn.sftp.create_dir(remote.to_string()).await.map_err(|e| root.err(e))?;
        let mut entries = tokio::fs::read_dir(local).await.map_err(|e| e.to_string())?;
        while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
            let file_type = entry.file_type().await.map_err(|e| e.to_string())?;
            if file_type.is_symlink() {
                continue;
            }
            if *budget == 0 {
                return Err(format!("항목이 너무 많습니다 (한 번에 {MAX_IMPORT_ENTRIES}개까지)"));
            }
            *budget -= 1;
            let name = entry.file_name().to_string_lossy().to_string();
            let target = format!("{remote}/{name}");
            if file_type.is_dir() {
                upload_tree(root, &entry.path(), &target, budget).await?;
            } else {
                upload_file(root, &entry.path(), &target).await?;
            }
        }
        Ok(())
    })
}

pub struct Imported {
    pub copied: Vec<String>,
    pub skipped: Vec<(String, String)>,
}

pub async fn import_entries(root: &RemoteRoot, target_dir: &str, sources: &[String]) -> Result<Imported, String> {
    let dest_dir = root.resolve_dir(target_dir).await?;
    let mut out = Imported { copied: Vec::new(), skipped: Vec::new() };
    let mut budget = MAX_IMPORT_ENTRIES;
    for source in sources {
        let path = std::path::PathBuf::from(source);
        let label = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| source.clone());
        match import_one(root, &dest_dir, &path, &mut budget).await {
            Ok(name) => out.copied.push(join_rel(target_dir, &name)),
            Err(reason) => out.skipped.push((label, reason)),
        }
    }
    Ok(out)
}

async fn import_one(root: &RemoteRoot, dest_dir: &str, source: &Path, budget: &mut usize) -> Result<String, String> {
    if !source.is_absolute() {
        return Err("올바른 경로가 아닙니다".into());
    }
    let meta = tokio::fs::symlink_metadata(source).await.map_err(|_| "찾을 수 없습니다".to_string())?;
    if meta.file_type().is_symlink() {
        return Err("바로가기(심볼릭 링크)는 복사하지 않습니다".into());
    }
    let name = source.file_name().map(|n| n.to_string_lossy().to_string()).ok_or("이름이 없는 항목입니다")?;
    let new_name = unique_name(root, dest_dir, &name, meta.is_dir()).await;
    let target = format!("{dest_dir}/{new_name}");
    if meta.is_dir() {
        if *budget == 0 {
            return Err(format!("항목이 너무 많습니다 (한 번에 {MAX_IMPORT_ENTRIES}개까지)"));
        }
        *budget -= 1;
        if let Err(e) = upload_tree(root, source, &target, budget).await {
            let _ = root.conn.exec(&format!("rm -rf -- {}", sh_quote(&target)?), SHELL_TIMEOUT).await; // 반쯤 복사된 폴더는 남기지 않는다
            return Err(format!("복사하지 못했습니다 ({e})"));
        }
    } else {
        if *budget == 0 {
            return Err(format!("항목이 너무 많습니다 (한 번에 {MAX_IMPORT_ENTRIES}개까지)"));
        }
        *budget -= 1;
        if let Err(e) = upload_file(root, source, &target).await {
            let _ = root.conn.sftp.remove_file(target).await;
            return Err(format!("복사하지 못했습니다 ({e})"));
        }
    }
    Ok(new_name)
}

// ── 표준 문서 · 프로젝트 메모리 ──

pub async fn ensure_docs(root: &RemoteRoot) -> Result<Vec<String>, String> {
    let existing: Vec<String> = root.conn.sftp.read_dir(root.path.clone()).await.map_err(|e| root.err(e))?.map(|e| e.file_name()).collect();
    let mut created = Vec::new();
    for (name, template) in PROJECT_DOCS {
        // 대소문자만 다른 파일(todo.md 등)도 기존 문서로 본다
        if existing.iter().any(|e| e.eq_ignore_ascii_case(name)) {
            continue;
        }
        let path = format!("{}/{name}", root.path);
        // EXCLUDE: 동시에 다른 곳에서 만들었더라도 덮어쓰지 않는다
        let Ok(mut file) = root.conn.sftp.open_with_flags(path, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE).await else { continue };
        file.write_all(template.as_bytes()).await.map_err(|e| e.to_string())?;
        file.shutdown().await.map_err(|e| e.to_string())?;
        created.push(name.to_string());
    }
    Ok(created)
}

/// 원격 파일 전체를 읽는다 (없으면 None)
pub async fn read_optional(root: &RemoteRoot, rel: &str) -> Result<Option<String>, String> {
    let path = root.abs(rel);
    match root.conn.sftp.try_exists(path.clone()).await {
        Ok(true) => {}
        Ok(false) => return Ok(None),
        Err(e) => return Err(root.err(e)),
    }
    let bytes = root.conn.sftp.read(path).await.map_err(|e| root.err(e))?;
    Ok(Some(String::from_utf8_lossy(&bytes).to_string()))
}

/// 임시 파일에 쓴 뒤 바꿔 넣는다 (쓰는 도중 끊겨도 원본이 깨지지 않는다)
pub async fn write_replace(conn: &Conn, path: &str, data: &[u8]) -> Result<(), String> {
    let temp = format!("{path}.aiws-tmp");
    let mut file = conn.sftp.open_with_flags(temp.clone(), OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE).await.map_err(|e| map_sftp_error(conn, e))?;
    file.write_all(data).await.map_err(|e| e.to_string())?;
    file.shutdown().await.map_err(|e| e.to_string())?;
    let out = conn.exec(&format!("mv -f -- {} {}", sh_quote(&temp)?, sh_quote(path)?), SHELL_TIMEOUT).await?;
    if out.success() { Ok(()) } else { Err(out.stderr_text().trim().to_string()) }
}

// ── git ──

const GIT_ENV: &str = "GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never GIT_SSH_COMMAND='ssh -o BatchMode=yes'";

fn git_script(root: &RemoteRoot, args: &[&str]) -> Result<String, String> {
    let mut script = format!("{GIT_ENV} git -C {} -c core.quotepath=false", sh_quote(&root.path)?);
    for arg in args {
        script.push(' ');
        script.push_str(&sh_quote(arg)?);
    }
    Ok(script)
}

/// 원격에서 git을 실행한다. oneshot이면 새 접속을 쓴다 (푸시처럼 오래 걸리는 명령이 명령 셸을 막지 않게)
pub async fn git(root: &RemoteRoot, args: &[&str], timeout: Duration, oneshot: bool) -> Result<ExecOut, String> {
    let script = git_script(root, args)?;
    let out = if oneshot { root.conn.exec_oneshot(&script, timeout).await } else { root.conn.exec(&script, timeout).await };
    match out {
        // 127: 명령을 찾을 수 없음
        Ok(o) if o.code == 127 => Err("GIT_NOT_FOUND".into()),
        Err(e) if e == "TIMEOUT" => Err("시간이 너무 오래 걸려 중단했습니다. 네트워크와 로그인 상태를 확인하세요.".into()),
        other => other,
    }
}

/// 실제 ssh 서버가 있을 때만 도는 점검 (`AIWS_SSH_TEST_PORT`·`AIWS_SSH_TEST_KEY` 지정, 사용자 aiws@127.0.0.1).
/// 실행: AIWS_SSH_TEST_PORT=2222 AIWS_SSH_TEST_KEY=~/.ssh/aiws_test cargo test remote_live -- --ignored --nocapture
#[cfg(test)]
#[path = "../tests/remote_ops_live.rs"]
mod live_tests;
