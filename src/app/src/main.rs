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
