'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'demo.js'), 'utf8');
const adapter = fs.readFileSync(path.join(root, 'live-data.js'), 'utf8');

function extract(start, end) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin + start.length);
  assert(begin >= 0 && finish > begin, `Missing source boundary: ${start}`);
  return source.slice(begin, finish);
}

function element() {
  const classes = new Set();
  return {
    textContent: '', className: '', disabled: false, value: '',
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
      remove(name) { classes.delete(name); }
    }
  };
}

function harness() {
  const stage = element();
  const status = element();
  const nodes = { '#liveStatus': status, '#shuffleBtn': element() };
  const context = vm.createContext({
    window: {}, Date,
    stage, scenarioSel: element(), pauseBtn: element(),
    STALE_SEC: 3,
    state: { source: 'live', liveModel: null, liveError: '', liveHealth: null,
      liveFetchedAt: 0, liveDataAt: 0, liveLastSig: '', liveRev: 0, perTeam: 1 },
    $: selector => nodes[selector] || null
  });
  vm.runInContext(adapter, context);
  vm.runInContext([
    extract('  function applyLiveModel(d)', '  /* live 下把只对 mock 有效的控件禁用'),
    extract('  function syncToolbarState()', '  var liveTransport ='),
    extract('  function renderLiveStatus()', '  /* ---------------------------------------------------------------- events */')
  ].join('\n'), context);
  return { context, stage, status, state: context.state, nodes };
}

function frame(overrides = {}) {
  return { schema: 2, ok: true, ts: 100, frame: 200, pid: 42, phase: 'match',
    map: 'Fixture map', players: [], ...overrides };
}

function apply(h, value) {
  h.context.input = value;
  return vm.runInContext('applyLiveModel(input)', h.context);
}

function render(h) { vm.runInContext('renderLiveStatus()', h.context); }

test('HTTP error still applies stale class and visible status after deadline', () => {
  const h = harness();
  apply(h, frame());
  h.state.liveHealth = { ageMs: 3000, error: 'HTTP 503' };
  h.state.liveError = 'HTTP 503';
  render(h);
  assert.equal(h.stage.classList.contains('live-stale'), true);
  assert.equal(h.stage.classList.contains('live-error'), true);
  assert.match(h.status.textContent, /HTTP 503/);
  assert.match(h.status.textContent, /3s 未更新/);
});

test('pending fetch health can mark stale without a fetch completion', () => {
  const h = harness();
  apply(h, frame());
  h.state.liveHealth = { ageMs: 2999 };
  render(h);
  assert.equal(h.stage.classList.contains('live-stale'), false);
  h.state.liveHealth.ageMs = 3000;
  render(h);
  assert.equal(h.stage.classList.contains('live-stale'), true);
});

test('stale class updates even when no statusbar element exists', () => {
  const h = harness();
  apply(h, frame());
  h.nodes['#liveStatus'] = null;
  h.state.liveHealth = { ageMs: 10000 };
  render(h);
  assert.equal(h.stage.classList.contains('live-stale'), true);
});

test('new source data recovers stale and error classes', () => {
  const h = harness();
  apply(h, frame());
  h.state.liveHealth = { ageMs: 4000 };
  h.state.liveError = 'request timeout';
  render(h);
  apply(h, frame({ ts: 101, frame: 201 }));
  h.state.liveHealth = { ageMs: 0 };
  render(h);
  assert.equal(h.stage.classList.contains('live-stale'), false);
  assert.equal(h.stage.classList.contains('live-error'), false);
});

test('lobby holds prior roster but hides HUD, new match replaces it', () => {
  const h = harness();
  const player = { slot: 0, name: 'Player A', country: 'USSR', money: 1000 };
  apply(h, frame({ players: [player] }));
  const held = h.state.liveModel;
  apply(h, frame({ ok: false, phase: 'lobby', frame: 0, ts: 101 }));
  assert.equal(h.state.liveModel, held);
  assert.equal(h.state.liveModel.meta.phase, 'lobby');
  assert.equal(h.stage.classList.contains('live-offline'), true);
  h.state.liveHealth = { ageMs: 10000 };
  render(h);
  assert.equal(h.stage.classList.contains('live-stale'), false);
  apply(h, frame({ pid: 99, ts: 102, players: [{ ...player, country: 'Chinese' }] }));
  assert.notEqual(h.state.liveModel, held);
  assert.equal(h.stage.classList.contains('live-offline'), false);
});

test('mock source clears error/stale visual state', () => {
  const h = harness();
  apply(h, frame());
  h.state.liveHealth = { ageMs: 10000 };
  h.state.liveError = 'HTTP 503';
  render(h);
  h.state.source = 'mock';
  render(h);
  assert.equal(h.stage.classList.contains('live-stale'), false);
  assert.equal(h.stage.classList.contains('live-error'), false);
});

test('mapping failure throws instead of falsely accepting fresh data', () => {
  const h = harness();
  apply(h, frame());
  const previous = h.state.liveModel;
  h.context.window.LIVE_DATA.toModel = () => { throw new Error('bad model'); };
  assert.throws(() => apply(h, frame({ ts: 102 })), /映射失败/);
  assert.equal(h.state.liveModel, previous);
});

test('transport loads before demo and old liveLoop is removed', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert(html.indexOf('src="live-transport.js"') < html.indexOf('src="demo.js"'));
  assert.doesNotMatch(source, /function liveLoop\(/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /sse=0/);
});

test('P1-3: steady-state frame advance does not trigger full relayout', () => {
  const h = harness();
  const p1 = { slot: 0, name: 'Alpha', country: 'USSR', team: 0, cash: 5000 };
  const p2 = { slot: 1, name: 'Beta', country: 'UnitedStates', team: 1, cash: 5000 };
  const sc = { valid: true, width: 1920, height: 1080, sidebar_side: 1, view_rect: [0, 0, 1752, 1048], sidebar_rect: [1752, 158, 168, 922] };
  assert.equal(apply(h, frame({ frame: 100, ts: 1000, screen: sc, players: [p1, p2] })), true);
  assert.equal(apply(h, frame({ frame: 115, ts: 1500, screen: sc, players: [p1, p2] })), false);
  assert.equal(apply(h, frame({ frame: 130, ts: 2000, paused: true, screen: sc, players: [p1, p2] })), false);
  // menuOpen 或 screen 尺寸变化时才需要重排
  assert.equal(apply(h, frame({ frame: 145, ts: 2500, menu_open: true, screen: sc, players: [p1, p2] })), true);
  assert.equal(
    apply(h, frame({ frame: 160, ts: 3000, menu_open: true, screen: { ...sc, width: 2560 }, players: [p1, p2] })),
    true
  );
});

test('P1-7: cardGridBudget does not double-subtract CARD_HEAD_H + CARD_PAD_H', () => {
  const snippet = extract('  var CARD_HEAD_H = 24;', '  /* 算出两个互不重叠的行数配额');
  const ctx = vm.createContext({
    state: { perTeam: 3 },
    $: () => ({ clientHeight: 720 })
  });
  vm.runInContext(snippet, ctx);
  const budget = vm.runInContext('cardGridBudget()', ctx);
  // (720 - 3 * 36 - 2 * 8) / 3 = 198.666...，足够 3 行 (156px) -> 3v3 6 格
  assert(Math.abs(budget - (720 - 3 * 36 - 2 * 8) / 3) < 0.01, `unexpected budget: ${budget}`);
});

test('P1-8: control-bridge __ctrlPatch is immutable and supports independent score (B1)', async () => {
  const bridgeSrc = fs.readFileSync(path.join(root, 'control-bridge.js'), 'utf8');
  let ctrlPayload = { show_units: true, show_queues: true, show_score: true, observer_gate: false, match_name: '', score_l: 2, score_r: 1, mode_label: '' };
  const dispatched = [];
  const docBodyClasses = new Set();
  const ctx = vm.createContext({
    window: {
      dispatchEvent(ev) { dispatched.push(ev.type); },
      addEventListener() {}
    },
    document: {
      getElementById() { return null; },
      body: {
        classList: {
          toggle(c, on) { if (on) docBodyClasses.add(c); else docBodyClasses.delete(c); },
          contains(c) { return docBodyClasses.has(c); }
        }
      }
    },
    CustomEvent: function (type) { this.type = type; },
    fetch: () => Promise.resolve({ json: () => Promise.resolve(ctrlPayload) }),
    setInterval: () => 1,
    clearInterval: () => {}
  });
  ctx.window.window = ctx.window;
  vm.runInContext(bridgeSrc, ctx);
  await new Promise(r => setImmediate(r));

  const baseModel = { map: 'Original Map', series: null, modeLabel: '1V1' };
  assert.equal(docBodyClasses.has('yield-tl'), false, 'yield_top_left 缺省应视为关闭');
  const patched1 = ctx.window.__ctrlPatch(baseModel);
  assert.notEqual(patched1, baseModel, '必须返回浅拷贝而非原地修改');
  assert.equal(baseModel.map, 'Original Map');
  assert.equal(baseModel.series, null);
  assert.equal(patched1.map, 'Original Map', '未填赛事名应保留原地图名');
  assert.deepEqual({ A: patched1.series.A, B: patched1.series.B }, { A: 2, B: 1 }, '决策 B1：仅改局分也必须生效');

  // 填赛事名后覆盖 map，再清空应恢复原 map
  ctrlPayload = { ...ctrlPayload, match_name: 'Finals G1', score_l: 0, score_r: 0, mode_label: 'BO5' };
  const ctx2 = vm.createContext({
    window: { dispatchEvent() {}, addEventListener() {} },
    document: { getElementById() { return null; }, body: { classList: { toggle() {}, contains() { return false; } } } },
    CustomEvent: function (type) { this.type = type; },
    fetch: () => Promise.resolve({ json: () => Promise.resolve(ctrlPayload) }),
    setInterval: (fn) => { ctx2._poll = fn; return 1; },
    clearInterval: () => {}
  });
  vm.runInContext(bridgeSrc, ctx2);
  await new Promise(r => setImmediate(r));
  const p2 = ctx2.window.__ctrlPatch(baseModel);
  assert.equal(p2.map, 'Finals G1');
  assert.deepEqual({ A: p2.series.A, B: p2.series.B }, { A: 0, B: 0 });
  assert.equal(p2.modeLabel, 'BO5');
  assert.equal(baseModel.map, 'Original Map', '原 model 不得被污染');

  ctrlPayload = { ...ctrlPayload, match_name: '', score_l: 0, score_r: 0, mode_label: '' };
  ctx2._poll();
  await new Promise(r => setImmediate(r));
  const p3 = ctx2.window.__ctrlPatch(baseModel);
  assert.equal(p3.map, 'Original Map', '清空赛事名应立即恢复原地图名');
  assert.equal(p3.series, null);
  assert.equal(p3.modeLabel, '1V1');
});

test('P1-3: playerKey separates same-name players by slot', () => {
  const snippet = extract('  function playerKey(p, idx)', '  function updatePlayerChip');
  const ctx = vm.createContext({});
  vm.runInContext(snippet, ctx);
  const k0 = ctx.playerKey({ name: 'Player', color: '#f00', slot: 0 }, 0);
  const k1 = ctx.playerKey({ name: 'Player', color: '#f00', slot: 1 }, 1);
  assert.notEqual(k0, k1);
});
