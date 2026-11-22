//! hud_bridge.exe 生命周期管理：
//! - 外部实例探测（在跑就不拉起、退出不回收）
//! - Job 对象 KILL_ON_JOB_CLOSE：mo_hud 被强杀/崩溃时内核自动终结桥，无孤儿进程
//! - 崩溃退避重启（1s/5s/30s 循环），每次重启重读 ini 的 interval（频率切换即生效）
//! （对应 06-EXE架构设计.md §5）

use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

use win32job::{ExtendedLimitInfo, Job};
use std::os::windows::io::AsRawHandle;

use crate::config::AppState;

const BRIDGE_PROC: &str = "hud_bridge.exe";
const BACKOFF_MS: &[u64] = &[1_000, 5_000, 30_000];
const EXTERNAL_POLL_MS: u64 = 2_000;
const MISSING_RETRY_MS: u64 = 5_000;

static CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
static JOB: OnceLock<Mutex<Option<Job>>> = OnceLock::new();
static WAKE: OnceLock<(Mutex<u64>, Condvar)> = OnceLock::new();
static RESTART_REQUESTED: AtomicBool = AtomicBool::new(false);
static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);
static MISSING_LOGGED: AtomicBool = AtomicBool::new(false);

fn child_slot() -> &'static Mutex<Option<Child>> {
    CHILD.get_or_init(|| Mutex::new(None))
}
fn job_slot() -> &'static Mutex<Option<Job>> {
    JOB.get_or_init(|| Mutex::new(None))
}
fn wake_pair() -> &'static (Mutex<u64>, Condvar) {
    WAKE.get_or_init(|| (Mutex::new(0), Condvar::new()))
}

fn notify_wake() {
    let (mu, cv) = wake_pair();
    let mut gen = mu.lock().unwrap_or_else(|e| e.into_inner());
    *gen = gen.wrapping_add(1);
    cv.notify_all();
}

/// 可被主动重启或应用退出立刻打断的等待（替代硬 sleep 防止 30s 退避卡死改频）。
fn wait_interruptible(ms: u64) -> bool {
    let (mu, cv) = wake_pair();
    let gen = mu.lock().unwrap_or_else(|e| e.into_inner());
    let start = *gen;
    if STOP_REQUESTED.load(Ordering::Acquire) || RESTART_REQUESTED.load(Ordering::Acquire) {
        return true;
    }
    let (after, _) = cv
        .wait_timeout_while(gen, Duration::from_millis(ms), |g| {
            *g == start
                && !STOP_REQUESTED.load(Ordering::Acquire)
                && !RESTART_REQUESTED.load(Ordering::Acquire)
        })
        .unwrap_or_else(|e| e.into_inner());
    *after != start
        || STOP_REQUESTED.load(Ordering::Acquire)
        || RESTART_REQUESTED.load(Ordering::Acquire)
}

/// 入口：在独立线程调用（setup 里 spawn）。内部含看护循环，直到 shutdown() 被调用。
pub fn launch(state: std::sync::Arc<AppState>) {
    STOP_REQUESTED.store(false, Ordering::Release);
    if crate::winutil::process_running(BRIDGE_PROC) {
        let mut b = state.bridge.lock().unwrap();
        b.external = true;
        b.running = true;
        b.ours = false;
        drop(b);
        state.log("检测到外部 hud_bridge.exe 实例：不拉起、不回收（若外部退出将自动接管）");
    } else {
        let interval = state.ini.lock().unwrap().interval_ms;
        spawn_bridge(&state, interval);
    }
    watch_loop(state);
}

/// 频率切换：ini 已由调用方更新，标记主动重启、杀旧进程并立即唤醒看护线程（不进退避、不计崩溃重启）。
pub fn restart_with_interval(state: &std::sync::Arc<AppState>, interval: u32) {
    if state.bridge.lock().unwrap().external {
        state.log("数据桥为外部实例，频率切换不生效（请手动重启外部桥）");
        return;
    }
    state.log(format!("按新频率 {interval}ms 重启数据桥"));
    RESTART_REQUESTED.store(true, Ordering::Release);
    kill_ours(state);
    notify_wake();
}

/// 应用退出前调用：停止看护循环并显式回收托管子进程（即使 Job 创建失败也不留孤儿）。
pub fn shutdown(state: &std::sync::Arc<AppState>) {
    STOP_REQUESTED.store(true, Ordering::Release);
    notify_wake();
    let is_ext = state.bridge.lock().unwrap().external;
    if !is_ext {
        kill_ours(state);
    }
}

fn kill_ours(state: &std::sync::Arc<AppState>) {
    {
        let mut slot = child_slot().lock().unwrap();
        if let Some(child) = slot.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
            state.log("已终止托管的数据桥");
        }
        *slot = None;
    }
    // 托管实例已不存在：ours/running 同步落回 false，否则控制台会一直显示"托管运行中/Job 陪葬"
    let mut b = state.bridge.lock().unwrap();
    b.running = false;
    b.ours = false;
}

fn init_unit_count_rules(path: &std::path::Path, contents: &[u8]) -> std::io::Result<bool> {
    use std::io::Write;
    let temporary = path.with_extension(format!("ini.{}.tmp", std::process::id()));
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
    let written = file.write_all(contents).and_then(|_| file.sync_all());
    drop(file);
    let result = written.and_then(|_| {
        // 同卷 NTFS 优先用硬链接原子发布；FAT32/exFAT 等不支持硬链接的文件系统回退 create_new 原子创建，
        // 两条路径在目标已存在时均返回 Ok(false)，绝不覆盖用户编辑。
        match std::fs::hard_link(&temporary, path) {
            Ok(()) => Ok(true),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(_) => match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
                Ok(mut dst) => dst.write_all(contents).and_then(|_| dst.sync_all()).map(|()| true),
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
                Err(err) => Err(err),
            },
        }
    });
    let cleanup = std::fs::remove_file(&temporary);
    match (result, cleanup) {
        (Err(err), _) | (Ok(_), Err(err)) => Err(err),
        (Ok(created), Ok(())) => Ok(created),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_count_rules_init_preserves_user_edits() {
        let directory = std::env::temp_dir().join(format!("mo-unit-rules-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("unit_count_rules.ini");
        assert!(init_unit_count_rules(&path, b"default").unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), b"default");
        std::fs::write(&path, b"edited").unwrap();
        assert!(!init_unit_count_rules(&path, b"new template").unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), b"edited");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn wait_interruptible_wakes_immediately_on_restart_request() {
        STOP_REQUESTED.store(false, Ordering::Release);
        RESTART_REQUESTED.store(false, Ordering::Release);
        let t0 = std::time::Instant::now();
        let handle = std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(40));
            RESTART_REQUESTED.store(true, Ordering::Release);
            notify_wake();
        });
        let woke = wait_interruptible(5_000);
        handle.join().unwrap();
        RESTART_REQUESTED.store(false, Ordering::Release);
        assert!(woke, "主动重启信号必须立即唤醒等待线程");
        assert!(
            t0.elapsed() < Duration::from_millis(1_000),
            "唤醒耗时过长: {:?}",
            t0.elapsed()
        );
    }
}

/// 返回 true 表示成功拉起子进程；false 表示缺可执行文件或拉起失败。
fn spawn_bridge(state: &std::sync::Arc<AppState>, interval: u32) -> bool {
    let exe = state.paths.bridge_exe();
    if !exe.is_file() {
        if !MISSING_LOGGED.swap(true, Ordering::AcqRel) {
            state.log(format!("数据桥不存在: {}", exe.display()));
        }
        return false;
    }
    MISSING_LOGGED.store(false, Ordering::Release);
    let out = state.paths.state_json();
    if let Some(parent) = out.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let rules = state.paths.unit_count_rules();
    if !rules.exists() {
        // 安装包只更新 default 模板；create_new 保证初始化不覆盖已有用户规则。
        let initial = std::fs::read(state.paths.toolkit_dir.join("unit_count_rules.default.ini"))
            .unwrap_or_else(|_| include_bytes!("../../bridge/unit_count_rules.default.ini").to_vec());
        match init_unit_count_rules(&rules, &initial) {
            Ok(true) => state.log(format!("已初始化单位计数规则: {}", rules.display())),
            Ok(false) => {}
            Err(err) => state.log(format!("单位计数规则创建失败: {err}；桥将使用内置默认规则")),
        }
    }
    let mut cmd = Command::new(&exe);
    cmd.args([
        "--interval",
        &interval.to_string(),
        "--out",
        &out.to_string_lossy(),
        "--no-text",
    ])
    .arg("--unit-count-rules")
    .arg(&rules)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    // 桥是控制台程序：不弹黑框
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match cmd.spawn() {
        Ok(mut child) => {
            // Job 陪葬：句柄故意常驻（本进程退出时 OS 关闭 job → 桥被终结）
            let mut in_job = false;
            if let Ok(job) = Job::create() {
                let mut info = ExtendedLimitInfo::new();
                info.limit_kill_on_job_close();
                if job.set_extended_limit_info(&info).is_ok()
                    && job.assign_process(child.as_raw_handle() as _).is_ok()
                {
                    *job_slot().lock().unwrap() = Some(job);
                    in_job = true;
                    state.log("数据桥已挂入 Job 对象（KILL_ON_JOB_CLOSE）");
                }
            }
            // stdout/stderr 回捕进日志。stderr 必须一并读走：管道写满（约 4KB）后
            // 子进程会阻塞在写调用上，表现为桥"活着但不再出数"。
            if let Some(out) = child.stdout.take() {
                let st = state.clone();
                std::thread::spawn(move || {
                    use std::io::{BufRead, BufReader};
                    let reader = BufReader::new(out);
                    for line in reader.lines().map_while(Result::ok) {
                        if !line.trim().is_empty() {
                            st.log(format!("[bridge] {line}"));
                        }
                    }
                });
            }
            if let Some(err) = child.stderr.take() {
                let st = state.clone();
                std::thread::spawn(move || {
                    use std::io::{BufRead, BufReader};
                    let reader = BufReader::new(err);
                    for line in reader.lines().map_while(Result::ok) {
                        if !line.trim().is_empty() {
                            st.log(format!("[bridge:err] {line}"));
                        }
                    }
                });
            }
            {
                // ours 的语义是"在 Job 里"，不是"我起的"——挂 Job 失败时如实报未挂
                let mut b = state.bridge.lock().unwrap();
                b.running = true;
                b.ours = in_job;
                b.external = false;
            }
            state
                .log(format!("数据桥已启动（interval={interval}ms, pid={:?}）", child.id()));
            *child_slot().lock().unwrap() = Some(child);
            true
        }
        Err(e) => {
            state.log(format!("数据桥启动失败: {e}"));
            false
        }
    }
}

fn watch_loop(state: std::sync::Arc<AppState>) {
    let mut attempt = 0usize;
    loop {
        if STOP_REQUESTED.load(Ordering::Acquire) {
            break;
        }
        let is_ext = state.bridge.lock().unwrap().external;
        if is_ext {
            wait_interruptible(EXTERNAL_POLL_MS);
            if STOP_REQUESTED.load(Ordering::Acquire) {
                break;
            }
            if !crate::winutil::process_running(BRIDGE_PROC) {
                {
                    let mut b = state.bridge.lock().unwrap();
                    b.external = false;
                    b.running = false;
                    b.ours = false;
                }
                state.log("外部 hud_bridge.exe 已退出，切换为托管模式并重新拉起");
                attempt = 0;
                let interval = state.ini.lock().unwrap().interval_ms;
                spawn_bridge(&state, interval);
            }
            continue;
        }

        wait_interruptible(500);
        if STOP_REQUESTED.load(Ordering::Acquire) {
            break;
        }

        // 主动改频重启：立即以新 interval 重拉，不累增重启计数、不进崩溃退避
        if RESTART_REQUESTED.swap(false, Ordering::AcqRel) {
            attempt = 0;
            let interval = state.ini.lock().unwrap().interval_ms;
            spawn_bridge(&state, interval);
            continue;
        }

        let mut slot = child_slot().lock().unwrap();
        let (exited, had_child) = match slot.as_mut() {
            None => (true, false),
            Some(child) => match child.try_wait() {
                Ok(Some(status)) => {
                    if !RESTART_REQUESTED.load(Ordering::Acquire) && !STOP_REQUESTED.load(Ordering::Acquire) {
                        state.log(format!(
                            "数据桥退出（{status}），退避 {}ms 后重启",
                            BACKOFF_MS[attempt.min(BACKOFF_MS.len() - 1)]
                        ));
                    }
                    (true, true)
                }
                Ok(None) => (false, true),
                Err(e) => {
                    state.log(format!("数据桥 wait 失败: {e}"));
                    (true, true)
                }
            },
        };
        if exited {
            *slot = None;
            drop(slot);
            if STOP_REQUESTED.load(Ordering::Acquire) {
                break;
            }
            if RESTART_REQUESTED.swap(false, Ordering::AcqRel) {
                attempt = 0;
                let interval = state.ini.lock().unwrap().interval_ms;
                spawn_bridge(&state, interval);
                continue;
            }
            {
                let mut b = state.bridge.lock().unwrap();
                b.running = false;
                b.ours = false;
                if had_child {
                    b.restarts += 1;
                }
            }
            let wait_ms = if had_child {
                BACKOFF_MS[attempt.min(BACKOFF_MS.len() - 1)]
            } else {
                MISSING_RETRY_MS
            };
            wait_interruptible(wait_ms);
            if STOP_REQUESTED.load(Ordering::Acquire) {
                break;
            }
            if RESTART_REQUESTED.swap(false, Ordering::AcqRel) {
                attempt = 0;
            } else if had_child {
                attempt = (attempt + 1).min(BACKOFF_MS.len() - 1);
            }
            let interval = state.ini.lock().unwrap().interval_ms;
            spawn_bridge(&state, interval);
        } else {
            attempt = 0;
        }
    }
}
