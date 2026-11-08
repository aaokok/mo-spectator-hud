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
