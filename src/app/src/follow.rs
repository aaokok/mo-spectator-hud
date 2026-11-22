//! 覆盖窗口跟随：每 100ms 找 gamemd.exe 的最大可见窗口，把覆盖层贴到其客户区。
//! 原理同 mo_hud v2 的 overlay_tick，但从 C++ 移到 Rust：纯外部窗口移动，不碰游戏进程。
//!
//! R10 失焦自动隐藏（控制台开关 auto_hide_on_blur，默认开）：
//! 游戏窗口存在但不在前台（或已最小化）→ 覆盖层自动隐藏，避免置顶悬浮在
//! 其他应用上方；回到前台自动恢复。热键手动"显示"会临时钉住（ov_user_pin），
//! 直到下次游戏重新获得前台才交还自动权。游戏窗口消失不隐藏（保留
//! "等待进入对局"占位窗口的既有行为）。

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use tauri::Manager;
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::config::AppState;

const GAME_PROC: &str = "gamemd.exe";
const TICK_MS: u64 = 100;
const IDLE_TICK_MS: u64 = 400;

pub fn start(app: tauri::AppHandle, state: Arc<AppState>) {
    std::thread::spawn(move || {
        let mut last: Option<(i32, i32, i32, i32)> = None;
        let mut cached: Option<(u32, isize)> = None;
        let mut had_game = false;
        loop {
            std::thread::sleep(Duration::from_millis(if had_game { TICK_MS } else { IDLE_TICK_MS }));
            let found = cached
                .and_then(|(pid, hwnd)| {
                    crate::winutil::cached_window_rect(hwnd, pid).map(|rect| (pid, hwnd, rect))
                })
                .or_else(|| {
                    let pid = crate::winutil::find_pid_by_name(GAME_PROC)?;
                    let (hwnd, rect) = crate::winutil::find_main_window(pid)?;
                    Some((pid, hwnd, rect))
                });
            match found {
                Some((pid, hwnd, rect)) => {
                    cached = Some((pid, hwnd));
                    state.game_hwnd.store(hwnd, Ordering::Relaxed);   // R13 光标指示器共用
                    if !had_game {
                        state.log(format!("找到游戏窗口（pid={pid}），覆盖层开始跟随"));
                        had_game = true;
                    }
                    let iconic = crate::winutil::is_iconic_w(hwnd);
                    // R23：前台放宽到同游戏进程，游戏中按 Esc 弹选项对话框不误隐藏覆盖层
                    let focused = crate::winutil::is_foreground_of_window_pid(hwnd);
                    if focused {
                        // 前台回归后，手动钉住失效，交还自动权
                        state.ov_user_pin.store(false, Ordering::Relaxed);
                    }
                    let blur_hide = state.ctrl.lock().unwrap().auto_hide_on_blur;
                    let want_hidden = blur_hide
                        && !state.ov_user_pin.load(Ordering::Relaxed)
                        && (!focused || iconic);
                    if state.ov_auto_hidden.swap(want_hidden, Ordering::Relaxed) != want_hidden {
                        state.log(if want_hidden {
                            "游戏窗口失焦/最小化，覆盖层自动隐藏"
                        } else {
                            "游戏窗口回到前台，覆盖层恢复显示"
                        });
                        crate::shell::apply_overlay_flags(&state);
                    }
                    if !iconic && last != Some(rect) {
                        if let Some(w) = overlay_window(&app) {
                            let (x, y, wd, ht) = rect;
                            let _ = w.set_position(PhysicalPosition::new(x, y));
                            let _ = w.set_size(PhysicalSize::new(wd as u32, ht as u32));
                        }
                        last = Some(rect);
                    }
                }
                None => {
                    cached = None;
                    state.game_hwnd.store(0, Ordering::Relaxed);
                    if had_game {
                        state.log("游戏窗口消失，覆盖层停在原位（可用热键手动隐藏）");
                        had_game = false;
                    }
                    last = None;
                    state.ov_user_pin.store(false, Ordering::Relaxed);
                    if state.ov_auto_hidden.swap(false, Ordering::Relaxed) {
                        crate::shell::apply_overlay_flags(&state);
                    }
                }
            }
        }
    });
}

fn overlay_window(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("overlay")
}
