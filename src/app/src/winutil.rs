//! Win32 进程/窗口/显示器的只读工具（桥、跟随、环境自检共用）

use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
    TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClientRect, GetWindowLongW, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible, SetLayeredWindowAttributes, SetWindowLongW, SetWindowPos, GWL_EXSTYLE,
    HWND_TOPMOST, LWA_ALPHA, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
};

pub const WS_EX_TRANSPARENT: i32 = 0x20;
pub const WS_EX_NOACTIVATE: i32 = 0x800_0000;

/// LAYERED 窗口必须调用一次 SLWA 才会被 DWM 渲染。tao 的 click-through
/// （set_ignore_cursor_events）只加 WS_EX_LAYERED|WS_EX_TRANSPARENT 不调 SLWA，
/// 整窗内容不可见（M0 spike 实证）。alpha=255：透明度完全交给页面自身；
/// 命中测试按像素 alpha：HUD 不透明处吃点击，透明处穿透到下层窗口。
pub fn layered_commit_visible(hwnd: isize) {
    unsafe {
        SetLayeredWindowAttributes(hwnd as _, 0, 255, LWA_ALPHA);
    }
}

/// 硬置顶兜底：有些游戏会抢 topmost，跟随线程可周期性重调
pub fn force_topmost(hwnd: isize) {
    unsafe {
        SetWindowPos(
            hwnd as _,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
}

/// 非 LAYERED 路线的穿透位备用方案（当前主路线是 set_ignore_cursor_events + SLWA）
pub fn add_click_through_bits(hwnd: isize) {
    unsafe {
        let cur = GetWindowLongW(hwnd as _, GWL_EXSTYLE);
        SetWindowLongW(hwnd as _, GWL_EXSTYLE, cur | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE);
    }
}

/// 按进程名（大小写不敏感）找 pid
pub fn find_pid_by_name(exe_name: &str) -> Option<u32> {
    let exe = exe_name.to_ascii_lowercase();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap.is_null() || snap as isize == -1 {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let name = String::from_utf16_lossy(
                    &entry.szExeFile[..entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(0)],
                )
                .to_ascii_lowercase();
                if name == exe {
                    return Some(entry.th32ProcessID);
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
    }
    None
}

pub fn process_running(exe_name: &str) -> bool {
    find_pid_by_name(exe_name).is_some()
}

/// 某 pid 下面积最大的可见窗口，保留窗口句柄（R10 失焦隐藏需要用 hwnd
/// 对比 GetForegroundWindow）。最小化窗口也计入候选（只比 IsWindowVisible），
/// 由调用方用 is_iconic 判断——否则游戏最小化时会误报"窗口消失"。
pub fn find_main_window(pid: u32) -> Option<(isize, (i32, i32, i32, i32))> {
    struct Ctx {
        pid: u32,
        best: Option<(isize, (i32, i32, i32, i32))>,
        best_area: i64,
    }
    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = unsafe { &mut *(lparam as *mut Ctx) };
        let mut wpid: u32 = 0;
        unsafe { GetWindowThreadProcessId(hwnd, &mut wpid) };
        if wpid != ctx.pid {
            return 1;
        }
        unsafe {
            if IsWindowVisible(hwnd) == 0 {
                return 1;
            }
            let mut rc = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            if GetClientRect(hwnd, &mut rc) == 0 {
                return 1;
            }
            let w = (rc.right - rc.left) as i64;
            let h = (rc.bottom - rc.top) as i64;
            let area = w * h;
            if w < 200 || h < 150 || area <= ctx.best_area {
                return 1;
            }
            let mut pt = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
            if ClientToScreen(hwnd, &mut pt) == 0 {
                return 1;
            }
            ctx.best_area = area;
            ctx.best = Some((hwnd as isize, (pt.x, pt.y, w as i32, h as i32)));
        }
        1
    }
    let mut ctx = Ctx { pid, best: None, best_area: 0 };
    unsafe { EnumWindows(Some(cb), &mut ctx as *mut Ctx as LPARAM) };
    ctx.best
}

/// 当前前台窗口（0 = 无）。失焦判定：foreground != 游戏窗口
pub fn foreground_hwnd() -> isize {
    unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() as isize }
}

pub fn is_iconic_w(hwnd: isize) -> bool {
    unsafe { IsIconic(hwnd as _) != 0 }
}

/// 窗口所属进程 pid（0 = 取不到）。R23：前台判据要认"同进程的其它顶层窗口"
/// （Esc/选项菜单），不能只比句柄。
pub fn window_pid(hwnd: isize) -> u32 {
    if hwnd == 0 {
        return 0;
    }
    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd as _, &mut pid) };
    pid
}

/// 全局光标位置（R13 光标指示器：只读本进程 API，不碰游戏）
pub fn cursor_pos() -> Option<(i32, i32)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt = POINT { x: 0, y: 0 };
    unsafe {
        if GetCursorPos(&mut pt) != 0 {
            Some((pt.x, pt.y))
        } else {
            None
        }
    }
}

/// 窗口客户区屏幕原点（把全局光标换算成覆盖层页内坐标用）
pub fn client_origin(hwnd: isize) -> Option<(i32, i32)> {
    let mut pt = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
    unsafe {
        if ClientToScreen(hwnd as _, &mut pt) != 0 {
            Some((pt.x, pt.y))
        } else {
            None
        }
    }
}

/// 窗口 DPI 缩放（物理像素 → CSS 像素）
pub fn dpi_scale(hwnd: isize) -> f64 {
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    let dpi = unsafe { GetDpiForWindow(hwnd as _) };
    if dpi == 0 {
        1.0
    } else {
        dpi as f64 / 96.0
    }
}

/// 主显示器分辨率（环境自检用）
pub fn primary_monitor_size() -> Option<(u32, u32)> {
    use windows_sys::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
        MONITOR_DEFAULTTOPRIMARY,
    };

    unsafe extern "system" fn cb(_hm: HMONITOR, _dc: HDC, _r: *mut RECT, l: LPARAM) -> BOOL {
        unsafe {
            let mut info: MONITORINFOEXW = std::mem::zeroed();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            if GetMonitorInfoW(_hm, &mut info.monitorInfo) != 0
                && (info.monitorInfo.dwFlags & 1) != 0
            {
                let out = &mut *(l as *mut (u32, u32));
                *out = (
                    (info.monitorInfo.rcMonitor.right - info.monitorInfo.rcMonitor.left) as u32,
                    (info.monitorInfo.rcMonitor.bottom - info.monitorInfo.rcMonitor.top) as u32,
                );
            }
        }
        1
    }
    let mut out = (0u32, 0u32);
    unsafe {
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(cb),
            &mut out as *mut (u32, u32) as LPARAM,
        );
        let _ = MONITOR_DEFAULTTOPRIMARY;
    }
    if out.0 > 0 {
        Some(out)
    } else {
        None
    }
}

/// 读 PE 头 TimeDateStamp（桥 preflight 同款口径：YR 1.001 = 0x3BDF544E）
pub fn pe_timestamp(exe: &std::path::Path) -> Option<u32> {
    let data = std::fs::read(exe).ok()?;
    if data.len() < 0x40 {
        return None;
    }
    let lfanew = u32::from_le_bytes([data[0x3c], data[0x3d], data[0x3e], data[0x3f]]) as usize;
    if lfanew + 8 > data.len() {
        return None;
    }
    Some(u32::from_le_bytes([
        data[lfanew + 4],
        data[lfanew + 5],
        data[lfanew + 6],
        data[lfanew + 7],
    ]))
}
