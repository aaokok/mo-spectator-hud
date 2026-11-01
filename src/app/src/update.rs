//! GitHub Release 检查（仅查询，不下载、不安装）。
//!
//! 用系统 WinHTTP：走 schannel，不新增 TLS/HTTP crate；GitHub API 强制要求 UA。
//! 只读 GET，超时上限 10 秒；响应体上限 256 KB，避免异常内容撑爆日志与内存。

use std::ffi::c_void;

use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Networking::WinHttp::*;

pub const REPO: &str = "aaokok/mo-spectator-hud";
pub const API_HOST: &str = "api.github.com";
const UA: &str = concat!("mo-spectator-hud/", env!("CARGO_PKG_VERSION"));
const MAX_BODY: usize = 256 * 1024;

/// WinHTTP 句柄在 Drop 时按逆序关闭，任一步失败不会泄漏。
struct Session(*mut c_void);
struct Connection(*mut c_void);
struct Request(*mut c_void);

impl Drop for Request {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { WinHttpCloseHandle(self.0) };
        }
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { WinHttpCloseHandle(self.0) };
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { WinHttpCloseHandle(self.0) };
        }
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn open(repo: &str) -> Result<(Session, Connection, Request), String> {
    unsafe {
        let session = WinHttpOpen(
            wide(UA).as_ptr(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            std::ptr::null(),
            std::ptr::null(),
            0,
        );
        if session.is_null() {
            return Err(format!("WinHttpOpen 失败（{}）", GetLastError()));
        }
        let session = Session(session);
        // 连接 5 秒、收发 8 秒；DNS 也受连接超时约束。
        let _ = WinHttpSetTimeouts(session.0, 5000, 5000, 8000, 8000);
        let host = wide(API_HOST);
        let conn = WinHttpConnect(session.0, host.as_ptr(), INTERNET_DEFAULT_HTTPS_PORT, 0);
        if conn.is_null() {
            return Err(format!("无法连接 {API_HOST}（{}）", GetLastError()));
        }
        let conn = Connection(conn);
        let path = wide(&format!("/repos/{repo}/releases/latest"));
        let request = WinHttpOpenRequest(
            conn.0,
            wide("GET").as_ptr(),
            path.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            WINHTTP_FLAG_SECURE,
        );
        if request.is_null() {
            return Err(format!("WinHttpOpenRequest 失败（{}）", GetLastError()));
        }
        let request = Request(request);
        let headers = wide("Accept: application/vnd.github+json\r\nX-GitHub-Api-Version: 2022-11-28\r\n");
        if WinHttpSendRequest(
            request.0,
            headers.as_ptr(),
            (headers.len() - 1) as u32,
            std::ptr::null(),
            0,
            0,
            0,
        ) == 0
        {
            return Err(format!("请求 GitHub 失败（{}）", GetLastError()));
        }
        if WinHttpReceiveResponse(request.0, std::ptr::null_mut()) == 0 {
            return Err(format!("等待 GitHub 响应超时或中断（{}）", GetLastError()));
        }
        Ok((session, conn, request))
    }
}

fn status_code(request: *mut c_void) -> Result<u32, String> {
    let mut code: u32 = 0;
    let mut len = std::mem::size_of::<u32>() as u32;
    let ok = unsafe {
        WinHttpQueryHeaders(
            request,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            std::ptr::null(),
            &mut code as *mut u32 as *mut c_void,
            &mut len,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(format!("读取 HTTP 状态失败（{}）", unsafe { GetLastError() }));
    }
    Ok(code)
}

/// 读到 EOF 或达到上限；超过上限直接报错，不截断 JSON 后误判。
fn read_body(request: *mut c_void) -> Result<String, String> {
    let mut body: Vec<u8> = Vec::new();
    loop {
        let mut available: u32 = 0;
        if unsafe { WinHttpQueryDataAvailable(request, &mut available) } == 0 {
            return Err(format!("读取响应失败（{}）", unsafe { GetLastError() }));
        }
        if available == 0 {
            break;
        }
        if body.len() + available as usize > MAX_BODY {
            return Err("GitHub 响应超过 256 KB，已中止".into());
        }
        let mut chunk = vec![0u8; available as usize];
        let mut read: u32 = 0;
        if unsafe {
            WinHttpReadData(request, chunk.as_mut_ptr() as *mut c_void, available, &mut read)
        } == 0
        {
            return Err(format!("读取响应失败（{}）", unsafe { GetLastError() }));
        }
        if read == 0 {
            break;
        }
        chunk.truncate(read as usize);
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| "GitHub 响应不是合法 UTF-8".to_string())
}

/// 语义化版本比较：容忍 `v` 前缀与尾部构建号（如 1.2.3-beta.1 按 prerelease 处理）。
/// 无法解析时返回 None，由调用方降级为字符串比较并标注。
fn parse(version: &str) -> Option<semver::Version> {
    semver::Version::parse(version.trim().trim_start_matches(['v', 'V'])).ok()
}

/// true = latest 比 local 新。无法保证顺序时返回 None。
pub fn is_newer(local: &str, latest: &str) -> Option<bool> {
    Some(parse(latest)? > parse(local)?)
}

/// 判断当前平台对应的安装包文件名（NSIS 产物为 `mo_hud_<version>_x64-setup.exe`）。
/// 仅用于区分发布说明里是否有可下载资产，不参与版本判断。
fn pick_asset(names: &[String]) -> Option<String> {
    names
        .iter()
        .find(|n| n.to_ascii_lowercase().ends_with("-setup.exe"))
        .cloned()
}

pub struct Release {
    pub tag: String,
    pub url: String,
    pub published_at: String,
    pub notes: String,
    pub prerelease: bool,
    pub asset: Option<String>,
}

impl Release {
    pub fn from_json(body: &str) -> Result<Release, String> {
        let value: serde_json::Value =
            serde_json::from_str(body).map_err(|e| format!("GitHub 响应解析失败：{e}"))?;
        let tag = value
            .get("tag_name")
            .and_then(|v| v.as_str())
            .ok_or("GitHub 响应缺少 tag_name")?
            .to_string();
        let url = value
            .get("html_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let names: Vec<String> = value
            .get("assets")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|a| a.get("name").and_then(|n| n.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let notes = value
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .take(1200)
            .collect::<String>();
        Ok(Release {
            tag,
            url,
            published_at: value
                .get("published_at")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            notes,
            prerelease: value.get("prerelease").and_then(|v| v.as_bool()).unwrap_or(false),
            asset: pick_asset(&names),
        })
    }
}

/// 查询最新 Release。网络/HTTP/解析错误都以 Err 返回，由路由转成 `ok:false`。
pub fn fetch_latest() -> Result<Release, String> {
    fetch_latest_for(REPO)
}

/// 便于用公开仓库验证整条 WinHTTP 链路；生产只经 [`fetch_latest`] 走 [`REPO`]。
pub fn fetch_latest_for(repo: &str) -> Result<Release, String> {
    let (_session, _conn, request) = open(repo)?;
    let code = status_code(request.0)?;
    match code {
        200 => {}
        403 | 429 => return Err("GitHub 接口限流，请稍后再试".into()),
        404 => return Err("该仓库暂无 Release（或仓库不可见）".into()),
        other => return Err(format!("GitHub 返回 HTTP {other}")),
    }
    Release::from_json(&read_body(request.0)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(tag: &str, prerelease: bool) -> String {
        format!(
            r#"{{"tag_name":"{tag}","html_url":"https://github.com/aaokok/mo-spectator-hud/releases/tag/{tag}","published_at":"2026-11-01T00:00:00Z","body":"notes","prerelease":{prerelease},"assets":[{{"name":"mo_hud_{tag}_x64-setup.exe"}},{{"name":"source.zip"}}]}}"#
        )
    }

    #[test]
    fn compares_versions() {
        assert_eq!(is_newer("0.1.2", "0.2.0"), Some(true));
        assert_eq!(is_newer("0.1.2", "v0.1.2"), Some(false));
        assert_eq!(is_newer("0.1.2", "0.1.10"), Some(true));
        assert_eq!(is_newer("0.1.2", "0.1.1"), Some(false));
        assert_eq!(is_newer("0.1.2", "0.1.2-beta.1"), Some(false));
        assert_eq!(is_newer("0.1.2", "latest"), None);
    }

    #[test]
    fn parses_release_shape() {
        let release = Release::from_json(&sample("v0.2.0", false)).unwrap();
        assert_eq!(release.tag, "v0.2.0");
        assert!(release.url.ends_with("/v0.2.0"));
        assert_eq!(release.asset.as_deref(), Some("mo_hud_v0.2.0_x64-setup.exe"));
        assert!(!release.prerelease);
    }

    #[test]
    fn rejects_missing_tag() {
        assert!(Release::from_json(r#"{"html_url":"x"}"#).is_err());
        assert!(Release::from_json("not json").is_err());
    }

    #[test]
    fn newline_header_is_not_in_url() {
        // 防止把用户可控内容拼进请求头；当前 URL 全为常量。
        assert!(!API_HOST.contains(['\r', '\n']));
        assert!(!REPO.contains(['\r', '\n']));
    }

    /// 真实网络请求，仅在有 `MO_UPDATE_NET_TEST=1` 时执行，避免 CI/离线构建误连外网。
    #[test]
    fn live_release_roundtrip() {
        if std::env::var("MO_UPDATE_NET_TEST").as_deref() != Ok("1") {
            return;
        }
        let release = fetch_latest_for("sharkdp/bat").expect("WinHTTP 应能取到公开 Release");
        assert!(!release.tag.is_empty());
        assert!(release.url.starts_with("https://github.com/"));
    }
}
