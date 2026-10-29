/* pages/overview.js — 总览
 * 4 张状态卡 + 实时预览 + 快捷控制 + 本局速览
 */
(function () {
'use strict';

const App = window.App;
const $ = window.$;

const QUICK = [
  {
    key: 'show_score', label: '比分 / 比赛名',
    descOn: '顶栏中央显示局分与赛事名',
    descOff: '顶栏中央留空，左右分队位置不跳动',
  },
  {
    key: 'show_units', label: '单位栏',
    descOn: '左右两侧显示玩家单位图标与数量',
    descOff: '左右单位栏隐藏，游戏画面更完整',
  },
  {
    key: 'show_queues', label: '生产队列',
    descOn: '右侧建造栏区域显示 6 通道队列',
    descOff: '队列隐藏，露出游戏原版建造栏',
  },
  {
    key: 'observer_gate', label: '观察者门槛',
    descOn: '仅在观察者视角渲染 HUD',
    descOff: '非观察者对局也会渲染 HUD（测试期默认关）',
  },
];

let frameLoaded = false;
const PREVIEW_KEY = 'mo_hud.preview';

/** 预览开关状态：默认开启，关闭后彻底卸载 iframe 省掉后台解码 */
function previewEnabled() {
  try { return localStorage.getItem(PREVIEW_KEY) !== 'off'; } catch (e) { return true; }
}

function applyPreviewState() {
  const card = document.querySelector('#page-overview .preview');
  if (!card) return;
  const on = previewEnabled();
  card.classList.toggle('off', !on);
  const btn = $('btnPreviewToggle');
  if (btn) {
    btn.textContent = on ? '关闭预览' : '开启预览';
    btn.title = on ? '关闭后停止预览渲染，减少后台开销' : '重新开启实时预览';
  }
}

/** 关闭时把 iframe 指向 about:blank，浏览器会停止页面里的渲染与轮询 */
function teardownPreview() {
  const frame = $('previewFrame');
  if (frame) {
    frame.src = 'about:blank';
    frame.style.display = 'none';
  }
  frameLoaded = false;
  const ph = $('previewPh');
  if (ph) ph.style.display = 'none';
}

function wirePreviewToggle() {
  const toggle = () => {
    const next = !previewEnabled();
    try { localStorage.setItem(PREVIEW_KEY, next ? 'on' : 'off'); } catch (e) {}
    applyPreviewState();
    if (next) {
      syncPreview();
      if (App.status) renderStats(App.status);
      App.toast('已开启实时预览');
    } else {
      teardownPreview();
      App.toast('已关闭预览，后台不再渲染');
    }
  };
  const a = $('btnPreviewToggle');
  const b = $('btnPreviewOn');
  if (a) a.onclick = toggle;
  if (b) b.onclick = toggle;
}

function init() {
  const host = $('quickToggles');
  host.innerHTML = '';
  for (const o of QUICK) {
    host.appendChild(App.ToggleRow({
      ...o,
      scope: 'sync',
      defaultValue: o.key !== 'observer_gate',
      onChange: () => {
        updateQuickCount();
        syncPreview();
      },
    }));
  }
  updateQuickCount();

  $('btnFreeze').onclick = () => {
    App.freeze = !App.freeze;
    $('btnFreeze').textContent = App.freeze ? '恢复' : '冻结';
    $('btnFreeze').classList.toggle('primary', App.freeze);
    App.toast(App.freeze ? '预览已冻结，数据继续采集' : '预览已恢复');
  };

  applyPreviewState();
  wirePreviewToggle();
  wirePreview();
  loadSummary();
  // 只在总览页可见时轮询，切到别的页就停
  setInterval(() => { if (App.route === 'overview') loadSummary(); }, 2000);
}

/** 预览：仅在页面可见时加载，避免后台持续解码 */
function wirePreview(){
  const frame = $('previewFrame');
  // 未挂载真实页面时隐藏（about:blank 会渲染成白底，盖住棋盘纹）
  frame.style.display = 'none';
  frame.src = 'about:blank';
}

function mountPreview() {
  const frame = $('previewFrame');
  if (frameLoaded) return;
  if (!previewEnabled()) return;
  frameLoaded = true;
  frame.style.display = '';
  // 与覆盖窗口同 URL；local=1 让页面走覆盖模式（透明、无工具栏）
  frame.src = `http://127.0.0.1:${App.port}/?overlay=1&local=1&source=live&url=/state/out/hud_state.json`;
  frame.onload = () => {
    const ph = $('previewPh');
    if (ph) ph.style.display = 'none';
  };
}

function updateQuickCount() {
  const c = App.ctrl || {};
  const on = QUICK.filter(o => !!c[o.key]).length;
  const el = $('qcount');
  if (el) el.textContent = `${on} / ${QUICK.length} 已开启`;
}

/* ---------- 状态卡 ---------- */

function initStats() {
  // 每 1.5 秒（跟随 status 轮询）由 onStatus 更新
}

function onStatus(st) {
  if (App.route !== 'overview') return;
  renderStats(st);
  syncPreview();
}

function renderStats(st) {
  const g = st.game_state || {};
  const o = st.overlay;
  const b = st.bridge;
  const hs = App.hudState(st);

  /* 数据桥 */
  const sb = $('statBridge');
  sb.className = 'stat ' + (b.external ? 'warn' : b.running ? 'ok' : 'bad');
  sb.querySelector('.val').textContent = b.external ? '外部实例' : b.running ? '托管运行中' : '未运行';
  $('sbSampling').innerHTML = `${st.interval_ms}<small>ms 采样</small>`;
  $('sbMeta').innerHTML = b.external
    ? '<span>不由本程序回收</span><span>频率切换不生效</span>'
    : `<span>重启 <em>${b.restarts}</em> 次</span><span>${b.ours ? 'Job 陪葬' : '未挂 Job'}</span>`;
  $('sbFoot').innerHTML = '<span>hud_bridge.exe</span><span>v7.0</span>';
  $('sbBar').style.width = b.running ? '100%' : '8%';

  /* 游戏 */
  const sg = $('statGame');
  const phase = g.phase;
  sg.className = 'stat ' + (!g.present ? '' : phase === 'match' ? 'ok' : 'warn');
  sg.querySelector('.val').textContent = !g.present ? '无数据' : App.fmt.phase(phase);
  const elapsed = (App.summary && App.summary.elapsed_sec) || 0;
  $('sgElapsed').innerHTML = `${App.fmt.duration(elapsed)}<small>已进行</small>`;
  $('sgMeta').innerHTML = g.present
    ? `<span>帧 <em>${(g.frame || 0).toLocaleString()}</em></span><span>${g.paused ? '<em>已暂停</em>' : '<em>未暂停</em>'}</span>`
    : '<span>等待进入对局</span>';
  const s = App.summary || {};
  $('sgFoot').innerHTML = g.present
    ? `<span>${s.players_in_session || 0} 人 · ${perTeam(s.players_in_session)}</span><span>${App.esc(App.fmt.phase(phase))}</span>`
    : '<span>—</span><span>—</span>';
  $('sgBar').style.width = phase === 'match' ? '62%' : '10%';

  /* 覆盖层 */
  const so = $('statOverlay');
  so.className = 'stat ' + (hs === 'on' ? 'ok' : hs === 'paused' ? 'warn' : '');
  so.querySelector('.val').textContent = hs === 'on' ? '显示中' : hs === 'paused' ? '已暂停' : '已隐藏';
  const c = App.ctrl || {};
  const behaviors = [o.topmost, c.auto_hide_on_blur !== false, c.cursor_indicator !== false].filter(Boolean).length;
  $('soCount').innerHTML = `${behaviors}<small>项行为已开</small>`;
  $('soMeta').innerHTML = `<span>置顶 <em>${o.topmost ? '开' : '关'}</em></span>
    <span>失焦隐藏 <em>${c.auto_hide_on_blur !== false ? '开' : '关'}</em></span>`;
  $('soFoot').innerHTML = `<span>光标指示器</span><span>${c.cursor_indicator !== false ? '开' : '关'}</span>`;
  $('soBar').style.width = hs === 'on' ? '100%' : hs === 'paused' ? '45%' : '6%';

  /* 数据 */
  const sd = $('statData');
  const age = g.present && g.mtime_ms ? Date.now() - g.mtime_ms : null;
  const stale = age != null && age > 3000;
  sd.className = 'stat ' + (age == null ? 'bad' : stale ? 'warn' : 'ok');
  sd.querySelector('.val').textContent = age == null ? '无数据' : stale ? '已陈旧' : '实时';
  $('sdAge').innerHTML = age == null ? '—' : `${App.fmt.age(age)}<small>前更新</small>`;
  $('sdMeta').innerHTML = age == null
    ? '<span>等待第一帧</span>'
    : `<span>状态 <em>${g.ok === false ? '异常' : 'ok'}</em></span><span>3 秒判陈旧</span>`;
  $('sdFoot').innerHTML = '<span>hud_state.json</span>' + (age == null ? '' : `<span>${g.paused ? '已暂停' : '推送中'}</span>`);
  $('sdBar').style.width = age == null ? '4%' : stale ? '35%' : '96%';

  /* 预览 chips */
  const scr = s.screen || {};
  const res = $('chipRes');
  res.textContent = scr.valid ? `${scr.width}×${scr.height}` : '几何未知';
  res.className = 'chip' + (scr.valid ? ' on' : '');

  const follow = $('chipFollow');
  follow.textContent = o.game_found ? '跟随游戏窗口' : '未找到游戏';
  follow.className = 'chip' + (o.game_found ? ' on' : ' warn');

  const ageChip = $('chipAge');
  ageChip.textContent = age == null ? '无数据帧' : `帧龄 ${App.fmt.age(age)}`;
  ageChip.className = 'chip' + (age == null ? ' warn' : stale ? ' warn' : '');

  const live = $('previewLive');
  live.className = 'live' + (stale || age == null ? ' stale' : '');
  live.innerHTML = `<span class="d"></span>${age == null ? 'NO DATA' : stale ? 'STALE' : 'LIVE'}`;
}

function perTeam(n) {
  const total = Number(n) || 0;
  const per = total >= 2 ? Math.floor(total / 2) : 0;
  return per ? `${per}v${per}` : '—';
}

/** 预览三态：跟随真实状态显示蒙层，不改数据流 */
function syncPreview() {
  const st = App.status;
  const stage = $('stage');
  if (!st) return;
  const hs = App.hudState(st);
  stage.classList.toggle('paused', hs === 'paused');
  stage.classList.toggle('hidden', hs === 'hidden');
  if (hs === 'paused') {
    $('ovlTitle').textContent = '已暂停 · 游戏失焦';
    $('ovlSub').textContent = '回到游戏窗口即自动恢复（或点「固定显示」）';
  } else if (hs === 'hidden') {
    $('ovlTitle').textContent = 'HUD 已隐藏';
    $('ovlSub').textContent = '覆盖窗口与 OBS 画面都不会显示';
  } else {
    $('ovlTitle').textContent = '';
    $('ovlSub').textContent = '';
  }

  const g = st.game_state || {};
  const has = !!(g.present && g.mtime_ms && Date.now() - g.mtime_ms <= 8000) && previewEnabled();
  if (has) mountPreview();
  const ph = $('previewPh');
  if (ph) {
    if (!previewEnabled()) {
      ph.style.display = 'none';
    } else {
      ph.style.display = has ? 'none' : 'grid';
      if (!has) {
        ph.innerHTML = `<div><b>${g.present ? 'HUD 数据已停止更新' : '尚未收到数据帧'}</b>
          ${g.present ? '检查游戏是否仍在运行' : '启动游戏进入对局后自动显示'}</div>`;
      }
    }
  }
}

/* ---------- 本局速览 ---------- */

async function loadSummary() {
  try {
    const s = await App.api('/app/summary');
    App.summary = s;
    renderSummary(s);
    renderStats(App.status || { overlay: {}, bridge: {}, game_state: {} });
    if (window.App.pages.overview.renderTextEchoHook) {}
  } catch (e) { /* 静默 */ }
}

function renderSummary(s) {
  const src = $('matchSrc');
  src.textContent = s.present ? 'hud_state.json' : '无数据';

  $('miMap').textContent = s.present ? (s.map_uiname || s.map || '—') : '—';
  $('miMode').textContent = s.present ? modeLabel(s) : '—';
  $('miObserver').textContent = s.present
    ? ((s.observer && s.observer.is_observer) ? '是' : '否')
    : '—';
  $('miElapsed').textContent = s.present ? App.fmt.duration(s.elapsed_sec) : '—';

  const drops = $('miDrops');
  if (!s.present) {
    drops.textContent = '—';
    drops.className = 'chip';
  } else if (s.out_of_sync) {
    drops.textContent = '数据不同步';
    drops.className = 'chip warn';
  } else {
    drops.textContent = s.paused ? '已暂停' : '正常';
    drops.className = 'chip' + (s.paused ? ' warn' : ' on');
  }

  const body = $('ptableBody');
  const players = s.present ? (s.players || []) : [];
  if (!players.length) {
    body.innerHTML = `<tr><td colspan="6" style="color:#61707f;padding:14px 15px">
      ${s.present ? '本局没有非观察者玩家' : '等待进入对局…'}</td></tr>`;
    return;
  }
  body.innerHTML = players.map(p => {
    const color = Array.isArray(p.color) ? `rgb(${p.color.join(',')})` : '#55606e';
    const name = App.esc(p.uiname || p.name || '玩家 ' + (p.slot + 1));
    const stCls = p.status === 'online' ? 'okc' : p.status === 'win' ? 'okc' : p.status === 'defeated' ? 'warnc' : 'badc';
    const army = p.army && typeof p.army === 'object'
      ? Object.values(p.army).reduce((a, b) => a + (Number(b) || 0), 0) : 0;
    return `<tr>
      <td><span class="nm"><i style="--c:${color}"></i>${name}</span></td>
      <td>${App.esc(App.fmt.faction(p.faction))}</td>
      <td>${App.fmt.money(p.cash)}</td>
      <td>${army}</td>
      <td>${p.kills || 0}</td>
      <td class="${stCls}">${App.esc(App.fmt.status(p.status))}</td>
    </tr>`;
  }).join('');
}

function modeLabel(s) {
  const n = Number(s.players_in_session) || 0;
  const per = n >= 2 ? Math.floor(n / 2) : 0;
  const base = s.game_mode === 3 ? '遭遇战' : s.game_mode != null ? '模式 ' + s.game_mode : '—';
  return per ? `${base} · ${per}v${per}` : base;
}

App.registerPage('overview', {
  init,
  onStatus,
  onShow: () => {
    applyPreviewState();
    if (App.status) { renderStats(App.status); syncPreview(); }
    loadSummary();
  },
  onCtrl: () => {
    updateQuickCount();
    syncPreview();
    if (App.status) renderStats(App.status);
  },
  onSummary: renderSummary,
});

// 让主控在 summary 更新后能通知本页（避免循环依赖）
window.__overviewOnCtrl = () => {
  updateQuickCount();
  syncPreview();
};
})();
