/* pages/supers.js — 支援技能
 * R29 新增，R42 与「单位」页统一呈现。
 * 这一页管的是「超级武器 / 支援技能」的图标栏（F 方案），和「单位」页完全独立：
 * 单位页的 hidden_units 是 unit_types 的 ID（HTNK/E1…），
 * 这里的 hidden_supers 是 SuperWeapon 节名（NukeSpecial/ForceShieldSpecial…）。
 * 两套清单互不影响，页面上也各有一句提示，避免用户搞混。
 */
(function () {
'use strict';

const App = window.App;
const $ = window.$;

const INDEX = window.SW_INDEX || [];
const byId = new Map(INDEX.map(x => [x.id, x]));

/* 条件分组：Money.Amount 的符号决定发射时扣钱还是给钱。
   和覆盖层角标的 money/power 语义同源（assets/sw-cond.js）。 */
const COST_CN = { cost: '扣款', free: '免费', gain: '返还' };
const COST_ORDER = ['cost', 'free', 'gain'];
const costGroup = it => (it.cost < 0 ? 'cost' : it.cost > 0 ? 'gain' : 'free');

/* 从 /control/state 解析出来的当前配置 */
let SHOW = false;
let PRIO = [];      /* 优先显示顺序（数组序 = 显示优先级） */
let HID = [];       /* 不显示 */

let lastSig = '';
let filter = { q: '', state: '', cost: '', power: '' };
let sortMode = 'hud';
let selectedId = null;

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

/* rules 的 RechargeTime 以分钟计；小于 1 分钟换成秒更好读 */
function rechText(it) {
  const v = parseFloat(it.recharge);
  if (!isFinite(v) || v <= 0) return '—';
  return v < 1 ? `${Math.round(v * 60)} 秒` : `${v} 分钟`;
}

/* 条件摘要：给用户看「这个技能吃不吃钱/电」，和覆盖层角标同一套语义 */
function condText(it) {
  const parts = [];
  if (it.cost < 0) parts.push('发射扣 $' + Math.abs(it.cost));
  else if (it.cost > 0) parts.push('发射得 $' + it.cost);
  else parts.push('无金钱条件');
  parts.push(it.power ? '需电力' : '不耗电');
  return parts.join(' · ');
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

const isHidden = id => HID.includes(id);
const isPrio = id => PRIO.includes(id);

function passes(it) {
  if (filter.q) {
    const q = filter.q.toUpperCase();
    if (!(it.id.toUpperCase().includes(q) ||
          (it.name || '').toUpperCase().includes(q) ||
          (it.uiname || '').toUpperCase().includes(q))) return false;
  }
  if (filter.cost && costGroup(it) !== filter.cost) return false;
  if (filter.power === 'on' && !it.power) return false;
  if (filter.power === 'off' && it.power) return false;
  if (filter.state === 'hid' && !isHidden(it.id)) return false;
  if (filter.state === 'prio' && !isPrio(it.id)) return false;
  if (filter.state === 'mod' && !(isHidden(it.id) || isPrio(it.id))) return false;
  return true;
}

/* 排序：hud = 优先表 → 桥输出原序；其余模式不改变优先语义，只在页面上重排 */
function sortList(list) {
  if (sortMode === 'name') {
    return list.slice().sort((a, b) =>
      (a.name || a.id).localeCompare(b.name || b.id, 'en', { sensitivity: 'base' }));
  }
  if (sortMode === 'rech' || sortMode === 'rechd') {
    const rank = it => { const v = parseFloat(it.recharge); return isFinite(v) ? v : Infinity; };
    const dir = sortMode === 'rech' ? 1 : -1;
    return list.slice().sort((a, b) => (rank(a) - rank(b)) * dir);
  }
  if (sortMode === 'group') {
    return list.slice().sort((a, b) =>
      (COST_ORDER.indexOf(costGroup(a)) - COST_ORDER.indexOf(costGroup(b)))
      || (a.name || a.id).localeCompare(b.name || b.id, 'en', { sensitivity: 'base' }));
  }
  return list;
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
    /* .modflag 的显隐类是 .show；R42 之前写成 .on，标记一直没出现过 */
    el.classList.toggle('show', mod);
    if (b) b.className = 'b ' + (mod ? 'on' : '');
    if (t) t.textContent = mod ? `${h} 隐藏 / ${PRIO.length} 优先` : '默认';
  }
  const st = $('supers-stat');
  if (st) {
    const powered = INDEX.filter(it => it.power).length;
    st.innerHTML = `<span><b>${INDEX.length}</b> 个支援技能</span>` +
      `<span>需电力 <b>${powered}</b></span>` +
      (h ? `<span class="warn"><b>${h}</b> 已隐藏</span>` : '') +
      (PRIO.length ? `<span><b>${PRIO.length}</b> 设了优先</span>` : '') +
      '<span style="margin-left:auto">点击行查看详情</span>';
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
    descOn: '单位格下方显示支援技能，1v1 玩家面板放宽为两列（节名如 NukeSpecial，与单位页清单独立）',
    descOff: '不显示支援技能，1v1 维持单列窄栏；非 1v1 对局始终不插入',
    onChange: on => {
      SHOW = on;
      const main = $('supersMain');
      if (main) main.classList.toggle('off', !on);
      paintAll();
    }
  });
  host.appendChild(toggleRow);
}

/* ---------- 分类 chip ---------- */
function renderChips() {
  const bar = $('sChips');
  if (!bar) return;
  bar.innerHTML = '';

  const groups = [
    { grp: '条件', key: 'cost', codes: COST_ORDER, cn: COST_CN },
    { grp: '电力', key: 'power', codes: ['on', 'off'], cn: { on: '需电力', off: '不耗电' } },
  ];

  for (const g of groups) {
    const lab = document.createElement('span');
    lab.className = 'gl';
    lab.textContent = g.grp;
    bar.appendChild(lab);
    for (const code of g.codes) {
      const on = filter[g.key] === code;
      const b = document.createElement('button');
      b.className = 'chip' + (on ? ' on' : '');
      b.textContent = g.cn[code] || code;
      b.title = on ? '取消该过滤' : `只看「${g.cn[code] || code}」`;
      b.onclick = () => {
        filter[g.key] = on ? '' : code;
        renderChips();
        render();
      };
      bar.appendChild(b);
    }
  }
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

  const list = sortList(orderedAll().filter(passes));
  const prioRank = new Map(PRIO.map((id, i) => [id, i]));

  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div style="padding:20px;color:var(--dim);font-size:12px">' +
      '没有匹配的技能。调整搜索或过滤条件。</div>';
    renderStat();
    return;
  }

  /* 分组表头只在「按条件分组」或默认顺序下给，搜索命中单一结果时不加噪音 */
  const showGroup = sortMode === 'group';
  let frag = document.createDocumentFragment();
  let curGroup = null;

  for (const it of list) {
    if (showGroup) {
      const g = costGroup(it);
      if (g !== curGroup) {
        curGroup = g;
        const n = list.filter(x => costGroup(x) === g).length;
        const h = document.createElement('div');
        h.className = 'ugroup';
        h.textContent = `${COST_CN[g]}（${n}）`;
        frag.appendChild(h);
      }
    }
    frag.appendChild(superRow(it, prioRank.get(it.id)));
  }

  box.appendChild(frag);
  renderStat();
  if (selectedId && document.querySelector('.swrow[data-id="' + selectedId + '"]')) {
    markSelected(selectedId);
  } else {
    select(firstVisibleId(list));
  }
}

const firstVisibleId = list => (list.length ? list[0].id : null);

function superRow(it, rank) {
  const id = it.id;
  const hid = isHidden(id);
  const inPrio = rank !== undefined;

  const row = document.createElement('div');
  row.className = 'urow swrow' + (hid ? ' hid' : '');
  row.dataset.id = id;

  const img = document.createElement('img');
  img.className = 'ic';
  img.src = iconUrl(id);
  img.alt = '';
  img.loading = 'lazy';
  img.onerror = function () {
    const ph = document.createElement('div');
    ph.className = 'ic noimg';
    img.replaceWith(ph);
  };
  row.appendChild(img);

  const info = document.createElement('div');
  info.className = 'info';
  const idEl = document.createElement('div');
  idEl.className = 'id';
  idEl.textContent = id;
  const subEl = document.createElement('div');
  subEl.className = 'sub';
  subEl.textContent = `${it.name || it.uiname || '—'} · ${COST_CN[costGroup(it)]} · 充能 ${rechText(it)}`;
  info.append(idEl, subEl);
  row.appendChild(info);

  const badges = document.createElement('div');
  badges.className = 'badges';
  if (inPrio) badges.appendChild(bdg('优先 ' + (rank + 1), 'prio'));
  if (hid) badges.appendChild(bdg('不显示', 'hid'));
  /* 92% 的技能都需电，只在例外时打标，避免每行都挂个徽标 */
  if (!it.power) badges.appendChild(bdg('不耗电', 'pow'));
  row.appendChild(badges);

  const bPrio = document.createElement('button');
  bPrio.className = 'actbtn';
  bPrio.dataset.act = 'prio';
  bPrio.title = '提到优先列表最前';
  bPrio.textContent = '优先';
  row.appendChild(bPrio);

  const bHide = document.createElement('button');
  bHide.className = 'actbtn';
  bHide.dataset.act = 'hide';
  bHide.textContent = hid ? '恢复' : '不显示';
  row.appendChild(bHide);

  row.onclick = e => {
    if (e.target.closest('button[data-act]')) return;
    select(id);
  };
  return row;
}

function bdg(text, cls) {
  const s = document.createElement('span');
  s.className = 'bdg' + (cls ? ' ' + cls : '');
  s.textContent = text;
  return s;
}

function markSelected(id) {
  document.querySelectorAll('.urow.sel').forEach(r => r.classList.remove('sel'));
  const row = document.querySelector('.swrow[data-id="' + id + '"]');
  if (row) row.classList.add('sel');
}

/* ---------- 详情 ---------- */
function select(id) {
  if (!id) return;
  selectedId = id;
  markSelected(id);
  const it = byId.get(id) || { id };
  const hid = isHidden(id);
  const rank = PRIO.indexOf(id);

  $('sdIcon').innerHTML = '';
  const big = document.createElement('img');
  big.src = iconUrl(id);
  big.alt = '';
  big.onerror = () => { big.remove(); };
  $('sdIcon').appendChild(big);

  $('sdName').textContent = it.name || it.id;
  $('sdId').textContent = id;
  $('sdCond').textContent = it.cost === undefined ? '—' : condText(it);
  $('sdRech').textContent = it.recharge === undefined ? '—' : rechText(it);
  $('sdUiname').textContent = it.uiname || '—';
  $('sdUiname').title = it.uiname || '';
  $('sdShow').textContent = hid ? '不显示' : '显示中';
  $('sdShow').style.color = hid ? 'var(--danger)' : 'var(--ok)';

  let hint = '未做特殊配置时，按桥输出的原序显示在玩家面板的单位格下方。';
  if (hid) hint = '该技能已勾选「不显示」；点下方按钮即可恢复。';
  else if (rank >= 0) hint = `在优先表第 ${rank + 1} 位；列表里可上下移动调整顺序。`;
  else if (!it.power) hint = '不耗电：断电或 EMP 期间仍可正常充能。';
  $('sdHint').textContent = hint;

  $('sdBtnPrio').disabled = false;
  $('sdBtnPrio').textContent = rank === 0 ? '已在最前' : '设为优先';
  $('sdBtnPrio').disabled = rank === 0;
  $('sdBtnHide').disabled = false;
  $('sdBtnHide').textContent = hid ? '恢复显示' : '不显示此技能';
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

function renderStat() {
  const st = $('supers-stat');
  if (st) updateFlag();
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

  const sortSel = $('sfSort');
  if (sortSel) sortSel.onchange = () => { sortMode = sortSel.value; render(); };

  const stateSel = $('sfState');
  if (stateSel) stateSel.onchange = () => { filter.state = stateSel.value; render(); };

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
        select(id);
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

  const bp = $('sdBtnPrio');
  if (bp) {
    bp.onclick = async () => {
      if (!selectedId) return;
      PRIO = [selectedId].concat(PRIO.filter(x => x !== selectedId));
      await commitPrio();
      paintAll();
      select(selectedId);
    };
  }

  const bh = $('sdBtnHide');
  if (bh) {
    bh.onclick = async () => {
      if (!selectedId) return;
      const id = selectedId;
      HID = isHidden(id) ? HID.filter(x => x !== id) : [...HID, id];
      await commitHid();
      paintAll();
      select(id);
    };
  }

  const reset = $('btnSupersReset');
  if (reset) {
    reset.addEventListener('click', async () => {
      PRIO = []; HID = [];
      filter = { q: '', state: '', cost: '', power: '' };
      sortMode = 'hud';
      if ($('ssearch')) $('ssearch').value = '';
      if ($('sfSort')) $('sfSort').value = 'hud';
      if ($('sfState')) $('sfState').value = '';
      await push({ super_priority: '', hidden_supers: '' });
      renderChips();
      paintAll();
      App.toast('已恢复默认支援技能配置', 'ok');
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
  const main = $('supersMain');
  if (main) main.classList.toggle('off', !SHOW);
  if (sig === lastSig) { updateFlag(); return; }
  lastSig = sig;
  PRIO = np; HID = nh;
  paintAll();
  if (selectedId) select(selectedId);
}

function init() {
  initToggle();
  initEvents();
  renderChips();
  onCtrl(App.ctrl || {});
}

App.registerPage('supers', {
  init,
  onCtrl,
  onShow: () => paintAll(),
});
})();
