//! 窗口、托盘、热键（Tauri shell 层）

use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{App, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::config::AppState;

pub fn setup(app: &App, state: Arc<AppState>, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let _ = state.app.set(app.handle().clone());

    // 控制窗口（普通网页，自管状态走 /app/* + /control/*）
    // R16：加宽到两栏布局（方案 §4），尺寸最小 960×640
    let control_url: tauri::Url = format!("http://127.0.0.1:{port}/control").parse()?;
    WebviewWindowBuilder::new(app.handle(), "control", WebviewUrl::External(control_url))
        .title("MO 观战 HUD · 控制台")
        .inner_size(1180.0, 800.0)
        .min_inner_size(960.0, 640.0)
        .build()?;

    // [M0 spike 结论] 直连最终 URL（302 链路无关紧要，OBS 侧继续走 /overlay）。
    // 覆盖窗口：透明 + 置顶 + 无边框 + 点击穿透；初始隐藏，页面加载完成即显示，
    // 跟随线程负责贴位（gamemd.exe 窗口客户区）。
    // cursorregions=1：只有真实覆盖窗口上报遮盖矩形（R23）。控制台预览 iframe 与
    // OBS 浏览器源用同一个 overlay=1&local=1 形态，若不加这个标记会把小预览框的
    // 矩形覆盖到真实覆盖窗口的判定上。
    let overlay_url: tauri::Url = format!(
        "http://127.0.0.1:{port}/?overlay=1&local=1&cursorregions=1&source=live&url=%2Fstate%2Fout%2Fhud_state.json"
    )
    .parse()?;
    let st_load = state.clone();
    let overlay = WebviewWindowBuilder::new(app.handle(), "overlay", WebviewUrl::External(overlay_url))
        .title("MO HUD 覆盖层")
        .decorations(false)
        .transparent(true)
        .always_on_top(state.ov_topmost.load(Ordering::Relaxed))
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        .focused(false)
        .visible(false)
        .on_page_load(move |w, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                // tao 的 click-through：LAYERED|TRANSPARENT，但必须补 SLWA 才会被渲染
                let _ = w.set_ignore_cursor_events(true);
                if let Ok(h) = w.hwnd() {
                    crate::winutil::layered_commit_visible(h.0 as isize);
                    if st_load.ov_topmost.load(Ordering::Relaxed) {
                        crate::winutil::force_topmost(h.0 as isize);
                    }
                }
                apply_overlay_flags(&st_load);
            }
        })
        .build()?;
    let _ = overlay.set_ignore_cursor_events(true);
    if let Ok(h) = overlay.hwnd() {
        let h = h.0 as isize;
        state.overlay_hwnd.store(h, Ordering::Relaxed);   // R13 光标指示器坐标换算用
        crate::winutil::layered_commit_visible(h);
        if state.ov_topmost.load(Ordering::Relaxed) {
            crate::winutil::force_topmost(h);
        }
    }

    create_tray(app.handle(), port)?;

    // R16：热键默认不注册，按 ini 恢复（可开关、可改键；失败只记状态不崩）
    apply_hotkeys(&state);

    // 数据桥（独立线程：Job 陪葬 + 退避重启）
    {
        let st = state.clone();
        std::thread::spawn(move || crate::bridge::launch(st));
    }
    // 跟随线程
    crate::follow::start(app.handle().clone(), state.clone());
    // R13 光标指示器采样线程（SSE 有订阅者才实际工作）
    crate::cursor::start(state.clone());

    state.log(format!("mo_hud(Tauri) 就绪 · 服务端口 {port}"));
    Ok(())
}

// ---------- 状态应用 ----------

/// 把旗标真正落到窗口上（server 与热键共用）。
/// R10：实际可见 = 用户开关 ov_visible && !(失焦自动隐藏 && !手动钉住)。
pub fn apply_overlay_flags(state: &Arc<AppState>) {
    let pinned = state.ov_user_pin.load(Ordering::Relaxed);
    let effective_auto_hidden = state.ov_auto_hidden.load(Ordering::Relaxed) && !pinned;
    if pinned && state.ov_auto_hidden.load(Ordering::Relaxed) {
        state.ov_auto_hidden.store(false, Ordering::Relaxed);
    }
    if let Some(app) = state.app.get() {
        if let Some(w) = app.get_webview_window("overlay") {
            let v = state.ov_visible.load(Ordering::Relaxed) && !effective_auto_hidden;
            let t = state.ov_topmost.load(Ordering::Relaxed);
            if v {
                let _ = w.show();
            } else {
                let _ = w.hide();
            }
            let _ = w.set_always_on_top(t);
        }
    }
}

fn state_of(app: &AppHandle) -> Arc<AppState> {
    app.state::<Arc<AppState>>().inner().clone()
}

pub fn focus_control(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("control") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn toggle_visible(app: &AppHandle) {
    let st = state_of(app);
    // 按当前实际可见态翻转：无论是手动隐藏还是失焦暂停，一次热键/托盘即立即固定显示；
    // 当前正在显示时，一次即隐藏并清钉。
    let currently_shown = st.ov_visible.load(Ordering::Relaxed)
        && (!st.ov_auto_hidden.load(Ordering::Relaxed) || st.ov_user_pin.load(Ordering::Relaxed));
    if currently_shown {
        st.ov_visible.store(false, Ordering::Relaxed);
        st.ov_user_pin.store(false, Ordering::Relaxed);
        st.log("覆盖窗口显隐 -> false");
    } else {
        st.ov_visible.store(true, Ordering::Relaxed);
        st.ov_user_pin.store(true, Ordering::Relaxed);
        st.ov_auto_hidden.store(false, Ordering::Relaxed);
        st.log("覆盖窗口显隐 -> true（固定显示）");
    }
    apply_overlay_flags(&st);
}

fn toggle_topmost(app: &AppHandle) {
    let st = state_of(app);
    let t = !st.ov_topmost.load(Ordering::Relaxed);
    st.ov_topmost.store(t, Ordering::Relaxed);
    let mut ini = st.ini.lock().unwrap();
    ini.overlay_topmost = t;
    let _ = ini.save(&st.paths.ini);
    drop(ini);
    st.log(format!("覆盖窗口置顶 -> {t}"));
    apply_overlay_flags(&st);
}

fn copy_obs_url(app: &AppHandle) {
    let st = state_of(app);
    let url = format!("http://127.0.0.1:{}/overlay", st.port());
    let _ = app.clipboard().write_text(&url);
    st.log(format!("OBS 浏览器源地址已复制: {url}"));
}

// ---------- 热键（R16：默认关闭、可开关、可改键、失败不崩） ----------

/// 按 ini 现状重装热键。注册失败只写 hotkey_status + 日志，不影响程序运行。
pub fn apply_hotkeys(state: &Arc<AppState>) {
    let Some(app) = state.app.get() else { return };
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let (enabled, vis, top) = {
        let ini = state.ini.lock().unwrap();
        (ini.hotkey_enabled, ini.hotkey_visible.clone(), ini.hotkey_topmost.clone())
    };

    if !enabled {
        let mut st = state.hotkey_status.lock().unwrap();
        st.enabled = false;
        st.ok = true;
        st.error.clear();
        drop(st);
        state.log("全局热键：已关闭");
        return;
    }

    let mut errs: Vec<String> = Vec::new();
    for (label, s) in [("显隐", &vis), ("置顶", &top)] {
        if s.trim().is_empty() {
            continue;
        }
        if let Err(e) = gs.register(s.as_str()) {
            errs.push(format!("{label} {s}: {e}"));
        }
    }

    let mut st = state.hotkey_status.lock().unwrap();
    st.enabled = true;
    st.ok = errs.is_empty();
    st.error = errs.join("；");
    drop(st);

    if errs.is_empty() {
        state.log(format!("全局热键已注册：{vis}（显隐）· {top}（置顶）"));
    } else {
        state.log(format!("全局热键注册失败：{}", errs.join("；")));
    }
}

/// 控制台改热键：先落 ini 再重装，返回最新状态。
pub fn update_hotkeys(
    state: &Arc<AppState>,
    enabled: Option<bool>,
    visible: Option<String>,
    topmost: Option<String>,
) -> crate::config::HotkeyStatus {
    {
        let mut ini = state.ini.lock().unwrap();
        if let Some(v) = enabled {
            ini.hotkey_enabled = v;
        }
        if let Some(v) = visible {
            let v = v.trim().to_lowercase();
            // 清空 = 该动作不绑键；非空则必须是可解析的加速键串
            if v.is_empty() || v.parse::<Shortcut>().is_ok() {
                ini.hotkey_visible = v;
            }
        }
        if let Some(v) = topmost {
            let v = v.trim().to_lowercase();
            if v.is_empty() || v.parse::<Shortcut>().is_ok() {
                ini.hotkey_topmost = v;
            }
        }
        let _ = ini.save(&state.paths.ini);
    }
    apply_hotkeys(state);
    state.hotkey_status.lock().unwrap().clone()
}

pub fn on_hotkey(app: &AppHandle, shortcut: &Shortcut) {
    let st = state_of(app);
    let (vis, top) = {
        let ini = st.ini.lock().unwrap();
        (ini.hotkey_visible.clone(), ini.hotkey_topmost.clone())
    };
    if !vis.is_empty() && vis.parse::<Shortcut>().map(|s| s == *shortcut).unwrap_or(false) {
        toggle_visible(app);
        return;
    }
    if !top.is_empty() && top.parse::<Shortcut>().map(|s| s == *shortcut).unwrap_or(false) {
        toggle_topmost(app);
    }
}

// ---------- 托盘 ----------

fn create_tray(app: &AppHandle, _port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, "open", "打开控制面板", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "显示/隐藏覆盖层 (Ctrl+Alt+H)", true, None::<&str>)?;
    let topmost = MenuItem::with_id(app, "topmost", "覆盖层置顶开关 (Ctrl+Alt+T)", true, None::<&str>)?;
    let copy = MenuItem::with_id(app, "copy", "复制 OBS 浏览器源地址", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &toggle, &topmost, &copy, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().ok_or("缺少应用图标")?.clone())
        .tooltip("MO 观战 HUD")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => focus_control(app),
            "toggle" => toggle_visible(app),
            "topmost" => toggle_topmost(app),
            "copy" => copy_obs_url(app),
            "quit" => {
                let st = state_of(app);
                crate::bridge::shutdown(&st);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_control(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
