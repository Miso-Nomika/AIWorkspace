//! 프로젝트 폴더 관련 명령: 폴더 생성, 파일 트리 조회, 파일 읽기 (읽기 전용), 표준 문서 생성.
//! 파일 접근은 데이터 파일(projects.json)에 등록된 프로젝트 폴더 안으로만 허용한다.

use std::collections::HashSet;
use crate::data;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 탐색기에서 숨기는 폴더 (용량이 크거나 생성물)
const IGNORED_DIRS: &[&str] = &[
    ".git", "node_modules", ".next", "target", "__pycache__", ".venv", "venv", ".turbo", ".cache",
];
/// 탐색기·실시간 감시에서 제외하는 폴더인지
pub(crate) fn is_ignored_dir(name: &str) -> bool {
    IGNORED_DIRS.contains(&name)
}

/// 폴더 하나에서 읽는 최대 항목 수 (넘으면 그 폴더만 일부만 담고 truncated 표시)
/// 한 폴더에서 보여 줄 수 있는 최대 항목 수 (처음부터 이만큼 보여 주고, 넘으면 이름순 앞부분만 담고 전체 개수로 안내한다)
pub(crate) const MAX_LIST_LIMIT: usize = 50_000;
/// 한 폴더에서 이름·종류를 읽는 최대 항목 수 (넘으면 일부는 세지도 않고 truncated 표시)
pub(crate) const MAX_SCAN_PER_DIR: usize = 200_000;
pub(crate) const MAX_DEPTH: usize = 12;
pub(crate) const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_PDF_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Serialize)]
pub struct FileNode {
    name: String,
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<FileNode>>,
    /// 폴더를 읽었을 때 그 안의 전체 항목 수 (children이 이보다 적으면 앞부분만 담은 것 — 화면이 "더 보기"를 보여 준다)
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<usize>,
}

impl FileNode {
    pub(crate) fn file(name: String) -> Self {
        Self { name, kind: "file", children: None, total: None }
    }
    pub(crate) fn folder(name: String, children: Option<Vec<FileNode>>, total: usize) -> Self {
        let total = children.as_ref().map(|_| total);
        Self { name, kind: "folder", children, total }
    }
}

#[derive(Serialize)]
pub struct FileListing {
    nodes: Vec<FileNode>,
    truncated: bool,
    /// 프로젝트 최상위의 전체 항목 수
    total: usize,
}

impl FileListing {
    pub(crate) fn new(nodes: Vec<FileNode>, truncated: bool, total: usize) -> Self {
        Self { nodes, truncated, total }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    computer_name: String,
    default_projects_dir: String,
}

#[tauri::command]
pub fn device_info(app: AppHandle) -> DeviceInfo {
    let computer_name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .or_else(|_| fs::read_to_string("/etc/hostname").map(|s| s.trim().to_string()))
        .unwrap_or_else(|_| "이 PC".into());
    let default_projects_dir = app
        .path()
        .document_dir()
        .map(|d| d.join("AIWorkspace").to_string_lossy().to_string())
        .unwrap_or_default();
    DeviceInfo { computer_name, default_projects_dir }
}

/// Windows 예약 이름 (CON·PRN·AUX·NUL·COM1~9·LPT1~9 — 확장자가 붙어도 예약: CON.txt)
fn is_reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    let bytes = stem.as_bytes();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (bytes.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && (b'1'..=b'9').contains(&bytes[3]))
}

/// 파일·폴더 이름으로 쓸 수 있는지 (프로젝트 폴더 이름, 파일 트리에서 새로 만드는 이름 공통)
pub(crate) fn is_valid_folder_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && name.chars().count() <= 200
        && !is_reserved_name(name)
        && trimmed == name
        && !name.ends_with('.')
        && name != "."
        && name != ".."
        && !name.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control())
}

/// 새 프로젝트 폴더를 만든다. 이미 있으면 실패.
#[tauri::command]
pub fn create_project_dir(parent: String, name: String) -> Result<String, String> {
    if !is_valid_folder_name(&name) {
        return Err("INVALID_NAME".into());
    }
    let parent = PathBuf::from(parent);
    if !parent.is_absolute() {
        return Err("INVALID_PARENT".into());
    }
    fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let target = parent.join(&name);
    match fs::create_dir(&target) {
        Ok(()) => Ok(target.to_string_lossy().to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err("ALREADY_EXISTS".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// 로컬 폴더 또는 원격(SSH) 폴더. git처럼 로컬·원격이 같은 논리를 쓰는 곳에서 갈라 쓴다.
#[derive(Clone, Copy)]
pub(crate) enum RootRef<'a> {
    Local(&'a Path),
    Remote(&'a crate::remote::ops::RemoteRoot),
}

impl<'a> From<&'a Path> for RootRef<'a> {
    fn from(p: &'a Path) -> Self {
        RootRef::Local(p)
    }
}
impl<'a> From<&'a PathBuf> for RootRef<'a> {
    fn from(p: &'a PathBuf) -> Self {
        RootRef::Local(p.as_path())
    }
}
impl<'a> From<&'a crate::remote::ops::RemoteRoot> for RootRef<'a> {
    fn from(r: &'a crate::remote::ops::RemoteRoot) -> Self {
        RootRef::Remote(r)
    }
}

/// 원격 폴더를 동기 코드(spawn_blocking 안)에서 기다린다
fn wait<T>(future: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

/// root가 등록된 프로젝트 폴더인지 확인하고 정규화된 경로를 돌려준다.
pub(crate) fn registered_root(app: &AppHandle, root: &str) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(root).map_err(|_| "NOT_FOUND".to_string())?;
    let projects = data::load(app, "projects").unwrap_or_default();
    let registered = projects.as_array().into_iter().flatten().any(|p| {
        p.pointer("/location/path")
            .and_then(|v| v.as_str())
            .and_then(|path| fs::canonicalize(path).ok())
            .is_some_and(|path| path == canonical)
    });
    if registered { Ok(canonical) } else { Err("NOT_REGISTERED".into()) }
}

/// root 안의 상대 경로를 실제 경로로 바꾼다. root 밖으로 나가면 실패.
pub(crate) fn resolve_inside(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let target = fs::canonicalize(root.join(relative)).map_err(|_| "NOT_FOUND".to_string())?;
    if target.starts_with(root) { Ok(target) } else { Err("OUTSIDE_PROJECT".into()) }
}

// ── 파일 트리: 새 파일·폴더 만들기, 끌어 옮기기, 파일 관리자에서 끌어다 복사해 넣기 ──
// 모든 경로는 등록된 프로젝트 폴더 안으로 제한하고, node_modules 같은 제외 폴더 안에는 만들거나 옮기지 않는다.

/// 앞뒤 "/"를 정리하고 "\\"를 "/"로 바꾼 상대 경로 (프런트엔드와 같은 표기)
pub(crate) fn normalize_rel(rel: &str) -> String {
    rel.replace('\\', "/").trim_matches('/').to_string()
}

pub(crate) fn join_rel(parent: &str, name: &str) -> String {
    let parent = normalize_rel(parent);
    if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") }
}

/// 폴더 상대 경로("" = 프로젝트 최상위)를 실제 폴더로 바꾼다. 프로젝트 밖·제외 폴더·폴더가 아닌 곳이면 실패.
fn resolve_dir(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = normalize_rel(rel);
    if rel.is_empty() {
        return Ok(root.to_path_buf());
    }
    if !is_safe_relative(&rel) {
        return Err("OUTSIDE_PROJECT".into());
    }
    if Path::new(&rel).components().any(|c| {
        let name = c.as_os_str().to_string_lossy();
        IGNORED_DIRS.contains(&&*name)
    }) {
        return Err("IGNORED_DIR".into());
    }
    let dir = resolve_inside(root, &rel)?;
    if dir.is_dir() { Ok(dir) } else { Err("NOT_A_DIR".into()) }
}

/// parent 폴더 안에 빈 파일(kind="file") 또는 폴더(kind="dir")를 만든다. 같은 이름이 있으면 덮어쓰지 않고 실패. 새 항목의 상대 경로를 돌려준다.
fn create_entry(root: &Path, parent: &str, name: &str, kind: &str) -> Result<String, String> {
    if !is_valid_folder_name(name) {
        return Err("INVALID_NAME".into());
    }
    let target = resolve_dir(root, parent)?.join(name);
    let created = match kind {
        "dir" => fs::create_dir(&target),
        "file" => fs::OpenOptions::new().write(true).create_new(true).open(&target).map(|_| ()),
        _ => return Err("INVALID_KIND".into()),
    };
    match created {
        Ok(()) => Ok(join_rel(parent, name)),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err("ALREADY_EXISTS".into()),
        Err(e) => Err(format!("CREATE_FAILED: {e}")),
    }
}

#[tauri::command]
pub async fn create_project_entry(app: AppHandle, root: String, parent: String, name: String, kind: String) -> Result<String, String> {
    if let Some(remote) = crate::remote::ops::resolve(&app, &root).await? {
        return crate::remote::ops::create_entry(&remote, &parent, &name, &kind).await;
    }
    let root = registered_root(&app, &root)?;
    create_entry(&root, &parent, &name, &kind)
}

/// from(파일·폴더)을 to_dir 폴더 안으로 옮긴다. 같은 이름이 있으면 덮어쓰지 않고 실패, 폴더를 자기 자신·하위로 옮길 수 없다.
/// 같은 폴더로 옮기면 아무 일도 하지 않는다. 새 상대 경로를 돌려준다.
fn move_entry(root: &Path, from: &str, to_dir: &str) -> Result<String, String> {
    let from = normalize_rel(from);
    if !is_safe_relative(&from) {
        return Err("OUTSIDE_PROJECT".into());
    }
    let meta = fs::symlink_metadata(root.join(&from)).map_err(|_| "NOT_FOUND".to_string())?;
    if meta.file_type().is_symlink() {
        return Err("SYMLINK".into());
    }
    let source = resolve_inside(root, &from)?;
    let dest_dir = resolve_dir(root, to_dir)?;
    if meta.is_dir() && dest_dir.starts_with(&source) {
        return Err("MOVE_INTO_SELF".into());
    }
    let name = source.file_name().ok_or("NOT_FOUND")?.to_os_string();
    let target = dest_dir.join(&name);
    if target == source {
        return Ok(from);
    }
    if fs::symlink_metadata(&target).is_ok() {
        return Err("ALREADY_EXISTS".into());
    }
    fs::rename(&source, &target).map_err(|e| format!("MOVE_FAILED: {e}"))?;
    Ok(join_rel(to_dir, &name.to_string_lossy()))
}

#[tauri::command]
pub async fn move_project_entry(app: AppHandle, root: String, from: String, to_dir: String) -> Result<String, String> {
    if let Some(remote) = crate::remote::ops::resolve(&app, &root).await? {
        return crate::remote::ops::move_entry(&remote, &from, &to_dir).await;
    }
    let root = registered_root(&app, &root)?;
    move_entry(&root, &from, &to_dir)
}

/// path(파일·폴더)의 이름을 new_name으로 바꾼다 (같은 폴더 안). 같은 이름이 이미 있으면 덮어쓰지 않고 실패하되, 대소문자만 바꾸는 것(a.txt → A.txt)은 허용한다.
/// 제외 폴더(.git·node_modules 등) 안의 항목·제외 폴더 자체, 심볼릭 링크는 바꾸지 않고, 폴더 이름을 제외 폴더 이름으로 바꿀 수도 없다. 새 상대 경로를 돌려준다.
fn rename_entry(root: &Path, path: &str, new_name: &str) -> Result<String, String> {
    let rel = normalize_rel(path);
    if !is_safe_relative(&rel) {
        return Err("OUTSIDE_PROJECT".into());
    }
    if !is_valid_folder_name(new_name) {
        return Err("INVALID_NAME".into());
    }
    if Path::new(&rel).components().any(|c| IGNORED_DIRS.contains(&&*c.as_os_str().to_string_lossy())) {
        return Err("IGNORED_DIR".into());
    }
    let meta = fs::symlink_metadata(root.join(&rel)).map_err(|_| "NOT_FOUND".to_string())?;
    if meta.file_type().is_symlink() {
        return Err("SYMLINK".into());
    }
    if meta.is_dir() && IGNORED_DIRS.contains(&new_name) {
        return Err("IGNORED_DIR".into());
    }
    let source = resolve_inside(root, &rel)?;
    let old_name = source.file_name().ok_or("NOT_FOUND")?.to_string_lossy().to_string();
    let parent_rel = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("").to_string();
    if old_name == new_name {
        return Ok(rel);
    }
    let target = source.parent().ok_or("NOT_FOUND")?.join(new_name);
    if fs::symlink_metadata(&target).is_ok() && fs::canonicalize(&target).ok().as_ref() != Some(&source) {
        return Err("ALREADY_EXISTS".into()); // 다른 항목이 이미 그 이름이다 (같은 항목의 대소문자 변경이면 통과)
    }
    fs::rename(&source, &target).map_err(|e| format!("RENAME_FAILED: {e}"))?;
    Ok(join_rel(&parent_rel, new_name))
}

#[tauri::command]
pub async fn rename_project_entry(app: AppHandle, root: String, path: String, new_name: String) -> Result<String, String> {
    if let Some(remote) = crate::remote::ops::resolve(&app, &root).await? {
        return crate::remote::ops::rename_entry(&remote, &path, &new_name).await;
    }
    let root = registered_root(&app, &root)?;
    rename_entry(&root, &path, &new_name)
}

/// 가져오기 한 번에 복사할 수 있는 항목(파일·폴더) 수 상한
const MAX_IMPORT_ENTRIES: usize = 20_000;

#[derive(Serialize)]
pub struct ImportSkipped {
    name: String,
    reason: String,
}

#[derive(Serialize)]
pub struct ImportResult {
    /// 복사된 항목의 새 상대 경로
    copied: Vec<String>,
    skipped: Vec<ImportSkipped>,
}

/// dir 안의 항목 수(심볼릭 링크 제외, 하위 포함). limit을 넘으면 None.
fn count_entries(dir: &Path, limit: usize) -> Option<usize> {
    let mut count = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        for entry in fs::read_dir(&current).ok()?.flatten() {
            let Ok(file_type) = entry.file_type() else { continue };
            if file_type.is_symlink() {
                continue;
            }
            count += 1;
            if count > limit {
                return None;
            }
            if file_type.is_dir() {
                stack.push(entry.path());
            }
        }
    }
    Some(count)
}

/// 폴더 내용을 그대로 복사한다 (심볼릭 링크는 건너뜀). 원본은 읽기만 한다.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)?.flatten() {
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let target = to.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// dir 안에서 쓸 수 있는 이름: 같은 이름이 있으면 "이름 (1).확장자", "이름 (2).확장자"… (폴더는 확장자 없이 "이름 (1)")
fn unique_name(dir: &Path, name: &str, is_dir: bool) -> String {
    if fs::symlink_metadata(dir.join(name)).is_err() {
        return name.to_string();
    }
    let (stem, ext) = match (is_dir, name.rfind('.')) {
        (false, Some(i)) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..10_000)
        .map(|n| format!("{stem} ({n}){ext}"))
        .find(|candidate| fs::symlink_metadata(dir.join(candidate)).is_err())
        .unwrap_or_else(|| format!("{stem} (copy){ext}"))
}

/// 항목 하나를 dest_dir 안으로 복사한다. 성공하면 새 이름, 건너뛰면 이유를 돌려준다.
fn copy_one(root: &Path, dest_dir: &Path, source: &Path, budget: &mut usize) -> Result<String, String> {
    if !source.is_absolute() {
        return Err("올바른 경로가 아닙니다".into());
    }
    let meta = fs::symlink_metadata(source).map_err(|_| "찾을 수 없습니다".to_string())?;
    if meta.file_type().is_symlink() {
        return Err("바로가기(심볼릭 링크)는 복사하지 않습니다".into());
    }
    let canonical = fs::canonicalize(source).map_err(|_| "찾을 수 없습니다".to_string())?;
    if canonical.starts_with(root) {
        return Err("프로젝트 폴더 안의 항목은 복사하지 않습니다".into());
    }
    if dest_dir.starts_with(&canonical) {
        return Err("폴더를 자기 안에 복사할 수 없습니다".into());
    }
    let name = canonical.file_name().map(|n| n.to_string_lossy().to_string()).ok_or("이름이 없는 항목입니다")?;
    let new_name = unique_name(dest_dir, &name, meta.is_dir());
    let target = dest_dir.join(&new_name);
    if meta.is_dir() {
        let count = count_entries(&canonical, *budget).ok_or_else(|| format!("항목이 너무 많습니다 (한 번에 {MAX_IMPORT_ENTRIES}개까지)"))?;
        *budget -= count + 1;
        if let Err(e) = copy_tree(&canonical, &target) {
            let _ = fs::remove_dir_all(&target); // 반쯤 복사된 폴더는 남기지 않는다
            return Err(format!("복사하지 못했습니다 ({e})"));
        }
    } else {
        if *budget == 0 {
            return Err(format!("항목이 너무 많습니다 (한 번에 {MAX_IMPORT_ENTRIES}개까지)"));
        }
        *budget -= 1;
        fs::copy(&canonical, &target).map_err(|e| format!("복사하지 못했습니다 ({e})"))?;
    }
    Ok(new_name)
}

/// 파일 관리자에서 끌어다 놓은 항목들을 target_dir 폴더로 복사한다 (원본은 이동·삭제하지 않는다).
fn import_entries(root: &Path, target_dir: &str, sources: &[String]) -> Result<ImportResult, String> {
    let dest_dir = resolve_dir(root, target_dir)?;
    let (mut copied, mut skipped) = (Vec::new(), Vec::new());
    let mut budget = MAX_IMPORT_ENTRIES;
    for source in sources {
        let path = PathBuf::from(source);
        let label = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| source.clone());
        match copy_one(root, &dest_dir, &path, &mut budget) {
            Ok(name) => copied.push(join_rel(target_dir, &name)),
            Err(reason) => skipped.push(ImportSkipped { name: label, reason }),
        }
    }
    Ok(ImportResult { copied, skipped })
}

#[tauri::command]
pub async fn import_into_project(app: AppHandle, root: String, target_dir: String, sources: Vec<String>) -> Result<ImportResult, String> {
    if let Some(remote) = crate::remote::ops::resolve(&app, &root).await? {
        let done = crate::remote::ops::import_entries(&remote, &target_dir, &sources).await?;
        return Ok(ImportResult { copied: done.copied, skipped: done.skipped.into_iter().map(|(name, reason)| ImportSkipped { name, reason }).collect() });
    }
    let root = registered_root(&app, &root)?;
    tauri::async_runtime::spawn_blocking(move || import_entries(&root, &target_dir, &sources))
        .await
        .map_err(|e| e.to_string())?
}

/// 파일·폴더를 영구 삭제한다 (휴지통을 거치지 않는다). 폴더는 안의 모든 내용까지 지우고, 지운 항목 수(폴더 자신 포함)를 돌려준다.
/// 프로젝트 폴더 자체·프로젝트 밖·제외 폴더(`.git`·node_modules 등) 안의 항목은 지우지 않는다. 바로가기(심볼릭 링크)는 링크만 지우고 가리키는 곳은 건드리지 않는다.
fn delete_entry(root: &Path, rel: &str) -> Result<usize, String> {
    let rel = normalize_rel(rel);
    if !is_safe_relative(&rel) {
        return Err("OUTSIDE_PROJECT".into());
    }
    if Path::new(&rel).components().any(|c| {
        let name = c.as_os_str().to_string_lossy();
        IGNORED_DIRS.contains(&&*name)
    }) {
        return Err("IGNORED_DIR".into());
    }
    // 부모 폴더를 실제 경로로 확인한 뒤 이름을 붙인다 (대상이 바로가기여도 따라가지 않기 위해 대상 자체는 canonicalize 하지 않는다)
    let relative = Path::new(&rel);
    let name = relative.file_name().ok_or("OUTSIDE_PROJECT")?;
    let parent = match relative.parent() {
        Some(p) if !p.as_os_str().is_empty() => resolve_inside(root, &p.to_string_lossy())?,
        _ => root.to_path_buf(),
    };
    let target = parent.join(name);
    let meta = fs::symlink_metadata(&target).map_err(|_| "NOT_FOUND".to_string())?;
    let fail = |e: std::io::Error| format!("DELETE_FAILED: {e}");
    if meta.file_type().is_symlink() {
        // 파일 바로가기는 remove_file, 폴더 바로가기(Windows)는 remove_dir
        return fs::remove_file(&target).or_else(|_| fs::remove_dir(&target)).map(|_| 1).map_err(fail);
    }
    if meta.is_dir() {
        let count = count_entries(&target, usize::MAX).unwrap_or(0);
        fs::remove_dir_all(&target).map_err(fail)?;
        return Ok(count + 1);
    }
    // Windows의 읽기 전용 파일은 속성을 풀어야 지워진다
    if let Err(first) = fs::remove_file(&target) {
        let mut permissions = meta.permissions();
        if permissions.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            fs::set_permissions(&target, permissions).map_err(fail)?;
            fs::remove_file(&target).map_err(fail)?;
        } else {
            return Err(fail(first));
        }
    }
    Ok(1)
}

#[tauri::command]
pub async fn delete_project_entry(app: AppHandle, root: String, path: String) -> Result<usize, String> {
    if let Some(remote) = crate::remote::ops::resolve(&app, &root).await? {
        return crate::remote::ops::delete_entry(&remote, &path).await;
    }
    let root = registered_root(&app, &root)?;
    delete_entry(&root, &path)
}

/// 폴더 하나를 읽는다. 하위 폴더는 `expanded`(프로젝트 기준 상대 경로, "/" 구분)에 든 것만 안까지 읽고, 나머지는 children 없이 둔다
/// (사용자가 펼칠 때 읽는다). 한 폴더의 항목을 모두 모아 "폴더 먼저, 이름순"으로 정렬한 뒤 앞에서부터 `limits`(폴더별 표시 개수, 없으면 기본값)만큼만 담는다 —
/// 어떤 항목이 빠지는지가 파일 시스템의 읽기 순서가 아니라 이름 순서로 정해지고, 전체 개수(`total`)를 함께 알려 화면이 "더 보기"를 보여 줄 수 있다.
/// 한 폴더의 항목을 모두 모은 뒤에 하위 폴더로 내려가므로 큰 폴더가 형제 항목을 가리지 않는다.
fn walk(dir: &Path, rel: &str, depth: usize, expanded: &HashSet<String>, truncated: &mut bool) -> (Vec<FileNode>, usize) {
    let Ok(entries) = fs::read_dir(dir) else { return (Vec::new(), 0) };
    let mut listed: Vec<(String, bool)> = Vec::new(); // (이름, 폴더 여부)
    for entry in entries.flatten() {
        if listed.len() >= MAX_SCAN_PER_DIR {
            *truncated = true; // 항목이 너무 많아 일부는 세지도 못했다
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(file_type) = entry.file_type() else { continue };
        // 심볼릭 링크는 따라가지 않는다 (순환·폴더 밖 접근 방지)
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() && IGNORED_DIRS.contains(&name.as_str()) {
            continue;
        }
        listed.push((name, file_type.is_dir()));
    }
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
                let (kids, kid_total) = walk(&dir.join(&name), &path, depth + 1, expanded, truncated);
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
}

/// 폴더 항목들을 "폴더 먼저, 이름순(대소문자 무시)"으로 정렬하고 앞의 `limit`개만 남긴다. 정렬 전의 전체 개수도 돌려준다.
pub(crate) fn page_entries(mut list: Vec<(String, bool)>, limit: usize) -> (Vec<(String, bool)>, usize) {
    list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase())).then_with(|| a.0.cmp(&b.0)));
    let total = list.len();
    list.truncate(limit);
    (list, total)
}

/// 파일 트리: 최상위는 항상 읽고, `expanded`에 든 폴더만 안까지 읽는다 (펼칠 때마다 화면이 이 목록을 다시 요청한다).
/// expanded의 경로는 비교에만 쓰고 직접 열지 않으므로 프로젝트 폴더 밖은 읽을 수 없다.
#[tauri::command]
pub async fn list_project_files(app: AppHandle, root: String, expanded: Option<Vec<String>>) -> Result<FileListing, String> {
    if let Some(remote) = crate::remote::ops::resolve(&app, &root).await? {
        let expanded = expanded.unwrap_or_default();
        return match crate::remote::ops::list_tree(&remote, expanded.clone()).await {
            // 연결이 끊긴 채로 요청이 가면 한 번 다시 연결해서 다시 읽는다 (읽기만 하므로 되풀이해도 안전하다)
            Err(e) if e == "CONNECTION_LOST" => {
                let remote = crate::remote::ops::resolve(&app, &root).await?.ok_or("NOT_REGISTERED")?;
                crate::remote::ops::list_tree(&remote, expanded).await
            }
            other => other,
        };
    }
    let root = registered_root(&app, &root)?;
    Ok(list_tree(&root, expanded.unwrap_or_default()))
}

fn list_tree(root: &Path, expanded: Vec<String>) -> FileListing {
    let expanded: HashSet<String> = expanded.into_iter().collect();
    let mut truncated = false;
    let (nodes, total) = walk(root, "", 0, &expanded, &mut truncated);
    FileListing::new(nodes, truncated, total)
}

#[tauri::command]
pub async fn read_project_file(app: AppHandle, root: String, path: String) -> Result<String, String> {
    if let Some(remote) = crate::remote::ops::resolve(&app, &root).await? {
        return match crate::remote::ops::read_text(&remote, &path).await {
            Err(e) if e == "CONNECTION_LOST" => {
                let remote = crate::remote::ops::resolve(&app, &root).await?.ok_or("NOT_REGISTERED")?;
                crate::remote::ops::read_text(&remote, &path).await
            }
            other => other,
        };
    }
    let root = registered_root(&app, &root)?;
    let target = resolve_inside(&root, &path)?;
    let meta = fs::metadata(&target).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("NOT_A_FILE".into());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err("TOO_LARGE".into());
    }
    let bytes = fs::read(&target).map_err(|e| e.to_string())?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err("BINARY".into());
    }
    String::from_utf8(bytes).map_err(|_| "BINARY".into())
}

/// 바이트 그대로 읽어 보여 줄 수 있는 형식(이미지·PDF)과 크기 제한. 확장자는 프런트엔드가 아니라 여기서 직접 판단한다.
pub(crate) fn binary_limit(path: &Path) -> Option<u64> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "svg" | "avif" => Some(MAX_IMAGE_BYTES),
        "pdf" => Some(MAX_PDF_BYTES),
        _ => None,
    }
}

/// 이미지·PDF 파일을 바이트 그대로 읽는다 (뷰어용). 폴더 검증은 read_project_file과 같고, 이 두 형식만 읽는다.
#[tauri::command]
pub async fn read_project_file_bytes(app: AppHandle, root: String, path: String) -> Result<tauri::ipc::Response, String> {
    if let Some(remote) = crate::remote::ops::resolve(&app, &root).await? {
        let bytes = match crate::remote::ops::read_media(&remote, &path).await {
            Err(e) if e == "CONNECTION_LOST" => {
                let remote = crate::remote::ops::resolve(&app, &root).await?.ok_or("NOT_REGISTERED")?;
                crate::remote::ops::read_media(&remote, &path).await?
            }
            other => other?,
        };
        return Ok(tauri::ipc::Response::new(bytes));
    }
    let root = registered_root(&app, &root)?;
    let target = resolve_inside(&root, &path)?;
    let limit = binary_limit(&target).ok_or("UNSUPPORTED_TYPE")?;
    let meta = fs::metadata(&target).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("NOT_A_FILE".into());
    }
    if meta.len() > limit {
        return Err("TOO_LARGE_MEDIA".into());
    }
    let bytes = fs::read(&target).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 스레드로 넘길 수 있게 소유한 로컬·원격 폴더
pub(crate) enum OwnedRoot {
    Local(PathBuf),
    Remote(crate::remote::ops::RemoteRoot),
}

impl OwnedRoot {
    pub(crate) fn as_ref(&self) -> RootRef<'_> {
        match self {
            OwnedRoot::Local(p) => RootRef::Local(p),
            OwnedRoot::Remote(r) => RootRef::Remote(r),
        }
    }
}

/// root 문자열(로컬 경로 또는 ssh://…)이 등록된 프로젝트 폴더인지 확인하고 돌려준다
pub(crate) async fn owned_root(app: &AppHandle, root: &str) -> Result<OwnedRoot, String> {
    if let Some(remote) = crate::remote::ops::resolve(app, root).await? {
        return Ok(OwnedRoot::Remote(remote));
    }
    Ok(OwnedRoot::Local(registered_root(app, root)?))
}

/// 되돌리기에서 마지막 커밋에 없던 새 파일을 지울 때 (로컬·원격 공통)
fn delete_any(root: RootRef<'_>, rel: &str) -> Result<usize, String> {
    match root {
        RootRef::Local(path) => delete_entry(path, rel),
        RootRef::Remote(remote) => wait(crate::remote::ops::delete_entry(remote, rel)),
    }
}

/// git이 아직 모르는 새 파일의 내용을 읽는다 (1MB 제한). 너무 크면 TOO_LARGE
fn read_new_file(root: RootRef<'_>, path: &str) -> Result<Vec<u8>, String> {
    match root {
        RootRef::Local(root) => {
            let target = resolve_inside(root, path)?;
            let meta = fs::metadata(&target).map_err(|e| e.to_string())?;
            if meta.len() > MAX_FILE_BYTES {
                return Err("TOO_LARGE".into());
            }
            fs::read(&target).map_err(|e| e.to_string())
        }
        RootRef::Remote(remote) => wait(crate::remote::ops::read_bytes_limited(remote, path, MAX_FILE_BYTES, "TOO_LARGE")),
    }
}

// ── Git 상태 (읽기 전용) ──

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    status: String,
    path: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    hash: String,
    message: String,
    relative_time: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    is_repo: bool,
    branch: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    changes: Vec<GitChange>,
    last_commit: Option<GitCommit>,
}

/// git 한 번의 결과 (로컬·원격 공통)
pub(crate) struct GitOut {
    pub status: GitCode,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub(crate) struct GitCode(bool);

impl GitCode {
    pub fn success(&self) -> bool {
        self.0
    }
}

fn git<'a>(root: impl Into<RootRef<'a>>, args: &[&str]) -> Result<GitOut, String> {
    match root.into() {
        RootRef::Local(root) => {
            let mut cmd = std::process::Command::new("git");
            // core.quotepath=false: 한글 등 비ASCII 경로를 8진수 이스케이프 없이 출력
            cmd.arg("-C").arg(root).args(["-c", "core.quotepath=false"]).args(args);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000);
            }
            cmd.output()
                .map(|o| GitOut { status: GitCode(o.status.success()), stdout: o.stdout, stderr: o.stderr })
                .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "GIT_NOT_FOUND".to_string() } else { e.to_string() })
        }
        RootRef::Remote(remote) => {
            let out = wait(crate::remote::ops::git(remote, args, std::time::Duration::from_secs(60), false))?;
            Ok(GitOut { status: GitCode(out.success()), stdout: out.stdout, stderr: out.stderr })
        }
    }
}

/// `## main...origin/main [ahead 2, behind 1]` 형식의 첫 줄 해석
fn parse_branch_line(line: &str, status: &mut GitStatus) {
    let rest = line.trim_start_matches("## ");
    let (names, tracking) = match rest.split_once(" [") {
        Some((n, t)) => (n, t.trim_end_matches(']')),
        None => (rest, ""),
    };
    if let Some(name) = names.strip_prefix("No commits yet on ") {
        status.branch = Some(name.to_string());
    } else if let Some((branch, upstream)) = names.split_once("...") {
        status.branch = Some(branch.to_string());
        status.upstream = Some(upstream.to_string());
    } else {
        status.branch = Some(names.to_string());
    }
    for part in tracking.split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            status.ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            status.behind = n.parse().unwrap_or(0);
        }
    }
}

fn parse_porcelain(text: &str) -> GitStatus {
    let mut status = GitStatus { is_repo: true, ..Default::default() };
    for line in text.lines() {
        if line.starts_with("## ") {
            parse_branch_line(line, &mut status);
        } else if line.len() > 3 {
            let code = line[..2].trim();
            let path = line[3..].rsplit(" -> ").next().unwrap_or(&line[3..]).trim_matches('"');
            status.changes.push(GitChange { status: code.to_string(), path: path.to_string() });
        }
    }
    status
}

#[tauri::command]
pub async fn git_status(app: AppHandle, root: String) -> Result<GitStatus, String> {
    let root = owned_root(&app, &root).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = root.as_ref();
        let out = git(root, &["status", "--porcelain=v1", "--branch", "--untracked-files=all"])?;
        if !out.status.success() {
            // 저장소가 아닌 폴더
            return Ok(GitStatus::default());
        }
        let mut status = parse_porcelain(&String::from_utf8_lossy(&out.stdout));
        if let Ok(log) = git(root, &["log", "-1", "--format=%h%x1f%s%x1f%cr"]) {
            let text = String::from_utf8_lossy(&log.stdout);
            let parts: Vec<&str> = text.trim().splitn(3, '\u{1f}').collect();
            if log.status.success() && parts.len() == 3 {
                status.last_commit = Some(GitCommit {
                    hash: parts[0].into(),
                    message: parts[1].into(),
                    relative_time: parts[2].into(),
                });
            }
        }
        Ok(status)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── 변경 내용 보기 (Git diff) · 폴더 열기 ──

const MAX_DIFF_BYTES: usize = 500_000;

/// 프로젝트 안의 상대 경로인지 (절대 경로·상위 폴더 이동 불가). 삭제된 파일도 다루므로 canonicalize 대신 구성 요소로 검사한다.
pub(crate) fn is_safe_relative(path: &str) -> bool {
    let p = Path::new(path);
    !path.is_empty() && !path.contains('\0') && p.is_relative() && p.components().all(|c| matches!(c, std::path::Component::Normal(_)))
}

/// 새 파일(Git이 아직 모르는 파일)을 "전부 추가된 줄"인 diff 형태로 만든다.
fn new_file_diff(path: &str, text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = format!("--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n", lines.len());
    for line in lines {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn truncate_diff(mut text: String) -> String {
    if text.len() > MAX_DIFF_BYTES {
        let mut cut = MAX_DIFF_BYTES;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n… (변경 내용이 너무 커서 여기까지만 표시합니다)\n");
    }
    text
}

/// 한 파일의 변경 내용(마지막 커밋과의 차이)을 unified diff 텍스트로 돌려준다. 변경이 없으면 빈 문자열.
#[tauri::command]
pub async fn git_diff(app: AppHandle, root: String, path: String) -> Result<String, String> {
    let root = owned_root(&app, &root).await?;
    if !is_safe_relative(&path) {
        return Err("OUTSIDE_PROJECT".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = root.as_ref();
        let status = git(root, &["status", "--porcelain=v1", "--untracked-files=all", "--", &path])?;
        if !status.status.success() {
            return Err("NOT_A_REPO".to_string());
        }
        if String::from_utf8_lossy(&status.stdout).trim_start().starts_with("??") {
            // 새 파일: 내용을 전부 추가된 줄로 보여 준다 (1MB·텍스트 제한은 파일 읽기와 같다)
            let bytes = match read_new_file(root, &path) {
                Ok(bytes) => bytes,
                Err(e) if e == "TOO_LARGE" => return Ok(format!("(새 파일 {path} — 1MB보다 커서 내용을 표시하지 않습니다)\n")),
                Err(e) => return Err(e),
            };
            return Ok(match String::from_utf8(bytes) {
                Ok(text) if !text.contains('\0') => truncate_diff(new_file_diff(&path, &text)),
                _ => format!("(새 파일 {path} — 텍스트가 아니라 내용을 표시하지 않습니다)\n"),
            });
        }
        let diff = git(root, &["diff", "HEAD", "--no-color", "--no-ext-diff", "--", &path])?;
        let text = if diff.status.success() {
            String::from_utf8_lossy(&diff.stdout).to_string()
        } else {
            // 아직 커밋이 없는 저장소: 스테이징된 변경을 보여 준다
            let staged = git(root, &["diff", "--cached", "--no-color", "--no-ext-diff", "--", &path])?;
            String::from_utf8_lossy(&staged.stdout).to_string()
        };
        Ok(truncate_diff(text))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── 커밋 · 푸시 (사용자가 버튼을 눌렀을 때만) ──
// 강제 푸시·브랜치 변경·병합은 만들지 않는다. 인증은 앱이 다루지 않고 PC의 기존 git 설정(자격 증명 관리자 등)에 맡긴다.

const MAX_COMMIT_PATHS: usize = 1000;
const MAX_MESSAGE_BYTES: usize = 2000;
const COMMIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const PUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// git을 시간 제한을 두고 실행한다. 성공 여부와 출력(표준 출력 + 표준 오류)을 돌려준다. 인증 입력을 기다리지 않는다.
fn git_timed<'a>(root: impl Into<RootRef<'a>>, args: &[&str], timeout: std::time::Duration) -> Result<(bool, String), String> {
    let root = match root.into() {
        RootRef::Local(path) => path,
        RootRef::Remote(remote) => {
            // 푸시는 새 접속으로 실행해 다른 원격 작업을 막지 않는다
            let oneshot = args.first().is_some_and(|a| *a == "push");
            let out = wait(crate::remote::ops::git(remote, args, timeout, oneshot))?;
            return Ok((out.success(), format!("{}{}", out.stdout_text(), out.stderr_text()).trim().to_string()));
        }
    };
    use std::io::Read;
    use std::process::Stdio;
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(root).args(["-c", "core.quotepath=false"]).args(args);
    cmd.env("GIT_TERMINAL_PROMPT", "0").env("GCM_INTERACTIVE", "never");
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { "GIT_NOT_FOUND".to_string() } else { e.to_string() }
    })?;
    let drain = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            String::from_utf8_lossy(&bytes).to_string()
        })
    };
    let out = drain(Box::new(child.stdout.take().ok_or("git 출력을 읽지 못했습니다")?));
    let err = drain(Box::new(child.stderr.take().ok_or("git 출력을 읽지 못했습니다")?));
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(50)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("시간이 너무 오래 걸려 중단했습니다. 네트워크와 로그인 상태를 확인하세요.".into());
            }
        }
    };
    let (out, err) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
    Ok((status.success(), format!("{}{}", out, err).trim().to_string()))
}

/// 선택한 파일만 커밋한다 (스테이징해 둔 다른 변경은 건드리지 않는다). 성공하면 git이 알려 주는 첫 줄.
fn commit_paths<'a>(root: impl Into<RootRef<'a>>, paths: &[String], message: &str) -> Result<String, String> {
    let root = root.into();
    let message = message.trim();
    if message.is_empty() {
        return Err("커밋 메시지를 입력하세요.".into());
    }
    if message.len() > MAX_MESSAGE_BYTES || message.contains('\0') {
        return Err("커밋 메시지가 너무 깁니다.".into());
    }
    if paths.is_empty() {
        return Err("커밋할 파일을 선택하세요.".into());
    }
    if paths.len() > MAX_COMMIT_PATHS {
        return Err(format!("한 번에 {MAX_COMMIT_PATHS}개까지 커밋할 수 있습니다."));
    }
    if !paths.iter().all(|p| is_safe_relative(p)) {
        return Err("OUTSIDE_PROJECT".into());
    }
    let mut add: Vec<&str> = vec!["add", "-A", "--"];
    add.extend(paths.iter().map(String::as_str));
    let (ok, text) = git_timed(root, &add, COMMIT_TIMEOUT)?;
    if !ok {
        return Err(text);
    }
    let mut commit: Vec<&str> = vec!["commit", "-m", message, "--"];
    commit.extend(paths.iter().map(String::as_str));
    let (ok, text) = git_timed(root, &commit, COMMIT_TIMEOUT)?;
    if !ok {
        return Err(text);
    }
    Ok(text.lines().next().unwrap_or("커밋했습니다.").to_string())
}

/// 현재 브랜치를 푸시한다. 상위 브랜치가 아직 없으면 origin에 만들면서 올린다 (`push -u origin HEAD`). 강제 푸시는 쓰지 않는다.
fn push_current<'a>(root: impl Into<RootRef<'a>>) -> Result<String, String> {
    let root = root.into();
    let (has_upstream, _) = git_timed(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], COMMIT_TIMEOUT)?;
    let args: &[&str] = if has_upstream { &["push"] } else { &["push", "-u", "origin", "HEAD"] };
    let (ok, text) = git_timed(root, args, PUSH_TIMEOUT)?;
    if ok { Ok(if text.is_empty() { "푸시했습니다.".into() } else { text }) } else { Err(text) }
}

/// 선택한 파일을 한 커밋으로 만든다. 실패하면 git이 낸 메시지를 그대로 돌려준다.
#[tauri::command]
pub async fn git_commit(app: AppHandle, root: String, paths: Vec<String>, message: String) -> Result<String, String> {
    let root = owned_root(&app, &root).await?;
    tauri::async_runtime::spawn_blocking(move || commit_paths(root.as_ref(), &paths, &message))
        .await
        .map_err(|e| e.to_string())?
}

const MAX_REVERT_PATHS: usize = 500;

#[derive(Serialize, Debug)]
pub struct RevertSkipped {
    path: String,
    reason: String,
}

#[derive(Serialize, Debug)]
pub struct RevertReport {
    /// 마지막 커밋의 내용으로 되돌린 파일 수 (수정·삭제·이름 변경)
    restored: usize,
    /// 마지막 커밋에 없던 새 파일이라 지운 수
    removed: usize,
    skipped: Vec<RevertSkipped>,
}

/// 마지막 커밋에 이 경로가 있는지
fn in_head(root: RootRef<'_>, path: &str) -> Result<bool, String> {
    let spec = format!("HEAD:{path}");
    Ok(git(root, &["cat-file", "-e", &spec])?.status.success())
}

/// `git status --porcelain=v1 -z`의 항목들: (상태 코드 XY, 경로, 이름 변경·복사의 원래 경로).
/// 경로를 한정하지 않고 전체를 읽는다 — 이름 변경은 원래 경로까지 함께 볼 때만 R로 잡히기 때문이다.
fn status_entries(root: RootRef<'_>) -> Result<Vec<(String, String, Option<String>)>, String> {
    let out = git(root, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let mut parts = text.split(' ').filter(|p| !p.is_empty());
    let mut entries = Vec::new();
    while let Some(entry) = parts.next() {
        if entry.len() < 4 {
            continue;
        }
        let code = entry[..2].to_string();
        let renamed_from = if code.starts_with('R') || code.starts_with('C') { parts.next().map(String::from) } else { None };
        entries.push((code, entry[3..].to_string(), renamed_from));
    }
    Ok(entries)
}

/// 선택한 파일의 변경을 마지막 커밋 상태로 되돌린다. 수정·삭제·이름 변경은 마지막 커밋의 내용으로 복원하고,
/// 마지막 커밋에 없던 새 파일은 영구 삭제한다 (휴지통 없음). 충돌 중인 파일은 건너뛴다.
fn revert_paths<'a>(root: impl Into<RootRef<'a>>, paths: &[String]) -> Result<RevertReport, String> {
    let root = root.into();
    if paths.is_empty() {
        return Err("되돌릴 파일을 선택하세요.".into());
    }
    if paths.len() > MAX_REVERT_PATHS {
        return Err(format!("한 번에 {MAX_REVERT_PATHS}개까지 되돌릴 수 있습니다."));
    }
    if !paths.iter().all(|p| is_safe_relative(p)) {
        return Err("OUTSIDE_PROJECT".into());
    }
    if !git(root, &["rev-parse", "--is-inside-work-tree"])?.status.success() {
        return Err("NOT_A_REPO".into());
    }
    if !git(root, &["rev-parse", "--verify", "-q", "HEAD"])?.status.success() {
        return Err("커밋이 하나도 없어 되돌릴 기준이 없습니다.".into());
    }
    let mut report = RevertReport { restored: 0, removed: 0, skipped: Vec::new() };
    let entries = status_entries(root)?;
    for path in paths {
        let path = normalize_rel(path);
        let skip = |reason: &str| RevertSkipped { path: path.clone(), reason: reason.into() };
        // 새 폴더는 상태 목록에 파일 단위로 나오므로(untracked-files=all) 폴더를 고르면 그 안의 항목도 함께 본다
        let prefix = format!("{path}/");
        let matched: Vec<_> = entries.iter().filter(|(_, p, _)| *p == path || p.starts_with(&prefix)).collect();
        let Some((code, _, renamed_from)) = matched.iter().find(|(_, p, _)| *p == path).copied().or_else(|| matched.first().copied()) else {
            report.skipped.push(skip("바뀐 내용이 없습니다"));
            continue;
        };
        let (code, renamed_from) = (code.clone(), renamed_from.clone());
        if code.contains('U') || code == "AA" || code == "DD" {
            report.skipped.push(skip("충돌 중인 파일은 되돌리지 않습니다 (먼저 충돌을 해결하세요)"));
            continue;
        }
        if in_head(root, &path)? {
            let out = git(root, &["checkout", "HEAD", "--", &path])?;
            if !out.status.success() {
                report.skipped.push(skip(String::from_utf8_lossy(&out.stderr).trim()));
                continue;
            }
            report.restored += 1;
        } else {
            // 마지막 커밋에 없던 새 파일: 인덱스에 올라가 있으면 빼고 파일을 지운다
            let _ = git(root, &["rm", "-r", "-f", "--cached", "-q", "--ignore-unmatch", "--", &path])?;
            match delete_any(root, &path) {
                Ok(_) => report.removed += 1,
                Err(e) if e == "NOT_FOUND" => report.removed += 1, // 이미 파일이 없다 (인덱스만 정리됨)
                Err(e) => {
                    report.skipped.push(skip(&e));
                    continue;
                }
            }
        }
        // 이름을 바꾼 파일이면 원래 이름도 마지막 커밋으로 되살린다
        if let Some(old) = renamed_from.filter(|o| is_safe_relative(o)) {
            if in_head(root, &old)? && git(root, &["checkout", "HEAD", "--", &old])?.status.success() {
                report.restored += 1;
            }
        }
    }
    Ok(report)
}

#[tauri::command]
pub async fn git_revert(app: AppHandle, root: String, paths: Vec<String>) -> Result<RevertReport, String> {
    let root = owned_root(&app, &root).await?;
    tauri::async_runtime::spawn_blocking(move || revert_paths(root.as_ref(), &paths)).await.map_err(|e| e.to_string())?
}

/// 현재 브랜치를 푸시한다. 실패하면 git이 낸 메시지를 그대로 돌려준다.
#[tauri::command]
pub async fn git_push(app: AppHandle, root: String) -> Result<String, String> {
    let root = owned_root(&app, &root).await?;
    tauri::async_runtime::spawn_blocking(move || push_current(root.as_ref()))
        .await
        .map_err(|e| e.to_string())?
}

/// 프로젝트 폴더를 운영체제 파일 관리자(Windows 탐색기·Linux 파일 관리자)로 연다. 등록된 프로젝트 폴더만 열 수 있다.
#[tauri::command]
pub fn open_project_folder(app: AppHandle, root: String) -> Result<(), String> {
    if root.starts_with(crate::remote::ROOT_PREFIX) {
        return Err("REMOTE_PROJECT".into()); // 원격 폴더는 이 PC의 파일 관리자로 열 수 없다
    }
    // 등록된 폴더인지 확인한다. 경로는 사용자가 등록한 그대로 쓴다 (canonicalize 결과의 확장 경로 접두사는 탐색기가 못 읽는다)
    registered_root(&app, &root)?;
    let mut cmd = if cfg!(windows) { std::process::Command::new("explorer") } else { std::process::Command::new("xdg-open") };
    cmd.arg(&root);
    // explorer는 성공해도 종료 코드가 1이라 실행됐는지(spawn)만 본다
    cmd.spawn().map(|_| ()).map_err(|_| "OPEN_FAILED".to_string())
}

/// 열 수 있는 웹 주소인지: http(s)만, 공백·제어 문자 없음, 2,048자 이하 (채팅 답변 속 링크를 기본 브라우저로 열 때 쓴다)
fn is_openable_url(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://")) && url.len() <= 2048 && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// 웹 주소를 운영체제의 기본 브라우저로 연다 (앱 화면 안에서 이동하면 앱이 사라지므로 링크는 이 명령으로 연다).
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    if !is_openable_url(&url) {
        return Err("INVALID_URL".into());
    }
    let mut cmd = if cfg!(windows) { std::process::Command::new("explorer") } else { std::process::Command::new("xdg-open") };
    cmd.arg(&url);
    cmd.spawn().map(|_| ()).map_err(|_| "OPEN_FAILED".to_string())
}

// ── 프로젝트 표준 문서 (TODO.md, 기능명세서.md) ──
// 프로젝트를 열 때 없으면 만든다. 이미 있으면 절대 건드리지 않는다 (탐색기 외에 앱이 쓰는 유일한 프로젝트 파일).

pub const PROJECT_DOCS: &[(&str, &str)] = &[
    (
        "TODO.md",
        "# TODO

앞으로 할 작업만 적습니다. 완료한 항목은 지우고 완료 이력은 남기지 않습니다.
우선순위: 🔴 높음 · 🟡 보통 · ⚪ 낮음

## 요약

사용자가 한눈에 보고 지시할 수 있도록 남은 작업을 우선순위 순으로 한 줄씩 적습니다. 항목을 추가·삭제·변경하면 함께 고칩니다.

| 번호 | 우선순위 | 한 줄 요약 |
| --- | --- | --- |

## 상세

<!-- 형식 (번호는 다시 쓰지 않음):
- [ ] **T01** 🔴 할 일 한 줄 요약
  - 완료 기준: 무엇이 되면 끝인지 (사용자가 확인할 수 있는 동작)
  - 범위·결정: 이미 정한 방식, 건드릴 파일, 하지 않을 것 (필요할 때만)
-->
",
    ),
    (
        "기능명세서.md",
        "# 기능명세서

현재 실제로 구현된 기능만 적습니다. 계획·미구현 기능은 적지 않습니다(→ TODO.md).

<!-- 형식: 큰 개념 그룹(##) 아래에 기능(###). 제목 깊이는 3 이하
## 그룹 이름
### 기능 이름
- 목적:
- 주요 동작:
- 관련 파일:
-->
",
    ),
];

/// 없는 표준 문서만 만든다. 만든 파일 이름 목록을 돌려준다.
pub fn ensure_docs_in(root: &Path) -> Result<Vec<String>, String> {
    let mut created = Vec::new();
    for (name, template) in PROJECT_DOCS {
        let path = root.join(name);
        // 대소문자만 다른 파일(todo.md 등)도 기존 문서로 본다 (Linux)
        let exists = path.exists()
            || fs::read_dir(root).map_or(false, |entries| {
                entries.flatten().any(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(name))
            });
        if exists {
            continue;
        }
        // create_new: 동시에 다른 곳에서 만들었더라도 덮어쓰지 않는다
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                std::io::Write::write_all(&mut file, template.as_bytes()).map_err(|e| e.to_string())?;
                created.push(name.to_string());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(created)
}

/// 등록된 프로젝트 폴더에 표준 문서(TODO.md, 기능명세서.md)가 없으면 만든다.
#[tauri::command]
pub async fn ensure_project_docs(app: AppHandle, root: String) -> Result<Vec<String>, String> {
    if let Some(remote) = crate::remote::ops::resolve(&app, &root).await? {
        return crate::remote::ops::ensure_docs(&remote).await;
    }
    let root = registered_root(&app, &root)?;
    ensure_docs_in(&root)
}

#[cfg(test)]
#[path = "tests/workspace.rs"]
mod tests;
