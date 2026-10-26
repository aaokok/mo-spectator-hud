//! hud_bridge.exe 生命周期管理：
//! - 外部实例探测（在跑就不拉起、退出不回收）
//! - Job 对象 KILL_ON_JOB_CLOSE：mo_hud 被强杀/崩溃时内核自动终结桥，无孤儿进程
//! - 崩溃退避重启（1s/5s/30s 循环），每次重启重读 ini 的 interval（频率切换即生效）
//! （对应 06-EXE架构设计.md §5）

use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use win32job::{ExtendedLimitInfo, Job};
use std::os::windows::io::AsRawHandle;

use crate::config::AppState;

const BRIDGE_PROC: &str = "hud_bridge.exe";
const BACKOFF_MS: &[u64] = &[1_000, 5_000, 30_000];

static CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
static JOB: OnceLock<Mutex<Option<Job>>> = OnceLock::new();

fn child_slot() -> &'static Mutex<Option<Child>> {
    CHILD.get_or_init(|| Mutex::new(None))
}
fn job_slot() -> &'static Mutex<Option<Job>> {
    JOB.get_or_init(|| Mutex::new(None))
}

/// 入口：在独立线程调用（setup 里 spawn）。内部含看护循环，永不返回。
pub fn launch(state: std::sync::Arc<AppState>) {
    if crate::winutil::process_running(BRIDGE_PROC) {
        let mut b = state.bridge.lock().unwrap();
        b.external = true;
        b.running = true;
        state.log("检测到外部 hud_bridge.exe 实例：不拉起、不回收（退出时保留）");
        return;
    }
    let interval = state.ini.lock().unwrap().interval_ms;
    spawn_bridge(&state, interval);
    watch_loop(state);
}

/// 频率切换：ini 已由调用方更新，杀掉托管实例，看护线程会以新 interval 拉起
pub fn restart_with_interval(state: &std::sync::Arc<AppState>, interval: u32) {
    if state.bridge.lock().unwrap().external {
        state.log("数据桥为外部实例，频率切换不生效（请手动重启外部桥）");
        return;
    }
    state.log(format!("按新频率 {interval}ms 重启数据桥"));
    kill_ours(state);
}

fn kill_ours(state: &std::sync::Arc<AppState>) {
    let mut slot = child_slot().lock().unwrap();
    if let Some(child) = slot.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
        state.log("已终止托管的数据桥");
    }
    *slot = None;
}

fn spawn_bridge(state: &std::sync::Arc<AppState>, interval: u32) {
    let exe = state.paths.bridge_exe();
    if !exe.is_file() {
        state.log(format!("数据桥不存在: {}", exe.display()));
        return;
    }
    let out = state.paths.state_json();
    if let Some(parent) = out.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut cmd = Command::new(&exe);
    cmd.args([
        "--interval",
        &interval.to_string(),
        "--out",
        &out.to_string_lossy(),
        "--no-text",
    ])
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
            if let Ok(job) = Job::create() {
                let mut info = ExtendedLimitInfo::new();
                info.limit_kill_on_job_close();
                if job.set_extended_limit_info(&info).is_ok()
                    && job.assign_process(child.as_raw_handle() as _).is_ok()
                {
                    *job_slot().lock().unwrap() = Some(job);
                    state.log("数据桥已挂入 Job 对象（KILL_ON_JOB_CLOSE）");
                }
            }
            // stdout 回捕进日志
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
            state.bridge.lock().unwrap().running = true;
            state
                .log(format!("数据桥已启动（interval={interval}ms, pid={:?}）", child.id()));
            *child_slot().lock().unwrap() = Some(child);
        }
        Err(e) => state.log(format!("数据桥启动失败: {e}")),
    }
}

fn watch_loop(state: std::sync::Arc<AppState>) {
    let mut attempt = 0usize;
    loop {
        std::thread::sleep(Duration::from_millis(500));
        let mut slot = child_slot().lock().unwrap();
        let exited = match slot.as_mut() {
            None => true,
            Some(child) => match child.try_wait() {
                Ok(Some(status)) => {
                    state.log(format!(
                        "数据桥退出（{status}），退避 {}ms 后重启",
                        BACKOFF_MS[attempt.min(BACKOFF_MS.len() - 1)]
                    ));
                    true
                }
                Ok(None) => false,
                Err(e) => {
                    state.log(format!("数据桥 wait 失败: {e}"));
                    true
                }
            },
        };
        if exited {
            *slot = None;
            drop(slot);
            state.bridge.lock().unwrap().restarts += 1;
            std::thread::sleep(Duration::from_millis(
                BACKOFF_MS[attempt.min(BACKOFF_MS.len() - 1)],
            ));
            attempt = (attempt + 1).min(BACKOFF_MS.len() - 1);
            let interval = state.ini.lock().unwrap().interval_ms;
            spawn_bridge(&state, interval);
        } else {
            attempt = 0;
        }
    }
}
