#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod cursor;
mod config;
mod envcheck;
mod follow;
mod server;
mod shell;
mod winutil;

use std::sync::Arc;

use tauri::Manager;
use tauri_plugin_global_shortcut::ShortcutState;

fn main() {
    let paths = config::Paths::resolve();
    let state = Arc::new(config::AppState::new(paths));
    install_panic_hook(state.clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            shell::focus_control(app);
        }))
        // R16：热键改为运行时按 ini 动态注册（默认关闭、可改键、失败不崩），
        // 这里只装插件与事件分发，不再 with_shortcuts 静态注册。
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        shell::on_hotkey(app, shortcut);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state.clone())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    // 关控制窗口 = 退出整个应用
                    "control" => window.app_handle().exit(0),
                    // 关覆盖窗口 = 隐藏（托盘/热键可再开）
                    "overlay" => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    _ => {}
                }
            }
        })
        .setup(move |app| {
            let port = server::start(state.clone())?;
            shell::setup(app, state.clone(), port)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("mo_hud 启动失败");
}

/// panic 兜底：发布版是 `windows_subsystem="windows"`，没有控制台，
/// 崩溃信息原本只会进 Windows 事件日志、用户拿不到。这里落盘（>2 MB 轮转）
/// 并塞进日志队列，控制台「日志」页可直接看到，反馈问题时能直接复制。
fn install_panic_hook(state: Arc<config::AppState>) {
    let dir = state.paths.app_root.clone();
    std::panic::set_hook(Box::new(move |info| {
        let msg = format!("[{}] PANIC {info}", config::chrono_now());
        config::append_capped(&dir, "_panic.log", &msg);
        {
            let mut q = state.log.lock().unwrap_or_else(|e| e.into_inner());
            q.push_back(msg.clone());
        }
        eprintln!("{msg}");
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真触发一次 panic：确认 _panic.log 落盘且内容进了日志队列。
    /// 钩子是进程级的，测试结束必须还原，否则会污染同进程其他用例。
    #[test]
    fn panic_hook_writes_file_and_log_queue() {
        let dir = std::env::temp_dir().join("mo_hud_panic_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let state = Arc::new(config::AppState::new(config::Paths {
            exe_dir: dir.clone(),
            app_root: dir.clone(),
            demo_root: dir.clone(),
            toolkit_dir: dir.clone(),
            ini: dir.join("test.ini"),
        }));

        let prev = std::panic::take_hook();
        install_panic_hook(state.clone());
        let hit = std::panic::catch_unwind(|| panic!("PANIC-HOOK-SELFTEST"));
        std::panic::set_hook(prev);

        assert!(hit.is_err(), "catch_unwind 应捕获到 panic");
        let text = std::fs::read_to_string(dir.join("_panic.log")).unwrap_or_default();
        assert!(text.contains("PANIC-HOOK-SELFTEST"), "落盘内容: {text:?}");
        let q = state.log.lock().unwrap();
        assert!(
            q.iter().any(|l| l.contains("PANIC-HOOK-SELFTEST")),
            "日志队列应有 panic：{q:?}"
        );
        drop(q);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
