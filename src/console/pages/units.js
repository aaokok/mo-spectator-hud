/* pages/units.js — 单位与图标
 * 全宽列表 + 右侧详情抽屉 + 换图标弹窗。
 * 关键性能约束：列表只在「单位相关状态」变化时重建（不是每次 ctrl 轮询）。
 */
(function () {
'use strict';

const App = window.App;
const $ = window.$;

const CLASS_CN = { bld: '建筑', def: '防御', inf: '步兵', veh: '载具', shi: '舰船', air: '飞机' };
const SIDE_CN = { al: '盟军', sv: '苏军', ep: '厄普西隆', fo: '焚风', multi: '多阵营', gen: '通用' };
const TAG_CN = { hero: '英雄', clone: '克隆体', sync: '纳米同步', morph: '形态转换' };
const TAG_GROUPS = [
  { grp: '形态', codes: ['bld', 'def', 'inf', 'veh', 'shi', 'air'], cn: CLASS_CN },
  { grp: '阵营', codes: ['al', 'sv', 'ep', 'fo'], cn: SIDE_CN },
  { grp: '语义', codes: ['hero', 'clone', 'sync', 'morph'], cn: TAG_CN },
];
const SIDE_ORDER = ['al', 'sv', 'ep', 'fo', 'multi', 'gen'];
const CLASS_ORDER = ['bld', 'def', 'inf', 'veh', 'shi', 'air'];
const ICON_V = '?v=r16';

const ICON_SET = window.LIVE_ICON_SET || null;
const cats = (ICON_SET && ICON_SET.cats) || {};
const baseIds = ICON_SET && ICON_SET.base ? Object.keys(ICON_SET.base).sort() : [];

/* 单位自定义状态（从 /control/state 的 JSON 串解析） */
let OVR = {};
let HIDU = [];
let HID_TAGS = [];
let CMODE = 'keep';
let PRIO = '["hero","one","cnt"]';

/* 上一次参与重建的签名，用于跳过无关轮询 */
let lastSig = '';

let filter = { q: '', cls: '', side: '', state: '' };
let selectedId = null;
let renderQueued = false;

/* ---------- 图标 URL ---------- */
const ovrValue = id => {
  const v = OVR[id];
  if (!v) return '';
  if (typeof v === 'string') return v;
  return v.b || v.a || '';
};
const iconUrl = id => {
  const v = ovrValue(id);
  if (v) {
    const f = String(v).replace(/^custom\//i, '');
    return /\.png$/i.test(f)
      ? '/custom_icons/' + f.toLowerCase()
      : '/icons/byid/' + f.toUpperCase() + '.png' + ICON_V;
  }
  const b = ICON_SET && ICON_SET.base[id];
  return b ? '/icons/' + b + ICON_V : '';
};
/* 无 cameo 的单位（MO 里 DRACOD 等 art 段本就没 CameoPCX）画同尺寸占位块，
   不用 img 空 src——空 src 会被解析成当前页面 URL，画出一个破图。 */
const noIconBox = () => {
  const d = document.createElement('div');
  d.className = 'ic noimg';
  return d;
};
const tagHidden = id => {
  if (!HID_TAGS.length) return false;
  return (cats[id] || '').split(':').some(p => HID_TAGS.includes(p));
};
const isHidden = id => HIDU.includes(id) || tagHidden(id);

/* ---------- 过滤 ---------- */
function passes(id) {
  const parts = (cats[id] || '').split(':');
  const cls = CLASS_CN[parts[0]] ? parts[0] : '';
  const side = parts[1] || 'gen';
  const q = filter.q.toUpperCase();

  if (q && !id.includes(q)) return false;
  if (filter.cls && cls !== filter.cls) return false;
  if (filter.side && side !== filter.side) return false;
  if (filter.state === 'ovr' && !OVR[id]) return false;
  if (filter.state === 'hid' && !isHidden(id)) return false;
  if (filter.state === 'mod') {
    const modified = !!OVR[id] || HIDU.includes(id) || HID_TAGS.length > 0;
    if (!modified) return false;
  }
  return true;
}

/* ---------- 渲染 ---------- */

function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    doRender();
  });
}

function doRender() {
  const box = $('ulist');
  if (!box) return;
  if (!baseIds.length) {
    box.innerHTML = '<div style="padding:20px;color:var(--dim);font-size:12px">' +
      '图标索引未加载（需 mo_hud.exe 或 serve.py 模式）。</div>';
    return;
  }

  const groups = new Map();
  for (const id of baseIds) {
    if (!passes(id)) continue;
    const parts = (cats[id] || '').split(':');
    const c = CLASS_CN[parts[0]] ? parts[0] : 'zz';
    const s = parts[1] || 'gen';
    const key = s + '|' + c;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(id);
  }

  const keys = [...groups.keys()].sort((a, b) => {
    const [sa, ca] = a.split('|'), [sb, cb] = b.split('|');
    return SIDE_ORDER.indexOf(sa) - SIDE_ORDER.indexOf(sb)
      || CLASS_ORDER.indexOf(ca) - CLASS_ORDER.indexOf(cb);
  });

  const frag = document.createDocumentFragment();
  let total = 0;
  for (const key of keys) {
    const [s, c] = key.split('|');
    const ids = groups.get(key);
    total += ids.length;

    const h = document.createElement('div');
    h.className = 'ugroup';
    h.textContent = `${SIDE_CN[s] || s} · ${CLASS_CN[c] || '未分类'}（${ids.length}）`;
    frag.appendChild(h);

    for (const id of ids) {
      frag.appendChild(unitRow(id));
    }
  }

  if (!total) {
    frag.appendChild(Object.assign(document.createElement('div'), {
      style: 'padding:20px;color:var(--dim);font-size:12px',
      textContent: '没有匹配的单位。调整搜索或过滤条件。',
    }));
  }

  box.innerHTML = '';
  box.appendChild(frag);

  renderStat();
  if (selectedId && document.querySelector('.urow[data-id="' + selectedId + '"]')) {
    markSelected(selectedId);
  }
}

function unitRow(id) {
  const parts = (cats[id] || '').split(':');
  const hid = isHidden(id);
  const row = document.createElement('div');
  row.className = 'urow';
  row.dataset.id = id;

  const src = iconUrl(id);
  const img = src ? document.createElement('img') : noIconBox();
  if (src) {
    img.className = 'ic';
    img.loading = 'lazy';
    img.src = src;
    img.alt = '';
  }

  const info = document.createElement('div');
  info.className = 'info';
  const idEl = document.createElement('div');
  idEl.className = 'id';
  idEl.textContent = id;
  const subEl = document.createElement('div');
  subEl.className = 'sub';
  subEl.textContent = `${SIDE_CN[parts[1] || 'gen'] || '通用'} · ${CLASS_CN[parts[0]] || '未分类'}`;
  info.append(idEl, subEl);

  const badges = document.createElement('div');
  badges.className = 'badges';
  if (hid) badges.appendChild(bdg(HIDU.includes(id) ? '已隐藏' : '分类隐藏', 'hid'));
  if (OVR[id]) badges.appendChild(bdg('已换图', 'usr'));
  for (let i = 2; i < parts.length; i++) {
    if (!TAG_CN[parts[i]]) continue;
    badges.appendChild(bdg(TAG_CN[parts[i]], parts[i] === 'hero' ? 'hero' : parts[i] === 'one' ? 'one' : ''));
  }

  const btnIcon = document.createElement('button');
  btnIcon.className = 'actbtn';
  btnIcon.textContent = '换图';
  btnIcon.onclick = e => { e.stopPropagation(); openPicker(id); };

  const btnHide = document.createElement('button');
  btnHide.className = 'actbtn';
  if (tagHidden(id) && !HIDU.includes(id)) {
    btnHide.textContent = '分类隐藏中';
    btnHide.disabled = true;
    btnHide.title = '由上方分类开关隐藏；关闭对应分类即可恢复';
    btnHide.style.opacity = '.5';
    btnHide.style.cursor = 'not-allowed';
  } else {
    btnHide.textContent = hid ? '显示' : '隐藏';
    btnHide.onclick = e => {
      e.stopPropagation();
      HIDU = hid ? HIDU.filter(x => x !== id) : [...HIDU, id];
      save();
      render();
      select(id);
      App.toast(`「${id}」${hid ? '已恢复显示' : '已隐藏'}`, 'ok');
    };
  }

  row.append(img, info, badges, btnIcon, btnHide);
  row.onclick = () => select(id);
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
  const row = document.querySelector('.urow[data-id="' + id + '"]');
  if (row) row.classList.add('sel');
}

/* ---------- 详情抽屉 ---------- */

function select(id) {
  selectedId = id;
  markSelected(id);
  const parts = (cats[id] || '').split(':');
  const hid = isHidden(id);

  const dSrc = iconUrl(id);
  /* 容器 #dIcon 自带底色与描边，无 cameo 时留空即为纯色占位 */
  $('dIcon').innerHTML = dSrc ? `<img src="${dSrc}" alt="">` : '';
  $('dId').textContent = id;
  $('dCls').textContent = `${SIDE_CN[parts[1] || 'gen'] || '通用'} · ${CLASS_CN[parts[0]] || '未分类'}`;

  const v = ovrValue(id);
  $('dIconName').textContent = v || (ICON_SET && ICON_SET.base[id]) || '—';
  $('dIconName').title = $('dIconName').textContent;
  $('dSrc').textContent = OVR[id] ? '自定义覆盖' : '默认 cameo';

  const tags = [];
  if (parts.includes('hero')) tags.push('英雄');
  if (parts.includes('one')) tags.push('限造 1 个');
  if (parts.includes('clone')) tags.push('克隆体');
  if (parts.includes('sync')) tags.push('纳米同步');
  if (parts.includes('morph')) tags.push('形态转换');
  $('dTags').textContent = tags.length ? tags.join(' · ') : '无';

  $('dShow').textContent = hid ? (HIDU.includes(id) ? '已隐藏' : '分类隐藏中') : '显示中';
  $('dShow').style.color = hid ? 'var(--danger)' : 'var(--ok)';

  $('dBtnIcon').disabled = false;
  $('dBtnHide').disabled = false;
  $('dBtnHide').textContent = hid ? '恢复显示' : '隐藏此单位';

  let hint = '英雄与「限造 1 个」的单位默认排在单位栏最前，其次按数量降序。';
  if (HIDU.includes(id)) hint = '该单位已被显式隐藏；点「恢复显示」即可在前端单位栏重新出现。';
  else if (tagHidden(id)) hint = '该单位由上方分类开关隐藏；先关闭对应分类，才能单独控制它。';
  else if (OVR[id]) hint = '该单位使用自定义图标；点「换图标」可改回图库或清空覆盖。';
  $('dHint').textContent = hint;
}

/* ---------- 保存 ---------- */

function save() {
  App.postControl({
    unit_icon_overrides: JSON.stringify(OVR),
    hidden_units: JSON.stringify(HIDU),
    hidden_tags: JSON.stringify(HID_TAGS),
    hidden_count_mode: CMODE,
  }).then(() => {
    updateFlags();
    if (App.pages.overview && App.pages.overview.onCtrl) App.pages.overview.onCtrl();
  }).catch(e => App.toast('保存失败：' + e.message, 'bad'));
}

/* ---------- 分类 chip ---------- */

function renderTagBar() {
  const bar = $('tagbar');
  bar.innerHTML = '';
  for (const g of TAG_GROUPS) {
    const lab = document.createElement('span');
    lab.className = 'gl';
    lab.textContent = g.grp;
    bar.appendChild(lab);
    for (const code of g.codes) {
      const b = document.createElement('button');
      const off = HID_TAGS.includes(code);
      b.className = 'chip' + (off ? ' off' : '');
      b.textContent = g.cn[code];
      b.title = off ? `恢复显示全部${g.cn[code]}` : `隐藏全部${g.cn[code]}`;
      b.onclick = () => {
        HID_TAGS = off ? HID_TAGS.filter(t => t !== code) : [...HID_TAGS, code];
        save();
        renderTagBar();
        render();
        App.toast(off ? `已恢复「${g.cn[code]}」` : `已隐藏全部「${g.cn[code]}」`,
          off ? 'ok' : 'warn', () => {
            HID_TAGS = off ? [...HID_TAGS, code] : HID_TAGS.filter(t => t !== code);
            save(); renderTagBar(); render();
          });
      };
      bar.appendChild(b);
    }
  }
}

function renderStat() {
  const shown = baseIds.filter(passes).length;
  $('units-stat').innerHTML =
    `<span><b>${shown}</b> / ${baseIds.length} 个单位</span>
     <span>显式隐藏 <b>${HIDU.length}</b></span>
     <span>分类隐藏 <b>${HID_TAGS.length}</b></span>
     <span>换图 <b>${Object.keys(OVR).length}</b></span>
     <span style="margin-left:auto">点击行查看详情</span>`;
}

function updateFlags() {
  const n = Object.keys(OVR).length + HIDU.length + HID_TAGS.length + (CMODE === 'drop' ? 1 : 0);
  const el = $('modUnits');
  el.classList.toggle('show', n > 0);
  $('modUnitsTxt').textContent = `${n} 项已修改`;
}

/* ---------- 过滤控件 ---------- */

function initFilters() {
  // 形态 / 阵营下拉由分类数据生成
  const clsSel = $('fClass');
  for (const [code, cn] of Object.entries(CLASS_CN)) {
    const o = document.createElement('option');
    o.value = code; o.textContent = cn;
    clsSel.appendChild(o);
  }
  const sideSel = $('fSide');
  for (const code of SIDE_ORDER) {
    const o = document.createElement('option');
    o.value = code; o.textContent = SIDE_CN[code];
    sideSel.appendChild(o);
  }

  let t = null;
  $('usearch').oninput = e => {
    filter.q = e.target.value.trim();
    clearTimeout(t);
    t = setTimeout(render, 120);
  };
  clsSel.onchange = () => { filter.cls = clsSel.value; render(); };
  sideSel.onchange = () => { filter.side = sideSel.value; render(); };
  $('fState').onchange = () => { filter.state = $('fState').value; render(); };

  $('cmode').onchange = () => {
    CMODE = $('cmode').value;
    save();
    App.toast(CMODE === 'drop' ? '隐藏单位不再计入 +N' : '隐藏单位仍计入 +N');
  };
  $('uprio').onchange = () => {
    PRIO = $('uprio').value;
    App.postControl({ unit_priority: PRIO })
      .then(() => App.toast('单位排序已更新'))
      .catch(e => App.toast('保存失败：' + e.message, 'bad'));
  };

  $('btnUnitsReset').onclick = () => {
    OVR = {}; HIDU = []; HID_TAGS = []; CMODE = 'keep'; PRIO = '["hero","one","cnt"]';
    $('cmode').value = 'keep';
    $('uprio').value = PRIO;
    App.postControl({
      unit_icon_overrides: '{}',
      hidden_units: '[]',
      hidden_tags: '[]',
      hidden_count_mode: 'keep',
      unit_priority: PRIO,
    }).then(() => {
      renderTagBar(); render(); updateFlags();
      App.toast('已恢复默认单位配置', 'ok');
    }).catch(e => App.toast('恢复失败：' + e.message, 'bad'));
  };
}

/* ---------- 换图标弹窗 ---------- */

let pickId = null;

function openPicker(id) {
  pickId = id;
  $('pick-title').textContent = id + ' 当前图标：';
  $('pick-search').value = '';
  $('pick-custom').value = ovrValue(id);
  renderGallery('');
  $('pickmodal').hidden = false;
  $('pick-search').focus();
}

function renderGallery(q) {
  const g = $('pick-gallery');
  const list = baseIds.filter(id => !q || id.includes(q)).slice(0, 300);
  g.innerHTML = '';
  const cur = $('pick-custom').value.trim().toUpperCase();
  for (const id of list) {
    const b = document.createElement('button');
    if (id === cur) b.classList.add('on');
    b.innerHTML = `<img src="/icons/byid/${id}.png${ICON_V}" loading="lazy" alt=""><span>${id}</span>`;
    b.onclick = () => {
      $('pick-custom').value = id;
      g.querySelectorAll('button.on').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
    };
    g.appendChild(b);
  }
  if (!list.length) g.innerHTML = '<span style="color:var(--dim);font-size:12px">无匹配</span>';
}

function initPicker() {
  $('pick-search').oninput = () => renderGallery($('pick-search').value.trim().toUpperCase());
  $('pick-close').onclick = () => { $('pickmodal').hidden = true; };
  $('pickmodal').onclick = e => { if (e.target === $('pickmodal')) $('pickmodal').hidden = true; };
  $('pick-apply').onclick = () => {
    const v = $('pick-custom').value.trim();
    if (!v) delete OVR[pickId];
    else OVR[pickId] = v;
    save();
    render();
    select(pickId);
    $('pickmodal').hidden = true;
    App.toast(v ? `「${pickId}」图标已替换` : `「${pickId}」已恢复默认图标`);
  };
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('pickmodal').hidden) $('pickmodal').hidden = true;
  });
}

/* ---------- 详情按钮 ---------- */

function initDetailButtons() {
  $('dBtnIcon').onclick = () => { if (selectedId) openPicker(selectedId); };
  $('dBtnHide').onclick = () => {
    if (!selectedId) return;
    const hid = isHidden(selectedId);
    if (tagHidden(selectedId) && !HIDU.includes(selectedId)) {
      App.toast('该单位由分类开关隐藏，请先关闭对应分类', 'warn');
      return;
    }
    HIDU = hid ? HIDU.filter(x => x !== selectedId) : [...HIDU, selectedId];
    save();
    render();
    select(selectedId);
  };
}

/* ---------- 状态同步 ---------- */

const parseJsonOr = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };

function onCtrl(c) {
  const ovr = parseJsonOr(c.unit_icon_overrides, {});
  OVR = (ovr && !Array.isArray(ovr)) ? ovr : {};
  HIDU = parseJsonOr(c.hidden_units, []) || [];
  HID_TAGS = parseJsonOr(c.hidden_tags, []) || [];
  CMODE = c.hidden_count_mode === 'drop' ? 'drop' : 'keep';
  PRIO = c.unit_priority || '["hero","one","cnt"]';

  if ($('cmode') && document.activeElement !== $('cmode')) $('cmode').value = CMODE;
  if ($('uprio') && document.activeElement !== $('uprio')) $('uprio').value = PRIO;

  // 只有单位相关状态变了才重建列表（避免每次轮询重排 450 行）
  const sig = JSON.stringify([OVR, HIDU, HID_TAGS, CMODE]);
  if (sig === lastSig) {
    updateFlags();
    return;
  }
  lastSig = sig;
  renderTagBar();
  render();
  updateFlags();
  if (selectedId) select(selectedId);
}

function init() {
  if (!ICON_SET || !ICON_SET.cats) return;
  initFilters();
  initPicker();
  initDetailButtons();
  renderTagBar();
  render();
}

App.registerPage('units', {
  init,
  onCtrl,
  onShow: () => render(),
});
})();
