/* 业务快照传输：宿主 SSE 优先，旧宿主 / serve.py 自动保留 500ms HTTP 轮询。
   只负责完整快照和新鲜度，不参与分队、计数、布局或动画。 */
(function () {
  'use strict';

  function create(options) {
    var pollMs = options.pollMs || 500;
    var timeoutMs = options.timeoutMs || 2000;
    var staleMs = options.staleMs || 3000;
    var generation = 0, streamGeneration = 0;
    var running = false, url = '', streamUrl = '';
    var pollTimer = null, retryTimer = null, watchdog = null, streamTimer = null;
    var request = null, stream = null, streaming = false;
    var retryMs = 5000, lastMessageAt = 0;
    var session = '', seq = 0, retiredSessions = {};
    var signature = '', dataAt = null, receivedAt = null, error = '';
    var sourceAgeKnown = false, lastData = null, lastTransport = '', pendingStream = null;

    function now() {
      return window.performance && window.performance.now ? window.performance.now() : Date.now();
    }

    function sourceSignature(data) {
      return [data.ts || 0, data.frame || 0, data.pid || 0, data.phase || ''].join(':');
    }

    function age() {
      return dataAt === null ? null : Math.max(0, now() - dataAt);
    }

    function health() {
      var value = {
        transport: streaming ? 'sse' : 'poll',
        error: error,
        ageMs: age(),
        stale: dataAt !== null && age() >= staleMs,
        received: receivedAt !== null,
        sourceAgeKnown: sourceAgeKnown,
        session: session,
        seq: seq
      };
      if (options.onHealth) options.onHealth(value);
      return value;
    }

    function validData(data) {
      return data && typeof data === 'object' && !Array.isArray(data) &&
        typeof data.ok === 'boolean' && Array.isArray(data.players);
    }

    function sameData(a, b) {
      if (a === b) return true;
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object' ||
          Array.isArray(a) !== Array.isArray(b)) return false;
      var keys = Object.keys(a);
      if (keys.length !== Object.keys(b).length) return false;
      for (var i = 0; i < keys.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(b, keys[i]) || !sameData(a[keys[i]], b[keys[i]])) return false;
      }
      return true;
    }

    function canSwitchToStream(data) {
      if (lastTransport !== 'poll' || !lastData) return true;
      /* 先在两条通道交接同一份数据，避免 watcher 落后于直接读文件时回滚。
         对象键序不参与比较：Rust Value 与原始 JSON 的序列化顺序可能不同。 */
      return sameData(data, lastData);
    }

    function accept(data, sourceAge, transport) {
      if (!validData(data)) throw new Error('无效的 HUD 快照');
      var sig = sourceSignature(data);
      var at = now();
      var suppliedAge = typeof sourceAge === 'number' && isFinite(sourceAge) && sourceAge >= 0;
      var candidate = at - (suppliedAge ? sourceAge : 0);
      if (options.onSnapshot) options.onSnapshot(data, {
        ageMs: suppliedAge ? sourceAge : 0, transport: transport, sourceAgeKnown: suppliedAge
      });
      if (sig !== signature || dataAt === null) {
        signature = sig;
        dataAt = candidate;
        sourceAgeKnown = suppliedAge;
      } else if (suppliedAge) {
        /* 重连 / 重复文件不能给旧数据重新发一张“新鲜通行证”。 */
        dataAt = Math.min(dataAt, candidate);
        sourceAgeKnown = true;
      }
      receivedAt = at;
      lastData = data;
      lastTransport = transport;
      error = '';
      health();
    }

    function cancelRequest() {
      if (!request) return;
      var active = request;
      request = null;
      active.cancel();
    }

    function clearPoll() {
      clearTimeout(pollTimer);
      pollTimer = null;
    }

    function schedulePoll(delay) {
      clearPoll();
      if (!running || streaming) return;
      pollTimer = setTimeout(function () {
        pollTimer = null;
        fetchSnapshot();
      }, delay);
    }

    function fetchSnapshot() {
      if (!running || streaming) return Promise.resolve(false);
      if (request) return request.promise;
      clearPoll();
      var token = generation;
      var requestUrl = url;
      var controller = window.AbortController ? new window.AbortController() : null;
      var active = { promise: null, cancel: null };
      request = active;
      var timer;
      var task = new Promise(function (resolve, reject) {
        var done = false;
        function finish(err, value) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (err) reject(err);
          else resolve(value);
        }
        active.cancel = function () {
          finish(null, null);
          if (controller) controller.abort();
        };
        timer = setTimeout(function () {
          finish(new Error('请求超时（' + timeoutMs + 'ms）'));
          if (controller) controller.abort();
        }, timeoutMs);
        var settings = { cache: 'no-store' };
        if (controller) settings.signal = controller.signal;
        Promise.resolve().then(function () {
          if (!running || token !== generation || request !== active) return null;
          var sep = requestUrl.indexOf('?') >= 0 ? '&' : '?';
          return fetch(requestUrl + sep + '_t=' + Date.now(), settings);
        }).then(function (response) {
          if (!response) return null;
          if (!response.ok) throw new Error('HTTP ' + response.status);
          var headersAt = now();
          var ageHeader = response.headers && response.headers.get('X-HUD-Source-Age-Ms');
          var sourceAge = ageHeader !== null && ageHeader !== undefined && ageHeader !== ''
            ? Number(ageHeader) : NaN;
          var modified = response.headers && response.headers.get('Last-Modified');
          var modifiedAt = modified ? Date.parse(modified) : NaN;
          return response.json().then(function (data) {
            return { data: data, age: isFinite(sourceAge) && sourceAge >= 0
              ? sourceAge + Math.max(0, now() - headersAt)
              : (isFinite(modifiedAt) ? Math.max(0, Date.now() - modifiedAt) : null) };
          });
        }).then(function (result) {
          finish(null, result);
        }, function (err) {
          finish(err);
        });
      });
      active.promise = task.then(function (result) {
        if (!running || token !== generation || request !== active || !result) return false;
        accept(result.data, result.age, 'poll');
        if (pendingStream && canSwitchToStream(pendingStream.value.data)) {
          var pending = pendingStream;
          pendingStream = null;
          pending.deliver();
        }
        return true;
      }).catch(function (err) {
        if (running && token === generation && request === active) {
          error = String(err && err.message ? err.message : err);
          health();
        }
        return false;
      }).then(function (ok) {
        if (request === active) {
          request = null;
          if (running && token === generation) schedulePoll(pollMs);
        }
        return ok;
      });
      return active.promise;
    }

    function closeStream() {
      streamGeneration++;
      clearTimeout(streamTimer);
      streamTimer = null;
      if (stream) stream.close();
      stream = null;
      streaming = false;
      pendingStream = null;
    }

    function retryStream() {
      clearTimeout(retryTimer);
      retryTimer = null;
      if (!running || !streamUrl) return;
      retryTimer = setTimeout(function () {
        retryTimer = null;
        openStream();
      }, retryMs);
      retryMs = Math.min(30000, retryMs * 2);
    }

    function streamFailed() {
      if (!running) return;
      closeStream();
      /* 通道失败先回原轮询，只有业务数据也失败才显示“连接失败”。 */
      schedulePoll(0);
      retryStream();
      health();
    }

    function envelope(value) {
      return value && typeof value.session === 'string' && value.session.length > 0 &&
        typeof value.seq === 'number' && isFinite(value.seq) &&
        value.seq >= 0 && Math.floor(value.seq) === value.seq;
    }

    function acceptSession(value) {
      if (value.session === session) return value.seq >= seq;
      if (Object.prototype.hasOwnProperty.call(retiredSessions, value.session)) return false;
      if (session) retiredSessions[session] = true;
      session = value.session;
      seq = 0;
      return true;
    }

    function openStream() {
      if (!running || !streamUrl || stream) return;
      var token = generation;
      var es;
      try {
        es = new window.EventSource(streamUrl);
      } catch (err) {
        retryStream();
        return;
      }
      stream = es;
      var streamToken = ++streamGeneration;
      var confirmed = false;
      lastMessageAt = now();
      streamTimer = setTimeout(function () {
        if (running && token === generation && streamToken === streamGeneration && !confirmed) streamFailed();
      }, timeoutMs);

      function current() {
        return running && token === generation && streamToken === streamGeneration && stream === es;
      }

      es.addEventListener('snapshot', function (event) {
        if (!current()) return;
        try {
          var value = JSON.parse(event.data);
          if (!envelope(value) || !validData(value.data) ||
              typeof value.source_age_ms !== 'number' || !isFinite(value.source_age_ms) ||
              value.source_age_ms < 0) throw new Error('无效的 SSE 快照');
          var valueAt = now();
          function deliver() {
            if (!current() || !acceptSession(value)) return;
            lastMessageAt = now();
            confirmed = true;
            clearTimeout(streamTimer);
            streamTimer = null;
            streaming = true;
            retryMs = 5000;
            clearPoll();
            cancelRequest();
            seq = value.seq;
            accept(value.data, value.source_age_ms + Math.max(0, now() - valueAt), 'sse');
          }
          if (!canSwitchToStream(value.data)) {
            pendingStream = { value: value, deliver: deliver };
            return;
          }
          pendingStream = null;
          deliver();
        } catch (err) {
          error = String(err && err.message ? err.message : err);
          streamFailed();
        }
      });
      es.addEventListener('health', function (event) {
        if (!current()) return;
        try {
          var value = JSON.parse(event.data);
          if (!envelope(value)) throw new Error('无效的 SSE 健康状态');
          if (value.session !== session && session && confirmed) return;
          lastMessageAt = now();
          if (streaming && value.session === session && value.seq === seq) {
            if (typeof value.source_age_ms === 'number' && isFinite(value.source_age_ms) &&
                value.source_age_ms >= 0 && dataAt !== null) {
              dataAt = Math.min(dataAt, now() - value.source_age_ms);
            }
            error = value.error ? String(value.error) : '';
            health();
          }
        } catch (err) {
          streamFailed();
        }
      });
      es.onerror = function () {
        if (current()) streamFailed();
      };
    }

    function chooseStream(source) {
      if (options.sse === false || !window.EventSource) return '';
      try {
        var resolved = new URL(source, location.href);
        var page = new URL(location.href);
        if (!/^https?:$/.test(resolved.protocol) || resolved.origin !== page.origin ||
            resolved.pathname !== '/state/out/hud_state.json' || resolved.search) return '';
        return '/live/state/sse';
      } catch (err) {
        return '';
      }
    }

    function stop() {
      running = false;
      generation++;
      clearPoll();
      clearTimeout(retryTimer);
      retryTimer = null;
      clearInterval(watchdog);
      watchdog = null;
      closeStream();
      cancelRequest();
    }

    function start(source) {
      var sameSource = source === url;
      stop();
      url = source || '';
      if (!url) return;
      running = true;
      if (!sameSource) {
        signature = '';
        dataAt = receivedAt = null;
        sourceAgeKnown = false;
        lastData = null;
        lastTransport = '';
        session = '';
        seq = 0;
        retiredSessions = {};
      }
      error = '';
      retryMs = 5000;
      streamUrl = chooseStream(url);
      watchdog = setInterval(function () {
        if (streaming && now() - lastMessageAt >= staleMs) streamFailed();
        health();
      }, 250);
      if (sameSource && lastData && options.onSnapshot) {
        options.onSnapshot(lastData, { ageMs: age(), transport: 'poll', sourceAgeKnown: sourceAgeKnown });
      }
      health();
      fetchSnapshot();
      openStream();
    }

    function refresh() {
      if (!running) return Promise.resolve(false);
      if (streaming) {
        /* 恢复可见时重订阅，取带真实年龄的当前快照，不重置本地停滞计时。 */
        closeStream();
        clearTimeout(retryTimer);
        retryTimer = null;
        openStream();
      }
      return fetchSnapshot();
    }

    return { start: start, stop: stop, refresh: refresh, health: health };
  }

  window.HUD_LIVE_TRANSPORT = { create: create };
})();
