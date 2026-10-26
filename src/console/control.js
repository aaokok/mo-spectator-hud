/* control.js — MO 观战 HUD 控制台主控
 *
 * 职责：路由、状态轮询、四层状态反馈、toast/撤销、热键录制。
 * 分页逻辑在 pages/*.js，本文件先加载，最后调用 Page.init()。
 *
 * 四层反馈（方案 §6）：
 *   L1 控件本体   switch + 状态字「已开启 / 已关闭」
 *   L2 行副标题   开关态改写文案，关闭时说后果
 *   L3 分区       「N 项已修改」+ 行左侧琥珀竖条
 *   L4 全局       顶栏 pill + 实时预览 + 带撤销的 toast
 */
(function () {
'use strict';

const $ = id => document.getElementById(id);
const $$ = sel => [...document.querySelectorAll(sel)];

/* ======================= 应用状态 ======================= */

const App = {
  port: 8770,
  status: null,       // /app/status
  ctrl: null,         // /control/state
  summary: null,      // /app/summary
  envChecks: null,
  pages: {},
  route: 'overview',
  freeze: false,
  online: false,
};

window.App = App;
window.$ = $;
window.$$ = $$;

/* ======================= HTTP ======================= */

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(path + ' -> ' + r.status);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r;
}
App.api = api;

/** /control/set 走表单编码（与 v1 契约一致） */
App.postControl = async function (patch) {
  const body = new URLSearchParams(patch);
  const snap = await api('/control/set', { method: 'POST', body });
  App.ctrl = snap;
  return snap;
};

/* ======================= 格式化 ======================= */

const PHASE_CN = {
  no_client: '未检测到客户端',
  lobby: '大厅 / 准备中',
  loading: '载入中',
  match: '对局中',
  post_match: '对局结束',
};

const STATUS_CN = {
  online: '在线',
  win: '胜利',
  defeated: '战败',
  resigned: '投降',
  lostconn: '掉线',
};

const FACTION_CN = {
  USSR: '苏军',
  UnitedStates: '盟军',
  YuriCountry: '厄普西隆',
  Foehn: '焚风',
  China: '中国',
  Cuba: '古巴',
  Iraq: '伊拉克',
  Libya: '利比亚',
  Russia: '俄罗斯',
  Germany: '德国',
  France: '法国',
  Britain: '英国',
  Korea: '韩国',
  America: '美国',
};

App.fmt = {
  phase: p => PHASE_CN[p] || (p ? String(p) : '—'),
  status: s => STATUS_CN[s] || s || '—',
  faction: f => FACTION_CN[f] || f || '—',
  /** 秒 → mm:ss / h:mm:ss */
  duration(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const mm = String(m).padStart(2, '0');
    const s2 = String(ss).padStart(2, '0');
    return h ? `${h}:${mm}:${s2}` : `${mm}:${s2}`;
  },
  money(v) {
    const n = Number(v) || 0;
    return n >= 10000 ? '$' + (n / 1000).toFixed(1) + 'k' : '$' + n.toLocaleString();
  },
  age(ms) {
    if (!ms || ms < 0) return '—';
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
    return Math.round(ms / 60000) + ' min';
  },
};

/* ======================= toast ======================= */

let toastSeq = 0;
/**
 * @param {string} msg
 * @param {'ok'|'warn'|'bad'} kind
 * @param {Function|null} undo 传了就显示「撤销」
 */
function toast(msg, kind = 'ok', undo = null) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'warn' ? ' warn' : kind === 'bad' ? ' bad' : '');
  el.dataset.id = 't' + (++toastSeq);
  const d = document.createElement('span');
  d.className = 'd';
  const txt = document.createElement('span');
  txt.textContent = msg;
  el.append(d, txt);
  if (undo) {
    const u = document.createElement('button');
    u.className = 'undo';
    u.textContent = '撤销';
    u.onclick = () => { el.remove(); undo(); };
    el.appendChild(u);
  }
  box.appendChild(el);
  setTimeout(() => el.remove(), undo ? 4200 : 2600);
  while (box.children.length > 3) box.firstChild.remove();
}
App.toast = toast;

/* ======================= 路由 ======================= */

const TITLES = {
  overview: '总览',
  display: '直播画面',
  units: '单位与图标',
  env: '运行环境',
  logs: '运行日志',
  tutorial: '使用教程',
  help: '帮助',
};
const ROUTE_KEY = 'mo_hud_route';

function goto(name) {
  if (!TITLES[name]) name = 'overview';
  App.route = name;
  $$('#nav button').forEach(b => {
    const on = b.dataset.page === name;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $$('.page').forEach(p => p.classList.toggle('on', p.id === 'page-' + name));
  $('pageTitle').textContent = TITLES[name];
  $('content').scrollTop = 0;
  try { localStorage.setItem(ROUTE_KEY, name); } catch (e) {}
  const page = App.pages[name];
  if (page && page.onShow) page.onShow();
}
App.goto = goto;

$$('#nav button').forEach(b => {
  b.onclick = () => goto(b.dataset.page);
});

document.addEventListener('click', e => {
  const g = e.target.closest('[data-goto]');
  if (g) goto(g.dataset.goto);
});

/* ======================= 状态轮询 ======================= */

async function refreshStatus() {
  try {
    const st = await api('/app/status');
    App.status = st;
    App.port = st.port;
    App.online = true;
    $('railPort').textContent = String(st.port);
    $('railDot').style.background = 'var(--ok)';
    renderStatusPills(st);
    renderOverlayPills(st);
    renderHotkeyStatus(st.hotkeys);
    // 分页钩子（只通知当前页，避免后台页面做无谓重排）
    const page = App.pages[App.route];
    if (page && page.onStatus) page.onStatus(st);
    return st;
  } catch (e) {
    App.online = false;
    $('railPort').textContent = '离线';
    $('railDot').style.background = 'var(--danger)';
    pill('pillBridge', 'bad', '数据桥', '状态获取失败');
    pill('pillHud', 'bad', 'HUD', '未知');
    pill('pillGame', '', '对局', '未知');
    pill('pillData', 'bad', '数据', '—');
    throw e;
  }
}
App.refreshStatus = refreshStatus;

function pill(id, cls, label, value) {
  const el = $(id);
  if (!el) return;
  el.className = 'pill' + (cls ? ' ' + cls : '');
  el.innerHTML = '';
  const d = document.createElement('span');
  d.className = 'd';
  el.appendChild(d);
  el.appendChild(document.createTextNode(label + ' '));
  const b = document.createElement('b');
  b.textContent = value;
  el.appendChild(b);
}

/** HUD 三态：显示中 / 已暂停（失焦）/ 已隐藏 */
function hudState(st) {
  const o = st.overlay;
  if (!o.visible) return 'hidden';
  if (o.auto_hidden && !o.pinned) return 'paused';
  return 'on';
}
App.hudState = hudState;

function renderStatusPills(st) {
  const o = st.overlay;
  const hs = hudState(st);

  // 数据桥
  if (st.bridge.external) pill('pillBridge', 'warn', '数据桥', '外部实例');
  else if (st.bridge.running) pill('pillBridge', 'ok', '数据桥', '运行中');
  else pill('pillBridge', 'bad', '数据桥', '未运行');

  // HUD
  if (hs === 'on') pill('pillHud', 'ok', 'HUD', o.pinned ? '显示中 · 已钉住' : '显示中');
  else if (hs === 'paused') pill('pillHud', 'warn', 'HUD', '已暂停 · 游戏失焦');
  else pill('pillHud', '', 'HUD', '已隐藏');

  // 对局
  const g = st.game_state || {};
  if (!g.present) pill('pillGame', '', '对局', '无数据帧');
  else if (g.phase === 'match') {
    pill('pillGame', 'ok', '对局', '对局中');
  } else if (g.phase) {
    pill('pillGame', 'warn', '对局', App.fmt.phase(g.phase));
  } else {
    pill('pillGame', 'warn', '对局', '状态未知');
  }

  // 数据新鲜度（3 秒判陈旧，与渲染核一致）
  const age = g.present && g.mtime_ms ? Date.now() - g.mtime_ms : null;
  if (age == null) pill('pillData', 'bad', '数据', '无数据帧');
  else if (age > 3000) pill('pillData', 'warn', '数据', App.fmt.age(age) + ' 未更新');
  else pill('pillData', '', '数据', App.fmt.age(age));

  // 主按钮文案随三态翻转
  const btnTxt = $('btnHudTxt');
  const btn = $('btnHud');
  if (hs === 'hidden') {
    btnTxt.textContent = '显示 HUD';
    btn.classList.add('primary');
  } else if (hs === 'paused') {
    btnTxt.textContent = '固定显示';
    btn.classList.add('primary');
  } else {
    btnTxt.textContent = '隐藏 HUD';
    btn.classList.remove('primary');
  }
}

function renderOverlayPills(st) {
  const o = st.overlay;
  const hs = hudState(st);
  const setP = (id, cls, text) => {
    const el = $(id);
    if (!el) return;
    el.className = 'pill' + (cls ? ' ' + cls : '');
    el.innerHTML = '<span class="d"></span>' + text;
  };
  setP('ovPillVis', hs === 'on' ? 'ok' : hs === 'paused' ? 'warn' : '', hs === 'on' ? '显示中' : hs === 'paused' ? '已暂停 · 失焦' : '已隐藏');
  setP('ovPillTop', o.topmost ? 'ok' : '', o.topmost ? '置顶' : '不置顶');
  setP('ovPillFollow', o.game_found ? 'ok' : '', o.game_found ? '跟随中' : '未找到游戏');

  const vb = $('btnOvVisible');
  if (vb) vb.textContent = hs === 'hidden' ? '显示 HUD' : '隐藏 HUD';
  const tb = $('btnOvTopmost');
  if (tb) tb.textContent = o.topmost ? '取消置顶' : '设为置顶';
}
App.renderOverlayPills = renderOverlayPills;

/* ======================= 覆盖层动作 ======================= */

async function setOverlay(patch) {
  const st = await api('/app/overlay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  App.status = st;
  renderStatusPills(st);
  renderOverlayPills(st);
  return st;
}
App.setOverlay = setOverlay;

/** 点主按钮：隐藏在 ⇄ 显示（显示时带 pin，压过失焦暂停） */
App.toggleHud = async function (silent) {
  const st = App.status || await refreshStatus();
  const hs = hudState(st);
  if (hs === 'hidden') {
    await setOverlay({ visible: true, pin: true });
    if (!silent) toast('HUD 已显示（回到游戏后恢复自动）', 'ok', () => setOverlay({ visible: false, pin: false }));
  } else {
    await setOverlay({ visible: false, pin: false });
    if (!silent) toast('HUD 已隐藏', 'ok', () => setOverlay({ visible: true, pin: false }));
  }
};

$('btnHud').onclick = () => App.toggleHud().catch(e => toast('操作失败：' + e.message, 'bad'));
$('btnOvVisible').onclick = () => App.toggleHud().catch(e => toast('操作失败：' + e.message, 'bad'));
$('btnOvTopmost').onclick = async () => {
  const st = App.status || await refreshStatus();
  const next = !st.overlay.topmost;
  await setOverlay({ topmost: next });
  toast(next ? '覆盖层已置顶' : '已取消置顶', 'ok', () => setOverlay({ topmost: !next }));
};

/* ======================= 复制 ======================= */

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg || '已复制到剪贴板');
  } catch (e) {
    // WebView2 无权限时退回临时 textarea
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(okMsg || '已复制到剪贴板'); }
    catch (e2) { toast('复制失败，请手动选取', 'bad'); }
    ta.remove();
  }
}
App.copyText = copyText;

$('btnCopy').onclick = () => {
  copyText(`http://127.0.0.1:${App.port}/overlay`, '已复制 OBS 浏览器源地址');
};

/* ======================= 配色 ======================= */

const THEME_KEY = 'mo_hud.theme';

function applyTheme(name) {
  document.documentElement.dataset.theme = name === 'dark' ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, name); } catch (e) {}
  const btn = $('btnTheme');
  if (btn) {
    const dark = name === 'dark';
    btn.title = dark ? '当前深色，点击切换为浅色' : '当前浅色，点击切换为深色';
    btn.setAttribute('aria-label', btn.title);
  }
}

$('btnTheme').onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  toast(next === 'dark' ? '已切换到深色' : '已切换到浅色');
};
applyTheme(document.documentElement.dataset.theme || 'light');

/* ======================= 教程参考图放大 ======================= */

/* 缩略图悬停弹原尺寸大图并跟随指针，移开即收；点击钉住，再点 / Esc 收起。
   全局只建一个浮层，任何时候只有一张图在解码。 */
function initRefZoom() {
  const big = document.createElement('div');
  big.className = 'refbig';
  big.hidden = true;
  const bigImg = document.createElement('img');
  bigImg.alt = '';
  big.appendChild(bigImg);
  document.body.appendChild(big);

  let pinned = false, cur = null;

  function place(x, y) {
    const pad = 10, gap = 18;
    const w = big.offsetWidth, h = big.offsetHeight;
    let nx = x + gap, ny = y + gap;
    if (nx + w > innerWidth - pad) nx = x - w - gap;
    if (ny + h > innerHeight - pad) ny = y - h - gap;
    nx = Math.max(pad, Math.min(nx, Math.max(pad, innerWidth - w - pad)));
    ny = Math.max(pad, Math.min(ny, Math.max(pad, innerHeight - h - pad)));
    big.style.left = nx + 'px';
    big.style.top = ny + 'px';
  }

  function show(thumb, x, y) {
    cur = thumb;
    if (bigImg.getAttribute('src') !== thumb.dataset.img) {
      bigImg.src = thumb.dataset.img;
    }
    big.hidden = false;
    /* 图还没解码时 offsetWidth 是 0，夹边会算错，所以 onload 再定位一次 */
    bigImg.onload = () => place(x, y);
    place(x, y);
  }

  function hide() {
    pinned = false;
    cur = null;
    big.hidden = true;
    big.classList.remove('pinned');
  }

  function unpinOnly() { pinned = false; big.classList.remove('pinned'); }

  document.addEventListener('mousemove', e => {
    if (!cur || pinned) return;
    place(e.clientX, e.clientY);
  });

  document.addEventListener('mouseover', e => {
    const thumb = e.target.closest('.refzoom[data-img]');
    if (!thumb || thumb === cur) return;
    pinned = false;
    big.classList.remove('pinned');
    show(thumb, e.clientX, e.clientY);
  });

  document.addEventListener('mouseout', e => {
    const thumb = e.target.closest('.refzoom[data-img]');
    if (!thumb || pinned) return;
    /* 指针落在浮层内部不算离开（钉住状态下浮层可点） */
    if (e.relatedTarget && big.contains(e.relatedTarget)) return;
    hide();
  });

  document.addEventListener('click', e => {
    const thumb = e.target.closest('.refzoom[data-img]');
    if (thumb) {
      if (pinned && cur === thumb) { hide(); return; }
      pinned = true;
      big.classList.add('pinned');
      const r = thumb.getBoundingClientRect();
      show(thumb, r.right, r.top + r.height / 2);
      return;
    }
    if (pinned && big.contains(e.target)) { hide(); return; }
    /* 换页签 / 点别处都收起，避免浮层留在屏上 */
    if (pinned) hide();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !big.hidden) { hide(); return; }
    const thumb = e.target.closest && e.target.closest('.refzoom[data-img]');
    if (!thumb) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (pinned && cur === thumb) { hide(); return; }
      pinned = true;
      big.classList.add('pinned');
      const r = thumb.getBoundingClientRect();
      show(thumb, r.right, r.top + r.height / 2);
    }
  });
}
initRefZoom();

/* ======================= 热键 ======================= */

const HOTKEY_DEFAULT = { enabled: false, visible: 'ctrl+alt+h', topmost: 'ctrl+alt+t' };

function renderHotkeyStatus(h) {
  if (!h) return;
  // 回填输入框：否则点了「应用」会把没动过的那个键位当空串提交，把热键清掉
  for (const [id, val] of [['hotkey_visible', h.visible], ['hotkey_topmost', h.topmost]]) {
    const inp = $(id);
    const ae = document.activeElement;
    const editing = ae && (ae.id === id || ae.id === 'btnHotkeyCapture' || ae.id === 'btnHotkeyCapture2');
    if (inp && !editing) inp.value = val || '';
  }
  const el = $('hotkeyStatusTxt');
  if (!h.enabled) {
    el.textContent = '已关闭';
    el.style.color = 'var(--dim)';
  } else if (h.ok) {
    el.textContent = '已生效';
    el.style.color = 'var(--ok)';
  } else {
    el.textContent = '注册失败';
    el.style.color = 'var(--danger)';
  }
  const hint = $('hotkeyHint');
  if (h.enabled && !h.ok && h.error) {
    hint.textContent = '注册失败：' + h.error + '。可换一组按键再试；不影响程序其他功能。';
    hint.style.color = 'var(--danger)';
  } else {
    hint.textContent = '默认不注册任何全局热键。开启后按键格式为「修饰键+主键」，例如 ctrl+alt+h；被其他软件占用时会给出原因，程序仍可正常使用。';
    hint.style.color = 'var(--dim)';
  }
}

/** 把 KeyboardEvent 转成插件可解析的加速键串 */
function eventToAccel(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('super');
  const k = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta', 'Dead'].includes(k)) return null;
  let code = '';
  if (/^[a-zA-Z]$/.test(k)) code = k.toLowerCase();
  else if (/^[0-9]$/.test(k)) code = 'digit' + k;
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) code = k.toLowerCase();
  else {
    const map = {
      ' ': 'space', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
      Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
      Insert: 'insert', Delete: 'delete', Enter: 'enter', Tab: 'tab',
      '-': 'minus', '=': 'equal', ',': 'comma', '.': 'period', '/': 'slash',
      ';': 'semicolon', "'": 'quote', '[': 'bracketleft', ']': 'bracketright',
      '\\': 'backslash', '`': 'backquote',
    };
    code = map[k] || '';
  }
  if (!code || !mods.length) return null;
  return mods.join('+') + '+' + code;
}

function bindCapture(btn) {
  btn.onclick = () => {
    const input = $(btn.dataset.target);
    const prev = input.value;
    let done = false;
    btn.textContent = '按键中…';
    btn.classList.add('primary');
    input.value = '';
    input.placeholder = '请按下组合键（Esc 取消）';
    input.focus();

    const cleanup = () => {
      document.removeEventListener('keydown', onKey, true);
      btn.textContent = '录制';
      btn.classList.remove('primary');
      input.placeholder = btn.dataset.target === 'hotkey_visible' ? '如 ctrl+alt+h' : '如 ctrl+alt+t';
    };
    const onKey = e => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        input.value = prev;
        done = true;
        cleanup();
        return;
      }
      const accel = eventToAccel(e);
      if (!accel) {
        input.placeholder = '需要至少一个修饰键（Ctrl/Alt/Shift）';
        return;
      }
      input.value = accel;
      done = true;
      cleanup();
      toast(`已录制 ${accel}，点「应用热键」生效`);
    };
    document.addEventListener('keydown', onKey, true);
    // 失去焦点视为放弃录制
    input.addEventListener('blur', () => {
      if (done) return;
      done = true;
      input.value = prev;
      cleanup();
    }, { once: true });
  };
}
bindCapture($('btnHotkeyCapture'));
bindCapture($('btnHotkeyCapture2'));

$('btnHotkeyApply').onclick = async () => {
  const body = {
    visible: $('hotkey_visible').value.trim(),
    topmost: $('hotkey_topmost').value.trim(),
  };
  try {
    const r = await api('/app/hotkeys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    renderHotkeyStatus(r);
    App.refreshStatus().catch(() => {});
    if (r.ok) toast('热键已更新：' + [r.visible && `显隐 ${r.visible}`, r.topmost && `置顶 ${r.topmost}`].filter(Boolean).join(' · '));
    else toast('热键注册失败：' + (r.error || '未知原因'), 'bad');
  } catch (e) {
    toast('保存失败：' + e.message, 'bad');
  }
};

$('btnHotkeyReset').onclick = () => {
  $('hotkey_visible').value = HOTKEY_DEFAULT.visible;
  $('hotkey_topmost').value = HOTKEY_DEFAULT.topmost;
  toast('已填入默认键位，点「应用热键」生效');
};

/** 热键开关（复用统一 trow 构造） */
function buildHotkeySwitch() {
  const host = $('hotkeyEnableRow');
  host.innerHTML = '';
  host.appendChild(ToggleRow({
    label: '启用全局热键',
    scope: 'local',
    key: 'hk_enabled',
    descOn: '按设定组合键可在任何窗口显隐 / 置顶 HUD',
    descOff: '默认关闭：避免与游戏或其他软件抢键；需要时再打开',
    get: () => !!(App.status && App.status.hotkeys && App.status.hotkeys.enabled),
    set: async v => {
      const r = await api('/app/hotkeys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: v }),
      });
      renderHotkeyStatus(r);
      App.refreshStatus().catch(() => {});
      return r;
    },
    keepState: true,   // 状态以服务端回包为准
  }));
}

/* ======================= 通用开关行 ======================= */

/**
 * 构造一行开关。四层反馈的 L1/L2 在这里，L3 由调用方 updateModFlag。
 * @param {object} o
 * @param {string} o.label        名称
 * @param {'sync'|'local'} o.scope 生效范围
 * @param {string} [o.key]        与默认值比较用的键（配合 get）
 * @param {Function} [o.get]      读取当前值（默认从 App.ctrl 取）
 * @param {Function} [o.set]      提交（默认写 /control/set）
 * @param {string} o.descOn       开启时副标题
 * @param {string} [o.descOff]    关闭时副标题（缺省用 descOn）
 * @param {Function} [o.onChange] 本地副作用
 * @param {boolean} [o.keepState] true = 不本地翻转，等 set 回包
 */
function ToggleRow(o) {
  const el = document.createElement('div');
  el.className = 'trow';

  const wrap = document.createElement('div');
  const lbl = document.createElement('div');
  lbl.className = 'lbl';
  lbl.appendChild(document.createTextNode(o.label));
  const scope = document.createElement('span');
  scope.className = 'scope ' + (o.scope === 'local' ? 'local' : 'sync');
  scope.textContent = o.scope === 'local' ? '仅本地' : 'OBS 同步';
  lbl.appendChild(scope);
  const desc = document.createElement('div');
  desc.className = 'desc';
  wrap.append(lbl, desc);

  const ctl = document.createElement('div');
  ctl.className = 'ctl';
  const stateTxt = document.createElement('span');
  stateTxt.className = 'stateTxt';
  const sw = document.createElement('label');
  sw.className = 'sw';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('aria-label', o.label);
  const track = document.createElement('span');
  track.className = 'track';
  sw.append(input, track);
  ctl.append(stateTxt, sw);

  el.append(wrap, ctl);

  let current = false;
  let modded = false;

  function paint(on) {
    current = !!on;
    input.checked = current;
    el.classList.toggle('on', current);
    stateTxt.textContent = current ? '已开启' : '已关闭';
    desc.textContent = current ? o.descOn : (o.descOff || o.descOn);
    desc.classList.toggle('warn', !current && !!o.descOff);
    el.classList.toggle('mod', modded);
  }

  function read() {
    if (o.get) return !!o.get();
    return !!(App.ctrl && App.ctrl[o.key]);
  }

  input.onchange = async () => {
    const next = input.checked;
    const prev = !next;
    if (!o.keepState) paint(next);
    el.classList.add('saving');
    try {
      if (o.set) await o.set(next);
      else {
        await App.postControl({ [o.key]: next ? '1' : '0' });
      }
      el.classList.remove('saving');
      el.classList.remove('bad');
      if (o.keepState) paint(read());
      modded = o.defaultValue !== undefined ? current !== o.defaultValue : modded;
      el.classList.toggle('mod', modded);
      if (o.onChange) o.onChange(current);
      toast(`「${o.label}」${current ? '已开启' : '已关闭'}`, 'ok',
        async () => {
          if (o.set) await o.set(prev); else await App.postControl({ [o.key]: prev ? '1' : '0' });
          paint(read());
          if (o.onChange) o.onChange(current);
          el.classList.remove('mod');
          modded = false;
        });
    } catch (e) {
      el.classList.remove('saving');
      el.classList.add('bad');
      paint(prev);
      if (o.onChange) o.onChange(current);
      toast(`「${o.label}」保存失败：${e.message}`, 'bad');
      setTimeout(() => el.classList.remove('bad'), 1600);
    }
  };

  paint(read());
  el._refresh = () => {
    if (o.defaultValue !== undefined) modded = read() !== o.defaultValue;
    paint(read());
  };
  el._isMod = () => modded;
  return el;
}
App.ToggleRow = ToggleRow;

/* ======================= 顶栏文案（两处输入框同步） ======================= */

const textInputs = [
  ['match_name', 'match_name2'],
  ['score_l', 'score_l2'],
  ['score_r', 'score_r2'],
  ['mode_label', 'mode_label2'],
];

let textTimer = null;
function pushText(patch) {
  clearTimeout(textTimer);
  textTimer = setTimeout(() => {
    App.postControl(patch)
      .then(() => { renderTextEcho(); refreshCtrl().catch(() => {}); })
      .catch(e => toast('文案保存失败：' + e.message, 'bad'));
  }, 400);
}

function bindTextInputs() {
  for (const pair of textInputs) {
    for (const id of pair) {
      const el = $(id);
      if (!el) continue;
      el.oninput = () => {
        // 另一侧的镜像同步
        for (const other of pair) {
          const o = $(other);
          if (o && o !== el) o.value = el.value;
        }
        const patch = {};
        patch[pair[0]] = el.value;
        pushText(patch);
      };
    }
  }
  $$('[data-clear]').forEach(b => {
    b.onclick = () => {
      const key = b.dataset.clear;
      const patch = {};
      if (key === 'score') { patch.score_l = '0'; patch.score_r = '0'; }
      else patch[key] = '';
      clearTimeout(textTimer);
      App.postControl(patch).then(() => {
        refreshCtrl();
        renderTextEcho();
        toast('已恢复为游戏数据');
      }).catch(e => toast('恢复失败：' + e.message, 'bad'));
    };
  });
  $('btnResetText').onclick = () => {
    const patch = { match_name: '', score_l: '0', score_r: '0', mode_label: '' };
    App.postControl(patch).then(() => {
      refreshCtrl();
      renderTextEcho();
      toast('顶栏文案已全部恢复为游戏数据', 'ok');
    }).catch(e => toast('恢复失败：' + e.message, 'bad'));
  };
}

function renderTextEcho() {
  const c = App.ctrl || {};
  const s = App.summary || {};
  const gameMode = modeLabelOf(s);

  const matchTxt = c.match_name ? `${c.match_name}（自定义）` : '来自游戏数据';
  const scoreTxt = (c.match_name || c.score_l || c.score_r)
    ? `${c.score_l ?? 0} : ${c.score_r ?? 0}（自定义）` : '来自游戏数据';
  const modeTxt = c.mode_label
    ? `${c.mode_label}（自定义）`
    : (gameMode === '—' ? '来自游戏数据（当前无对局）' : `${gameMode}（来自游戏）`);

  for (const id of ['echoMatch', 'echoMatch2']) {
    const el = $(id);
    if (el) el.innerHTML = `当前显示：<b>${esc(matchTxt)}</b>`;
  }
  for (const id of ['echoScore', 'echoScore2']) {
    const el = $(id);
    if (el) el.innerHTML = `当前显示：<b>${esc(scoreTxt)}</b>`;
  }
  for (const id of ['echoMode', 'echoMode2']) {
    const el = $(id);
    if (el) el.innerHTML = `当前显示：<b>${esc(modeTxt)}</b>`;
  }
  const src = $('copySrc');
  if (src) src.textContent = c.match_name || c.mode_label ? '自定义' : '游戏数据';
}

function modeLabelOf(s) {
  // 只有对局中才显示模式；对局外 game_mode 是残留值（常见 0）
  if (s.phase !== 'match') return '—';
  const n = Number(s.players_in_session) || 0;
  const per = n >= 2 ? Math.floor(n / 2) : 0;
  const modeMap = { 3: '遭遇战', 4: '多人' };
  const base = modeMap[s.game_mode] || (s.game_mode != null ? '模式 ' + s.game_mode : '—');
  return per ? `${base} · ${per}v${per}` : base;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
App.esc = esc;

/* ======================= /control/state ======================= */

async function refreshCtrl() {
  try {
    const c = await api('/control/state');
    App.ctrl = c;
    // 文本输入：不在编辑焦点时回填
    for (const [a, b] of textInputs) {
      const val = c[a] ?? '';
      for (const id of [a, b]) {
        const el = $(id);
        if (el && document.activeElement !== el) el.value = val;
      }
    }
    if ($('cmode') && document.activeElement !== $('cmode')) $('cmode').value = c.hidden_count_mode || 'keep';
    if ($('uprio') && document.activeElement !== $('uprio')) {
      $('uprio').value = c.unit_priority || '["hero","one","cnt"]';
    }
    renderTextEcho();
    $$('.trow').forEach(r => { if (r._refresh) r._refresh(); });
    // 分页钩子：单位页与总览都要重算（前者列表/徽章，后者快捷计数）
    for (const name of Object.keys(App.pages)) {
      const p = App.pages[name];
      if (p && p.onCtrl) {
        try { p.onCtrl(c); } catch (e) { console.error('onCtrl failed: ' + name, e); }
      }
    }
    return c;
  } catch (e) {
    return null;
  }
}
App.refreshCtrl = refreshCtrl;

/* ======================= 环境自检（共享给总览/环境页） ======================= */

const CHECK_GROUPS = {
  os: '系统与运行时',
  webview2: '系统与运行时',
  game: '游戏本体',
  bridge: '数据链路',
  out: '数据链路',
  icons: '数据链路',
  service: '本地服务',
  display: '显示与安全',
  av: '显示与安全',
};
const GROUP_ORDER = ['系统与运行时', '游戏本体', '数据链路', '显示与安全', '本地服务'];

let envLoading = false;
async function loadEnv(force) {
  if (envLoading) return;
  envLoading = true;
  try {
    const { checks } = await api('/envcheck' + (force ? '?force=1' : ''));
    App.envChecks = checks;
    renderEnv(checks);
    renderEnvNotice(checks);
    renderStatusPills(App.status || { overlay: {}, bridge: {}, game_state: {} });
    return checks;
  } catch (e) {
    $('envGroups').innerHTML = `<div class="notice bad">检测失败：${esc(e.message)}</div>`;
    throw e;
  } finally {
    envLoading = false;
  }
}
App.loadEnv = loadEnv;

function envCounts(checks) {
  const c = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const x of checks || []) c[x.level] = (c[x.level] || 0) + 1;
  return c;
}

function renderEnv(checks) {
  const n = envCounts(checks);
  const sum = $('envSum');
  const ic = $('envSumIc');
  let cls = 'envsum', icon = '✓', title = '环境就绪';
  if (n.fail) { cls += ' bad'; icon = '✕'; title = `有 ${n.fail} 项必须处理`; }
  else if (n.warn) { cls += ''; icon = '!'; title = `可以观战，但有 ${n.warn} 项建议处理`; }
  else { cls += ' ok'; }
  sum.className = cls;
  ic.textContent = icon;
  $('envSumTitle').textContent = title;
  $('envSumSub').textContent =
    `${n.pass} 项通过 · ${n.warn} 项建议 · ${n.fail} 项失败 · 检测于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;

  const groups = {};
  for (const c of checks || []) {
    const g = CHECK_GROUPS[c.id] || '其他';
    (groups[g] = groups[g] || []).push(c);
  }
  const order = [...GROUP_ORDER, ...Object.keys(groups).filter(g => !GROUP_ORDER.includes(g))];
  const host = $('envGroups');
  host.innerHTML = '';
  for (const g of order) {
    if (!groups[g]) continue;
    const sec = document.createElement('section');
    sec.className = 'card';
    sec.innerHTML = `<header><h2>${esc(g)}</h2></header><div class="body"></div>`;
    const body = sec.querySelector('.body');
    for (const c of groups[g]) {
      const row = document.createElement('div');
      row.className = 'envrow ' + c.level;
      // 通过项只写「正常」；只有异常/建议项才展开路径、版本与原因
      const detail = c.level === 'pass' ? '正常' : c.detail;
      const hint = c.level === 'pass' ? '' : (c.hint || '');
      row.innerHTML = `<span class="d"></span><span class="t">${esc(c.title)}</span>
        <span class="v" title="${esc(c.detail)}">${esc(detail)}</span>` +
        (hint ? `<span class="h">${esc(hint)}</span>` : '');
      body.appendChild(row);
      if (c.id === 'game') {
        const pr = document.createElement('div');
        pr.className = 'pathrow';
        pr.innerHTML = `<input type="text" id="gamepath" placeholder="游戏根目录（含 gamemd.exe），留空沿用注册表 / 自动检测">
          <button class="btn sm" id="btn-gamepath">保存并检测</button>`;
        body.appendChild(pr);
        pr.querySelector('#btn-gamepath').onclick = async () => {
          try {
            await api('/app/gamepath', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: pr.querySelector('#gamepath').value }),
            });
            toast('游戏目录已保存，正在重新检测');
            await loadEnv(true);
          } catch (e) {
            toast('保存失败：' + e.message, 'bad');
          }
        };
      }
      if (c.id === 'bridge') {
        const pr = document.createElement('div');
        pr.className = 'field';
        pr.innerHTML = `<label for="interval">采样频率</label>
          <select id="interval" style="max-width:130px">
            <option value="500">500 ms</option>
            <option value="250">250 ms</option>
            <option value="100">100 ms</option>
          </select>
          <span style="font-size:11px;color:var(--dim);flex:1">修改后立即重启桥，约 1 秒数据中断</span>
          <button class="btn sm" id="btn-restart">立即重启</button>`;
        body.appendChild(pr);
        pr.querySelector('#interval').value = String(App.status?.interval_ms || 500);
        pr.querySelector('#btn-restart').onclick = async () => {
          const interval = Number(pr.querySelector('#interval').value);
          try {
            await api('/app/bridge/restart', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ interval }),
            });
            toast(`已按 ${interval} ms 重启数据桥`);
            setTimeout(() => refreshStatus().catch(() => {}), 900);
          } catch (e) {
            toast('重启失败：' + e.message, 'bad');
          }
        };
      }
    }
    host.appendChild(sec);
  }
}
App.renderEnv = renderEnv;

function renderEnvNotice(checks) {
  const box = $('envNotice');
  if (!box) return;
  const items = (checks || []).filter(c => c.level === 'fail' || c.level === 'warn');
  if (!items.length) { box.hidden = true; return; }
  box.hidden = false;
  box.className = 'notice' + (items.some(c => c.level === 'fail') ? ' bad' : '');
  $('envNoticeTxt').textContent =
    `${items.length} 项建议处理：` + items.map(c => c.title).join(' · ');
}

function envReportText() {
  const mark = { pass: '✓', warn: '!', fail: '✕', info: 'i' };
  const lines = (App.envChecks || []).map(c =>
    `${mark[c.level] || '·'} ${c.title} — ${c.detail}${c.hint ? '（' + c.hint + '）' : ''}`);
  const st = App.status;
  if (st) {
    lines.unshift(`MO 观战 HUD 环境报告 · ${new Date().toLocaleString('zh-CN')}`);
    lines.push('');
    lines.push(`服务端口 ${st.port} · 采样 ${st.interval_ms}ms`);
    lines.push(`数据桥 ${st.bridge.running ? '运行中' : '未运行'}${st.bridge.external ? '（外部实例）' : ''}`);
    lines.push(`覆盖层 ${st.overlay.visible ? '显示' : '隐藏'} · ${st.overlay.topmost ? '置顶' : '不置顶'}`);
  }
  return lines.join('\n');
}

$('btn-env').onclick = () => {
  loadEnv(true).then(() => toast('已重新检测')).catch(e => toast('检测失败：' + e.message, 'bad'));
};
$('btn-env-copy').onclick = () => copyText(envReportText(), '完整环境报告已复制');
$('btnReport').onclick = () => copyText(envReportText(), '环境报告已复制');

/* ======================= 日志（主轮询，pages/logs 负责渲染细节） ======================= */

let logPaused = false;
async function refreshLog() {
  try {
    const { lines } = await api('/app/log');
    if (App.pages.logs && App.pages.logs.setLines) App.pages.logs.setLines(lines);
    return lines;
  } catch (e) { return null; }
}
App.refreshLog = refreshLog;
App.isLogPaused = () => logPaused;
App.setLogPaused = v => { logPaused = v; };

/* ======================= 初始化 ======================= */

let statusTimer = null, logTimer = null, summaryTimer = null;

async function boot() {
  bindTextInputs();
  buildHotkeySwitch();

  // 分页初始化（pages/*.js 已把工厂挂到 App.pages）
  for (const name of Object.keys(App.pages)) {
    const p = App.pages[name];
    if (p && p.init) {
      try { p.init(); } catch (e) { console.error('page init failed: ' + name, e); }
    }
  }
  buildHelpStates();

  // 路由：优先 URL hash → localStorage → 总览
  let initial = location.hash.replace('#', '');
  if (!TITLES[initial]) {
    try { initial = localStorage.getItem(ROUTE_KEY) || 'overview'; } catch (e) { initial = 'overview'; }
  }
  goto(TITLES[initial] ? initial : 'overview');

  // 首屏
  try {
    await refreshStatus();
    await refreshCtrl();
    loadEnv(false).catch(() => {});
    refreshLog();
  } catch (e) {
    toast('无法连接本地服务，请确认 mo_hud.exe 正在运行', 'bad');
  }

  statusTimer = setInterval(() => refreshStatus().catch(() => {}), 1500);
  logTimer = setInterval(() => { if (!logPaused) refreshLog(); }, 2000);
  return;
}

function buildHelpStates() {
  const host = $('helpStates');
  const rows = [
    ['已开启 / 已关闭', '开关本体状态字，绿色=已开启'],
    ['已修改 + 琥珀竖条', '与默认值不同，分区标题会统计条数'],
    ['已暂停 · 游戏失焦', 'HUD 仍开着，但游戏不在前台所以自动隐藏；回到游戏即恢复'],
    ['显示中 · 已钉住', '在控制台点了「显示」，切回游戏前也会保持可见'],
    ['保存中… / 保存失败', '保存失败会自动回滚并弹红色提示'],
    ['3.2 s 未更新', '数据帧超过 3 秒没更新，HUD 会淡化并提示'],
  ];
  host.innerHTML = rows.map(([a, b]) => `<div><b style="color:var(--txt)">${esc(a)}</b> — ${esc(b)}</div>`).join('');
}

/* 供分页脚本注册（pages/*.js 在本文件之后加载） */
App.registerPage = function (name, impl) {
  App.pages[name] = impl;
};

// 等全部脚本（含 pages/*.js）就位后再启动，避免分页模块还没注册就 init
if (document.readyState === 'complete') boot();
else window.addEventListener('load', boot, { once: true });
})();
