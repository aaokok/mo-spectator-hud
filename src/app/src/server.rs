use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Form, Path as AxumPath, Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, LOCATION};
use axum::http::{HeaderName, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;
use tokio_stream::StreamExt as _;

use crate::config::{safe_join, AppState, CtrlState};

/// 绑定 127.0.0.1:8770，占用则 +1 最多到 8790（06-架构 §2）
pub fn start(state: Arc<AppState>) -> Result<u16, String> {
    for port in 8770..=8790 {
        match try_bind(port, state.clone()) {
            Ok(()) => {
                state.set_port(port);
                state.log(format!("HTTP 服务就绪: http://127.0.0.1:{port}"));
                return Ok(port);
            }
            Err(_) => state.log(format!("端口 {port} 被占用，尝试下一个")),
        }
    }
    Err("端口 8770-8790 全部被占用".into())
}

fn try_bind(port: u16, state: Arc<AppState>) -> Result<(), String> {
    let listener = tauri::async_runtime::block_on(async {
        tokio::net::TcpListener::bind(("127.0.0.1", port)).await
    })
    .map_err(|e| e.to_string())?;

    let router = Router::new()
        .route("/", get(index))
        .route("/index.html", get(index))
        .route("/overlay", get(overlay_redirect))
        .route("/control", get(control_page))
        .route("/favicon.ico", get(favicon))
        .route("/control/state", get(control_state))
        .route("/control/set", post(control_set))
        .route("/ui/{*path}", get(ui_file))
        .route("/state/{*path}", get(state_file))
        .route("/icons/{*path}", get(icon_file))
        .route("/cursor/sse", get(cursor_sse))
        .route("/cursor/regions", post(cursor_regions))
        .route("/probe", post(probe_ok))
        .route("/probe-error", post(probe_err))
        .route("/envcheck", get(envcheck))
        .route("/app/status", get(app_status))
        .route("/app/log", get(app_log))
        .route("/app/summary", get(app_summary))
        .route("/app/overlay", post(app_overlay))
        .route("/app/gamepath", post(app_gamepath))
        .route("/app/bridge/restart", post(bridge_restart))
        .route("/app/hotkeys", post(app_hotkeys))
        .route("/{*path}", get(static_file))
        .with_state(state);

    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("HTTP 服务退出: {e}");
        }
    });
    Ok(())
}

// ---------- 静态资源 ----------

async fn index(State(st): State<Arc<AppState>>) -> Response {
    serve_file(&st.paths.demo_root, "index.html", "no-cache", &[]).await
}

async fn control_page(State(st): State<Arc<AppState>>) -> Response {
    serve_file(&st.paths.app_root, "control.html", "no-cache", &[]).await
}

/// 空 favicon：WebView2 默认会请求，返回 204 避免控制台出现的 404 噪音
async fn favicon() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

/// R16 `/ui/<rel>`：控制台自身的 css/js 等资源（app_root 下），
/// 让 control.html 可以拆分成 html/css/js 而不是单文件内联。
/// 白名单扩展名 + safe_join 双保险，不会越出 hud/ 目录。
async fn ui_file(State(st): State<Arc<AppState>>, AxumPath(path): AxumPath<String>) -> Response {
    serve_file(
        &st.paths.app_root,
        &path,
        "no-cache",
        &["css", "js", "html", "png", "svg", "woff2", "woff", "ttf"],
    )
    .await
}

/// 其余路径 = Demo 静态文件（06-架构 §3：`GET /<其它>`），no-cache 改完刷新即生效
async fn static_file(State(st): State<Arc<AppState>>, AxumPath(path): AxumPath<String>) -> Response {
    serve_file(&st.paths.demo_root, &path, "no-cache", &[]).await
}

/// /state/<rel>：工具包目录内，限 .json/.txt，防穿越，no-store（06-架构 §3）
async fn state_file(
    State(st): State<Arc<AppState>>,
    AxumPath(path): AxumPath<String>,
) -> Response {
    serve_file(&st.paths.toolkit_dir, &path, "no-store", &["json", "txt"]).await
}

/// /icons/<rel>：工具包 icons/，immutable（R7.13 缓存分级）
async fn icon_file(
    State(st): State<Arc<AppState>>,
    AxumPath(path): AxumPath<String>,
) -> Response {
    serve_file(&st.paths.icons_dir(), &path, "public, max-age=86400, immutable", &[]).await
}

/// R13 /cursor/sse：光标指示器事件流（cursor.rs 采样线程广播；
/// 无订阅者时采样线程零流量；连接断开自动结束）
async fn cursor_sse(State(st): State<Arc<AppState>>) -> Response {
    let rx = st.cursor_tx.subscribe();
    let stream = tokio_stream::wrappers::BroadcastStream::new(rx)
        .filter_map(|r| r.ok())
        .map(|data| Ok::<_, std::convert::Infallible>(Event::default().data(data)));
    Sse::new(stream)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(5))
                .text("keep-alive"),
        )
        .into_response()
}

/// R23 /cursor/regions：覆盖层上报遮盖面板矩形（CSS px，覆盖层客户区坐标）。
/// 采样线程据此只在"指针压到面板上"时才推坐标；没上报/已陈旧则退回常亮。
/// 前端在布局变化后 POST 一次，body 为 {"rects":[[x,y,w,h],...]}。
async fn cursor_regions(
    State(st): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let mut rects = Vec::new();
    if let Some(arr) = body["rects"].as_array() {
        for item in arr.iter().take(64) {
            let Some(q) = item.as_array() else { continue };
            if q.len() != 4 {
                continue;
            }
            let (Some(x), Some(y), Some(w), Some(h)) = (
                q[0].as_f64(),
                q[1].as_f64(),
                q[2].as_f64(),
                q[3].as_f64(),
            ) else {
                continue;
            };
            // 只接受有限的、非负尺寸的矩形；脏数据直接丢弃，宁可少判不误判
            if !x.is_finite() || !y.is_finite() || !w.is_finite() || !h.is_finite() {
                continue;
            }
            if w <= 0.0 || h <= 0.0 {
                continue;
            }
            rects.push((x, y, w, h));
        }
    }
    let n = rects.len();
    *st.cursor_regions.lock().unwrap() = Some(crate::config::CursorRegions {
        rects,
        at: Some(std::time::Instant::now()),
    });
    (StatusCode::OK, no_store(), Json(json!({ "ok": true, "count": n }))).into_response()
}

async fn serve_file(root: &Path, rel: &str, cache: &'static str, allow: &[&str]) -> Response {
    let Some(p) = safe_join(root, rel) else {
        return text_resp(StatusCode::FORBIDDEN, "403 forbidden");
    };
    if !p.is_file() {
        return text_resp(StatusCode::NOT_FOUND, "404 not found");
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !allow.is_empty() && !allow.contains(&ext.as_str()) {
        return text_resp(StatusCode::FORBIDDEN, "403 ext not allowed");
    }
    let mime = mime_of(&ext);
    match tokio::fs::read(&p).await {
        Ok(body) => (
            StatusCode::OK,
            [(CONTENT_TYPE, mime), (CACHE_CONTROL, cache)],
            body,
        )
            .into_response(),
        Err(_) => text_resp(StatusCode::INTERNAL_SERVER_ERROR, "500 read error"),
    }
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" | "log" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn text_resp(code: StatusCode, body: &str) -> Response {
    (
        code,
        [(CONTENT_TYPE, "text/plain; charset=utf-8")],
        body.to_string(),
    )
        .into_response()
}

fn no_store() -> [(HeaderName, &'static str); 1] {
    [(CACHE_CONTROL, "no-store")]
}

// ---------- /overlay 302（保留调用方参数，只补默认） ----------

async fn overlay_redirect(
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let defaults = [
        ("local", "1"),
        ("source", "live"),
        ("url", "/state/out/hud_state.json"),
    ];
    let mut ser = form_urlencoded::Serializer::new(String::new());
    ser.append_pair("overlay", "1");
    for (k, dv) in defaults {
        let v = q.get(k).filter(|s| !s.is_empty()).map(|s| s.as_str()).unwrap_or(dv);
        ser.append_pair(k, v);
    }
    for (k, v) in &q {
        if k == "overlay" || defaults.iter().any(|(dk, _)| dk == k) {
            continue;
        }
        ser.append_pair(k, v);
    }
    let target = format!("/?{}", ser.finish());
    (StatusCode::FOUND, [(LOCATION, target)]).into_response()
}

// ---------- /probe ----------

async fn probe_ok(State(st): State<Arc<AppState>>, body: Bytes) -> Response {
    append_probe(&st, false, &body).await
}
async fn probe_err(State(st): State<Arc<AppState>>, body: Bytes) -> Response {
    append_probe(&st, true, &body).await
}

async fn append_probe(st: &Arc<AppState>, err: bool, body: &[u8]) -> Response {
    use tokio::io::AsyncWriteExt;
    let p = st.paths.probe_log(err);
    let mut line = String::from_utf8_lossy(body).to_string();
    if !line.ends_with('\n') {
        line.push('\n');
    }
    if let Ok(mut f) = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
        .await
    {
        let _ = f.write_all(line.as_bytes()).await;
    }
    StatusCode::NO_CONTENT.into_response()
}

// ---------- /control ----------

async fn control_state(State(st): State<Arc<AppState>>) -> Response {
    let ctrl = st.ctrl.lock().unwrap().clone();
    (StatusCode::OK, no_store(), Json(ctrl)).into_response()
}

async fn control_set(
    State(st): State<Arc<AppState>>,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    {
        let mut ctrl = st.ctrl.lock().unwrap();
        apply_form(&mut ctrl, &form);
        if let Err(e) = ctrl.save(&st.paths.demo_root) {
            st.log(format!("_control.json 落盘失败: {e}"));
        }
        let snap = ctrl.clone();
        drop(ctrl);
        st.log(format!(
            "控制状态更新: show_score={} show_units={} show_queues={} gate={} name={:?} {}:{} mode={:?} yield_tl={} hide_blur={} ovr={}B hid={}B tags={}B cmode={:?} cursor_ind={} prio={:?} wait_hint={} hide_q_menu={} cursor_covered_only={}",
            snap.show_score,
            snap.show_units,
            snap.show_queues,
            snap.observer_gate,
            snap.match_name,
            snap.score_l,
            snap.score_r,
            snap.mode_label,
            snap.yield_top_left,
            snap.auto_hide_on_blur,
            snap.unit_icon_overrides.len(),
            snap.hidden_units.len(),
            snap.hidden_tags.len(),
            snap.hidden_count_mode,
            snap.cursor_indicator,
            snap.unit_priority,
            snap.show_wait_hint,
            snap.hide_queue_on_menu,
            snap.cursor_only_when_covered
        ));
        (StatusCode::OK, no_store(), Json(snap)).into_response()
    }
}

fn apply_form(ctrl: &mut CtrlState, form: &HashMap<String, String>) {
    let truthy = |v: &str| matches!(v, "1" | "true" | "on" | "yes");
    let falsy = |v: &str| matches!(v, "0" | "false" | "off" | "no" | "");
    if let Some(v) = form.get("show_score") {
        if truthy(v) || falsy(v) {
            ctrl.show_score = truthy(v);
        }
    }
    if let Some(v) = form.get("show_units") {
        if truthy(v) || falsy(v) {
            ctrl.show_units = truthy(v);
        }
    }
    if let Some(v) = form.get("show_queues") {
        if truthy(v) || falsy(v) {
            ctrl.show_queues = truthy(v);
        }
    }
    if let Some(v) = form.get("observer_gate") {
        if truthy(v) || falsy(v) {
            ctrl.observer_gate = truthy(v);
        }
    }
    if let Some(v) = form.get("yield_top_left") {
        if truthy(v) || falsy(v) {
            ctrl.yield_top_left = truthy(v);
        }
    }
    if let Some(v) = form.get("auto_hide_on_blur") {
        if truthy(v) || falsy(v) {
            ctrl.auto_hide_on_blur = truthy(v);
        }
    }
    if let Some(v) = form.get("match_name") {
        ctrl.match_name = v.clone();
    }
    if let Some(v) = form.get("mode_label") {
        ctrl.mode_label = v.clone();
    }
    // R12 单位自定义：三个 JSON 串（对象/数组/数组）只存合法 JSON，空串 = 清空
    if let Some(v) = form.get("unit_icon_overrides") {
        let ok = v.trim().is_empty()
            || serde_json::from_str::<serde_json::Value>(v)
                .map(|j| j.is_object())
                .unwrap_or(false);
        if ok {
            ctrl.unit_icon_overrides = v.clone();
        }
    }
    let json_array = |v: &str| {
        v.trim().is_empty()
            || serde_json::from_str::<serde_json::Value>(v)
                .map(|j| j.is_array())
                .unwrap_or(false)
    };
    if let Some(v) = form.get("hidden_units") {
        if json_array(v) {
            ctrl.hidden_units = v.clone();
        }
    }
    if let Some(v) = form.get("hidden_tags") {
        if json_array(v) {
            ctrl.hidden_tags = v.clone();
        }
    }
    if let Some(v) = form.get("hidden_count_mode") {
        if v == "keep" || v == "drop" {
            ctrl.hidden_count_mode = v.clone();
        }
    }
    if let Some(v) = form.get("cursor_indicator") {
        if truthy(v) || falsy(v) {
            ctrl.cursor_indicator = truthy(v);
        }
    }
    if let Some(v) = form.get("unit_priority") {
        if crate::config::valid_priority_json(v) {
            ctrl.unit_priority = v.clone();
        }
    }
    // R22：两个 UI 行为开关（等待提示 / Esc 菜单隐藏队列）
    for (key, dst) in [
        ("show_wait_hint", &mut ctrl.show_wait_hint),
        ("hide_queue_on_menu", &mut ctrl.hide_queue_on_menu),
        ("cursor_only_when_covered", &mut ctrl.cursor_only_when_covered),
    ] {
        if let Some(v) = form.get(key) {
            if truthy(v) || falsy(v) {
                *dst = truthy(v);
            }
        }
    }
    if let Some(v) = form.get("score_l") {
        if let Ok(n) = v.parse() {
            ctrl.score_l = n;
        }
    }
    if let Some(v) = form.get("score_r") {
        if let Ok(n) = v.parse() {
            ctrl.score_r = n;
        }
    }
}

// ---------- /envcheck ----------

async fn envcheck(State(st): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let force = q.get("force").map(|v| v == "1" || v == "true").unwrap_or(false);
    let cached = if force {
        None
    } else {
        st.env_cache.lock().unwrap().as_ref().and_then(|(t, r)| {
            if t.elapsed().as_secs() < 10 {
                Some(r.clone())
            } else {
                None
            }
        })
    };
    let reports = match cached {
        Some(r) => r,
        None => {
            let r = crate::envcheck::run(&st.paths, st.port());
            *st.env_cache.lock().unwrap() = Some((std::time::Instant::now(), r.clone()));
            r
        }
    };
    (StatusCode::OK, no_store(), Json(json!({ "checks": reports }))).into_response()
}

// ---------- /app/* ----------

async fn app_status(State(st): State<Arc<AppState>>) -> Response {
    let game_state = read_state_meta(&st.paths.state_json());
    let ini = st.ini.lock().unwrap().clone();
    let bridge = st.bridge.lock().unwrap();
    let hotkey = st.hotkey_status.lock().unwrap().clone();
    let body = json!({
        "port": st.port(),
        "interval_ms": ini.interval_ms,
        "overlay": {
            "visible": st.ov_visible.load(Ordering::Relaxed),
            "topmost": st.ov_topmost.load(Ordering::Relaxed),
            // R16：真实可见 = visible && !auto_hidden；显隐按钮/状态条靠这三项判三态
            "auto_hidden": st.ov_auto_hidden.load(Ordering::Relaxed),
            "pinned": st.ov_user_pin.load(Ordering::Relaxed),
            "game_found": *st.game_hwnd.lock().unwrap() != 0,
        },
        "hotkeys": {
            "enabled": hotkey.enabled,
            "ok": hotkey.ok,
            "error": hotkey.error,
            "visible": ini.hotkey_visible,
            "topmost": ini.hotkey_topmost,
        },
        "bridge": {
            "ours": bridge.ours,
            "running": bridge.running,
            "restarts": bridge.restarts,
            "external": bridge.external,
        },
        "game_state": game_state,
    });
    (StatusCode::OK, no_store(), Json(body)).into_response()
}

async fn app_log(State(st): State<Arc<AppState>>) -> Response {
    let q = st.log.lock().unwrap();
    let tail: Vec<String> = q.iter().rev().take(200).rev().cloned().collect();
    (StatusCode::OK, no_store(), Json(json!({ "lines": tail }))).into_response()
}

/// R16 `/app/summary`：控制台总览用的轻量对局摘要。
/// hud_state.json 含全部 unit_types/queues（1 MB+），控制台只用得着地图/进度/四人战绩，
/// 这里在 Rust 侧裁剪后返回，避免前端每 2 秒拉整份状态。
async fn app_summary(State(st): State<Arc<AppState>>) -> Response {
    let p = st.paths.state_json();
    let Ok(txt) = tokio::fs::read_to_string(&p).await else {
        return (StatusCode::OK, no_store(), Json(json!({ "present": false }))).into_response();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
        return (StatusCode::OK, no_store(), Json(json!({ "present": false }))).into_response();
    };

    let players: Vec<serde_json::Value> = v["players"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|p| !p["is_observer_house"].as_bool().unwrap_or(false))
                .map(|p| {
                    let flags = &p["flags"];
                    json!({
                        "slot": p["slot"],
                        "name": p["name"].as_str().unwrap_or(""),
                        "uiname": p["uiname"].as_str().unwrap_or(""),
                        "faction": p["faction"].as_str().unwrap_or(""),
                        "country": p["country"].as_str().unwrap_or(""),
                        "team": p["team"],
                        "color": p["color"],
                        "human": p["human"],
                        "cash": p["cash"],
                        "kills": p["kills"],
                        "army": p["owned"],
                        "status": player_status(flags),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let mtime = std::fs::metadata(&p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    (StatusCode::OK, no_store(), Json(json!({
        "present": true,
        "mtime_ms": mtime,
        "phase": v["phase"],
        "paused": v["paused"],
        "out_of_sync": v["out_of_sync"],
        "elapsed_sec": v["elapsed_sec"],
        "map": v["map"],
        "game_mode": v["game_mode"],
        "players_in_session": v["players_in_session"],
        "observer": v["observer"],
        "screen": {
            "valid": v["screen"]["valid"],
            "width": v["screen"]["width"],
            "height": v["screen"]["height"],
            "sidebar_side": v["screen"]["sidebar_side"],
        },
        "players": players,
    })))
    .into_response()
}

/// 玩家状态：优先掉线/投降等负向标记，其次胜/负，其余在线。
fn player_status(flags: &serde_json::Value) -> &'static str {
    let t = |k: &str| flags[k].as_i64().unwrap_or(0) != 0;
    if t("lostconn") {
        "lostconn"
    } else if t("resigned") || t("gaveup") {
        "resigned"
    } else if t("defeated") || t("lose") {
        "defeated"
    } else if t("win") {
        "win"
    } else {
        "online"
    }
}

#[derive(Deserialize)]
struct OverlayReq {
    visible: Option<bool>,
    topmost: Option<bool>,
    /// R16：控制台点「显示」时置真，临时压过失焦自动隐藏（游戏回前台自动清）
    pin: Option<bool>,
}

async fn app_overlay(State(st): State<Arc<AppState>>, Json(req): Json<OverlayReq>) -> Response {
    if let Some(v) = req.visible {
        st.ov_visible.store(v, Ordering::Relaxed);
        st.log(format!("覆盖窗口显隐 -> {v}"));
    }
    if let Some(t) = req.topmost {
        st.ov_topmost.store(t, Ordering::Relaxed);
        let mut ini = st.ini.lock().unwrap();
        ini.overlay_topmost = t;
        let _ = ini.save(&st.paths.ini);
        st.log(format!("覆盖窗口置顶 -> {t}"));
    }
    if let Some(p) = req.pin {
        st.ov_user_pin.store(p, Ordering::Relaxed);
        st.log(format!("覆盖窗口钉住 -> {p}"));
    }
    crate::shell::apply_overlay_flags(&st);
    app_status(State(st)).await
}

#[derive(Deserialize)]
struct GamePathReq {
    path: String,
}

async fn app_gamepath(State(st): State<Arc<AppState>>, Json(req): Json<GamePathReq>) -> Response {
    {
        let mut ini = st.ini.lock().unwrap();
        ini.game_dir = req.path.trim().trim_matches('"').to_string();
        let _ = ini.save(&st.paths.ini);
    }
    *st.env_cache.lock().unwrap() = None;
    st.log("游戏目录已更新（观战环境检测缓存已失效）");
    (StatusCode::OK, no_store(), Json(json!({ "ok": true }))).into_response()
}

#[derive(Deserialize)]
struct RestartReq {
    interval: u32,
}

async fn bridge_restart(State(st): State<Arc<AppState>>, Json(req): Json<RestartReq>) -> Response {
    let interval = req.interval.clamp(100, 5000);
    {
        let mut ini = st.ini.lock().unwrap();
        ini.interval_ms = interval;
        let _ = ini.save(&st.paths.ini);
    }
    crate::bridge::restart_with_interval(&st, interval);
    (StatusCode::OK, no_store(), Json(json!({ "ok": true, "interval": interval }))).into_response()
}

#[derive(Deserialize)]
struct HotkeyReq {
    enabled: Option<bool>,
    visible: Option<String>,
    topmost: Option<String>,
}

/// R16：热键开关 / 改键（写 ini → 重装 → 回最新状态）
async fn app_hotkeys(State(st): State<Arc<AppState>>, Json(req): Json<HotkeyReq>) -> Response {
    let status = crate::shell::update_hotkeys(&st, req.enabled, req.visible, req.topmost);
    let ini = st.ini.lock().unwrap().clone();
    (StatusCode::OK, no_store(), Json(json!({
        "enabled": status.enabled,
        "ok": status.ok,
        "error": status.error,
        "visible": ini.hotkey_visible,
        "topmost": ini.hotkey_topmost,
    }))).into_response()
}

// ---------- 工具 ----------

/// 读 hud_state.json 的顶层状态（不解析 players，只取桥状态）
fn read_state_meta(p: &Path) -> serde_json::Value {
    let Ok(txt) = std::fs::read_to_string(p) else {
        return json!({ "present": false });
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
        return json!({ "present": false });
    };
    let mtime = std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        })
        .unwrap_or(0);
    json!({
        "present": true,
        "ok": v["ok"],
        "phase": v["phase"],
        "client_running": v["client_running"],
        "frame": v["frame"],
        "paused": v["paused"],
        "mtime_ms": mtime,
    })
}
