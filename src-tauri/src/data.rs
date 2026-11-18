//! 앱 데이터 저장소: 키마다 JSON 파일 하나.
//! 위치: %LOCALAPPDATA%\com.aiworkspace.desktop\data\<key>.json
//! (프로젝트 경로처럼 기기에 묶인 데이터가 있으므로 Roaming이 아닌 Local 폴더를 쓴다.)
//! 키 형식: `name` 또는 `name:id` (예: projects, memories, chat:abc123). 파일명에서는 ':' 대신 '.'을 쓴다.

use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 점검용 실행인지 (AIWORKSPACE_DATA_DIR가 지정됨)
pub fn is_test_run() -> bool {
    std::env::var_os("AIWORKSPACE_DATA_DIR").is_some_and(|v| !v.is_empty())
}

/// 외부 서버(GitHub·금리·날씨 같은 API) 호출을 막아야 하는지: 점검용 실행에서는 막는다. 다만 그 호출 자체를 확인하려는 점검은
/// 환경 변수 AIWS_ALLOW_EXTERNAL=1로 풀 수 있다 (점검 도우미의 allowExternal 옵션). 터미널·폴더 열기 같은 외부 요청이 아닌 동작은 막지 않는다
pub fn external_blocked() -> bool {
    is_test_run() && std::env::var_os("AIWS_ALLOW_EXTERNAL").is_none_or(|v| v != "1")
}

/// 앱 데이터의 기준 폴더. 환경 변수 AIWORKSPACE_DATA_DIR가 있으면 그 폴더를 쓴다 (화면 점검 스크립트가
/// 실제 데이터와 분리된 임시 폴더로 앱을 띄울 때 사용). 평소에는 %LOCALAPPDATA%com.aiworkspace.desktop.
pub fn base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    match std::env::var_os("AIWORKSPACE_DATA_DIR").filter(|v| !v.is_empty()) {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => app.path().app_local_data_dir().map_err(|e| e.to_string()),
    }
}

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = base_dir(app)?.join("data");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn is_valid_part(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn is_valid_key(key: &str) -> bool {
    let mut parts = key.splitn(2, ':');
    let name = parts.next().unwrap_or("");
    match parts.next() {
        None => is_valid_part(name),
        Some(id) => is_valid_part(name) && is_valid_part(id),
    }
}

fn key_to_file(key: &str) -> String {
    format!("{}.json", key.replacen(':', ".", 1))
}

fn file_to_key(file: &str) -> Option<String> {
    let stem = file.strip_suffix(".json")?;
    let key = stem.replacen('.', ":", 1);
    is_valid_key(&key).then_some(key)
}

pub fn load(app: &AppHandle, key: &str) -> Option<Value> {
    let path = data_dir(app).ok()?.join(key_to_file(key));
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// 모든 데이터 파일을 읽는다. 앱 시작 시 한 번 호출.
#[tauri::command]
pub fn data_load_all(app: AppHandle) -> Result<HashMap<String, Value>, String> {
    let dir = data_dir(&app)?;
    let mut result = HashMap::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(key) = file_to_key(&name) else { continue };
        if let Ok(text) = fs::read_to_string(entry.path()) {
            // 손상된 파일은 건너뛴다 (앱 전체가 멈추지 않도록)
            if let Ok(value) = serde_json::from_str(&text) {
                result.insert(key, value);
            }
        }
    }
    Ok(result)
}

/// 임시 파일에 쓴 뒤 교체해 쓰기 도중 종료돼도 기존 파일이 깨지지 않게 한다.
#[tauri::command]
pub fn data_save(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    if !is_valid_key(&key) {
        return Err(format!("invalid key: {key}"));
    }
    let dir = data_dir(&app)?;
    let target = dir.join(key_to_file(&key));
    let tmp = dir.join(format!("{}.tmp", key_to_file(&key)));
    let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &target).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn data_remove(app: AppHandle, key: String) -> Result<(), String> {
    if !is_valid_key(&key) {
        return Err(format!("invalid key: {key}"));
    }
    let path = data_dir(&app)?.join(key_to_file(&key));
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
#[path = "tests/data.rs"]
mod tests;
