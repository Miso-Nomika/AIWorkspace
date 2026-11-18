//! 엑셀(xlsx·xlsm) 읽기 — 뷰어용. 셀을 하나씩 읽어 행·열·셀 수 상한에서 멈춘다.
//!
//! calamine의 기본 방식(`worksheet_range`)은 시트에 적힌 크기만큼 메모리를 한꺼번에 잡으므로
//! (A1과 XFD1048576 두 칸만 있는 악성 파일이 수십억 칸을 잡음) 쓰지 않는다.

use calamine::{DataRef, Reader, SheetType, SheetVisible, Xlsx};
use serde::Serialize;
use std::fs::{self, File};
use std::io::BufReader;
use std::path::Path;
use tauri::AppHandle;

use crate::workspace::{registered_root, resolve_inside};

const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
/// 압축을 푼 뒤의 크기 합계 상한 (압축 폭탄 방어)
const MAX_UNPACKED_BYTES: u64 = 200 * 1024 * 1024;
const MAX_ROWS: u32 = 2_000;
const MAX_COLS: u32 = 100;
const MAX_TOTAL_CELLS: usize = 300_000;

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SheetData {
    pub name: String,
    pub hidden: bool,
    pub rows: Vec<Vec<String>>,
    /// [시작 행, 시작 열, 끝 행, 끝 열] (0부터, 보이는 범위 안으로 잘라 둠)
    pub merges: Vec<[u32; 4]>,
    /// 행·열·전체 셀 상한 때문에 일부만 담았다
    pub truncated: bool,
    /// 전체 셀 상한에 이미 닿아 이 시트는 읽지 않았다
    pub skipped: bool,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SheetBook {
    pub sheets: Vec<SheetData>,
}

fn cell_text(value: &DataRef) -> String {
    match value {
        DataRef::Empty => String::new(),
        DataRef::Int(i) => i.to_string(),
        DataRef::Float(f) => float_text(*f),
        DataRef::String(s) => s.clone(),
        DataRef::SharedString(s) => (*s).to_string(),
        DataRef::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        DataRef::DateTime(dt) => {
            if dt.is_datetime() {
                match dt.as_datetime() {
                    Some(d) => {
                        let text = d.to_string(); // 2024-03-05 13:45:00
                        if dt.as_f64() < 1.0 {
                            text.get(11..16).unwrap_or(&text).to_string() // 시간만
                        } else if text.get(11..19) == Some("00:00:00") {
                            text.get(..10).unwrap_or(&text).to_string()
                        } else {
                            text.get(..16).unwrap_or(&text).to_string()
                        }
                    }
                    None => float_text(dt.as_f64()),
                }
            } else {
                float_text(dt.as_f64())
            }
        }
        DataRef::DateTimeIso(s) | DataRef::DurationIso(s) => s.clone(),
        DataRef::Error(e) => e.to_string(),
    }
}

fn float_text(f: f64) -> String {
    if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e15 { format!("{}", f as i64) } else { f.to_string() }
}

/// 파일을 열기 전 확인: 크기와 압축 푼 크기 합계
fn check_limits(path: &Path) -> Result<(), String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("NOT_A_FILE".into());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err("TOO_LARGE_SHEET".into());
    }
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(BufReader::new(file)).map_err(|_| "INVALID_SHEET".to_string())?;
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let entry = zip.by_index_raw(i).map_err(|_| "INVALID_SHEET".to_string())?;
        total = total.saturating_add(entry.size());
        if total > MAX_UNPACKED_BYTES {
            return Err("TOO_LARGE_SHEET".into());
        }
    }
    Ok(())
}

pub fn read_sheets(path: &Path) -> Result<SheetBook, String> {
    check_limits(path)?;
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut book: Xlsx<_> = Xlsx::new(BufReader::new(file)).map_err(|_| "INVALID_SHEET".to_string())?;
    let metas: Vec<(String, bool)> = book
        .sheets_metadata()
        .iter()
        .filter(|s| matches!(s.typ, SheetType::WorkSheet))
        .map(|s| (s.name.clone(), !matches!(s.visible, SheetVisible::Visible)))
        .collect();

    let mut out = SheetBook::default();
    let mut budget = MAX_TOTAL_CELLS;
    for (name, hidden) in metas {
        let mut sheet = SheetData { name: name.clone(), hidden, ..Default::default() };
        if budget == 0 {
            sheet.skipped = true;
            out.sheets.push(sheet);
            continue;
        }
        let mut rows: Vec<Vec<String>> = Vec::new();
        let mut width: usize = 0;
        {
            let mut reader = book.worksheet_cells_reader(&name).map_err(|_| "INVALID_SHEET".to_string())?;
            while let Some(cell) = reader.next_cell().map_err(|_| "INVALID_SHEET".to_string())? {
                let (r, c) = cell.get_position();
                if r >= MAX_ROWS {
                    sheet.truncated = true;
                    break; // 행은 순서대로 나오므로 이후는 모두 범위 밖
                }
                if c >= MAX_COLS {
                    sheet.truncated = true;
                    continue;
                }
                let text = cell_text(cell.get_value());
                if text.is_empty() {
                    continue;
                }
                if budget == 0 {
                    sheet.truncated = true;
                    break;
                }
                budget -= 1;
                let (r, c) = (r as usize, c as usize);
                if rows.len() <= r {
                    rows.resize_with(r + 1, Vec::new);
                }
                let row = &mut rows[r];
                if row.len() <= c {
                    row.resize(c + 1, String::new());
                }
                row[c] = text;
                width = width.max(c + 1);
            }
        }
        for row in rows.iter_mut() {
            row.resize(width, String::new());
        }
        let height = rows.len() as u32;
        let width = width as u32;
        if let Ok(regions) = book.merge_cells_by_sheet_name(&name) {
            for d in regions {
                let (r1, c1) = d.start;
                let (r2, c2) = d.end;
                if r1 >= height || c1 >= width || (r1 == r2 && c1 == c2) {
                    continue;
                }
                sheet.merges.push([r1, c1, r2.min(height - 1), c2.min(width - 1)]);
            }
        }
        sheet.rows = rows;
        out.sheets.push(sheet);
    }
    Ok(out)
}

fn is_sheet_file(path: &Path) -> bool {
    matches!(path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(), Some("xlsx" | "xlsm"))
}

/// 프로젝트 안의 xlsx·xlsm을 시트별 표로 읽는다 (뷰어용, 읽기 전용)
#[tauri::command]
pub async fn read_project_sheet(app: AppHandle, root: String, path: String) -> Result<SheetBook, String> {
    if let Some(remote) = crate::remote::ops::resolve(&app, &root).await? {
        // 원격 파일은 이 PC의 임시 파일로 받아 같은 방식으로 읽는다 (calamine은 파일 경로가 필요하다)
        if !is_sheet_file(Path::new(&path)) {
            return Err("UNSUPPORTED_TYPE".into());
        }
        let bytes = crate::remote::ops::read_bytes_limited(&remote, &path, MAX_FILE_BYTES, "TOO_LARGE_SHEET").await?;
        let temp = std::env::temp_dir().join(format!("aiws-remote-sheet-{}-{}.xlsx", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
        fs::write(&temp, bytes).map_err(|e| e.to_string())?;
        let cleanup = temp.clone();
        let result = tauri::async_runtime::spawn_blocking(move || read_sheets(&temp)).await.map_err(|e| e.to_string());
        let _ = fs::remove_file(cleanup);
        return result?;
    }
    let root = registered_root(&app, &root)?;
    let target = resolve_inside(&root, &path)?;
    if !is_sheet_file(&target) {
        return Err("UNSUPPORTED_TYPE".into());
    }
    tauri::async_runtime::spawn_blocking(move || read_sheets(&target)).await.map_err(|e| e.to_string())?
}


#[cfg(test)]
#[path = "tests/sheet.rs"]
mod tests;
