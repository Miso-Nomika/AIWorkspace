//! 이전 버전이 남긴 찌꺼기 정리.
//!
//! 자동 업데이트는 새 설치 파일을 임시 폴더에 `AIWorkspace-<버전>-updater-<임의>` 폴더로 내려받고 지우지 않는다.
//! 업데이트할 때마다 폴더가 하나씩 쌓이므로, 앱이 시작할 때 현재 버전 이하(= 이미 설치가 끝난 버전)의 폴더를 지운다.

use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

const PREFIX: &str = "AIWorkspace-";
const MARK: &str = "-updater-";
/// 방금 내려받은(설치가 진행 중일 수 있는) 폴더는 건드리지 않는다
const MIN_AGE: Duration = Duration::from_secs(600);

/// "0.13.1"·"0.14.0-beta.1" → (0, 13, 1). 형식이 다르면 None
fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let core = text.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let version = (parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?);
    if parts.next().is_some() {
        return None;
    }
    Some(version)
}

/// 폴더 이름 `AIWorkspace-<버전>-updater-<임의>`에서 버전을 꺼낸다
fn updater_dir_version(name: &str) -> Option<(u64, u64, u64)> {
    let rest = name.strip_prefix(PREFIX)?;
    let end = rest.find(MARK)?;
    parse_version(&rest[..end])
}

/// 임시 폴더(temp)에서 현재 버전 이하의 업데이트 설치 폴더를 지우고 지운 개수를 돌려준다.
/// 폴더만 대상이며, 새 버전·형식이 다른 이름·최근(10분 이내) 폴더·지울 수 없는 폴더(사용 중)는 그대로 둔다.
pub fn clean_updater_leftovers(temp: &Path, current: &str, now: SystemTime) -> usize {
    let Some(current) = parse_version(current) else { return 0 };
    let Ok(entries) = fs::read_dir(temp) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_dir() {
            continue;
        }
        let Some(version) = entry.file_name().to_str().and_then(updater_dir_version) else { continue };
        if version > current {
            continue;
        }
        let old_enough = meta.modified().ok().and_then(|m| now.duration_since(m).ok()).is_some_and(|age| age >= MIN_AGE);
        if old_enough && fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// 앱 시작 때 백그라운드로 정리한다 (시작을 늦추지 않는다)
pub fn spawn_startup_cleanup(current_version: String) {
    std::thread::spawn(move || {
        clean_updater_leftovers(&std::env::temp_dir(), &current_version, SystemTime::now());
    });
}

#[cfg(test)]
#[path = "tests/cleanup.rs"]
mod tests;
