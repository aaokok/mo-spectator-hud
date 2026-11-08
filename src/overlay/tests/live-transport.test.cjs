'use strict';

// Run from the repository root (Node >= 18, no packages or browser required):
// node --test "src/overlay/tests/live-transport.test.cjs"
// The transport's refresh contract is tested here; demo DOM listeners are separate.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const MODULE_PATH = path.resolve(__dirname, '..', 'live-transport.js');
// Pin one source image per run, even if the product is edited concurrently.
const SOURCE = fs.readFileSync(MODULE_PATH, 'utf8');
const SOURCE_SHA256 = createHash('sha256').update(SOURCE).digest('hex');
const EPOCH = 1700000000000;
const DEFAULT_URL = '/state/out/hud_state.json';
const drain = () => new Promise(resolve => setImmediate(resolve));

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.tasks = new Map();
  }
  schedule(fn, delay = 0, interval = false) {
    const id = this.nextId++;
    const ms = Math.max(0, Number(delay) || 0);
    this.tasks.set(id, { id, fn, at: this.time + ms, interval: interval ? ms : 0 });
    return id;
  }
  clear(id) { this.tasks.delete(id); }
  async advance(ms) {
    assert.ok(ms >= 0, 'clock must not go backwards');
    await drain();
    const end = this.time + ms;
    let executions = 0;
    for (;;) {
      let next = null;
      for (const task of this.tasks.values()) {
        if (task.at <= end && (!next || task.at < next.at || (task.at === next.at && task.id < next.id))) {
          next = task;
        }
      }
      if (!next) break;
      if (++executions > 10000) throw new Error('fake clock runaway');
      this.time = next.at;
      if (next.interval) next.at += next.interval;
      else this.tasks.delete(next.id);
      next.fn();
      // Flush promise chains at their actual fake time, not at the end of a jump.
      await drain();
    }
    this.time = end;
    await drain();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function bridge(overrides = {}) {
  return { schema: 2, ok: true, ts: EPOCH, frame: 900, pid: 42, phase: 'match', players: [], ...overrides };
}

function makeHarness(t, options = {}) {
  const clock = new FakeClock();
  const requests = [];
  const sources = [];
  const snapshots = [];
  const snapshotAttempts = [];
  const healthEvents = [];
  const location = new URL(options.pageUrl || 'http://localhost:8765/overlay/');

  function response(data, { status = 200, headers = {}, json } = {}) {
    const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: key => normalized.get(key.toLowerCase()) ?? null },
      json: json || (() => Promise.resolve(data))
    };
  }

  function fetch(url, settings = {}) {
    const pending = deferred();
    const req = {
      url, settings, signal: settings.signal, at: clock.time,
      respond(data = bridge(), settings = {}) { pending.resolve(response(data, settings)); },
      reject(error) { pending.reject(error); }
    };
    requests.push(req);
    // Deliberately ignore abort: late completions must also be guarded logically.
    if (options.autoRespond) req.respond(bridge());
    return pending.promise;
  }

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closed = false;
      this.at = clock.time;
      this.onerror = null;
      sources.push(this);
      if (options.throwEventSource) throw new Error('EventSource unavailable');
    }
    addEventListener(name, fn) {
      const list = this.listeners.get(name) || [];
      list.push(fn);
      this.listeners.set(name, list);
    }
    emit(name, value) {
      const event = { data: typeof value === 'string' ? value : JSON.stringify(value) };
      // Also allow events after close, to reproduce queued obsolete callbacks.
      for (const fn of this.listeners.get(name) || []) fn(event);
    }
    fail() { if (this.onerror) this.onerror({ type: 'error' }); }
    close() { this.closed = true; }
  }

  class FakeAbortController {
    constructor() { this.signal = { aborted: false }; }
    abort() { this.signal.aborted = true; }
  }

  const window = {
    performance: { now: () => clock.time },
    EventSource: options.EventSource === false ? undefined : FakeEventSource,
    AbortController: options.AbortController === false ? undefined : FakeAbortController
  };
  const globals = {
    location, URL, fetch,
    Date: class extends Date { static now() { return EPOCH + clock.time; } },
    setTimeout: (fn, ms) => clock.schedule(fn, ms),
    clearTimeout: id => clock.clear(id),
    setInterval: (fn, ms) => clock.schedule(fn, ms, true),
    clearInterval: id => clock.clear(id)
  };
  Object.assign(window, globals);
  const context = vm.createContext({ window, ...globals });
  vm.runInContext(SOURCE, context, { filename: MODULE_PATH });
  const api = window.HUD_LIVE_TRANSPORT;
  assert.equal(typeof api?.create, 'function');
  const transport = api.create({
    pollMs: 500, timeoutMs: 2000, staleMs: 3000, sse: true,
    ...options.transport,
    onSnapshot(data, meta) {
      snapshotAttempts.push({ data, meta, at: clock.time });
      if (options.mapSnapshot) options.mapSnapshot(data, meta);
      snapshots.push({ data, meta, at: clock.time });
    },
    onHealth(value) { healthEvents.push({ ...value, at: clock.time }); }
  });
  t.after(() => {
    transport.stop();
    assert.equal(clock.tasks.size, 0, 'stop must clear every timer');
    assert.ok(sources.every(es => es.closed || options.throwEventSource), 'stop must close all EventSources');
  });

  return {
    clock, requests, sources, snapshots, snapshotAttempts, healthEvents, transport,
    advance: ms => clock.advance(ms),
    async start(url = DEFAULT_URL) { transport.start(url); await drain(); },
    snapshot(es = sources.at(-1), values = {}) {
      assert.ok(es, 'expected an EventSource');
      es.emit('snapshot', { session: 'session-a', seq: 1, source_age_ms: 0, data: bridge(), ...values });
    },
    heartbeat(es = sources.at(-1), values = {}) {
      assert.ok(es, 'expected an EventSource');
      es.emit('health', { session: 'session-a', seq: 1, source_age_ms: 0, error: '', ...values });
    }
  };
}

test('public API starts stopped, and stopped refresh is a no-op', async t => {
  t.diagnostic(`Node ${process.version}; source ${MODULE_PATH}; SHA256 ${SOURCE_SHA256}`);
  const h = makeHarness(t);
  assert.deepEqual(Object.keys(h.transport).sort(), ['health', 'refresh', 'start', 'stop']);
  const health = h.transport.health();
  assert.equal(health.ageMs, null);
  assert.equal(health.received, false);
  assert.equal(health.stale, false);
  assert.equal(await h.transport.refresh(), false);
  assert.equal(h.requests.length, 0);
  h.transport.start('');
  await h.advance(10000);
  assert.equal(h.sources.length, 0);
  assert.equal(h.requests.length, 0);
});

test('HTTP fallback is serial and polls 500ms after completion, with no-store and cache buster', async t => {
  const h = makeHarness(t, { EventSource: false });
  await h.start();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, `${DEFAULT_URL}?_t=${EPOCH}`);
  assert.equal(h.requests[0].settings.cache, 'no-store');
  await h.advance(1250);
  assert.equal(h.requests.length, 1, 'an unfinished request must not overlap another poll');
  h.requests[0].respond();
  await drain();
  assert.equal(h.snapshots.length, 1);
  await h.advance(499);
  assert.equal(h.requests.length, 1);
  await h.advance(1);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].at, 1750);
  h.requests[1].respond(bridge({ frame: 901 }));
  await drain();
  await h.advance(500);
  assert.equal(h.requests[2].at, 2250);
});

test('HTTP refresh is immediate, coalesces active requests, and returns success only on acceptance', async t => {
  const h = makeHarness(t, { EventSource: false });
  await h.start();
  const a = h.transport.refresh();
  const b = h.transport.refresh();
  assert.equal(a, b);
  assert.equal(h.requests.length, 1);
  h.requests[0].respond();
  assert.equal(await a, true);
  await h.advance(100);
  const next = h.transport.refresh();
  await drain();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].at, 100);
  h.requests[1].respond(bridge(), { status: 503 });
  assert.equal(await next, false);
  assert.equal(h.transport.health().error, 'HTTP 503');
  await h.advance(499);
  assert.equal(h.requests.length, 2);
  await h.advance(1);
  assert.equal(h.requests.length, 3);
});

for (const abort of [true, false]) {
  for (const phase of ['fetch', 'response.json']) {
    test(`timeout covers pending ${phase}, AbortController ${abort ? 'present' : 'absent'}, and ignores late completion`, async t => {
      const h = makeHarness(t, { EventSource: false, AbortController: abort, transport: { timeoutMs: 200 } });
      await h.start();
      const result = h.transport.refresh();
      const body = deferred();
      if (phase === 'response.json') {
        h.requests[0].respond(bridge(), { json: () => body.promise });
        await drain();
      }
      assert.equal('signal' in h.requests[0].settings, abort);
      await h.advance(199);
      assert.equal(h.transport.health().error, '');
      await h.advance(1);
      assert.equal(await result, false);
      assert.equal(h.transport.health().error, '请求超时（200ms）');
      if (abort) assert.equal(h.requests[0].signal.aborted, true);
      assert.equal(h.snapshots.length, 0);
      await h.advance(499);
      assert.equal(h.requests.length, 1);
      await h.advance(1);
      assert.equal(h.requests.length, 2);
      h.requests[1].respond(bridge({ frame: 902 }));
      await drain();
      if (phase === 'fetch') h.requests[0].respond(bridge({ frame: 901 }));
      else body.resolve(bridge({ frame: 901 }));
      await drain();
      assert.deepEqual(h.snapshots.map(item => item.data.frame), [902]);
      assert.equal(h.transport.health().error, '');
    });
  }
}

for (const failedPoll of [false, true]) {
  test(`independent 250ms watchdog ages data during ${failedPoll ? '503 followed by pending request' : 'pending response.json'}`, async t => {
    const h = makeHarness(t, { EventSource: false, transport: { timeoutMs: 10000 } });
    await h.start();
    h.requests[0].respond();
    await drain();
    await h.advance(500);
    if (failedPoll) {
      h.requests[1].respond(bridge(), { status: 503 });
      await drain();
      assert.equal(h.transport.health().error, 'HTTP 503');
    } else {
      h.requests[1].respond(bridge(), { json: () => new Promise(() => {}) });
      await drain();
    }
    await h.advance(2499);
    assert.equal(h.healthEvents.at(-1).at, 2750);
    assert.equal(h.healthEvents.at(-1).stale, false);
    await h.advance(1);
    const health = h.healthEvents.at(-1); // No manual health() to manufacture this notification.
    assert.equal(health.at, 3000);
    assert.equal(health.ageMs, 3000);
    assert.equal(health.stale, true);
    assert.equal(h.snapshots.length, 1);
    assert.equal(h.requests.length, failedPoll ? 3 : 2);
  });
}

for (const phase of ['fetch', 'response.json']) {
  test(`switching URL and stop ignore old ${phase} results even when fetch ignores abort`, async t => {
    const h = makeHarness(t, { EventSource: false, AbortController: false });
    await h.start('/first.json');
    const body = deferred();
    if (phase === 'response.json') {
      h.requests[0].respond(bridge(), { json: () => body.promise });
      await drain();
    }
    h.transport.start('/second.json');
    await drain();
    h.requests[1].respond(bridge({ frame: 2 }));
    if (phase === 'fetch') h.requests[0].respond(bridge({ frame: 1 }));
    else body.resolve(bridge({ frame: 1 }));
    await drain();
    assert.deepEqual(h.snapshots.map(item => item.data.frame), [2]);
    assert.equal(h.requests[1].url, `/second.json?_t=${EPOCH}`);
    await h.advance(500);
    const pending = h.transport.refresh();
    h.transport.stop();
    assert.equal(await pending, false);
    h.requests[2].respond(bridge({ frame: 3 }));
    await h.advance(10000);
    assert.deepEqual(h.snapshots.map(item => item.data.frame), [2]);
    assert.equal(h.requests.length, 3);
    assert.equal(await h.transport.refresh(), false);
  });
}

test('cancelling or changing source before the fetch microtask does not issue a ghost request', async t => {
  const h = makeHarness(t, { EventSource: false });
  h.transport.start('/old.json');
  h.transport.start('/new.json');
  await drain();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, `/new.json?_t=${EPOCH}`);
  h.transport.start('/cancelled.json');
  h.transport.stop();
  await drain();
  assert.equal(h.requests.length, 1);
});

test('poll remains active until a named SSE snapshot, not open/message/health, then cancels its timer', async t => {
  const h = makeHarness(t);
  await h.start();
  const es = h.sources[0];
  assert.equal(es.url, '/live/state/sse');
  es.emit('open', {});
  es.emit('message', { session: 'session-a', seq: 1, source_age_ms: 0, data: bridge() });
  h.heartbeat(es);
  assert.equal(h.transport.health().transport, 'poll');
  assert.equal(h.snapshots.length, 0);
  h.requests[0].respond(bridge({ frame: 1 }));
  await drain();
  await h.advance(500);
  assert.equal(h.requests.length, 2);
  h.requests[1].respond(bridge({ frame: 2 }));
  await drain();
  h.snapshot(es, { data: bridge({ frame: 2 }) });
  assert.equal(h.transport.health().transport, 'sse');
  await h.advance(1000);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.snapshots.map(item => item.data.frame), [1, 2, 2]);
});

test('HTTP-to-SSE handoff refuses an older cached frame until both channels agree', async t => {
  const h = makeHarness(t);
  await h.start();
  h.requests[0].respond(bridge({ ts: 200, frame: 902 }));
  await drain();
  h.snapshot(undefined, { seq: 1, source_age_ms: 100, data: bridge({ ts: 100, frame: 901 }) });
  assert.deepEqual(h.snapshots.map(item => item.data.frame), [902]);
  assert.equal(h.transport.health().transport, 'poll');
  h.snapshot(undefined, { seq: 2, data: bridge({ ts: 200, frame: 902 }) });
  assert.equal(h.transport.health().transport, 'sse');
  assert.deepEqual(h.snapshots.map(item => item.data.frame), [902, 902]);
});

test('handoff compares JSON values independently of Rust object key order', async t => {
  const h = makeHarness(t);
  await h.start();
  const value = bridge({ screen: { valid: true, width: 1920, height: 1080 } });
  h.requests[0].respond(value);
  await drain();
  const reversed = Object.fromEntries(Object.entries(value).reverse());
  reversed.screen = { height: 1080, width: 1920, valid: true };
  h.snapshot(undefined, { data: reversed });
  assert.equal(h.transport.health().transport, 'sse');
});

test('a newer unmatched SSE waits for HTTP confirmation, then hands off without waiting another SSE event', async t => {
  const h = makeHarness(t);
  await h.start();
  h.requests[0].respond(bridge({ ts: 100, frame: 1 }));
  await drain();
  h.snapshot(undefined, { seq: 2, data: bridge({ ts: 200, frame: 2 }) });
  assert.equal(h.transport.health().transport, 'poll');
  await h.advance(500);
  h.requests[1].respond(bridge({ ts: 200, frame: 2 }));
  await drain();
  assert.equal(h.transport.health().transport, 'sse');
  assert.deepEqual(h.snapshots.map(item => item.data.frame), [1, 2, 2]);
  assert.equal(h.transport.health().ageMs, 500, 'waiting candidate must retain its source age');
});

test('explicit age header includes response body delay before applying freshness', async t => {
  const h = makeHarness(t, { EventSource: false });
  const body = deferred();
  await h.start();
  h.requests[0].respond(bridge(), {
    headers: { 'X-HUD-Source-Age-Ms': '2500' }, json: () => body.promise
  });
  await drain();
  await h.advance(1500);
  body.resolve(bridge());
  await drain();
  assert.equal(h.transport.health().ageMs, 4000);
  assert.equal(h.transport.health().stale, true);
});

test('first SSE snapshot cancels the pending HTTP body and ignores its later result', async t => {
  const h = makeHarness(t);
  await h.start();
  const body = deferred();
  h.requests[0].respond(bridge(), { json: () => body.promise });
  await drain();
  const pending = h.transport.refresh();
  h.snapshot(undefined, { data: bridge({ frame: 10 }) });
  assert.equal(await pending, false);
  assert.equal(h.requests[0].signal.aborted, true);
  body.resolve(bridge({ frame: 9 }));
  await h.advance(1000);
  assert.deepEqual(h.snapshots.map(item => item.data.frame), [10]);
  assert.equal(h.requests.length, 1);
});

test('SSE error immediately falls back to poll without inventing a business-data error', async t => {
  const h = makeHarness(t);
  await h.start();
  h.snapshot();
  const es = h.sources[0];
  es.fail();
  assert.equal(es.closed, true);
  assert.equal(h.transport.health().transport, 'poll');
  assert.equal(h.transport.health().error, '');
  await h.advance(0);
  assert.equal(h.requests.length, 2);
  h.requests[1].respond(bridge({ frame: 901 }));
  await drain();
  assert.equal(h.transport.health().error, '');
  assert.equal(h.snapshots.at(-1).meta.transport, 'poll');
});

test('SSE retries back off 5/10/20/30/30 seconds and reset to 5 seconds after a good snapshot', async t => {
  const h = makeHarness(t, { autoRespond: true });
  await h.start();
  for (const delay of [5000, 10000, 20000, 30000, 30000]) {
    const count = h.sources.length;
    h.sources.at(-1).fail();
    await h.advance(delay - 1);
    assert.equal(h.sources.length, count, `retry must wait ${delay}ms`);
    await h.advance(1);
    assert.equal(h.sources.length, count + 1);
  }
  h.snapshot();
  const count = h.sources.length;
  h.sources.at(-1).fail();
  await h.advance(4999);
  assert.equal(h.sources.length, count);
  await h.advance(1);
  assert.equal(h.sources.length, count + 1);
});

test('a constructor failure retains polling and schedules a bounded SSE retry', async t => {
  const h = makeHarness(t, { throwEventSource: true, autoRespond: true });
  await h.start();
  assert.equal(h.sources.length, 1);
  assert.equal(h.transport.health().transport, 'poll');
  await h.advance(4999);
  assert.ok(h.requests.length >= 10);
  assert.equal(h.sources.length, 1);
  await h.advance(1);
  assert.equal(h.sources.length, 2);
});

test('health before any snapshot cannot disable polling or evade the initial SSE timeout', async t => {
  const h = makeHarness(t, { autoRespond: true });
  await h.start();
  await h.advance(1500);
  h.heartbeat();
  await h.advance(499);
  assert.equal(h.sources[0].closed, false);
  await h.advance(1);
  assert.equal(h.sources[0].closed, true);
  assert.equal(h.transport.health().transport, 'poll');
  assert.ok(h.requests.length >= 4);
});

test('no SSE health for 3 seconds closes the stream, starts polling, and later reconnects', async t => {
  const h = makeHarness(t, { autoRespond: true });
  await h.start();
  h.snapshot();
  await h.advance(2999);
  assert.equal(h.sources[0].closed, false);
  await h.advance(1);
  assert.equal(h.sources[0].closed, true);
  assert.equal(h.transport.health().transport, 'poll');
  assert.equal(h.requests.at(-1).at, 3000);
  await h.advance(4999);
  assert.equal(h.sources.length, 1);
  await h.advance(1);
  assert.equal(h.sources.length, 2);
});

test('current health keeps SSE alive, reports source error/age, but does not make old data fresh', async t => {
  const h = makeHarness(t);
  await h.start();
  h.snapshot();
  await h.advance(2500);
  h.heartbeat(undefined, { source_age_ms: 4000, error: 'bridge unavailable' });
  assert.equal(h.transport.health().ageMs, 4000);
  assert.equal(h.transport.health().error, 'bridge unavailable');
  assert.equal(h.transport.health().stale, true);
  await h.advance(2500);
  h.heartbeat(undefined, { source_age_ms: 0, error: '' });
  assert.equal(h.transport.health().ageMs, 6500);
  assert.equal(h.transport.health().error, '');
  assert.equal(h.transport.health().stale, true);
  assert.equal(h.sources[0].closed, false);
  assert.equal(h.snapshots.length, 1);
  assert.equal(h.sources.length, 1);
});

test('old seq snapshots and retired sessions cannot roll state back; obsolete health cannot change age/error', async t => {
  const h = makeHarness(t);
  await h.start();
  h.snapshot(undefined, { seq: 2, data: bridge({ frame: 2 }) });
  await h.advance(500);
  h.snapshot(undefined, { seq: 1, data: bridge({ frame: 1 }) });
  h.heartbeat(undefined, { seq: 1, source_age_ms: 100000, error: 'old seq' });
  assert.equal(h.transport.health().ageMs, 500);
  assert.equal(h.transport.health().error, '');
  h.snapshot(undefined, { session: 'session-b', seq: 0, data: bridge({ frame: 3 }) });
  h.snapshot(undefined, { session: 'session-a', seq: 99, data: bridge({ frame: 4 }) });
  h.heartbeat(undefined, { session: 'session-a', seq: 99, source_age_ms: 100000, error: 'retired session' });
  assert.deepEqual(h.snapshots.map(item => item.data.frame), [2, 3]);
  assert.equal(h.transport.health().session, 'session-b');
  assert.equal(h.transport.health().seq, 0);
  assert.equal(h.transport.health().error, '');
  assert.equal(h.transport.health().ageMs, 0);
});

test('old stream events after switching source or stop are ignored and cannot schedule retries', async t => {
  const h = makeHarness(t);
  await h.start();
  const old = h.sources[0];
  h.snapshot(old);
  await h.start('/custom.json');
  h.snapshot(old, { seq: 100, data: bridge({ frame: 100 }) });
  h.heartbeat(old, { error: 'obsolete error' });
  old.fail();
  assert.equal(h.transport.health().received, false);
  assert.equal(h.transport.health().error, '');
  assert.equal(h.snapshots.length, 1);
  h.transport.stop();
  old.fail();
  h.snapshot(old);
  await h.advance(40000);
  assert.equal(h.sources.length, 1);
  assert.equal(h.requests.length, 2);
  assert.equal(h.snapshots.length, 1);
});

for (const nextSession of ['session-a', 'session-b']) {
  test(`reconnected identical old snapshot (${nextSession}) cannot refresh its age even with source_age_ms=0`, async t => {
    const h = makeHarness(t, { autoRespond: true });
    await h.start();
    h.snapshot();
    await h.advance(1000);
    h.sources[0].fail();
    await h.advance(5000);
    assert.equal(h.sources.length, 2);
    h.snapshot(undefined, { session: nextSession, seq: 1, source_age_ms: 0 });
    assert.equal(h.transport.health().ageMs, 6000);
    assert.equal(h.transport.health().stale, true);
  });
}

test('already-old SSE snapshot is immediately stale and its age is known', async t => {
  const h = makeHarness(t);
  await h.start();
  h.snapshot(undefined, { source_age_ms: 3000 });
  assert.equal(h.healthEvents.at(-1).stale, true);
  assert.equal(h.healthEvents.at(-1).ageMs, 3000);
  assert.equal(h.healthEvents.at(-1).sourceAgeKnown, true);
});

for (const kind of ['poll', 'sse']) {
  test(`phase-only advancement refreshes ${kind} data with identical ts/frame/pid`, async t => {
    const h = makeHarness(t, { EventSource: kind !== 'poll' });
    await h.start();
    if (kind === 'poll') { h.requests[0].respond(); await drain(); }
    else h.snapshot();
    await h.advance(500);
    if (kind === 'poll') { h.requests[1].respond(bridge({ phase: 'post_match' })); await drain(); }
    else h.snapshot(undefined, { seq: 2, data: bridge({ phase: 'post_match' }) });
    assert.equal(h.transport.health().ageMs, 0);
    assert.equal(h.transport.health().stale, false);
    assert.equal(h.snapshots.at(-1).data.phase, 'post_match');
    await h.advance(500);
    if (kind === 'poll') { h.requests[2].respond(bridge({ phase: 'post_match' })); await drain(); }
    else h.snapshot(undefined, { seq: 3, data: bridge({ phase: 'post_match' }) });
    assert.equal(h.transport.health().ageMs, 500, 'an unchanged signature must not refresh freshness');
  });
}

for (const entry of [
  { name: 'default absolute same-origin URL', url: 'http://localhost:8765/state/out/hud_state.json', sse: true },
  { name: 'default relative URL', url: '../state/out/hud_state.json', sse: true },
  { name: 'custom path', url: '/custom/hud.json', sse: false },
  { name: 'custom query', url: `${DEFAULT_URL}?team=red`, sse: false },
  { name: 'cross-origin hostname', url: 'http://remote.example:8765/state/out/hud_state.json', sse: false },
  { name: 'cross-origin port', url: 'http://localhost:9999/state/out/hud_state.json', sse: false },
  { name: 'cross-origin protocol', url: 'https://localhost:8765/state/out/hud_state.json', sse: false },
  { name: 'sse:false', url: DEFAULT_URL, sse: false, disabled: true }
]) {
  test(`URL selection: ${entry.name} ${entry.sse ? 'uses' : 'never connects to'} default SSE`, async t => {
    const h = makeHarness(t, { autoRespond: true, transport: { sse: !entry.disabled } });
    await h.start(entry.url);
    assert.equal(h.sources.length, entry.sse ? 1 : 0);
    const separator = entry.url.includes('?') ? '&' : '?';
    assert.equal(h.requests[0].url, `${entry.url}${separator}_t=${EPOCH}`);
    if (!entry.sse) {
      await h.advance(10000);
      await h.transport.refresh();
      assert.equal(h.sources.length, 0, 'refresh and retries must not invent a default SSE for custom URLs');
    } else assert.equal(h.sources[0].url, '/live/state/sse');
  });
}

test('visibility-style refresh resubscribes SSE, ignores old stream, and preserves old data age', async t => {
  const h = makeHarness(t);
  await h.start();
  h.snapshot(undefined, { source_age_ms: 2500 });
  await h.advance(1000);
  const old = h.sources[0];
  const result = h.transport.refresh();
  await drain();
  assert.equal(old.closed, true);
  assert.equal(h.sources.length, 2);
  assert.equal(h.transport.health().ageMs, 3500);
  assert.equal(h.transport.health().stale, true);
  h.snapshot(old, { seq: 20, data: bridge({ frame: 20 }) });
  h.snapshot(undefined, { source_age_ms: 0 });
  assert.equal(await result, false, 'a resubscribed snapshot cancels the refresh fallback request');
  assert.equal(h.transport.health().transport, 'sse');
  assert.equal(h.transport.health().ageMs, 3500);
  assert.equal(h.transport.health().stale, true);
  assert.deepEqual(h.snapshots.map(item => item.data.frame), [900, 900]);
  const count = h.requests.length;
  await h.advance(1000);
  assert.equal(h.requests.length, count);
});

for (const pause of [false, true]) {
  test(`same-source ${pause ? 'stop/start' : 'start/start'} replays lastData without granting stale data a new grace period`, async t => {
    const h = makeHarness(t, { EventSource: false });
    await h.start();
    h.requests[0].respond();
    await drain();
    await h.advance(3000);
    if (pause) {
      h.transport.stop();
      await h.advance(1000);
    }
    const age = h.transport.health().ageMs;
    const deliveries = h.snapshots.length;
    await h.start();
    assert.equal(h.transport.health().ageMs, age);
    assert.equal(h.transport.health().stale, true);
    assert.equal(h.transport.health().received, true);
    assert.equal(h.snapshots.length, deliveries + 1);
    assert.equal(h.snapshots.at(-1).data.frame, 900);
    assert.equal(h.snapshots.at(-1).meta.ageMs, age);
    h.requests.at(-1).respond(bridge(), { headers: { 'X-HUD-Source-Age-Ms': '0' } });
    await drain();
    assert.equal(h.transport.health().ageMs, age);
    assert.equal(h.transport.health().stale, true);
  });
}

test('changing source resets freshness and does not replay the previous source model', async t => {
  const h = makeHarness(t, { EventSource: false });
  await h.start('/a.json');
  h.requests[0].respond();
  await drain();
  await h.advance(1000);
  await h.start('/b.json');
  assert.equal(h.transport.health().ageMs, null);
  assert.equal(h.transport.health().received, false);
  assert.equal(h.snapshots.length, 1);
});

for (const kind of ['poll', 'sse']) {
  test(`onSnapshot mapping throw is not a successful first ${kind} snapshot`, async t => {
    let rejectMapping = true;
    const h = makeHarness(t, {
      EventSource: kind !== 'poll',
      mapSnapshot() { if (rejectMapping) throw new Error('mapping failed'); }
    });
    await h.start();
    if (kind === 'poll') {
      const result = h.transport.refresh();
      h.requests[0].respond(bridge(), { headers: { 'X-HUD-Source-Age-Ms': '4000' } });
      assert.equal(await result, false);
    } else h.snapshot(undefined, { source_age_ms: 4000 });
    const health = h.transport.health();
    assert.equal(health.ageMs, null);
    assert.equal(health.received, false);
    assert.equal(health.sourceAgeKnown, false);
    assert.equal(health.error, 'mapping failed');
    assert.equal(h.snapshots.length, 0);
    rejectMapping = false;
    if (kind === 'poll') await h.advance(500);
    else await h.advance(0);
    h.requests.at(-1).respond(bridge({ frame: 901 }));
    await drain();
    assert.equal(h.snapshots.length, 1);
    assert.equal(h.transport.health().received, true);
    assert.equal(h.transport.health().error, '');
  });
}

test('failed mapping cannot refresh previous age or replace cached lastData/signature', async t => {
  let rejectMapping = false;
  const h = makeHarness(t, {
    EventSource: false,
    mapSnapshot() { if (rejectMapping) throw new Error('mapping failed'); }
  });
  await h.start();
  h.requests[0].respond();
  await drain();
  await h.advance(500);
  rejectMapping = true;
  const result = h.transport.refresh();
  h.requests[1].respond(bridge({ frame: 901 }));
  assert.equal(await result, false);
  assert.equal(h.transport.health().ageMs, 500);
  assert.equal(h.transport.health().error, 'mapping failed');
  rejectMapping = false;
  await h.start();
  assert.equal(h.snapshots.at(-1).data.frame, 900, 'a failed mapped frame must not be replayed');
  assert.equal(h.transport.health().ageMs, 500);
  h.requests.at(-1).respond(bridge({ frame: 901 }));
  await drain();
  assert.equal(h.transport.health().ageMs, 0, 'the previously failed signature must still be accepted as new');
  assert.equal(h.snapshots.at(-1).data.frame, 901);
});

for (const entry of [
  { name: 'Last-Modified old file', headers: { 'Last-Modified': new Date(EPOCH - 5000).toUTCString() }, age: 5000, known: true },
  { name: 'Last-Modified future date clamps to zero', headers: { 'Last-Modified': new Date(EPOCH + 5000).toUTCString() }, age: 0, known: true },
  { name: 'invalid Last-Modified', headers: { 'Last-Modified': 'not-a-date' }, age: 0, known: false },
  { name: 'absent age headers', headers: {}, age: 0, known: false },
  { name: 'explicit source age wins over Last-Modified', headers: { 'X-HUD-Source-Age-Ms': '1234', 'Last-Modified': new Date(EPOCH - 5000).toUTCString() }, age: 1234, known: true },
  { name: 'explicit zero source age is known', headers: { 'X-HUD-Source-Age-Ms': '0', 'Last-Modified': new Date(EPOCH - 5000).toUTCString() }, age: 0, known: true },
  { name: 'invalid source age falls back to Last-Modified', headers: { 'X-HUD-Source-Age-Ms': 'nope', 'Last-Modified': new Date(EPOCH - 5000).toUTCString() }, age: 5000, known: true },
  { name: 'negative source age falls back to Last-Modified', headers: { 'X-HUD-Source-Age-Ms': '-1', 'Last-Modified': new Date(EPOCH - 5000).toUTCString() }, age: 5000, known: true }
]) {
  test(`HTTP age: ${entry.name}`, async t => {
    const h = makeHarness(t, { EventSource: false });
    await h.start();
    h.requests[0].respond(bridge(), { headers: entry.headers });
    await drain();
    const health = h.transport.health();
    assert.equal(health.ageMs, entry.age);
    assert.equal(health.sourceAgeKnown, entry.known);
    assert.equal(health.stale, entry.age >= 3000);
    assert.equal(h.snapshots[0].meta.sourceAgeKnown, entry.known);
  });
}

test('Last-Modified age includes time spent awaiting the JSON body', async t => {
  const h = makeHarness(t, { EventSource: false });
  const body = deferred();
  await h.start();
  h.requests[0].respond(bridge(), {
    headers: { 'Last-Modified': new Date(EPOCH - 2000).toUTCString() },
    json: () => body.promise
  });
  await h.advance(500);
  body.resolve(bridge());
  await drain();
  assert.equal(h.transport.health().ageMs, 2500);
});

test('invalid HTTP bridge payload fails without marking data received', async t => {
  const h = makeHarness(t, { EventSource: false });
  await h.start();
  const result = h.transport.refresh();
  h.requests[0].respond({ unexpected: true });
  assert.equal(await result, false);
  assert.equal(h.transport.health().received, false);
  assert.equal(h.transport.health().ageMs, null);
  assert.match(h.transport.health().error, /无效/);
});

for (const entry of [
  { name: 'malformed JSON', value: '{invalid json' },
  { name: 'negative seq', value: { session: 'session-a', seq: -1, source_age_ms: 0, data: bridge() } },
  { name: 'missing session', value: { seq: 1, source_age_ms: 0, data: bridge() } },
  { name: 'invalid source age', value: { session: 'session-a', seq: 1, source_age_ms: -1, data: bridge() } }
]) {
  test(`invalid SSE ${entry.name} falls back while preserving the existing HTTP request`, async t => {
    const h = makeHarness(t);
    await h.start();
    h.sources[0].emit('snapshot', entry.value);
    assert.equal(h.sources[0].closed, true);
    await h.advance(0);
    assert.equal(h.requests.length, 1, 'fallback must not overlap the already pending HTTP request');
    assert.equal(h.transport.health().transport, 'poll');
    h.requests[0].respond();
    await drain();
    assert.equal(h.snapshots.length, 1);
  });
}
