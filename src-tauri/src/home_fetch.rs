//! 홈 사용자 위젯의 외부 자료 받기 — 위젯 정의(`home.json`의 `sources`)가 적은 공개 주소(https, GET)를 대신 받아 글만 넘긴다.
//!
//! 웹뷰 CSP를 풀지 않으려고 Rust가 받는다. 키·토큰·로그인이 필요한 서비스는 지원하지 않는다(헤더·본문·인증 없음, 쿠키 저장소 없음).
//! 규칙: https·기본 포트·도메인 주소만(IP 직접 입력 불가), 이름을 먼저 풀어 루프백·사설망·링크 로컬 등이면 거부하고 확인한 주소로만 접속(DNS 바꿔치기 방지),
//! 리다이렉트는 따르지 않음, 응답 1MB·10초·글 형식만, 같은 주소는 15분 메모리 캐시, 실제 요청은 시간당 60회까지.
//! 저장된 홈에서 쓰는 도메인만 받을 수 있고(미리보기는 예외 — [추가]가 승인), 점검용 실행(AIWORKSPACE_DATA_DIR)에서는 거부한다(그 호출을 확인하려는 점검만 AIWS_ALLOW_EXTERNAL=1로 푼다).
//! 응답 본문과 요청 주소는 로그에 남기지 않는다.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::Url;
use serde::Deserialize;
use tauri::AppHandle;

use crate::data;

const MAX_BYTES: usize = 1_048_576;
const TIMEOUT: Duration = Duration::from_secs(10);
/// 일부 서버(FRED의 Akamai 등)는 이름만 있는 User-Agent("AIWorkspace")를 받으면 응답하지 않아, 버전과 저장소 주소를 붙인다
const USER_AGENT: &str = concat!("AIWorkspace/", env!("CARGO_PKG_VERSION"), " (+https://github.com/Miso-Nomika/AIWorkspace)");
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const HOUR: Duration = Duration::from_secs(3600);
const HOURLY_LIMIT: usize = 60;
const MAX_CACHE: usize = 100;
const MAX_URL: usize = 500;
const MAX_QUERY: usize = 10;
const TEST_MESSAGE: &str = "점검용 실행에서는 외부 서버를 부르지 않습니다.";

#[derive(Deserialize)]
pub struct FetchRequest {
    url: String,
    #[serde(default)]
    query: BTreeMap<String, String>,
    /// 미리보기(아직 홈에 저장되지 않은 위젯)인지
    #[serde(default)]
    preview: bool,
}

/// 인증 정보로 보이는 이름 (위젯 정의 검사와 같은 규칙)
fn secret_like(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    matches!(n.as_str(), "authorization" | "proxy-authorization" | "cookie") || ["key", "token", "secret", "passw"].iter().any(|w| n.contains(w))
}

/// 요청 주소를 검사해 최종 주소로 만든다: https·기본 포트·도메인(IP 직접 입력·localhost 불가)·아이디/비밀번호 없음, 쿼리는 이름순으로 덧붙임
pub(crate) fn build_url(url: &str, query: &BTreeMap<String, String>) -> Result<Url, String> {
    if url.len() > MAX_URL {
        return Err("주소가 너무 깁니다.".into());
    }
    let mut parsed = Url::parse(url).map_err(|_| "주소 형식이 올바르지 않습니다.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("https 주소만 받을 수 있습니다.".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("아이디·비밀번호가 든 주소는 받을 수 없습니다.".into());
    }
    if parsed.port().is_some_and(|p| p != 443) {
        return Err("기본 포트(443)가 아닌 주소는 받을 수 없습니다.".into());
    }
    match parsed.domain() {
        Some(d) if d != "localhost" && !d.ends_with(".localhost") => {}
        _ => return Err("도메인 주소만 받을 수 있습니다 (숫자 주소·localhost 불가).".into()),
    }
    if parsed.query_pairs().any(|(k, _)| secret_like(&k)) || query.keys().any(|k| secret_like(k)) {
        return Err("인증 정보(key·token 등)가 든 주소는 받을 수 없습니다 (키가 필요 없는 공개 API만).".into());
    }
    if query.len() > MAX_QUERY || query.iter().any(|(k, v)| k.len() > 40 || v.len() > 200) {
        return Err("쿼리가 너무 많거나 깁니다.".into());
    }
    if !query.is_empty() {
        let mut pairs = parsed.query_pairs_mut();
        for (k, v) in query {
            pairs.append_pair(k, v);
        }
    }
    parsed.set_fragment(None);
    Ok(parsed)
}

fn v4_blocked(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || (o[0] == 100 && (64..=127).contains(&o[1])) // 100.64.0.0/10 (통신사 공유 주소)
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0.0/24
        || (o[0] == 192 && o[1] == 0 && o[2] == 2) // 문서용
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19)) // 198.18.0.0/15
        || (o[0] == 198 && o[1] == 51 && o[2] == 100)
        || (o[0] == 203 && o[1] == 0 && o[2] == 113)
        || o[0] >= 240 // 예약
}

fn v6_blocked(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return v4_blocked(v4);
    }
    let s = ip.segments();
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (s[0] & 0xfe00) == 0xfc00 // fc00::/7 고유 로컬
        || (s[0] & 0xffc0) == 0xfe80 // fe80::/10 링크 로컬
        || (s[0] == 0x2001 && s[1] == 0x0db8) // 문서용
        || (s[0] == 0x0064 && s[1] == 0xff9b) // NAT64 (IPv4가 들어 있음)
        || s[0] == 0x2002 // 6to4 (IPv4가 들어 있음)
        || (s[0] == 0 && s[1] == 0 && s[2] == 0 && s[3] == 0 && s[4] == 0) // ::/80 (호환 주소 포함)
}

/// 이 PC·사설망·예약 대역 주소인지 (받으면 안 되는 곳)
pub(crate) fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v4_blocked(v),
        IpAddr::V6(v) => v6_blocked(v),
    }
}

/// 저장된 home.json 글에서 어떤 사용자 위젯이든 이 도메인을 소스로 쓰는지
pub(crate) fn host_allowed(home_json: &str, host: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(home_json) else { return false };
    let Some(items) = value.get("items").and_then(|v| v.as_array()) else { return false };
    items.iter().any(|item| {
        item.get("def")
            .and_then(|d| d.get("sources"))
            .and_then(|s| s.as_array())
            .is_some_and(|sources| sources.iter().any(|s| s.get("url").and_then(|u| u.as_str()).and_then(|u| Url::parse(u).ok()).and_then(|u| u.host_str().map(|h| h.eq_ignore_ascii_case(host))).unwrap_or(false)))
    })
}

/// 최근 한 시간 안의 실제 요청 횟수 제한
#[derive(Default)]
pub(crate) struct Limiter {
    times: VecDeque<Instant>,
}

impl Limiter {
    pub(crate) fn allow(&mut self, now: Instant, limit: usize) -> bool {
        while self.times.front().is_some_and(|t| now.duration_since(*t) >= HOUR) {
            self.times.pop_front();
        }
        if self.times.len() >= limit {
            return false;
        }
        self.times.push_back(now);
        true
    }
}

/// 받아도 되는 응답 형식인지 (JSON·글·CSV·XML/RSS). 형식 표시가 없으면 통과
pub(crate) fn content_type_ok(value: &str) -> bool {
    let v = value.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    v.is_empty() || v.starts_with("text/") || v == "application/json" || v == "application/xml" || v == "application/csv" || v.ends_with("+json") || v.ends_with("+xml")
}

#[derive(Default)]
struct State {
    cache: HashMap<String, (Instant, String)>,
    limiter: Limiter,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}

/// 주소 하나를 받는다 (정책은 호출한 쪽이 이미 확인). resolved가 있으면 그 주소로만 접속하고, 리다이렉트는 따르지 않는다
pub(crate) async fn fetch_with(url: &Url, resolved: Option<SocketAddr>) -> Result<String, String> {
    fetch_limited(url, resolved, MAX_BYTES).await
}

/// fetch_with와 같고 응답 크기 상한만 정한다 (경계 확인을 작은 본문으로 하려고 나눴다)
pub(crate) async fn fetch_limited(url: &Url, resolved: Option<SocketAddr>, max_bytes: usize) -> Result<String, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let mut builder = reqwest::Client::builder().timeout(TIMEOUT).redirect(reqwest::redirect::Policy::none()).user_agent(USER_AGENT);
    if let (Some(addr), Some(host)) = (resolved, url.host_str()) {
        builder = builder.resolve(host, addr);
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    let mut response = client
        .get(url.clone())
        .header(reqwest::header::ACCEPT, "application/json, text/csv, application/xml;q=0.9, text/*;q=0.8")
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "시간이 초과되었습니다 (10초).".to_string() } else { "연결하지 못했습니다.".to_string() })?;
    let status = response.status();
    if status.is_redirection() {
        return Err(format!("다른 주소로 넘기는 응답(HTTP {})은 따라가지 않습니다.", status.as_u16()));
    }
    if !status.is_success() {
        return Err(format!("받지 못했습니다 (HTTP {}).", status.as_u16()));
    }
    let content_type = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if !content_type_ok(&content_type) {
        return Err("글·JSON·CSV·XML 형식이 아닌 응답은 받지 않습니다.".into());
    }
    if response.content_length().is_some_and(|n| n as usize > max_bytes) {
        return Err("응답이 너무 큽니다 (1MB 초과).".into());
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "응답을 읽지 못했습니다.".to_string())? {
        if body.len() + chunk.len() > max_bytes {
            return Err("응답이 너무 큽니다 (1MB 초과).".into());
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| "UTF-8 글이 아닌 응답은 읽을 수 없습니다.".to_string())
}

/// 이름을 먼저 풀어 받으면 안 되는 주소(이 PC·사설망 등)가 하나라도 있으면 거부하고, 확인한 주소로만 접속해 받는다
pub(crate) async fn fetch_public(url: &Url) -> Result<String, String> {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 443)).await.map_err(|_| "주소를 찾지 못했습니다.".to_string())?.collect();
    if addrs.is_empty() {
        return Err("주소를 찾지 못했습니다.".into());
    }
    if addrs.iter().any(|a| is_blocked_ip(a.ip())) {
        return Err("이 PC나 사설망으로 연결되는 주소는 받을 수 없습니다.".into());
    }
    fetch_with(url, Some(addrs[0])).await
}

#[tauri::command]
pub async fn home_fetch(app: AppHandle, request: FetchRequest) -> Result<String, String> {
    if data::external_blocked() {
        return Err(TEST_MESSAGE.into());
    }
    let url = build_url(&request.url, &request.query)?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if !request.preview {
        let home = std::fs::read_to_string(data::base_dir(&app)?.join("data").join("home.json")).unwrap_or_default();
        if !host_allowed(&home, &host) {
            return Err("저장된 홈의 위젯이 쓰는 주소가 아닙니다.".into());
        }
    }
    let key = url.as_str().to_string();
    let now = Instant::now();
    {
        let mut st = state().lock().map_err(|_| "내부 오류".to_string())?;
        if let Some((at, text)) = st.cache.get(&key) {
            if now.duration_since(*at) < CACHE_TTL {
                return Ok(text.clone());
            }
        }
        if !st.limiter.allow(now, HOURLY_LIMIT) {
            return Err(format!("외부 자료를 받는 횟수 상한(시간당 {HOURLY_LIMIT}회)에 도달했습니다. 잠시 뒤 다시 시도됩니다."));
        }
    }
    let text = fetch_public(&url).await?;
    let mut st = state().lock().map_err(|_| "내부 오류".to_string())?;
    if st.cache.len() >= MAX_CACHE {
        let cutoff = Instant::now();
        st.cache.retain(|_, (at, _)| cutoff.duration_since(*at) < CACHE_TTL);
        if st.cache.len() >= MAX_CACHE {
            if let Some(oldest) = st.cache.iter().min_by_key(|(_, (at, _))| *at).map(|(k, _)| k.clone()) {
                st.cache.remove(&oldest);
            }
        }
    }
    st.cache.insert(key, (Instant::now(), text.clone()));
    Ok(text)
}

#[cfg(test)]
#[path = "tests/home_fetch.rs"]
mod tests;
