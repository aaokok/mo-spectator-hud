//! 观战环境自检：观战员每次的电脑可能不同，启动/进入前先跑一遍，
//! 控制面板展示结果并可一键复制报告远程沟通。
//! 新增检查项 = 加一个 check_* 函数并挂进 run()，返回 Vec<CheckReport>。

use std::path::Path;

use serde::Serialize;

use crate::config::Paths;
use crate::winutil;

#[derive(Serialize, Clone, Debug)]
pub struct CheckReport {
    pub id: String,
    /// pass | warn | fail | info
    pub level: String,
    pub title: String,
    pub detail: String,
    pub hint: String,
}

impl CheckReport {
    fn new(id: &str, level: &str, title: impl Into<String>, detail: impl Into<String>, hint: impl Into<String>) -> Self {
        CheckReport {
            id: id.into(),
            level: level.into(),
            title: title.into(),
            detail: detail.into(),
            hint: hint.into(),
        }
    }
}

/// 观战员常装的安全软件（提醒白名单用）
const AV_PROCESSES: &[(&str, &str)] = &[
    ("360tray.exe", "360 安全卫士"),
    ("360safe.exe", "360 安全卫士"),
    ("hipsTray.exe", "火绒安全"),
    ("wsctrl.exe", "火绒安全"),
    ("QQPCTray.exe", "腾讯电脑管家"),
];

pub fn run(paths: &Paths, port: u16) -> Vec<CheckReport> {
    let mut r = Vec::new();
    r.push(check_os());
    r.push(check_webview2());
    r.push(check_game(paths));
    r.push(check_bridge(paths));
    r.push(check_out_writable(paths));
    r.push(check_icons(paths));
    r.push(check_display());
    r.push(check_av());
    r.push(CheckReport::new(
        "service",
        "info",
        "本地服务",
        format!("http://127.0.0.1:{port}（OBS 浏览器源地址 /overlay）"),
        "",
    ));
    r
}

fn check_os() -> CheckReport {
    let build = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        .and_then(|k| k.get_value::<String, _>("CurrentBuildNumber"))
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    if build >= 17134 {
        CheckReport::new("os", "pass", "操作系统", format!("Windows 10/11 (build {build})"), "")
    } else {
        CheckReport::new("os", "fail", "操作系统", format!("build {build}，低于 17134"), "需要 Windows 10 1803 或更高（WebView2 随系统预装的最低版本）")
    }
}

fn check_webview2() -> CheckReport {
    const CLIENT_ID: &str = r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    let pv = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
        .open_subkey(CLIENT_ID)
        .and_then(|k| k.get_value::<String, _>("pv"))
        .or_else(|_| {
            winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
                .open_subkey(CLIENT_ID)
                .and_then(|k| k.get_value::<String, _>("pv"))
        })
        .ok()
        .filter(|s| !s.is_empty());
    if let Some(v) = pv {
        return CheckReport::new("webview2", "pass", "WebView2 运行时", format!("版本 {v}"), "");
    }
    // 注册表缺失时兜底看安装目录
    if let Ok(pf) = std::env::var("ProgramFiles(x86)") {
        let dir = Path::new(&pf).join(r"Microsoft\EdgeWebView\Application");
        if dir.is_dir() {
            return CheckReport::new("webview2", "pass", "WebView2 运行时", "已安装（按目录检测）", "");
        }
    }
    CheckReport::new(
        "webview2",
        "fail",
        "WebView2 运行时",
        "未检测到",
        "本程序需要 WebView2。到 https://developer.microsoft.com/microsoft-edge/webview2/ 下载 Evergreen Runtime 安装后重试。",
    )
}

fn game_dir_from_registry() -> Option<String> {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(r"SOFTWARE\Westwood\Mental Omega")
        .and_then(|k| k.get_value::<String, _>("InstallPath"))
        .ok()
        .map(|s| s.trim_end_matches('\\').to_string())
}

pub fn game_dir(paths: &Paths) -> Option<String> {
    let ini = paths.ini.clone();
    if let Ok(txt) = std::fs::read_to_string(&ini) {
        for line in txt.lines() {
            if let Some(v) = line.strip_prefix("game_dir=") {
                let v = v.trim();
                if !v.is_empty() && Path::new(v).join("gamemd.exe").is_file() {
                    return Some(v.to_string());
                }
            }
        }
    }
    let reg = game_dir_from_registry().filter(|d| Path::new(d).join("gamemd.exe").is_file());
    if reg.is_some() {
        return reg;
    }
    None
}

fn check_game(paths: &Paths) -> CheckReport {
    let Some(dir) = game_dir(paths) else {
        return CheckReport::new(
            "game",
            "warn",
            "游戏本体",
            "未找到《心灵终结》安装目录",
            "不影响预览/OBS（可用模拟数据）；接真实数据需要游戏。在控制台「环境」里手动设置游戏目录。",
        );
    };
    let root = Path::new(&dir);
    let gamemd = root.join("gamemd.exe");
    if !gamemd.is_file() {
        return CheckReport::new("game", "warn", "游戏本体", format!("{dir} 下没有 gamemd.exe"), "确认目录是否为游戏根目录");
    }
    // PE TimeDateStamp 与桥 preflight 同口径（YR 1.001 = 0x3BDF544E）
    match winutil::pe_timestamp(&gamemd) {
        Some(0x3BDF544E) => {}
        Some(other) => {
            return CheckReport::new(
                "game",
                "warn",
                "游戏本体",
                format!("gamemd.exe TimeDateStamp={other:#010x}，非标准 YR 1.001"),
                "数据桥 preflight 可能拒绝；确认是否 MO 3.3.6 合并环境",
            )
        }
        None => {
            return CheckReport::new("game", "warn", "游戏本体", "gamemd.exe 读取失败", "文件可能被占用或损坏")
        }
    };
    // 客户端检测（防汉化口径：只认标准渲染器变体名）
    let client = ["clientdx.exe", "clientogl.exe", "clientxna.exe"]
        .iter()
        .find(|c| root.join(c).is_file() || root.join("Resources").join(c).is_file());
    match client {
        Some(c) => CheckReport::new(
            "game",
            "pass",
            "游戏本体",
            format!("{dir} · gamemd 1.001 ✓ · 客户端 {c}"),
            "",
        ),
        None => CheckReport::new(
            "game",
            "warn",
            "游戏本体",
            format!("{dir} · gamemd 1.001 ✓ · 未找到 clientdx/ogl/xna"),
            "缺少 MO 客户端（CnCNet 启动器），观战时客户端需在本机运行",
        ),
    }
}

fn check_bridge(paths: &Paths) -> CheckReport {
    let exe = paths.bridge_exe();
    if !exe.is_file() {
        return CheckReport::new(
            "bridge",
            "fail",
            "数据桥 hud_bridge.exe",
            format!("缺少 {}", exe.display()),
            "把 HUD-字段验证工具包里的 hud_bridge.exe 放到本程序同级目录（发布），或检查开发布局路径",
        );
    }
    let size = std::fs::metadata(&exe).map(|m| m.len()).unwrap_or(0);
    CheckReport::new("bridge", "pass", "数据桥 hud_bridge.exe", format!("{}（{size} B）", exe.display()), "")
}

fn check_out_writable(paths: &Paths) -> CheckReport {
    let out = paths.out_dir();
    if let Err(e) = std::fs::create_dir_all(&out) {
        return CheckReport::new("out", "fail", "输出目录可写", format!("{} 创建失败: {e}", out.display()), "检查磁盘与权限");
    }
    let probe = out.join(".write_test");
    match std::fs::write(&probe, b"ok").and_then(|_| std::fs::remove_file(&probe)) {
        Ok(()) => CheckReport::new("out", "pass", "输出目录可写", out.display().to_string(), ""),
        Err(e) => CheckReport::new(
            "out",
            "fail",
            "输出目录可写",
            format!("写入失败: {e}"),
            "大概率是杀软拦截：把本程序目录加入白名单",
        ),
    }
}

fn check_icons(paths: &Paths) -> CheckReport {
    let byid = paths.icons_dir().join("byid");
    let n = std::fs::read_dir(&byid)
        .map(|d| d.filter_map(|e| e.ok()).filter(|e| e.path().extension().map(|x| x == "png").unwrap_or(false)).count())
        .unwrap_or(0);
    if n > 0 {
        CheckReport::new("icons", "pass", "单位图标库", format!("{n} 张 byid 图标"), "")
    } else {
        CheckReport::new("icons", "warn", "单位图标库", "icons/byid/ 为空或缺失", "单位栏与队列会退化为文字，复制工具包 icons/ 到位")
    }
}

fn check_display() -> CheckReport {
    match winutil::primary_monitor_size() {
        Some((w, h)) => {
            let note = if w < 1600 || h < 900 {
                "分辨率偏低，4v4 布局会进入紧凑档"
            } else {
                ""
            };
            CheckReport::new("display", "info", "主显示器", format!("{w}×{h} {note}"), "")
        }
        None => CheckReport::new("display", "warn", "主显示器", "无法获取分辨率", ""),
    }
}

fn check_av() -> CheckReport {
    let mut found: Vec<&str> = Vec::new();
    for (name, label) in AV_PROCESSES {
        if crate::winutil::process_running(name) && !found.contains(label) {
            found.push(*label);
        }
    }
    if found.is_empty() {
        CheckReport::new("av", "info", "安全软件", "未发现常见杀软", "")
    } else {
        CheckReport::new(
            "av",
            "warn",
            "安全软件",
            format!("检测到 {}", found.join("、")),
            "若数据桥/输出目录被拦截，请把本程序目录加入白名单",
        )
    }
}

/// 摘要（控制台展示 + 复制报告用）
pub fn summary(reports: &[CheckReport]) -> String {
    let mark = |l: &str| match l {
        "pass" => "✅",
        "warn" => "⚠️",
        "fail" => "❌",
        _ => "ℹ️",
    };
    reports
        .iter()
        .map(|c| format!("{} {} — {} {}", mark(&c.level), c.title, c.detail, c.hint))
        .collect::<Vec<_>>()
        .join("\n")
}
