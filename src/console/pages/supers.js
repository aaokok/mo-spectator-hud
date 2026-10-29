/* pages/supers.js — 支援技能
 * R29 新增。这一页管的是「超级武器 / 支援技能」的图标栏（F 方案），
 * 和「单位」页完全独立：单位页的 hidden_units 是 unit_types 的 ID（HTNK/E1…），
 * 这里的 hidden_supers 是 SuperWeapon 节名（NukeSpecial/ForceShieldSpecial…）。
 * 两套清单互不影响，页面上也各有一句提示，避免用户搞混。
 */
(function () {
'use strict';

const App = window.App;
const $ = window.$;

const INDEX = window.SW_INDEX || [];
const byId = new Map(INDEX.map(x => [x.id, x]));

/* 从 /control/state 解析出来的当前配置 */
let SHOW = false;
let PRIO = [];      /* 优先显示顺序（数组序 = 显示优先级） */
let HID = [];       /* 不显示 */

let lastSig = '';
let filter = { q: '' };

/* ---------- 工具 ---------- */
function parseArr(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  } catch (e) { return []; }
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const iconUrl = id => '/icons/sw/' + id + '.png';

/* 条件摘要：给用户看「这个技能吃不吃钱/电」，和覆盖层角标同一套语义 */
function condText(it) {
  const parts = [];
  if (it.cost < 0) parts.push('扣 $' + Math.abs(it.cost));
  if (it.power) parts.push('需电力');
  return parts.length ? parts.join(' · ') : '无条件';
}

/* 真实显示顺序：先按 PRIO 里的顺序，再补 PRIO 里没有的（保持清单原序） */
function orderedAll() {
  const out = [];
  const seen = new Set();
  PRIO.forEach(id => {
    if (byId.has(id) && !seen.has(id)) { out.push(byId.get(id)); seen.add(id); }
  });
  INDEX.forEach(it => {
    if (!seen.has(it.id)) { out.push(it); seen.add(it.id); }
  });
  return out;
}

function passes(it) {
  if (!filter.q) return true;
  const q = filter.q.toUpperCase();
  return it.id.toUpperCase().includes(q) ||
    (it.name || '').toUpperCase().includes(q) ||
    (it.uiname || '').toUpperCase().includes(q);
}

/* ---------- 提交 ---------- */
async function push(patch) {
  try {
    const snap = await App.postControl(patch);
    App.ctrl = snap;
    return snap;
  } catch (e) {
    App.toast('保存失败：' + e.message, 'bad');
    throw e;
  }
}

const commitPrio = () => push({ super_priority: JSON.stringify(PRIO) });
const commitHid = () => push({ hidden_supers: JSON.stringify(HID) });

/* ---------- 顶部状态 ---------- */
function updateFlag() {
  const n = INDEX.length;
  const h = HID.length;
  const mod = !!(PRIO.length || h);
  const el = $('modSupers');
  if (el) {
    const b = el.querySelector('.b');
    const t = $('modSupersTxt');
    el.classList.toggle('on', mod);
    if (b) b.className = 'b ' + (mod ? 'on' : '');
    if (t) t.textContent = mod ? `${h} 隐藏 / ${PRIO.length} 优先` : '默认';
  }
  const st = $('supers-stat');
  if (st) {
    st.innerHTML = `<span><b>${n}</b> 个支援技能</span>` +
      (h ? `<span class="warn"><b>${h}</b> 已隐藏</span>` : '') +
      (PRIO.length ? `<span><b>${PRIO.length}</b> 设了优先</span>` : '');
  }
}

/* ---------- 开关行 ---------- */
let toggleRow = null;
function initToggle() {
  const host = $('supersToggle');
  if (!host) return;
  host.innerHTML = '';
  toggleRow = App.ToggleRow({
    key: 'show_supers',
    label: '支援技能栏（F 方案）',
    scope: 'sync',
    defaultValue: false,
    descOn: '在玩家面板的单位格下方显示支援技能；开启后 1v1 的玩家面板改为两列',
    descOff: '关闭后维持原状：不显示支援技能，1v1 仍是单列窄栏',
    onChange: on => {
      SHOW = on;
      const body = $('supersBody');
      if (body) body.classList.toggle('off', !on);
      paintAll();
    }
  });
  host.appendChild(toggleRow);
}

/* ---------- 主列表 ---------- */
function render() {
  const box = $('slist');
  if (!box) return;
  if (!INDEX.length) {
    box.innerHTML = '<div style="padding:20px;color:var(--dim);font-size:12px">' +
      '支援技能索引未加载（缺 hud/sw-manifest.js）。</div>';
    return;
  }
  const list = orderedAll().filter(passes);
  const prioRank = new Map(PRIO.map((id, i) => [id, i]));

  box.innerHTML = '';
  list.forEach(it => {
    const hid = HID.includes(it.id);
    const rank = prioRank.has(it.id) ? prioRank.get(it.id) + 1 : 0;
    const row = document.createElement('div');
    row.className = 'urow swrow' + (hid ? ' hid' : '');
    row.dataset.id = it.id;
    var img = document.createElement('img');
    img.className = 'ic';
    img.src = iconUrl(it.id);
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = function () {
      var ph = document.createElement('div');
      ph.className = 'ic noimg';
      img.replaceWith(ph);
    };
    row.appendChild(img);

    var info = document.createElement('div');
    info.className = 'info';
    info.innerHTML =
      '<div class="id">' + esc(it.id) +
        (rank ? '<span class="bdg prio">优先 ' + rank + '</span>' : '') +
        (hid ? '<span class="bdg hid">不显示</span>' : '') + '</div>' +
      '<div class="sub">' + esc(it.name || it.uiname || '—') + ' · ' +
        condText(it) + (it.hidden ? ' · 原版侧栏不显示' : '') + '</div>';
    row.appendChild(info);

    var bPrio = document.createElement('button');
    bPrio.className = 'actbtn';
    bPrio.dataset.act = 'prio';
    bPrio.title = '提到优先列表最前';
    bPrio.textContent = '优先';
    row.appendChild(bPrio);

    var bHide = document.createElement('button');
    bHide.className = 'actbtn';
    bHide.dataset.act = 'hide';
    bHide.textContent = hid ? '恢复' : '不显示';
    row.appendChild(bHide);

    box.appendChild(row);
  });

  if (!list.length) {
    box.innerHTML = '<div style="padding:20px;color:var(--dim);font-size:12px">没有匹配的技能。</div>';
  }
}

/* ---------- 优先顺序面板 ---------- */
function renderPrio() {
  const box = $('prioList');
  if (!box) return;
  if (!PRIO.length) {
    box.innerHTML = '<div class="ph" style="padding:12px;color:var(--dim);font-size:11.5px">' +
      '还没设优先顺序。按桥输出原序显示。</div>';
    return;
  }
  box.innerHTML = '';
  PRIO.forEach((id, i) => {
    const it = byId.get(id) || { id };
    const row = document.createElement('div');
    row.className = 'prow';
    row.innerHTML =
      '<span class="n">' + (i + 1) + '</span>' +
      '<span class="nm">' + esc(it.name || id) + '<u>' + esc(id) + '</u></span>' +
      '<button class="btn xs ghost" data-prio="up" title="上移">↑</button>' +
      '<button class="btn xs ghost" data-prio="down" title="下移">↓</button>' +
      '<button class="btn xs ghost" data-prio="del" title="移出优先表">✕</button>';
    box.appendChild(row);
  });
}

function paintAll() {
  render();
  renderPrio();
  updateFlag();
}

/* ---------- 事件 ---------- */
function initEvents() {
  const q = $('ssearch');
  if (q) q.addEventListener('input', () => { filter.q = q.value.trim(); render(); });

  const box = $('slist');
  if (box) {
    box.addEventListener('click', async e => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.closest('.swrow').dataset.id;
      const act = btn.dataset.act;
      btn.disabled = true;
      try {
        if (act === 'hide') {
          if (HID.includes(id)) HID = HID.filter(x => x !== id);
          else HID.push(id);
          await commitHid();
        } else if (act === 'prio') {
          /* 提到最前；已在表里则移到首位 */
          PRIO = [id].concat(PRIO.filter(x => x !== id));
          await commitPrio();
        }
        paintAll();
      } finally {
        btn.disabled = false;
      }
    });
  }

  const pl = $('prioList');
  if (pl) {
    pl.addEventListener('click', async e => {
      const btn = e.target.closest('button[data-prio]');
      if (!btn) return;
      const idx = [...pl.querySelectorAll('.prow')].indexOf(btn.closest('.prow'));
      if (idx < 0) return;
      const act = btn.dataset.prio;
      btn.disabled = true;
      try {
        if (act === 'del') PRIO.splice(idx, 1);
        else if (act === 'up' && idx > 0) {
          [PRIO[idx - 1], PRIO[idx]] = [PRIO[idx], PRIO[idx - 1]];
        } else if (act === 'down' && idx < PRIO.length - 1) {
          [PRIO[idx + 1], PRIO[idx]] = [PRIO[idx], PRIO[idx + 1]];
        }
        await commitPrio();
        paintAll();
      } finally {
        btn.disabled = false;
      }
    });
  }

  const reset = $('btnSupersReset');
  if (reset) {
    reset.addEventListener('click', async () => {
      PRIO = []; HID = [];
      await push({ super_priority: '', hidden_supers: '' });
      paintAll();
    });
  }
}

/* ---------- 页面生命周期 ---------- */
function onCtrl(c) {
  SHOW = !!c.show_supers;
  const np = parseArr(c.super_priority);
  const nh = parseArr(c.hidden_supers);

  if (toggleRow) toggleRow._refresh();

  const sig = JSON.stringify([np, nh]);
  const body = $('supersBody');
  if (body) body.classList.toggle('off', !SHOW);
  if (sig === lastSig) { updateFlag(); return; }
  lastSig = sig;
  PRIO = np; HID = nh;
  paintAll();
}

function init() {
  initToggle();
  initEvents();
  onCtrl(App.ctrl || {});
}

App.registerPage('supers', {
  init,
  onCtrl,
  onShow: () => paintAll(),
});
})();
