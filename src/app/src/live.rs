//! 桥状态只读分发：唯一文件观察者 → latest cache → 独立业务 SSE。
//! 不改变桥字段；ts 是桥的 tick，不作为墙钟时间解释。

use std::convert::Infallible;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::response::sse::Event;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::watch;
use tokio_stream::wrappers::WatchStream;
use tokio_stream::Stream;

const CHECK_INTERVAL: Duration = Duration::from_millis(20);
const IDLE_CHECK_INTERVAL: Duration = Duration::from_millis(80);
const HEALTH_INTERVAL: Duration = Duration::from_secs(1);
static SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);

fn new_session() -> String {
    let epoch = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let serial = SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}-{:x}-{serial:x}", std::process::id(), epoch.as_nanos())
}

#[derive(Clone, Debug)]
struct SourceAge {
    initial: Duration,
    at: Instant,
}

impl SourceAge {
    fn age_ms(&self, now: Instant) -> u64 {
        self.initial
            .saturating_add(now.saturating_duration_since(self.at))
            .as_millis()
            .min(u64::MAX as u128) as u64
    }
}

#[derive(Clone, Debug, PartialEq)]
struct SourceSignature([Value; 4]);

impl SourceSignature {
    fn of(data: &Value) -> Self {
        Self(["ts", "frame", "pid", "phase"].map(|key| data[key].clone()))
    }
}

#[derive(Debug)]
struct Snapshot {
    data: Arc<Value>,
    compact_json: Arc<str>,
    raw: Arc<[u8]>,
    mtime_ms: u64,
    signature: SourceSignature,
    age: SourceAge,
}

#[derive(Clone, Debug)]
struct CacheState {
    session: String,
    seq: u64,
    snapshot: Option<Arc<Snapshot>>,
    error: Option<String>,
}

impl CacheState {
    fn new() -> Self {
        Self { session: new_session(), seq: 0, snapshot: None, error: None }
    }

    /// 保留旧桥形状：ok/players 是基本契约，phase 等可缺，未知字段原样保留。
    fn accept(
        &mut self,
        raw: Vec<u8>,
        mtime: SystemTime,
        wall_now: SystemTime,
        now: Instant,
    ) -> Result<bool, String> {
        let bytes_changed = self
            .snapshot
            .as_ref()
            .map(|s| s.raw.as_ref() != raw.as_slice())
            .unwrap_or(true);
        if !bytes_changed {
            // 原文字节完全一致：跳过 JSON 解析与深度比较，只清理可能存在的旧错
            let recovered = self.error.take().is_some();
            return Ok(recovered);
        }
        let data: Value = serde_json::from_slice(&raw).map_err(|e| format!("状态 JSON 无效: {e}"))?;
        if !data.is_object() {
            return Err("状态 JSON 必须是对象".into());
        }
        if !data["ok"].is_boolean() || !data["players"].is_array() {
            return Err("状态 JSON 必须包含 ok 布尔值和 players 数组".into());
        }
        let signature = SourceSignature::of(&data);
        let previous = self.snapshot.as_ref();
        let content_changed = previous.map(|s| s.data.as_ref() != &data).unwrap_or(true);
        let _recovered = self.error.take().is_some();
        // 首份文件可能早已陈旧；以后只认签名推进，用单调钟累计年龄。
        // 同签名即使其它字段变化/文件被重写，也不能洗掉停摆时间。
        // mtime 只初始化年龄，不拿墙钟推算桥 ts。
        let initial = wall_now.duration_since(mtime).unwrap_or_default();
        let age = match previous {
            Some(old) if old.signature == signature => old.age.clone(),
            Some(_) => SourceAge { initial: Duration::ZERO, at: now },
            None => SourceAge { initial, at: now },
        };
        let compact_json: Arc<str> = if content_changed {
            serde_json::to_string(&data)
                .map_err(|e| format!("状态 JSON 序列化失败: {e}"))?
                .into()
        } else {
            previous.expect("previous 必存在").compact_json.clone()
        };
        let mtime_ms = mtime
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if content_changed {
            self.seq += 1;
        }
        self.snapshot = Some(Arc::new(Snapshot {
            data: Arc::new(data),
            compact_json,
            raw: raw.into(),
            mtime_ms,
            signature,
            age,
        }));
        Ok(true)
    }

    fn fail(&mut self, error: String) -> bool {
        if self.error.as_ref() == Some(&error) {
            return false;
        }
        self.error = Some(error);
        true
    }

    fn source_age_ms(&self, now: Instant) -> Option<u64> {
        self.snapshot.as_ref().map(|s| s.age.age_ms(now))
    }
}

struct LiveInner {
    latest: watch::Sender<Arc<CacheState>>,
    started: AtomicBool,
}

#[derive(Clone)]
pub struct LiveCache {
    inner: Arc<LiveInner>,
}

impl LiveCache {
    pub fn new() -> Self {
        let (latest, _) = watch::channel(Arc::new(CacheState::new()));
        Self { inner: Arc::new(LiveInner { latest, started: AtomicBool::new(false) }) }
    }

    /// 只在监听端口绑定成功后取一次任务；不依赖订阅者数量启动/停止。
    pub fn watcher(&self, path: PathBuf) -> Option<impl Future<Output = ()> + Send + 'static> {
        if self.inner.started.swap(true, Ordering::AcqRel) {
            return None;
        }
        Some(observe(self.clone(), path))
    }

    fn accept(&self, raw: Vec<u8>, mtime: SystemTime, wall_now: SystemTime, now: Instant) -> bool {
        let mut current = (**self.inner.latest.borrow()).clone();
        match current.accept(raw, mtime, wall_now, now) {
            Ok(changed) => {
                if changed {
                    // send_replace 在尚无连接时也保留最后成功快照。
                    self.inner.latest.send_replace(Arc::new(current));
                }
                true
            }
            Err(error) => {
                self.fail(error);
                false
            }
        }
    }

    fn fail(&self, error: String) {
        self.inner.latest.send_if_modified(|current| {
            let mut next = (**current).clone();
            if !next.fail(error) {
                return false;
            }
            *current = Arc::new(next);
            true
        });
    }

    /// HTTP fallback 只在原文字节完全匹配缓存时附加年龄，绝不混用两个版本。
    pub fn source_age_ms_for_bytes(&self, raw: &[u8]) -> Option<u64> {
        let state = self.inner.latest.borrow();
        let snapshot = state.snapshot.as_ref()?;
        (snapshot.raw.as_ref() == raw).then(|| snapshot.age.age_ms(Instant::now()))
    }

    /// 供 /app/status 与 /app/summary 零磁盘 I/O 读取最新已解析快照与文件时间。
    pub fn latest_snapshot(&self) -> Option<(Arc<Value>, u64)> {
        let state = self.inner.latest.borrow();
        let snapshot = state.snapshot.as_ref()?;
        Some((snapshot.data.clone(), snapshot.mtime_ms))
    }

    fn has_subscribers(&self) -> bool {
        self.inner.latest.receiver_count() > 0
    }

    #[cfg(test)]
    pub(crate) fn seed_for_test(&self, raw: Vec<u8>, mtime: SystemTime, now: Instant) -> bool {
        self.accept(raw, mtime, mtime, now)
    }

    pub fn stream(&self) -> LiveStream {
        let mut health = tokio::time::interval_at(
            tokio::time::Instant::now() + HEALTH_INTERVAL,
            HEALTH_INTERVAL,
        );
        health.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let receiver = self.inner.latest.subscribe();
        let current = receiver.borrow().clone();
        LiveStream {
            updates: WatchStream::new(receiver),
            initial_health: current.snapshot.is_none(),
            current,
            health,
            health_due: false,
            last_seq: None,
            last_error: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
}

impl FileStamp {
    async fn read(path: &Path) -> Result<Self, String> {
        let meta = tokio::fs::metadata(path).await.map_err(|e| format!("状态文件不可用: {e}"))?;
        let modified = meta.modified().map_err(|e| format!("状态文件时间不可用: {e}"))?;
        Ok(Self { len: meta.len(), modified, created: meta.created().ok() })
    }
}

const ERROR_BACKOFF_MS: [u64; 5] = [20, 50, 100, 250, 500];

/// 失败不提交文件标识，并按指数退避重试，避免损坏文件/非 UTF-8 触发 50 Hz 刷盘风暴。
async fn observe(cache: LiveCache, path: PathBuf) {
    let mut previous: Option<FileStamp> = None;
    let mut last_failed_stamp: Option<FileStamp> = None;
    let mut retry = true;
    let mut err_streak: usize = 0;
    loop {
        let delay = if err_streak == 0 {
            if cache.has_subscribers() || retry {
                CHECK_INTERVAL
            } else {
                IDLE_CHECK_INTERVAL
            }
        } else {
            Duration::from_millis(ERROR_BACKOFF_MS[err_streak.min(ERROR_BACKOFF_MS.len() - 1)])
        };
        tokio::time::sleep(delay).await;

        let stamp = match FileStamp::read(&path).await {
            Ok(stamp) => stamp,
            Err(error) => {
                retry = true;
                last_failed_stamp = None;
                err_streak = (err_streak + 1).min(ERROR_BACKOFF_MS.len() - 1);
                cache.fail(error);
                continue;
            }
        };
        if !retry && previous.as_ref() == Some(&stamp) {
            err_streak = 0;
            continue;
        }
        // 文件元信息在出错后发生了变化，立刻清零退避以尽快恢复。
        if last_failed_stamp.as_ref() != Some(&stamp) {
            err_streak = 0;
        }
        let raw = match tokio::fs::read(&path).await {
            Ok(raw) => raw,
            Err(error) => {
                retry = true;
                last_failed_stamp = Some(stamp);
                err_streak = (err_streak + 1).min(ERROR_BACKOFF_MS.len() - 1);
                cache.fail(format!("状态文件读取失败: {error}"));
                continue;
            }
        };
        // 原子替换或写入与读取交错时，不把不确定版本的 mtime 交给缓存。
        match FileStamp::read(&path).await {
            Ok(after) if after == stamp => {}
            Ok(_) => {
                retry = true;
                last_failed_stamp = None;
                err_streak = (err_streak + 1).min(ERROR_BACKOFF_MS.len() - 1);
                cache.fail("状态文件读取期间发生变化".into());
                continue;
            }
            Err(error) => {
                retry = true;
                last_failed_stamp = None;
                err_streak = (err_streak + 1).min(ERROR_BACKOFF_MS.len() - 1);
                cache.fail(error);
                continue;
            }
        }
        retry = !cache.accept(raw, stamp.modified, SystemTime::now(), Instant::now());
        if !retry {
            previous = Some(stamp);
            last_failed_stamp = None;
            err_streak = 0;
        } else {
            last_failed_stamp = Some(stamp);
            err_streak = (err_streak + 1).min(ERROR_BACKOFF_MS.len() - 1);
        }
    }
}

#[derive(Serialize)]
struct HealthEvent<'a> {
    session: &'a str,
    seq: u64,
    source_age_ms: Option<u64>,
    error: Option<&'a str>,
}

/// 无连接后台任务、无 FIFO。WatchStream 只保留最新完整状态；连接 drop 即释放
/// receiver 和健康计时器。快照主体已在 accept() 预序列化一次，多连接直接复用。
pub struct LiveStream {
    updates: WatchStream<Arc<CacheState>>,
    current: Arc<CacheState>,
    health: tokio::time::Interval,
    initial_health: bool,
    health_due: bool,
    last_seq: Option<u64>,
    last_error: Option<Option<String>>,
}

impl Stream for LiveStream {
    type Item = Result<Event, Infallible>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        // 读到最新值并注册下一次唤醒；不把已经过时的快照逐个交给慢连接。
        while let Poll::Ready(Some(current)) = Pin::new(&mut this.updates).poll_next(cx) {
            this.current = current;
        }
        if this.health.poll_tick(cx).is_ready() {
            this.health_due = true;
        }
        let current = &this.current;
        let now = Instant::now();
        let health_changed = this.last_error.as_ref() != Some(&current.error);
        // 首次空缓存必须先 health；已输出过事件后，到期 health 不被连续快照饿死。
        let health_first = this.initial_health
            || (this.last_error.is_some() && (this.health_due || health_changed));
        if !health_first && this.last_seq != Some(current.seq) {
            if let Some(snapshot) = &current.snapshot {
                this.last_seq = Some(current.seq);
                if this.last_error.is_none() && current.error.is_none() {
                    this.last_error = Some(None);
                }
                let session_json =
                    serde_json::to_string(&current.session).expect("session 应可序列化");
                let payload = format!(
                    "{{\"session\":{session_json},\"seq\":{},\"source_age_ms\":{},\"data\":{}}}",
                    current.seq,
                    snapshot.age.age_ms(now),
                    snapshot.compact_json
                );
                let event = Event::default().event("snapshot").data(payload);
                return Poll::Ready(Some(Ok(event)));
            }
        }
        if this.initial_health || this.health_due || health_changed {
            this.initial_health = false;
            this.health_due = false;
            this.last_error = Some(current.error.clone());
            if current.snapshot.is_none() {
                this.last_seq = Some(current.seq);
            }
            let event = Event::default().event("health").json_data(HealthEvent {
                session: &current.session,
                seq: current.seq,
                source_age_ms: current.source_age_ms(now),
                error: current.error.as_deref(),
            }).expect("健康状态应可序列化");
            return Poll::Ready(Some(Ok(event)));
        }
        Poll::Pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::{IntoResponse, Sse};
    use serde_json::json;
    use tokio_stream::StreamExt;

    fn raw(ts: u64, frame: u64) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "schema": 2, "ok": true, "players": [],
            "ts": ts, "frame": frame, "pid": 42, "phase": "match",
        })).unwrap()
    }

    fn wall() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_000_000)
    }

    fn publish(cache: &LiveCache, ts: u64) {
        assert!(cache.accept(raw(ts, 7), wall(), wall(), Instant::now()));
    }

    async fn frame(stream: &mut LiveStream) -> (String, Value) {
        let event = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await.unwrap().unwrap().unwrap();
        // 经 axum 真正编码，既检查 named event，也检查线上 JSON 形状。
        let response = Sse::new(tokio_stream::iter([Ok::<_, Infallible>(event)]))
            .into_response();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        let name = text.lines().find_map(|s| s.strip_prefix("event: "))
            .unwrap().to_string();
        let data = text.lines().find_map(|s| s.strip_prefix("data: ")).unwrap();
        (name, serde_json::from_str(data).unwrap())
    }

    #[test]
    fn initial_old_mtime_and_future_mtime() {
        let now = Instant::now();
        let mut old = CacheState::new();
        old.accept(raw(1, 7), wall() - Duration::from_secs(120), wall(), now).unwrap();
        assert_eq!(old.seq, 1);
        assert_eq!(old.source_age_ms(now), Some(120_000));
        assert_eq!(old.source_age_ms(now + Duration::from_millis(750)), Some(120_750));
        let mut future = CacheState::new();
        future.accept(raw(1, 7), wall() + Duration::from_secs(120), wall(), now).unwrap();
        assert_eq!(future.source_age_ms(now), Some(0));
    }

    #[test]
    fn repeated_signature_does_not_refresh_age_or_sequence() {
        let now = Instant::now();
        let mut state = CacheState::new();
        state.accept(raw(1, 7), wall() - Duration::from_secs(60), wall(), now).unwrap();
        assert!(!state.accept(raw(1, 7), wall(), wall(), now + Duration::from_secs(5)).unwrap());
        assert_eq!(state.seq, 1);
        assert_eq!(state.source_age_ms(now + Duration::from_secs(5)), Some(65_000));
        // 仅格式不同不加 seq，但更新原文字节，使 HTTP 头仍能精确匹配。
        let value: Value = serde_json::from_slice(&raw(1, 7)).unwrap();
        let pretty = serde_json::to_vec_pretty(&value).unwrap();
        assert!(state.accept(pretty.clone(), wall(), wall(), now + Duration::from_secs(8)).unwrap());
        assert_eq!(state.seq, 1);
        assert_eq!(state.snapshot.as_ref().unwrap().raw.as_ref(), pretty.as_slice());
        assert_eq!(state.source_age_ms(now + Duration::from_secs(8)), Some(68_000));
    }

    #[test]
    fn content_change_increments_seq_but_same_signature_keeps_age() {
        let now = Instant::now();
        let mut state = CacheState::new();
        state.accept(raw(1, 7), wall(), wall(), now).unwrap();
        let mut data: Value = serde_json::from_slice(&raw(1, 7)).unwrap();
        data["extra"] = json!({"unknown": [1, 2, 3]});
        state.accept(serde_json::to_vec(&data).unwrap(), wall(), wall(), now + Duration::from_secs(4)).unwrap();
        assert_eq!(state.seq, 2);
        assert_eq!(state.snapshot.as_ref().unwrap().data.as_ref(), &data);
        assert_eq!(state.source_age_ms(now + Duration::from_secs(4)), Some(4_000));
    }

    #[test]
    fn paused_frame_with_advancing_ts_is_fresh_after_old_start() {
        let now = Instant::now();
        let mut state = CacheState::new();
        let mut data: Value = serde_json::from_slice(&raw(1, 7)).unwrap();
        data["paused"] = json!(true);
        state.accept(serde_json::to_vec(&data).unwrap(), wall() - Duration::from_secs(300), wall(), now).unwrap();
        data["ts"] = json!(2);
        let next = now + Duration::from_secs(10);
        state.accept(serde_json::to_vec(&data).unwrap(), wall(), wall(), next).unwrap();
        assert_eq!(state.seq, 2);
        assert_eq!(state.source_age_ms(next), Some(0));
        assert_eq!(state.source_age_ms(next + Duration::from_secs(3)), Some(3_000));
        for (key, value) in [("pid", json!(43)), ("phase", json!("post_match")), ("frame", json!(8))] {
            data[key] = value;
            state.accept(serde_json::to_vec(&data).unwrap(), wall(), wall(), next).unwrap();
        }
        assert_eq!(state.seq, 5);
    }

    #[test]
    fn invalid_or_missing_source_retains_last_snapshot_and_error() {
        let cache = LiveCache::new();
        let now = Instant::now();
        assert!(cache.accept(raw(1, 7), wall(), wall(), now));
        let previous = cache.inner.latest.borrow().snapshot.clone().unwrap();
        cache.fail("状态文件不可用: not found".into());
        assert_eq!(cache.inner.latest.borrow().error.as_deref(), Some("状态文件不可用: not found"));
        for invalid in [
            b"{".as_slice(), b"[]", b"null", b"{}",
            br#"{"players":[]}"#, br#"{"ok":true}"#,
            br#"{"ok":1,"players":[]}"#, br#"{"ok":false,"players":{}}"#,
        ] {
            assert!(!cache.accept(invalid.to_vec(), wall(), wall(), now + Duration::from_secs(9)));
            let current = cache.inner.latest.borrow();
            assert_eq!(current.seq, 1);
            assert!(current.error.is_some());
            assert!(Arc::ptr_eq(current.snapshot.as_ref().unwrap(), &previous));
            assert_eq!(current.source_age_ms(now + Duration::from_secs(9)), Some(9_000));
        }
        // 同一签名恢复成功，只清 error，不增加 seq 或洗掉年龄。
        assert!(cache.accept(raw(1, 7), wall(), wall(), now + Duration::from_secs(10)));
        assert!(cache.inner.latest.borrow().error.is_none());
        assert_eq!(cache.inner.latest.borrow().seq, 1);
        assert_eq!(cache.inner.latest.borrow().source_age_ms(now + Duration::from_secs(10)), Some(10_000));
    }

    #[test]
    fn legacy_fields_and_host_restart_sessions() {
        let mut first = CacheState::new();
        let mut second = CacheState::new();
        assert_ne!(first.session, second.session);
        let legacy = br#"{"ok":false,"players":[],"ts":123,"unknown":{"x":1}}"#.to_vec();
        first.accept(legacy.clone(), wall(), wall(), Instant::now()).unwrap();
        second.accept(legacy.clone(), wall(), wall(), Instant::now()).unwrap();
        assert_eq!(first.seq, 1);
        assert_eq!(second.seq, 1);
        assert_eq!(first.snapshot.as_ref().unwrap().data.as_ref(), &serde_json::from_slice::<Value>(&legacy).unwrap());
    }

    #[test]
    fn http_age_requires_exact_raw_version_and_watcher_starts_once() {
        let cache = LiveCache::new();
        let now = Instant::now() - Duration::from_secs(30);
        assert!(cache.accept(raw(1, 7), wall(), wall(), now));
        assert!(cache.source_age_ms_for_bytes(&raw(1, 7)).unwrap() >= 30_000);
        assert!(cache.source_age_ms_for_bytes(&raw(2, 7)).is_none());
        let task = cache.watcher(PathBuf::from("not-polled.json"));
        assert!(task.is_some());
        assert!(cache.watcher(PathBuf::from("not-polled.json")).is_none());
        drop(task);
    }

    #[tokio::test]
    async fn new_subscription_immediately_gets_current_snapshot_with_poll_age() {
        let cache = LiveCache::new();
        assert!(cache.accept(raw(1, 7), wall() - Duration::from_secs(120), wall(), Instant::now() - Duration::from_secs(5)));
        for _ in 0..2 {
            let (name, data) = frame(&mut cache.stream()).await;
            assert_eq!(name, "snapshot");
            assert_eq!(data["seq"], 1);
            assert!(data["source_age_ms"].as_u64().unwrap() >= 125_000);
            assert_eq!(data["session"], cache.inner.latest.borrow().session);
            assert_eq!(data["data"], serde_json::from_slice::<Value>(&raw(1, 7)).unwrap());
        }
    }

    #[tokio::test]
    async fn slow_consumer_merges_latest_and_drop_releases_receiver() {
        let cache = LiveCache::new();
        publish(&cache, 1);
        let mut stream = cache.stream();
        assert_eq!(frame(&mut stream).await.1["seq"], 1);
        for ts in 2..=10 {
            publish(&cache, ts);
        }
        let (name, data) = frame(&mut stream).await;
        assert_eq!(name, "snapshot");
        assert_eq!(data["seq"], 10);
        assert_eq!(data["data"]["ts"], 10);
        assert!(tokio::time::timeout(Duration::from_millis(10), stream.next()).await.is_err());
        assert_eq!(cache.inner.latest.receiver_count(), 1);
        drop(stream);
        assert_eq!(cache.inner.latest.receiver_count(), 0);
    }

    #[tokio::test]
    async fn empty_subscription_health_first_preserves_pending_snapshot() {
        let cache = LiveCache::new();
        let mut stream = cache.stream();
        // 建连接后、首 poll 前源写入：先发 health，下一 poll 仍必须给 snapshot。
        publish(&cache, 1);
        let (name, data) = frame(&mut stream).await;
        assert_eq!(name, "health");
        assert!(data.get("data").is_none());
        assert_eq!(frame(&mut stream).await.0, "snapshot");
        let mut empty = LiveCache::new().stream();
        let (name, data) = frame(&mut empty).await;
        assert_eq!(name, "health");
        assert_eq!(data["seq"], 0);
        assert!(data["source_age_ms"].is_null());
        assert!(data["error"].is_null());
    }

    #[tokio::test]
    async fn health_ticks_and_error_changes_never_refresh_source() {
        let cache = LiveCache::new();
        let now = Instant::now() - Duration::from_secs(10);
        assert!(cache.accept(raw(1, 7), wall(), wall(), now));
        let mut stream = cache.stream();
        assert_eq!(frame(&mut stream).await.0, "snapshot");
        cache.fail("状态文件读取失败".into());
        let (name, failed) = frame(&mut stream).await;
        assert_eq!(name, "health");
        assert_eq!(failed["seq"], 1);
        assert_eq!(failed["error"], "状态文件读取失败");
        assert!(failed.get("data").is_none());
        assert!(failed["source_age_ms"].as_u64().unwrap() >= 10_000);
        // 将首 tick 放到过去，后续 tick 仍隔一秒，避免测试真实等待。
        stream.health = tokio::time::interval_at(
            tokio::time::Instant::now() - Duration::from_millis(10),
            Duration::from_secs(1),
        );
        publish(&cache, 2);
        let (name, health) = frame(&mut stream).await;
        assert_eq!(name, "health", "连续新快照也不能饿死健康 tick");
        assert!(health["error"].is_null());
        let (name, snapshot) = frame(&mut stream).await;
        assert_eq!(name, "snapshot");
        assert_eq!(snapshot["seq"], 2);
    }

    #[tokio::test]
    async fn watcher_retries_invalid_and_missing_files_without_losing_cache() {
        let dir = std::env::temp_dir().join(format!("mo-hud-live-{}", new_session()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("hud_state.json");
        let cache = LiveCache::new();
        let task = tokio::spawn(cache.watcher(path.clone()).unwrap());
        let mut stream = cache.stream();
        let wait_for = |cache: LiveCache, predicate: fn(&CacheState) -> bool| async move {
            tokio::time::timeout(Duration::from_secs(3), async {
                while !predicate(&cache.inner.latest.borrow()) {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }).await.unwrap();
        };
        wait_for(cache.clone(), |s| s.error.is_some()).await;
        std::fs::write(&path, raw(1, 7)).unwrap();
        wait_for(cache.clone(), |s| s.seq == 1 && s.error.is_none()).await;
        std::fs::write(&path, b"{}").unwrap();
        wait_for(cache.clone(), |s| s.seq == 1 && s.error.is_some()).await;
        assert!(cache.inner.latest.borrow().snapshot.is_some());
        std::fs::remove_file(&path).unwrap();
        wait_for(cache.clone(), |s| s.error.as_deref().unwrap_or("").contains("不可用")).await;
        assert_eq!(cache.inner.latest.borrow().seq, 1);
        std::fs::write(&path, raw(2, 7)).unwrap();
        wait_for(cache.clone(), |s| s.seq == 2 && s.error.is_none()).await;
        // 未消费过的连接只能看到当前快照，不会按写入次数回放。
        assert_eq!(frame(&mut stream).await.0, "health");
        assert_eq!(frame(&mut stream).await.1["seq"], 2);
        task.abort();
        let _ = task.await;
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn watcher_handles_invalid_utf8_and_recovers_cleanly() {
        let dir = std::env::temp_dir().join(format!("mo-hud-utf8-{}", new_session()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("hud_state.json");
        // 含非法 GBK 字节的 JSON
        std::fs::write(&path, b"{\"ok\":true,\"players\":[],\"map\":\"\xb2\xe2\xca\xd4\"}").unwrap();
        let cache = LiveCache::new();
        let task = tokio::spawn(cache.watcher(path.clone()).unwrap());
        tokio::time::timeout(Duration::from_secs(2), async {
            while cache.inner.latest.borrow().error.is_none() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(cache.inner.latest.borrow().error.as_deref().unwrap_or("").contains("无效"));
        // 写入合法 UTF-8 后必须在退避周期内恢复
        std::fs::write(&path, raw(9, 100)).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while cache.inner.latest.borrow().seq != 1 || cache.inner.latest.borrow().error.is_some() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        let _ = task.await;
        std::fs::remove_dir_all(dir).unwrap();
    }
}
