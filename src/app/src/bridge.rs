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
        // 同卷链接发布完整文件，目标已存在则保留原文件，永不覆盖用户编辑。
        match std::fs::hard_link(&temporary, path) {
            Ok(()) => Ok(true),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(err) => Err(err),
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
    use super::init_unit_count_rules;

    #[test]
    fn unit_count_rules_init_preserves_user_edits() {
        let directory = std::env::temp_dir().join(format!("mo-unit-rules-{}", std::process::id()));
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
            {
                // 退避/重启期间桥已不在：状态必须同步落回，否则控制台显示与实际相反
                let mut b = state.bridge.lock().unwrap();
                b.running = false;
                b.ours = false;
                b.restarts += 1;
            }
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
