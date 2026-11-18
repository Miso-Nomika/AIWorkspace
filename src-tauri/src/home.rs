//! 개인 홈 위젯의 외부 자료 받기 — 미국 소비자물가(BLS)와 기준금리(뉴욕 연준 실효금리).
//!
//! 웹뷰 CSP를 풀지 않으려고 Rust가 받아서 글만 넘긴다(해석은 화면 쪽 `macro-core.ts`).
//! 받는 곳은 아래 두 호스트의 정해 둔 주소 모양뿐이며 웹에서 주소를 정할 수 없다. 응답 본문은 로그에 남기지 않는다.
//! (FRED는 이 PC에서 연결이 막혀 있어 쓰지 않는다.)

use std::time::{Duration, SystemTime, UNIX_EPOCH};

const BLS_URL: &str = "https://api.bls.gov/publicAPI/v1/timeseries/data/";
/// CPI-U 전 도시 소비자, 계절조정, 1982-84=100
const CPI_SERIES: &str = "CUSR0000SA0";
const EFFR_BASE: &str = "https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json";
const MAX_BYTES: usize = 2 * 1024 * 1024;
/// BLS v1은 요청 하나에 최대 10년까지만 준다 (더 길면 endyear를 줄여 최신 연도가 빠진다)
const BLS_WINDOW_YEARS: u32 = 10;
/// 받는 기간: 오늘 기준 약 20년
const HISTORY_YEARS: u32 = 20;

/// 오늘(UTC)의 (연, 월, 일). 1970-01-01부터의 일 수를 날짜로 바꾼다.
fn today() -> (u32, u32, u32) {
    let days = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0) as i64;
    civil_from_days(days)
}

/// 일 수(1970-01-01=0) → (연, 월, 일) — 그레고리력
fn civil_from_days(days: i64) -> (u32, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    ((if m <= 2 { y + 1 } else { y }) as u32, m as u32, d as u32)
}

/// 물가를 받을 10년짜리 창 두 개 [(시작 연도, 끝 연도)] — 오래된 것부터. year는 올해
fn cpi_windows(year: u32) -> [(u32, u32); 2] {
    let last = BLS_WINDOW_YEARS - 1;
    [(year - HISTORY_YEARS + 1, year - BLS_WINDOW_YEARS), (year - last, year)]
}

fn cpi_request_body(start: u32, end: u32) -> String {
    format!(r#"{{"seriesid":["{CPI_SERIES}"],"startyear":"{start}","endyear":"{end}"}}"#)
}

fn effr_url(today: (u32, u32, u32)) -> String {
    let (y, m, d) = today;
    format!("{EFFR_BASE}?startDate={}-01-01&endDate={y:04}-{m:02}-{d:02}&type=rate", y - HISTORY_YEARS)
}

fn client() -> Result<reqwest::Client, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder().timeout(Duration::from_secs(20)).user_agent("AIWorkspace").build().map_err(|e| e.to_string())
}

async fn read_text(response: reqwest::Response, what: &str) -> Result<String, String> {
    if !response.status().is_success() {
        return Err(format!("{what}를 받지 못했습니다 (HTTP {})", response.status().as_u16()));
    }
    if response.content_length().is_some_and(|n| n as usize > MAX_BYTES) {
        return Err(format!("{what} 응답이 예상보다 큽니다."));
    }
    let bytes = response.bytes().await.map_err(|e| format!("{what}를 받지 못했습니다: {e}"))?;
    if bytes.len() > MAX_BYTES {
        return Err(format!("{what} 응답이 예상보다 큽니다."));
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| format!("{what} 응답을 읽을 수 없습니다."))
}

/// 미국 소비자물가지수(BLS) — 10년짜리 창 두 개의 JSON 글을 오래된 것부터 돌려준다. 해석은 화면 쪽에서 한다
#[tauri::command]
pub async fn home_fetch_cpi() -> Result<Vec<String>, String> {
    if crate::data::external_blocked() {
        return Err("점검용 실행에서는 외부 서버를 부르지 않습니다.".into());
    }
    let client = client()?;
    let mut out = Vec::new();
    for (start, end) in cpi_windows(today().0) {
        let response = client
            .post(BLS_URL)
            .header("Content-Type", "application/json")
            .body(cpi_request_body(start, end))
            .send()
            .await
            .map_err(|e| format!("물가 자료를 받지 못했습니다: {e}"))?;
        out.push(read_text(response, "물가 자료").await?);
    }
    Ok(out)
}

/// 미국 기준금리(뉴욕 연준 실효금리, 일별) JSON 글. 해석·월평균은 화면 쪽에서 한다
#[tauri::command]
pub async fn home_fetch_effr() -> Result<String, String> {
    if crate::data::external_blocked() {
        return Err("점검용 실행에서는 외부 서버를 부르지 않습니다.".into());
    }
    let response = client()?.get(effr_url(today())).send().await.map_err(|e| format!("금리 자료를 받지 못했습니다: {e}"))?;
    read_text(response, "금리 자료").await
}

#[cfg(test)]
#[path = "tests/home.rs"]
mod tests;
