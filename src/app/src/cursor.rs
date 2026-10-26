//! R13 光标指示器采样：15ms 读全局光标，换算成覆盖层客户区 CSS 坐标，
//! 经 broadcast → HTTP SSE（/cursor/sse）推给覆盖层页。
//!
//! 为什么需要：游戏是自绘光标（画在游戏画面里，位于覆盖层之下），指针移到
//! 覆盖层的不透明面板（顶栏/侧栏/队列列）上就不可见。页内标记浮在面板之上，
//! OBS 浏览器源连同一页面，观赛流里同样可见。
//!
//! 成本闸门（静止/隐藏/失焦时零流量）：
//!   - 无 SSE 订阅者 → 纯睡眠；
//!   - 覆盖层不可见（ov_visible && !ov_auto_hidden）、游戏不在前台、
//!     控制台开关关闭 → 只推一帧 off 后静默；
//!   - 坐标不变（鼠标静止）→ 不推送。
//!
//! R23 遮挡判定（cursor_only_when_covered，默认开）：
//!   指针没压在任何覆盖层面板上时不推坐标 → 指示器完全不出现。
//!   矩形表由覆盖层页 POST /cursor/regions 上报（CSS px，客户区坐标）。
//!   没收到上报/已陈旧 → 退回 R13 常亮行为，不会因为上报缺失让指示器消失。
//!   命中判定是纯整数比较，零额外系统调用。

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use crate::config::AppState;

const SAMPLE_MS: u64 = 15;

pub fn start(state: Arc<AppState>) {
    std::thread::spawn(move || {
        let mut sent_on = false;
        let mut last = (i32::MIN, i32::MIN);
        loop {
            std::thread::sleep(Duration::from_millis(SAMPLE_MS));
            if state.cursor_tx.receiver_count() == 0 {
                continue;
            }
            let (indicator_on, only_covered) = {
                let c = state.ctrl.lock().unwrap();
                (c.cursor_indicator, c.cursor_only_when_covered)
            };
            let overlay = *state.overlay_hwnd.lock().unwrap();
            let game = *state.game_hwnd.lock().unwrap();
            /* R23：前台判据从"前台句柄 == 游戏主窗口"放宽到"前台窗口属于游戏进程"。
               Esc/选项菜单可能是同进程的另一个顶层窗口，旧判据下这段时间前台句柄
               不等于 game，指示器会整段消失。 */
            let fg_is_game = if game == 0 {
                false
            } else {
                let fg = crate::winutil::foreground_hwnd();
                if fg == 0 {
                    false
                } else if fg == game {
                    true
                } else {
                    let fp = crate::winutil::window_pid(fg);
                    fp != 0 && fp == crate::winutil::window_pid(game)
                }
            };
            let active = indicator_on
                && overlay != 0
                && state.ov_visible.load(Ordering::Relaxed)
                && !state.ov_auto_hidden.load(Ordering::Relaxed)
                && game != 0
                && fg_is_game;
            if !active {
                if sent_on {
                    let _ = state.cursor_tx.send("{\"on\":false}".to_string());
                    sent_on = false;
                    last = (i32::MIN, i32::MIN);
                }
                continue;
            }
            let Some((cx, cy)) = crate::winutil::cursor_pos() else { continue };
            let Some((ox, oy)) = crate::winutil::client_origin(overlay) else { continue };
            let scale = crate::winutil::dpi_scale(overlay);
            let fx = (cx - ox) as f64 / scale;
            let fy = (cy - oy) as f64 / scale;
            let x = fx.round() as i32;
            let y = fy.round() as i32;

            /* R23：只在指针压到我们自己的面板上时才画。
               矩形表缺失或陈旧 → 退回常亮（不能因为上报没到就让指示器消失）。 */
            if only_covered {
                let covered = {
                    let g = state.cursor_regions.lock().unwrap();
                    match g.as_ref() {
                        Some(r) if !r.is_stale() => r.hit(fx, fy),
                        _ => true,   /* 无上报 = 不知道遮没遮，按老行为常亮 */
                    }
                };
                if !covered {
                    if sent_on {
                        let _ = state.cursor_tx.send("{\"on\":false}".to_string());
                        sent_on = false;
                        last = (i32::MIN, i32::MIN);
                    }
                    continue;
                }
            }

            if sent_on && (x, y) == last {
                continue;
            }
            if state
                .cursor_tx
                .send(format!("{{\"x\":{x},\"y\":{y}}}"))
                .is_ok()
            {
                sent_on = true;
                last = (x, y);
            }
        }
    });
}
