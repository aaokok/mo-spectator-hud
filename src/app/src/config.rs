use std::collections::VecDeque;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// 开发/发布两套布局的路径解析（对应 06-EXE架构设计.md §7）。
/// 开发布局：exe 在 exe_New/src-tauri/target/{debug,release}/，
///          Demo 在 前端开发/Demo/，工具包在 SpectatorResearch/.../HUD-字段验证工具包/。
/// 发布布局：exe 同级放 hud/ demo/ hud_bridge.exe icons/ out/。
#[derive(Clone, Debug)]
pub struct Paths {
    pub exe_dir: PathBuf,
    /// app 自有页面（control.html 等）
    pub app_root: PathBuf,
    /// 渲染核静态资源（唯一布局实现 = Demo）
    pub demo_root: PathBuf,
    /// HUD-字段验证工具包（hud_bridge.exe / icons/ / out/）
    pub toolkit_dir: PathBuf,
    pub ini: PathBuf,
}

impl Paths {
    pub fn resolve() -> Paths {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."));
        let exe_dir = dunce_canonical(&exe_dir);

        // 开发布局优先：向上找同时含前端与控制台页面的祖先目录。
        // 必须排在发布布局判定之前 —— cargo build 会把 hud/ 与 demo/ 拷进
        // target/{debug,release}/，使 exe 同级同时满足发布布局条件；若先判发布布局，
        // 跑 debug exe 时读到的就是构建那一刻的副本，之后对源码的修改（新增页面、
        // 路由表等）全部不生效，表现为"点新页面立刻弹回总览"这类假故障。
        for anc in exe_dir.ancestors() {
            // 开源仓库标准布局：src/overlay/index.html + src/console/control.html
            if anc.join("src/overlay/index.html").is_file()
                && anc.join("src/console/control.html").is_file()
            {
                let toolkit = if anc.join("release/hud_bridge.exe").is_file() {
                    anc.join("release")
                } else {
                    anc.join("assets")
                };
                return Paths {
                    demo_root: anc.join("src/overlay"),
                    toolkit_dir: toolkit,
                    app_root: anc.join("src/console"),
                    ini: exe_dir.join("mo_hud.ini"),
                    exe_dir,
                };
            }

            // 本地开发测试布局：前端开发/Demo/index.html + 前端开发/exe_New/hud/control.html
            if anc.join("前端开发/Demo/index.html").is_file()
                && anc.join("前端开发/exe_New/hud/control.html").is_file()
            {
                let fe = anc.join("前端开发");
                return Paths {
                    demo_root: fe.join("Demo"),
                    toolkit_dir: anc
                        .join("SpectatorResearch/notes/reports/HUD-字段验证工具包"),
                    app_root: fe.join("exe_New/hud"),
                    ini: exe_dir.join("mo_hud.ini"),
                    exe_dir,
                };
            }
        }

        // 发布布局：exe 同级自带 hud/ + demo/（NSIS 安装后的形态）
        if exe_dir.join("hud/control.html").is_file() && exe_dir.join("demo/index.html").is_file() {
            return Paths {
                demo_root: exe_dir.join("demo"),
                toolkit_dir: exe_dir.clone(),
                app_root: exe_dir.join("hud"),
                ini: exe_dir.join("mo_hud.ini"),
                exe_dir,
            };
        }

        // 兜底：全部按 exe 同级
        Paths {
            demo_root: exe_dir.join("demo"),
            toolkit_dir: exe_dir.clone(),
            app_root: exe_dir.join("hud"),
            ini: exe_dir.join("mo_hud.ini"),
            exe_dir,
        }
    }

    pub fn icons_dir(&self) -> PathBuf {
        self.toolkit_dir.join("icons")
    }
    pub fn out_dir(&self) -> PathBuf {
        self.toolkit_dir.join("out")
    }
    pub fn bridge_exe(&self) -> PathBuf {
        self.toolkit_dir.join("hud_bridge.exe")
    }
    pub fn state_json(&self) -> PathBuf {
        self.out_dir().join("hud_state.json")
    }
    pub fn probe_log(&self, err: bool) -> PathBuf {
        self.app_root
            .join(if err { "_probe_error.log" } else { "_probe.log" })
    }
}

/// 规范化路径（不借 UI 层，避免中文路径下 dunce 之外的坑）
fn dunce_canonical(p: &Path) -> PathBuf {
    match std::fs::canonicalize(p) {
        Ok(p) => p,
        Err(_) => p.to_path_buf(),
    }
}

/// /control 状态：与 v1 完全同形的扁平契约（Demo/control-bridge.js 按键名消费）。
/// 扩展只允许"加键"，不许改键义 —— 渲染端忽略未知键。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CtrlState {
    pub show_score: bool,
    pub show_units: bool,
    pub show_queues: bool,
    pub observer_gate: bool,
    pub match_name: String,
    pub score_l: i32,
    pub score_r: i32,
    /// R11：模式标签覆盖（LAN/遭遇战/自定义文案），空 = 用桥数据原值
    pub mode_label: String,
    /// R10：顶栏左上让位（游戏事件/超武文字透出的竖条），渲染端消费
    pub yield_top_left: bool,
    /// R10：游戏窗口失焦/最小化时覆盖层自动隐藏（Rust 跟随线程消费）
    pub auto_hide_on_blur: bool,
    /// R12：单位图标覆盖 {"ID":"flakv"|"custom/xx.png"|{"b":..,"a":..}}，JSON 字符串。
    /// Rust 端只存储与回显（校验合法 JSON），展开在渲染端（demo.js rebuildUnitCustom）
    pub unit_icon_overrides: String,
    /// R12：显式隐藏的单位 ID 列表，JSON 字符串数组
    pub hidden_units: String,
    /// R12：分类隐藏标签（def/shi/hero/al/...，与 icons-live.js cats 对应），JSON 字符串数组
    pub hidden_tags: String,
    /// R12：隐藏计数口径 keep（藏格不扣 +N，默认）/ drop
    pub hidden_count_mode: String,
    /// R13：光标指示器（游戏自绘光标被面板遮挡，覆盖层页内画指针标记），默认开
    pub cursor_indicator: bool,
    /// R23：只在指针压到覆盖层面板上时才画指示器。默认开。
    /// 关掉退回 R13 老行为（游戏在前台就常亮）。判据来自覆盖层的 /cursor/regions 上报；
    /// 没收到上报（或已陈旧）时自动退回常亮，不会因为上报缺失而让指示器消失。
    pub cursor_only_when_covered: bool,
    /// R13：单位优先显示层级，JSON 数组，取值 hero/one/cnt 的排列，
    /// 默认 ["hero","one","cnt"]（英雄 → 限造1个 → 数量降序）
    pub unit_priority: String,
    /// R22：未进入对局时显示「等待进入对局…」占位提示（本地窗口/预览用）。
    /// OBS 浏览器源始终透明，不受此键影响。
    pub show_wait_hint: bool,
    /// R22：Esc / 选项菜单打开时自动隐藏生产队列列。默认开。
    /// 判据是桥的 menu_open（多人局 IsGamePaused 不置位，原来的 paused 判据从不触发）。
    pub hide_queue_on_menu: bool,
    /// R29：支援技能栏（F 方案）。默认关 —— 不开则渲染端维持原状。
    /// 只在 1v1 生效：开启后 1v1 的玩家面板也走两列（原本是单列窄栏），
    /// 给支援技能格腾出横向空间；非 1v1 不受影响。
    pub show_supers: bool,
    /// R29：支援技能优先显示顺序，JSON 数组，元素是超武节名。
    /// 数组内的按顺序排在前；不在数组里的按桥输出原序排在后面。
    pub super_priority: String,
    /// R29：不显示的支援技能，JSON 字符串数组（超武节名）。
    /// 与 hidden_units 完全分离 —— 单位是 unit_types 的 ID，这里是 SuperWeapon 节名。
    pub hidden_supers: String,
}

impl Default for CtrlState {
    fn default() -> Self {
        CtrlState {
            show_score: true,
            show_units: true,
            show_queues: true,
            observer_gate: false,
            match_name: String::new(),
            score_l: 0,
            score_r: 0,
            mode_label: String::new(),
            yield_top_left: true,
            auto_hide_on_blur: true,
            unit_icon_overrides: String::new(),
            hidden_units: String::new(),
            hidden_tags: String::new(),
            hidden_count_mode: String::from("keep"),
            cursor_indicator: true,
            cursor_only_when_covered: true,
            unit_priority: String::from("[\"hero\",\"one\",\"cnt\"]"),
            show_wait_hint: true,
            hide_queue_on_menu: true,
            show_supers: false,
            super_priority: String::new(),
            hidden_supers: String::new(),
        }
    }
}

impl CtrlState {
    pub fn load(demo_root: &Path) -> CtrlState {
        let mut st = CtrlState::default();
        if let Ok(txt) = std::fs::read_to_string(demo_root.join("_control.json")) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                st.show_score = v["show_score"].as_bool().unwrap_or(st.show_score);
                st.show_units = v["show_units"].as_bool().unwrap_or(st.show_units);
                st.show_queues = v["show_queues"].as_bool().unwrap_or(st.show_queues);
                st.observer_gate = v["observer_gate"].as_bool().unwrap_or(st.observer_gate);
                st.match_name = v["match_name"]
                    .as_str()
                    .unwrap_or(&st.match_name)
                    .to_string();
                st.mode_label = v["mode_label"]
                    .as_str()
                    .unwrap_or(&st.mode_label)
                    .to_string();
                st.score_l = v["score_l"].as_i64().unwrap_or(st.score_l as _) as i32;
                st.score_r = v["score_r"].as_i64().unwrap_or(st.score_r as _) as i32;
                st.yield_top_left = v["yield_top_left"].as_bool().unwrap_or(st.yield_top_left);
                st.auto_hide_on_blur = v["auto_hide_on_blur"].as_bool().unwrap_or(st.auto_hide_on_blur);
                for (key, dst) in [
                    ("unit_icon_overrides", &mut st.unit_icon_overrides),
                    ("hidden_units", &mut st.hidden_units),
                    ("hidden_tags", &mut st.hidden_tags),
                ] {
                    if let Some(s) = v[key].as_str() {
                        *dst = s.to_string();
                    }
                }
                if let Some(s) = v["hidden_count_mode"].as_str() {
                    if s == "keep" || s == "drop" {
                        st.hidden_count_mode = s.to_string();
                    }
                }
                if let Some(b) = v["cursor_indicator"].as_bool() {
                    st.cursor_indicator = b;
                }
                if let Some(b) = v["cursor_only_when_covered"].as_bool() {
                    st.cursor_only_when_covered = b;
                }
                if let Some(s) = v["unit_priority"].as_str() {
                    if valid_priority_json(s) {
                        st.unit_priority = s.to_string();
                    }
                }
                st.show_wait_hint = v["show_wait_hint"].as_bool().unwrap_or(st.show_wait_hint);
                st.hide_queue_on_menu = v["hide_queue_on_menu"].as_bool().unwrap_or(st.hide_queue_on_menu);
                st.show_supers = v["show_supers"].as_bool().unwrap_or(st.show_supers);
                for (key, dst) in [
                    ("super_priority", &mut st.super_priority),
                    ("hidden_supers", &mut st.hidden_supers),
                ] {
                    if let Some(s) = v[key].as_str() {
                        *dst = s.to_string();
                    }
                }
            }
        }
        st
    }

    pub fn save(&self, demo_root: &Path) -> std::io::Result<()> {
        let dst = demo_root.join("_control.json");
        let tmp = demo_root.join("_control.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(self).unwrap_or_default())?;
        std::fs::rename(&tmp, &dst)
    }
}

/// unit_priority 合法性：JSON 数组，元素取自 hero/one/cnt 且不重复
pub fn valid_priority_json(v: &str) -> bool {
    if v.trim().is_empty() {
        return true;
    }
    let Ok(serde_json::Value::Array(arr)) = serde_json::from_str(v) else {
        return false;
    };
    if arr.len() > 3 {
        return false;
    }
    let mut seen: Vec<&str> = Vec::new();
    arr.iter().all(|x| match x.as_str() {
        Some(s @ ("hero" | "one" | "cnt")) => {
            if seen.contains(&s) {
                false
            } else {
                seen.push(s);
                true
            }
        }
        _ => false,
    })
}

/// super_priority / hidden_supers 合法性：JSON 数组，元素全是字符串。
/// 不限定具体枚举 —— 超武节名由 MO 的 ini 决定，写死白名单会和地图内嵌 ini 脱节。
pub fn valid_string_array_json(v: &str) -> bool {
    if v.trim().is_empty() {
        return true;
    }
    match serde_json::from_str::<serde_json::Value>(v) {
        Ok(serde_json::Value::Array(arr)) => arr.iter().all(|x| x.is_string()),
        _ => false,
    }
}

/// mo_hud.ini（游戏目录、扫描频率、覆盖层开关、热键的持久化）
#[derive(Clone, Debug, Default)]
pub struct Ini {
    pub game_dir: String,
    pub interval_ms: u32,
    pub overlay_topmost: bool,
    /// R16：全局热键默认关闭，用户可在控制台开启/改键
    pub hotkey_enabled: bool,
    pub hotkey_visible: String,
    pub hotkey_topmost: String,
}

impl Ini {
    pub fn load(p: &Path) -> Ini {
        let mut ini = Ini {
            interval_ms: 500,
            overlay_topmost: true,
            game_dir: String::new(),
            hotkey_enabled: false,
            hotkey_visible: String::from("ctrl+alt+h"),
            hotkey_topmost: String::from("ctrl+alt+t"),
        };
        if let Ok(txt) = std::fs::read_to_string(p) {
            for line in txt.lines() {
                let Some((k, v)) = line.split_once('=') else { continue };
                let v = v.trim();
                match k.trim() {
                    "game_dir" => ini.game_dir = v.to_string(),
                    "interval_ms" => ini.interval_ms = v.parse().unwrap_or(500),
                    "overlay_topmost" => ini.overlay_topmost = v == "1" || v == "true",
                    "hotkey_enabled" => ini.hotkey_enabled = v == "1" || v == "true",
                    "hotkey_visible" => {
                        if !v.is_empty() {
                            ini.hotkey_visible = v.to_lowercase();
                        }
                    }
                    "hotkey_topmost" => {
                        if !v.is_empty() {
                            ini.hotkey_topmost = v.to_lowercase();
                        }
                    }
                    _ => {}
                }
            }
        }
        ini
    }

    pub fn save(&self, p: &Path) -> std::io::Result<()> {
        let txt = format!(
            "game_dir={}\ninterval_ms={}\noverlay_topmost={}\nhotkey_enabled={}\nhotkey_visible={}\nhotkey_topmost={}\n",
            self.game_dir,
            self.interval_ms,
            self.overlay_topmost,
            self.hotkey_enabled,
            self.hotkey_visible,
            self.hotkey_topmost
        );
        std::fs::write(p, txt)
    }
}

#[derive(Debug)]
pub struct BridgeInfo {
    pub ours: bool,
    pub running: bool,
    pub restarts: u32,
    pub external: bool,
}

/// 全应用共享状态：HTTP 服务 / 窗口 / 线程共同读写
pub struct AppState {
    pub paths: Paths,
    pub ini: Mutex<Ini>,
    pub port: AtomicU16,
    pub ctrl: Mutex<CtrlState>,
    pub log: Mutex<VecDeque<String>>,
    /// 覆盖层：用户开关（显隐 / 置顶）
    pub ov_visible: AtomicBool,
    pub ov_topmost: AtomicBool,
    /// 覆盖层：跟随线程判定（R10 失焦自动隐藏）；与 ov_visible 独立，
    /// 实际可见 = ov_visible && !ov_auto_hidden（见 shell::apply_overlay_flags）
    pub ov_auto_hidden: AtomicBool,
    /// 覆盖层：热键手动"显示"后的临时钉住（失焦也不藏），前台回归即失效
    pub ov_user_pin: AtomicBool,
    /// R13 光标指示器：覆盖层/游戏窗口句柄（0=未知），跟随线程与 setup 写入
    pub overlay_hwnd: Mutex<isize>,
    pub game_hwnd: Mutex<isize>,
    /// R13 光标指示器：采样线程 → /cursor/sse（broadcast，无订阅者时零流量）
    pub cursor_tx: tokio::sync::broadcast::Sender<String>,
    /// R23 光标指示器：覆盖层上报的遮盖面板矩形（CSS px，相对覆盖层客户区）。
    /// None = 还没收到上报（或已过期）→ 采样线程退回"常亮"的老行为。
    /// Some(空表) = 当前没有任何面板遮挡 → 指示器完全不出。
    pub cursor_regions: Mutex<Option<CursorRegions>>,
    /// R16 热键状态：注册是否成功、失败原因（供 /app/status 展示）
    pub hotkey_status: Mutex<HotkeyStatus>,
    pub bridge: Mutex<BridgeInfo>,
    pub env_cache: Mutex<Option<(Instant, Vec<crate::envcheck::CheckReport>)>>,
    pub app: OnceLock<AppHandle>,
}

/// R16：热键注册结果。enabled=false 时 error 恒为空（未尝试注册）。
#[derive(Clone, Debug, Default)]
pub struct HotkeyStatus {
    pub enabled: bool,
    pub ok: bool,
    pub error: String,
}

/// R23：覆盖层遮盖面板的矩形表（CSS px，覆盖层客户区坐标）。
/// 前端在每次布局变化后上报一次；采样线程用它判断"指针是不是正压在我们的面板上"。
#[derive(Clone, Debug, Default)]
pub struct CursorRegions {
    /// (x, y, w, h)，CSS px；x/y 是矩形左上角
    pub rects: Vec<(f64, f64, f64, f64)>,
    /// 上报时刻，用于判定陈旧（覆盖层页刷新/关掉后停止上报）
    pub at: Option<Instant>,
}

impl CursorRegions {
    /// 陈旧阈值：超过这么久没上报就当没收到，退回常亮。
    /// 覆盖层只在布局变化时上报，间隔可能很长，所以给足余量（30 秒）；
    /// 页面刷新会重建连接并立即补报一次。
    pub const STALE: Duration = Duration::from_secs(30);

    pub fn is_stale(&self) -> bool {
        match self.at {
            Some(t) => t.elapsed() > Self::STALE,
            None => true,
        }
    }

    /// 点是否落在任一矩形内。rects 为空 → 恒 false（没面板 → 不需要指示器）。
    pub fn hit(&self, x: f64, y: f64) -> bool {
        self.rects
            .iter()
            .any(|&(rx, ry, rw, rh)| x >= rx && x <= rx + rw && y >= ry && y <= ry + rh)
    }
}

impl AppState {
    pub fn new(paths: Paths) -> AppState {
        let ini = Ini::load(&paths.ini);
        let ov_topmost = ini.overlay_topmost;
        let hotkey_enabled = ini.hotkey_enabled;
        let ctrl = CtrlState::load(&paths.demo_root);
        let (cursor_tx, _) = tokio::sync::broadcast::channel::<String>(64);
        AppState {
            paths,
            ini: Mutex::new(ini),
            port: AtomicU16::new(0),
            ctrl: Mutex::new(ctrl),
            log: Mutex::new(VecDeque::new()),
            ov_visible: AtomicBool::new(true),
            ov_topmost: AtomicBool::new(ov_topmost),
            ov_auto_hidden: AtomicBool::new(false),
            ov_user_pin: AtomicBool::new(false),
            overlay_hwnd: Mutex::new(0),
            game_hwnd: Mutex::new(0),
            cursor_tx: cursor_tx.clone(),
            cursor_regions: Mutex::new(None),
            hotkey_status: Mutex::new(HotkeyStatus {
                enabled: hotkey_enabled,
                ok: false,
                error: String::new(),
            }),
            bridge: Mutex::new(BridgeInfo {
                ours: false,
                running: false,
                restarts: 0,
                external: false,
            }),
            env_cache: Mutex::new(None),
            app: OnceLock::new(),
        }
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }

    pub fn set_port(&self, p: u16) {
        self.port.store(p, Ordering::Relaxed);
    }

    pub fn log(&self, msg: impl AsRef<str>) {
        let msg = msg.as_ref();
        let line = format!("[{}] {msg}", chrono_now());
        {
            let mut q = self.log.lock().unwrap_or_else(|e| e.into_inner());
            q.push_back(line.clone());
            while q.len() > 500 {
                q.pop_front();
            }
        }
        append_log_file(&self.paths.app_root, &line);
        println!("{line}");
    }
}

/// 运行日志落盘。控制台「日志」页只留 500 行，程序一关现场就没了，
/// 用户反馈问题时无从查起。超过 2 MB 轮转一次（旧文件覆盖为 .1），
/// 一次完整对局的量远小于此，不会丢现场。
fn append_log_file(dir: &Path, line: &str) {
    append_capped(dir, "_mo_hud.log", line);
}

/// 追加一行到 `dir/name`；文件超过 2 MB 时先轮转为 `<name>.1`。
/// 日志类文件都必须走这里——异常/崩溃可能每帧触发，无上限会写满磁盘。
pub fn append_capped(dir: &Path, name: &str, line: &str) {
    use std::io::Write;
    let p = dir.join(name);
    let _ = std::fs::create_dir_all(dir);
    if let Ok(m) = std::fs::metadata(&p) {
        if m.len() > 2 * 1024 * 1024 {
            let _ = std::fs::rename(&p, dir.join(format!("{name}.1")));
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
    {
        let _ = writeln!(f, "{line}");
    }
}

/// 本地时间戳 HH:MM:SS（不引 chrono，省编译）
pub(crate) fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600 + 8) % 24; // UTC+8
    format!("{h:02}:{m:02}:{s:02}")
}

/// 逐段 safe_join：拒绝 `..` / 盘符 / 绝对路径，算法上不可能越界（R8.4 口径）
pub fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() || rel.contains('\\') || rel.contains('\0') {
        return None;
    }
    let mut out = root.to_path_buf();
    for seg in Path::new(rel).components() {
        match seg {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(out)
}
