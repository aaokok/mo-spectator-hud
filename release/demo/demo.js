/* MO Spectator HUD · Broadcast Demo
   两种数据源：
   - mock：内置模拟数据，纯静态演示
   - live：读 hud_bridge.exe 的 hud_state.json（schema 2），映射见 live-data.js
   口径对齐 bridge：
   - 分队：allies_mask 互置位（live 由 live-data.js 分组，mock 里用 teams[] 表达）
   - 电力：power[0]=产出/上限，power[1]=消耗/已用；已用 > 上限 标红
   - 国家：country -> assets/flags/<flag>.png（rules.ini File.Flag）
   - 生产队列：按引擎 6 条主工厂槽组织（queues 对象）；
     bridge 的队列字段尚未输出，live 下显示"未接入"，不伪装成空闲
   - 渗透：infiltration.barracks / war_factory -> 队列图标换 AltCameo
   - 几何：live 且 screen.valid 时，用 view_rect / sidebar_rect / radar_rect
     的真实像素，不再用 15.5% 估算 */

(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var stage = $('#stage');
  var viewport = $('#viewport');
  var game = $('#game');
  var hudScaler = $('#hudScaler');
  var unitLayer = $('#unitLayer');
  var radar = $('#gameRadar');
  var radarMap = $('#radarMap');
  var statusText = $('#statusText');
  var pauseBtn = $('#pauseBtn');
  var queueColumn = $('#queueColumn');

  var safeChk = $('#safeChk');
  var guideChk = $('#guideChk');
  var gameUiChk = $('#gameUiChk');
  var gateChk = $('#gateChk');
  var railChk = $('#railChk');
  var queueChk = $('#queueChk');
  var scenarioSel = $('#scenarioSel');
  var sourceSel = $('#sourceSel');
  var liveUrl = $('#liveUrl');
  var liveGeoChk = $('#liveGeoChk');

  var state = {
    canvasW: 1920,
    canvasH: 1080,
    gameAspect: 16 / 9,
    perTeam: 3,
    mockPerTeam: 3,      /* live 会覆盖 perTeam，回 mock 时用它还原 */
    railMax: 8,
    queueCols: 3,
    source: 'mock',      /* mock | live */
    liveUrl: '',
    liveModel: null,     /* live-data.js 映射后的模型 */
    livePollMs: 500,
    liveError: '',
    liveFetchedAt: 0,
    liveRev: 0,
    /* 数据停滞检测：桥停摆时文件不再更新，fetch 仍会成功返回旧内容。
       记下最近一次"内容真的变了"的时刻，超过阈值就判定数据是旧的。 */
    liveDataAt: 0,
    liveLastSig: '',
    /* live + screen.valid：真实像素几何（游戏坐标系） */
    liveGeom: null,
    /* OBS 覆盖层：背景透明、无游戏画面、画布跟随窗口 */
    overlay: false
  };

  /* 国家 ID -> 旗帜文件（rules.ini 的 File.Flag，去掉 .pcx） */
  var FLAG = {
    UnitedStates: 'unst',
    Europeans: 'euro',
    Pacific: 'paci',
    USSR: 'ussr',
    Latin: 'cuba',
    Chinese: 'chin',
    PsiCorps: 'psic',
    ScorpionCell: 'scrp',
    Headquaters: 'hdqt',
    Guild1: 'haih',
    Guild2: 'coro',
    Guild3: 'bast'
  };

  /* ------------------------------------------------------- data source layer */

  /* mock 侧每帧重新组装一个视图对象，保证 elapsed/paused 的改动即时可见 */
  function activeModel() {
    var m;
    if (state.source === 'live' && state.liveModel) m = state.liveModel;
    else m = {
      live: false,
      ok: true,
      map: MOCK.map,
      paused: MOCK.paused,
      /* R22：模拟数据没有真实菜单，恒 false（Esc 判据只对 live 有效） */
      menuOpen: false,
      elapsed: MOCK.elapsed,
      series: MOCK.series,
      modeLabel: modeLabelFor(state.perTeam),
      screen: null,
      observer: null,
      meta: null,
      ffa: false,
      teams: MOCK.teams
    };
    /* EXE 控制台(mo_hud.exe)注入的比赛名/局分覆盖,见 control-bridge.js */
    return window.__ctrlPatch ? window.__ctrlPatch(m) : m;
  }

  function currentTeams() { return activeModel().teams || []; }

  /* live 的图标来自 bridge 工具包的 icons 目录（byid/ 按单位 ID 命名）。
     /icons/ 响应是 immutable 长缓存，图标整体换版时靠 ICON_V 穿透（R14） */
  var ICON_V = '?v=r14';
  function iconSrc(id, alt) {
    var o = OVR && OVR[id];              /* R12 用户覆盖 > AltCameo > 生成表 */
    if (o) return alt ? (o.a || o.b) : o.b;
    var set = window.LIVE_ICON_SET;
    if (state.source === 'live' && set) {
      var file = alt && set.alt[id];
      if (!file) file = set.base[id];
      return file ? set.dir + file + ICON_V : '';
    }
    return 'assets/icons/' + id + (alt ? '_v' : '') + '.png';
  }

  function hasIcon(id) {
    var set = window.LIVE_ICON_SET;
    if (state.source === 'live' && set) return !!set.base[id];
    return true;   /* mock 图标集是手工挑的，假定齐全 */
  }

  function altIconName(id) {
    var set = window.LIVE_ICON_SET;
    if (state.source === 'live' && set) return set.alt[id] || '';
    return HAS_ALT[id] ? id : '';
  }

  /* ------------------------------------------------- R12 单位自定义（控制台）
     /control 键 unit_icon_overrides / hidden_units / hidden_tags /
     hidden_count_mode 由 control-bridge.js 解析成 window.__UNIT_CUSTOM，
     变更时派发 ctrl-units；这里一次性展开成 OVR/HIDDEN 两张扁平表。
     渲染每帧只做一次对象查找（iconSrc 的 OVR[id]、unitHidden 的 HIDDEN[id]），
     分类串 "c:s[:t...]" 的 split 只发生在配置变更时，不在渲染路径上。 */
  var OVR = null;         /* id -> {b:图标URL, a:老兵图标URL}；null = 无覆盖 */
  var HIDDEN = null;      /* id -> 1（显式 ∪ 分类命中）；null = 无隐藏 */
  var HIDE_DROP = false;  /* drop：+N 溢出计数也剔除隐藏单位（keep = 藏格不扣数） */

  function customIconBase() {
    return window.LIVE_CUSTOM_BASE ||
      (location.protocol === 'file:' ? 'custom_icons/' : '/custom_icons/');
  }

  /* 覆盖值三种写法：byid stem（flakv）；custom/xx.png（自备图，Demo/custom_icons/）；
     带 .png 的其他相对路径原样返回。全部在展开期归一成最终 URL。 */
  function normOverride(v) {
    if (!v) return '';
    v = String(v).trim().replace(/\\/g, '/').replace(/^custom\//i, '');
    if (!v) return '';
    if (/\.png$/i.test(v)) return customIconBase() + v.toLowerCase();
    var set = window.LIVE_ICON_SET;
    return set ? set.dir + 'byid/' + v.toUpperCase() + '.png' + ICON_V : '';
  }

  function rebuildUnitCustom() {
    OVR = null;
    HIDDEN = null;
    HIDE_DROP = false;
    PRIO = ['hero', 'one', 'cnt'];
    POS = { hero: 0, one: 1, cnt: 2 };
    TIER_CACHE = {};
    var c = window.__UNIT_CUSTOM;
    if (!c) return;

    /* R13 优先显示顺序（unit_priority）：白名单校验，cnt 缺失补尾 */
    if (c.prio && c.prio.length) {
      var p = [];
      for (var pi = 0; pi < c.prio.length; pi++) {
        var code = c.prio[pi];
        if ((code === 'hero' || code === 'one' || code === 'cnt') && p.indexOf(code) < 0) {
          p.push(code);
        }
      }
      if (p.length) {
        if (p.indexOf('cnt') < 0) p.push('cnt');
        PRIO = p;
        POS = {};
        for (var pj = 0; pj < p.length; pj++) POS[p[pj]] = pj;
        TIER_CACHE = {};
      }
    }

    if (c.ovr) {
      var o = {};
      for (var id in c.ovr) {
        var v = c.ovr[id];
        if (typeof v === 'string') {
          var b = normOverride(v);
          if (b) o[id] = { b: b };
        } else if (v && typeof v === 'object') {
          var b2 = normOverride(v.b);
          if (b2) o[id] = { b: b2, a: normOverride(v.a) || b2 };
        }
      }
      for (var k in o) { OVR = o; break; }   /* 空表保持 null，渲染零开销 */
    }

    var hasHid = c.hid && c.hid.length;
    var hasTags = c.tags && c.tags.length;
    if (hasHid || hasTags) {
      var h = Object.create(null);
      if (hasHid) for (var i = 0; i < c.hid.length; i++) h[c.hid[i]] = 1;
      if (hasTags) {
        var cats = window.LIVE_ICON_SET && window.LIVE_ICON_SET.cats;
        if (cats) {
          var tset = Object.create(null);
          for (var t = 0; t < c.tags.length; t++) tset[c.tags[t]] = 1;
          /* 形态/阵营/tag 任一命中即隐藏：串里除第 0 段外都是可隐藏维度，
             第 0 段（形态）也要能按类藏（如 def） */
          for (var uid in cats) {
            if (h[uid]) continue;
            var parts = cats[uid].split(':');
            for (var p = 0; p < parts.length; p++) {
              if (tset[parts[p]]) { h[uid] = 1; break; }
            }
          }
        }
      }
      for (var hk in h) { HIDDEN = h; break; }
    }
    HIDE_DROP = c.mode === 'drop';
  }

  function unitHidden(id) {
    return !!(HIDDEN && HIDDEN[id]);
  }

  /* ------------------------------------------------------------------ utils */

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function fmtCash(n) { return '$' + Math.round(n); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function flagOf(p) {
    var f = FLAG[p.country] || FLAG[p.faction];
    return f ? 'assets/flags/' + f + '.png' : '';
  }

  function flagImg(p, cls) {
    var src = flagOf(p);
    return src
      ? '<img class="' + (cls || 'flag') + '" src="' + src + '" alt="' + esc(p.country || '') + '">'
      : '';
  }

  /* 生产通道：与引擎的 6 个主工厂槽一一对应
     建筑 / 防御 / 步兵 / 载具 / 海军 / 飞机
     防御与建筑共用工厂但队列独立（Primary_ForDefenses，BuildCat==Combat）；
     海军是 UnitType 且 Naval=yes；飞机是 AircraftType 独立通道。 */
  var CHANNELS = [
    { key: 'building', label: '建筑', short: '建' },
    { key: 'defense',  label: '防御', short: '防' },
    { key: 'infantry', label: '步兵', short: '步' },
    { key: 'vehicle',  label: '载具', short: '载' },
    { key: 'navy',     label: '海军', short: '海' },
    { key: 'aircraft', label: '飞机', short: '空' }
  ];

  /* 兵营/重工被渗透（bridge: infiltration.barracks / war_factory）后，
     新生产的步兵 / 载具直接老兵——队列图标换 AltCameo（*uico）。
     MO 3.3.6 里只有兵营（Factory=InfantryType）和重工（Factory=UnitType）
     带 SpyEffect.UnitVeterancy=yes；船厂/机场没有该标签，所以海军/飞机不受影响。
     哪些单位有 AltCameo 由 assets/icons/alt-manifest.js 提供（从 art 段生成）。 */
  var HAS_ALT = window.ALT_CAMEO || {};

  /* 英雄单位优先显示：清单由 heroes.js 从 rules 的 Hero=yes 段生成，
     与 unit_types[].id 同口径（段名，不是 Image 目标）。 */
  var HERO = window.HERO_UNITS || {};

  function isHero(id) { return !!HERO[id]; }

  /* 纳米同步（Nanofiber Sync）变体：产品 TechnoType 无 cameo，图标已在前端
     资产层换成前身主 cameo（gen_icons_index.py 的 NANO_SYNC 表），这里只负责
     打 .synced 徽标类。变体保持独立 ID 与计数——这不是形态切换，不归一。 */
  var SYNC_OF = (window.LIVE_ICON_SET && window.LIVE_ICON_SET.sync) || {};

  function syncOf(id) { return SYNC_OF[id] || ''; }

  /* R10：分身/复制单位（非 Convert.Deploy 形态，计数独立）。天秤复制人 LIBRC 由
     Epsilon HQ 的 Libra Clones 支援技能成批召唤，art 上与本体共用同一 cameo，
     不加标识会被读成"天秤出现频率异常"。样式：降饱和 + "复制"角标，不算英雄。 */
  var CLONE_OF = { LIBRC: 'LIBRA' };

  function cloneOf(id) { return CLONE_OF[id] || ''; }

  if (window.LIVE_ICON_SET && window.LIVE_ICON_SET.dir) {
    document.documentElement.style.setProperty(
      '--sync-badge', 'url("' + window.LIVE_ICON_SET.dir + 'fsncicon.png' + ICON_V + '")');
  }

  /* 单位栏排序：英雄整体排在前，组内仍按数量降序；非英雄只按数量。
     同数量按 ID 稳定，避免每次渲染抖动。 */
  /* R13 优先显示：PRIO 是控制台可调的层级列表（unit_priority，默认
     英雄 > 限造1个 > 数量）。tier 查缓存 O(1)，只在配置变更时重建。
     口径事实（gen 复核）：16 英雄全部 BuildLimit=1，故第一级就是"英雄∩限1"，
     第二级是限1 非英雄（铁幕/导弹井/MAD/雷泽诺夫等），第三级数量降序。 */
  var IS_ONE = (function () {
    var o = {};
    var cats = window.LIVE_ICON_SET && window.LIVE_ICON_SET.cats;
    if (cats) {
      for (var id in cats) {
        if (cats[id].split(':').indexOf('one') >= 0) o[id] = 1;
      }
    }
    return o;
  })();
  var PRIO = ['hero', 'one', 'cnt'];
  var POS = { hero: 0, one: 1, cnt: 2 };
  var TIER_CACHE = {};

  function unitTier(id) {
    var t = TIER_CACHE[id];
    if (t !== undefined) return t;
    t = POS.cnt;
    if (isHero(id) && POS.hero < t) t = POS.hero;
    if (IS_ONE[id] && POS.one < t) t = POS.one;
    TIER_CACHE[id] = t;
    return t;
  }

  function unitOrder(a, b) {
    var ta = unitTier(a.id), tb = unitTier(b.id);
    if (ta !== tb) return ta - tb;
    return (b.count - a.count) || String(a.id).localeCompare(String(b.id));
  }

  function veteranChannel(p, key) {
    var inf = p.infiltration || {};
    if (key === 'infantry') return !!inf.barracks;
    if (key === 'vehicle') return !!inf.war_factory;
    return false;
  }

  /* power[0]=产出/上限, power[1]=消耗/已用 */
  function powerOf(p) {
    var cap = Math.max(0, Math.round((p.power && p.power[0]) || 0));
    var used = Math.max(0, Math.round((p.power && p.power[1]) || 0));
    return { used: used, cap: cap, over: cap > 0 && used > cap };
  }

  function unitTotal(p) {
    return (p.units || []).reduce(function (s, u) { return s + u.count; }, 0);
  }

  function ensureIndexes() {
    currentTeams().forEach(function (team) {
      team.players.forEach(function (p, i) {
        if (p._idx == null) p._idx = i;
        p._team = team.key;
      });
    });
  }

  function teamByKey(key) {
    var teams = currentTeams();
    for (var i = 0; i < teams.length; i++) {
      if (teams[i].key === key) return teams[i];
    }
    return null;
  }

  function rosterAll(team) {
    if (!team) return [];
    return team.players.slice(0, state.perTeam);
  }

  function roster(team) {
    if (!team) return [];
    /* R10：战败房不再进单位栏/生产队列（顶栏名单保留，用 rosterAll）。
       mock 数据没有 defeated 字段，过滤条件自然为假，不影响演示。 */
    return team.players
      .filter(function (p) { return !p.defeated; })
      .slice(0, state.perTeam);
  }

  function visiblePlayers() {
    var out = [];
    currentTeams().forEach(function (team) {
      roster(team).forEach(function (p) { out.push(p); });
    });
    return out;
  }

  function modeLabel() { return modeLabelFor(state.perTeam); }

  function modeLabelFor(n) { return n + 'V' + n; }

  function fitRect(area, aspect) {
    var w = area.w;
    var h = w / aspect;
    if (h > area.h) {
      h = area.h;
      w = h * aspect;
    }
    return {
      x: area.x + (area.w - w) / 2,
      y: area.y + (area.h - h) / 2,
      w: w,
      h: h
    };
  }

  /* ------------------------------------------------------------- rendering */

  function renderHeader() {
    var m = activeModel();

    $$('[data-clock]').forEach(function (el) { el.textContent = fmtTime(m.elapsed); });
    $$('[data-map]').forEach(function (el) { el.textContent = m.map; });
    $$('[data-mode]').forEach(function (el) { el.textContent = m.modeLabel || modeLabel(); });

    /* 局分：中间比赛名左右各一个整数。bridge 不输出局分，live 下留空 */
    var scoreA = $('[data-score="A"]');
    var scoreB = $('[data-score="B"]');
    if (m.series) {
      scoreA.textContent = m.series.A;
      scoreB.textContent = m.series.B;
      scoreA.classList.remove('n/a');
      scoreB.classList.remove('n/a');
      scoreA.title = scoreB.title = '';
    } else {
      scoreA.textContent = '–';
      scoreB.textContent = '–';
      scoreA.classList.add('n/a');
      scoreB.classList.add('n/a');
      scoreA.title = scoreB.title = 'bridge 未输出局分';
    }

    /* live 下把数据新鲜度写进状态栏，便于判断桥是否还活着 */
    if (m.live) {
      var age = state.liveFetchedAt ? Math.round((Date.now() - state.liveFetchedAt) / 1000) : -1;
      var stale = age >= 0 && age > 3;
      statusText.dataset.stale = stale ? '1' : '0';
    } else {
      statusText.dataset.stale = '0';
    }
  }

  function powerBox(p) {
    var w = powerOf(p);
    return '<span class="pbox' + (w.over ? ' over' : '') + '" title="电力：已用 / 上限">' +
      '<span class="ico bolt">⚡</span>' + w.used + '/' + w.cap + '</span>';
  }

  function cashBox(p) {
    return '<span class="pbox" title="资金">' +
      '<span class="ico cash">●</span>' + fmtCash(p.cash) + '</span>';
  }

  function playerChip(p) {
    var title = p.factionCN || p.faction || '';
    if (p.human === false) title += ' · AI' + (p.aiDiff ? ' ' + p.aiDiff : '');
    return '<div class="pchip' + (p.human === false ? ' ai' : '') + '" style="--c:' + p.color +
      '" title="' + esc(p.name + (title ? ' · ' + title : '')) + '">' +
      flagImg(p) +
      '<div class="pinfo">' +
        '<span class="pname">' + esc(p.name) + '</span>' +
        '<span class="pstats">' + powerBox(p) + cashBox(p) + '</span>' +
      '</div>' +
    '</div>';
  }

  /* ------------------------------------------------- 键控增量更新（防闪烁） */

  /* live 模式 500 ms 一帧。此前 renderTopBar/renderRails/renderQueues 每次
     innerHTML 全量重建，<img> 全部销毁重载（serve.py 还对图标发了 no-store），
     OBS 里表现为整屏闪烁。改为按 key 复用节点：只新建缺失、移除消失，
     其余在原节点上改文本/属性，图标节点永不重建。 */
  function elFromHtml(html) {
    var t = document.createElement('template');
    t.innerHTML = html;
    return t.content.firstElementChild;
  }

  /* items: 数据数组；key(it): 稳定键；make(it): 新建节点；update(el, it):
     原位刷新，返回 false 表示放弃复用（该节点整体重建）。 */
  function patchChildren(parent, items, key, make, update) {
    var keep = {};
    /* children 是活集合，先快照，遍历中的 insertBefore/remove 不能影响它。
       无 key 的子节点视为 make() 的遗留物，直接清掉，
       防止它和键控节点并存导致内容翻倍。 */
    Array.prototype.slice.call(parent.children).forEach(function (n) {
      if (n.dataset.key) keep[n.dataset.key] = n;
      else n.remove();
    });

    var cursor = null;
    items.forEach(function (it) {
      var k = key(it);
      var el = keep[k];
      delete keep[k];
      if (!el || (update && update(el, it) === false)) {
        if (el) el.remove();      /* 放弃复用的旧节点不能留在 DOM 里 */
        el = make(it);
        el.dataset.key = k;
      }
      var want = cursor ? cursor.nextSibling : parent.firstChild;
      if (want !== el) parent.insertBefore(el, want);
      cursor = el;
    });

    Object.keys(keep).forEach(function (k) { keep[k].remove(); });
  }

  function playerKey(p) {
    return p.name + '|' + p.color;
  }

  function updatePlayerChip(el, p) {
    var title = p.factionCN || p.faction || '';
    if (p.human === false) title += ' · AI' + (p.aiDiff ? ' ' + p.aiDiff : '');
    el.className = 'pchip' + (p.human === false ? ' ai' : '');
    el.style.setProperty('--c', p.color);
    el.title = p.name + (title ? ' · ' + title : '');
    /* 旗帜是 <img>，不重建；只有电力/资金这两个纯文本片段需要刷新 */
    var stats = el.querySelector('.pstats');
    if (stats) stats.innerHTML = powerBox(p) + cashBox(p);
  }

  function renderTopBar() {
    var top = $('.top-bar');
    if (!top) return;

    ['A', 'B'].forEach(function (g) {
      patchChildren(
        $('[data-group="' + g + '"]'),
        rosterAll(teamByKey(g)),
        playerKey,
        function (p) { return elFromHtml(playerChip(p)); },
        updatePlayerChip
      );
    });

    top.classList.toggle('dense', state.perTeam >= 4);
    top.classList.toggle('roomy', state.perTeam <= 2);

    fitChips(top);
  }

  /* 顶栏可用宽度不足时逐级压缩：dense -> tight */
  function fitChips(top) {
    var center = $('.top-center', top);
    var centerW = center ? center.offsetWidth : 0;
    var perPlayer = (top.offsetWidth - centerW) / 2 / Math.max(1, state.perTeam);
    top.classList.toggle('tight', perPlayer < 132);
  }

  /* ------------------------------------------------------------- unit rails */

  /* 单位格：只保留图标 + 右下角数量。星级/血条属于战术信息，
     观战 HUD 只负责"这个玩家有多少这类单位"，且按数量降序排。
     live 下缺图（MO 里 art 段本就没有 CameoPCX）时退成单位 ID 文字，
     与游戏内 sidebar 的空图标表现一致，不隐藏该条目。 */
  function unitCell(u) {
    var src = iconSrc(u.id, false);
    var hero = isHero(u.id);
    var pre = syncOf(u.id);
    var clo = cloneOf(u.id);
    var title = u.id + ' ×' + u.count
      + (hero ? ' · 英雄' : '')
      + (clo ? ' · 复制单位（本体 ' + clo + '）' : '')
      + (pre ? ' · 纳米同步变体（前身 ' + pre + '）' : '');
    var cls = 'ucell' + (hero ? ' hero' : '') + (pre ? ' synced' : '') + (clo ? ' clone' : '');

    if (!src || !hasIcon(u.id)) {
      return '<div class="' + cls + ' noicon" title="' + esc(title + '（无 cameo）') + '">' +
        '<span class="uid">' + esc(u.id) + '</span>' +
        '<span class="cnt">' + u.count + '</span>' +
      '</div>';
    }

    /* 图挂了也要保住信息：补上单位 ID 文字，而不是留一个空白格。
       内联 handler 里读 data-id，避免再拼一次转义。 */
    return '<div class="' + cls + '" title="' + esc(title) + '">' +
      '<img src="' + esc(src) + '" alt="' + esc(u.id) + '" draggable="false" data-id="' + esc(u.id) + '"' +
      ' onerror="var d=this.parentNode;d.classList.add(\'noicon\');' +
      'var s=document.createElement(\'span\');s.className=\'uid\';' +
      's.textContent=this.getAttribute(\'data-id\');d.insertBefore(s,this);this.remove();">' +
      '<span class="cnt">' + u.count + '</span>' +
    '</div>';
  }

  /* 单位栏能放几类：按栏高 ÷ 玩家数 分摊，再换算成行数 × 列数。
     栏高本身已被 applyLayout 收到可用高度的 65%（RAIL_FILL），
     这里直接用 clientHeight，不再二次缩放。 */
  var RAIL_FILL = 0.65;

  function railMaxUnits() {
    var rail = $('[data-rail="A"]');
    if (!rail) return 8;

    var cols = state.perTeam <= 1 ? 1 : 2;
    var n = Math.max(1, state.perTeam);
    var headH = 24;        /* 旗帜 + 名字行 */
    var cardPad = 12;      /* 卡片上下内边距 */
    var cardGap = 8;
    var rowH = 52;         /* 48 图标 + 4 间距 */

    var perCard = (rail.clientHeight - n * (headH + cardPad) - (n - 1) * cardGap) / n;
    var rows = Math.max(1, Math.floor((perCard + 4) / rowH));

    return Math.max(cols, Math.min(24, rows * cols));
  }

  function railList(p, max) {
    /* 英雄优先，其余按数量降序（同数量按 ID 稳定）；见 unitOrder。
       R12 隐藏单位在进 max 之前就滤掉；keep 口径下 +N 仍计入被隐藏的。 */
    var src = p.units || [];
    var all = src;
    if (HIDDEN) {
      all = [];
      for (var i = 0; i < src.length; i++) {
        if (!HIDDEN[src[i].id]) all.push(src[i]);
      }
    }
    var total = (HIDE_DROP ? all.length : src.length);
    var sorted = all.slice().sort(unitOrder);
    var list = sorted.slice(0, max);
    var rest = total - list.length;
    /* 有 +N 时预留一格，避免多出一行把卡片撑高 */
    if (rest > 0) {
      list = sorted.slice(0, Math.max(1, max - 1));
      rest = total - list.length;
    }
    return { list: list, rest: Math.max(0, rest) };
  }

  /* 只生成外壳（格子留空），内容统一由 updateRailCard 的键控补丁填充，
     保证格子从诞生起就带 key，不会被后续补丁当成遗留物再叠一份 */
  function railCardHtml(p, cols) {
    return '<div class="rp" style="--c:' + p.color + '">' +
      '<div class="rp-head">' +
        flagImg(p) +
        '<span class="rn">' + esc(p.name) + '</span>' +
      '</div>' +
      '<div class="rp-grid" style="grid-template-columns:repeat(' + cols + ',60px)"></div>' +
    '</div>';
  }

  function updateRailCard(card, p, cols, max) {
    card.style.setProperty('--c', p.color);
    var rn = card.querySelector('.rn');
    if (rn) rn.textContent = p.name;
    var grid = card.querySelector('.rp-grid');
    if (!grid) return false;
    var want = 'repeat(' + cols + ',60px)';
    if (grid.style.gridTemplateColumns !== want) grid.style.gridTemplateColumns = want;

    var ls = railList(p, max);
    var items = ls.list.map(function (u) { return { k: u.id, u: u }; });
    if (ls.rest > 0) items.push({ k: '__more', u: null });

    patchChildren(grid, items,
      function (it) { return it.k; },
      function (it) {
        return elFromHtml(it.u ? unitCell(it.u)
          : '<div class="ucell more">+' + ls.rest + '</div>');
      },
      function (cell, it) {
        if (!it.u) {                        /* +N 汇总格：只刷数字 */
          cell.textContent = '+' + ls.rest;
          return;
        }
        var u = it.u;
        var hero = isHero(u.id);
        var pre = syncOf(u.id);
        var clo = cloneOf(u.id);
        var src = iconSrc(u.id, false);
        /* 图标可用性变化（少见，icons-live.js 会话内是静态的）才整格重建 */
        if (!!cell.querySelector('img') !== !!(src && hasIcon(u.id))) return false;
        /* R12 图标覆盖变化：不重建格子，原位换 src（一次字符串比较的开销） */
        var im = cell.querySelector('img');
        if (im && im.getAttribute('src') !== src) im.setAttribute('src', src);
        cell.classList.toggle('clone', !!clo);
        cell.title = u.id + ' ×' + u.count
          + (hero ? ' · 英雄' : '')
          + (clo ? ' · 复制单位（本体 ' + clo + '）' : '')
          + (pre ? ' · 纳米同步变体（前身 ' + pre + '）' : '');
        var cnt = cell.querySelector('.cnt');
        if (cnt && cnt.textContent !== String(u.count)) cnt.textContent = u.count;
      });
  }

  function renderRails() {
    var cols = state.perTeam <= 1 ? 1 : 2;
    var max = state.railMax || 8;

    ['A', 'B'].forEach(function (key) {
      var el = $('[data-rail="' + key + '"]');
      if (!el) return;

      if (!railChk.checked) {
        el.innerHTML = '';
        el.classList.add('empty');
        return;
      }

      el.classList.remove('empty');

      patchChildren(el, roster(teamByKey(key)), playerKey,
        function (p) {
          var card = elFromHtml(railCardHtml(p, cols));
          updateRailCard(card, p, cols, max);
          return card;
        },
        function (card, p) { updateRailCard(card, p, cols, max); });
    });
  }

  /* -------------------------------------------------------- production queue */

  /* 单位/建筑图标。AltCameo（渗透后老兵版）缺图自动回退普通图。 */
  function queueNextCount(q) {
    var next = q.next || [];
    if (!HIDDEN) return next.length;
    var n = 0;
    for (var i = 0; i < next.length; i++) {
      if (!HIDDEN[next[i]]) n++;
    }
    return n;
  }

  /* R12 隐藏单位在产：通道结构保留（不能画成"空闲"骗人），只遮住图标与 ID。
     不复用 idle 类——updateQueuePanel 用 idle 判定"通道不活跃"，混用会每秒重建。 */
  function queueItemMasked(q, short, tail) {
    var pct = Math.round(q.pct || 0);
    return '<div class="qitem hid" title="已隐藏单位 · ' + pct + '%' +
      (tail ? ' · 后续 ' + tail + ' 项' : '') + '">' +
      '<span class="qtag">' + esc(short) + '</span>' +
      '<span class="qidle">已隐藏</span>' +
      (tail ? '<span class="qbadge">' + (tail + 1) + '</span>' : '') +
      '<span class="prog"><i style="width:' + pct + '%"></i></span>' +
    '</div>';
  }

  function queueItem(q, vet, short) {
    var id = q.id;
    var tail = queueNextCount(q);
    if (unitHidden(id)) return queueItemMasked(q, short, tail);
    var base = iconSrc(id, false);
    var alt = vet ? altIconName(id) : '';
    var src = alt ? iconSrc(id, true) : base;
    var pct = Math.round(q.pct || 0);
    var title = esc(id) + ' · ' + pct + '%' + (tail ? ' · 后续 ' + tail + ' 项' : '');

    if (!base) {
      return '<div class="qitem noicon" title="' + title + '">' +
        '<span class="uid">' + esc(id) + '</span>' +
        '<span class="qtag">' + esc(short) + '</span>' +
        (tail ? '<span class="qbadge">' + (tail + 1) + '</span>' : '') +
        '<span class="prog"><i style="width:' + pct + '%"></i></span>' +
      '</div>';
    }

    return '<div class="qitem" title="' + title + '">' +
      '<img src="' + esc(src) + '" alt="' + esc(id) + '" draggable="false"' +
        ' onerror="this.onerror=null;this.src=\'' + base + '\'">' +
      '<span class="qtag">' + esc(short) + '</span>' +
      (tail ? '<span class="qbadge">' + (tail + 1) + '</span>' : '') +
      '<span class="prog"><i style="width:' + pct + '%"></i></span>' +
    '</div>';
  }

  /* 空闲通道：显示通道名占位，不塌缩，避免误读成"没有这条队列" */
  function queueIdle(ch) {
    return '<div class="qitem idle" title="' + esc(ch.label) + ' · 空闲">' +
      '<span class="qtag">' + esc(ch.short) + '</span>' +
      '<span class="qidle">' + esc(ch.label) + '</span>' +
    '</div>';
  }

  /* bridge 还没输出 queues（05 未完成 #1）。live 下用中性占位，
     不能画成"空闲"——那会让人误以为玩家真没在生产。 */
  function queueUnavailable(ch) {
    return '<div class="qitem idle na" title="' + esc(ch.label) + ' · 数据桥未输出">' +
      '<span class="qtag">' + esc(ch.short) + '</span>' +
      '<span class="qidle">—</span>' +
    '</div>';
  }

  /* 只生成外壳（格子留空），内容统一由 updateQueuePanel 的键控补丁填充 */
  function queuePanelHtml(p, cols) {
    return '<div class="qpanel' + (p.queues ? '' : ' na') +
      '" style="--c:' + p.color + '"' +
      (p.queues ? '' : ' title="hud_bridge 尚未输出生产队列"') + '>' +
      '<div class="qhead">' +
        '<span class="qteam">' + esc(p._team) + '</span>' +
        '<span class="qtitle">' + esc(p.name) + '</span>' +
        '<span class="qcount"></span>' +
      '</div>' +
      '<div class="qgrid" style="grid-template-columns:repeat(' + cols + ',60px)"></div>' +
    '</div>';
  }

  function updateQueuePanel(panel, p, cols) {
    panel.className = 'qpanel' + (p.queues ? '' : ' na');
    if (p.queues) panel.removeAttribute('title');
    else panel.title = 'hud_bridge 尚未输出生产队列';
    panel.style.setProperty('--c', p.color);
    var qteam = panel.querySelector('.qteam');
    if (qteam) qteam.textContent = p._team;
    var qtitle = panel.querySelector('.qtitle');
    if (qtitle) qtitle.textContent = p.name;

    var grid = panel.querySelector('.qgrid');
    if (!grid) return false;
    var want = 'repeat(' + cols + ',60px)';
    if (grid.style.gridTemplateColumns !== want) grid.style.gridTemplateColumns = want;

    /* VET 徽标按渗透状态原位增删，不重建整卡 */
    var vetEl = panel.querySelector('.qvet');
    var wantVet = !!(p.infiltration &&
      (p.infiltration.barracks || p.infiltration.war_factory));
    if (wantVet && !vetEl) {
      var v = elFromHtml('<span class="qvet" title="兵营/重工被渗透：新造单位直接老兵">VET</span>');
      var head = panel.querySelector('.qhead');
      head.insertBefore(v, panel.querySelector('.qcount'));
    } else if (!wantVet && vetEl) {
      vetEl.remove();
    }

    var busy = 0;
    CHANNELS.forEach(function (ch) {
      var q = p.queues && p.queues[ch.key];
      if (q && q.id) busy++;
    });
    var count = panel.querySelector('.qcount');
    var countText = p.queues ? busy + '/' + CHANNELS.length : '未接入';
    if (count && count.textContent !== countText) count.textContent = countText;

    patchChildren(grid, CHANNELS,
      function (ch) { return ch.key; },
      function (ch) {
        if (!p.queues) return elFromHtml(queueUnavailable(ch));
        var q = p.queues[ch.key];
        if (q && q.id) {
          var el = elFromHtml(queueItem(q, veteranChannel(p, ch.key), ch.short));
          el.dataset.qid = q.id;
          return el;
        }
        return elFromHtml(queueIdle(ch));
      },
      function (cell, ch) {
        var q = p.queues && p.queues[ch.key];
        var active = !!(q && q.id);
        /* 状态切换（空闲↔生产↔未接入）或产品换了：结构不同，整格重建。
           R12 隐藏态翻转（配置变更）同样整格重建；遮蔽格命中则静置，
           不随进度刷内容（遮蔽本身就是不给信息）。 */
        if (active !== !cell.classList.contains('idle')) return false;
        if (active && cell.dataset.qid !== q.id) return false;
        if (!active && !p.queues && !cell.classList.contains('na')) return false;
        if (!active) return;
        var hidNow = unitHidden(q.id);
        if (hidNow !== cell.classList.contains('hid')) return false;
        if (hidNow) return;

        var pct = Math.round(q.pct || 0);
        var tail = queueNextCount(q);
        cell.title = esc(q.id) + ' · ' + pct + '%' + (tail ? ' · 后续 ' + tail + ' 项' : '');

        /* 渗透老兵版换图（AltCameo）：同一节点上换 src，不重建 */
        var alt = veteranChannel(p, ch.key) ? altIconName(q.id) : '';
        var src = alt ? iconSrc(q.id, true) : iconSrc(q.id, false);
        var im = cell.querySelector('img');
        if (im && im.getAttribute('src') !== src) im.setAttribute('src', src);

        var bar = cell.querySelector('.prog > i');
        if (bar) bar.style.width = pct + '%';

        var badge = cell.querySelector('.qbadge');
        var wantBadge = tail ? String(tail + 1) : '';
        if (wantBadge) {
          if (!badge) {
            var nb = elFromHtml('<span class="qbadge">' + wantBadge + '</span>');
            cell.insertBefore(nb, cell.querySelector('.prog'));
          } else if (badge.textContent !== wantBadge) {
            badge.textContent = wantBadge;
          }
        } else if (badge) {
          badge.remove();
        }
      });
  }

  function renderQueues() {
    if (!queueColumn) return;

    if (!queueChk.checked) {
      queueColumn.innerHTML = '';
      queueColumn.classList.add('hidden');
      return;
    }
    queueColumn.classList.remove('hidden');

    /* R22：Esc / 选项菜单打开时自动隐藏队列列。
       原判据是 model.paused，而那是 ScenarioClass::IsGamePaused——多人局按 Esc
       不会置位，所以这条自动隐藏从来没触发过。改看桥的 menu_open
       （可见 #32770 对话框 或 OwnerDraw 对话框栈深度>0）。
       开关 hide_queue_on_menu 默认开；与手动开关（hidden 类）互不干扰：
       手动关=hidden，菜单=menu-hide，二者任一生效即隐藏。 */
    var hideOnMenu = !(window.__CTRL_STATE && window.__CTRL_STATE.hide_queue_on_menu === false);
    queueColumn.classList.toggle('menu-hide',
      hideOnMenu && !!activeModel().menuOpen);
    /* R23：队列列被收起/恢复会改变遮挡区域，重报一次 */
    reportCoverRegions();

    /* 列数由 applyAnchors 按面板实际宽度反算，不要在这里兜底成 2 列：
       真实侧栏缩放后只有 ~126 px，2 列（60+3+60=123 + 内边距）会溢出。 */
    var cols = Math.max(1, state.queueCols || 3);

    patchChildren(queueColumn, visiblePlayers(), playerKey,
      function (p) {
        var panel = elFromHtml(queuePanelHtml(p, cols));
        updateQueuePanel(panel, p, cols);
        return panel;
      },
      function (panel, p) { updateQueuePanel(panel, p, cols); });
  }

  /* --------------------------------------------------------------- faux map */

  function addDot(x, y, color) {
    var d = document.createElement('i');
    d.className = 'unit-dot';
    d.style.left = Math.max(1, Math.min(99, x)) + '%';
    d.style.top = Math.max(1, Math.min(99, y)) + '%';
    d.style.setProperty('--c', color);
    unitLayer.appendChild(d);
  }

  function addBuilding(x, y, color) {
    var b = document.createElement('i');
    b.className = 'building';
    b.style.left = x + '%';
    b.style.top = y + '%';
    b.style.setProperty('--c', color);
    unitLayer.appendChild(b);
  }

  function addBase(cx, cy, colors) {
    var i, ang, r;

    for (i = 0; i < 7; i++) {
      ang = Math.random() * Math.PI * 2;
      r = 2 + Math.random() * 5;
      addBuilding(
        cx + Math.cos(ang) * r,
        cy + Math.sin(ang) * r * 0.7,
        colors[i % colors.length]
      );
    }

    for (i = 0; i < 18; i++) {
      ang = Math.random() * Math.PI * 2;
      r = 4 + Math.random() * 13;
      addDot(
        cx + Math.cos(ang) * r,
        cy + Math.sin(ang) * r * 0.7,
        colors[i % colors.length]
      );
    }
  }

  function renderFauxMap() {
    /* overlay 模式下地图/单位层 display:none，重建纯属浪费且加剧整页重排 */
    if (state.overlay) return;
    unitLayer.innerHTML = '';

    var m = activeModel();
    var players = visiblePlayers();
    var half = Math.ceil(players.length / 2);
    var colorsA = players.slice(0, half).map(function (p) { return p.color; });
    var colorsB = players.slice(half).map(function (p) { return p.color; });

    if (!colorsA.length) colorsA = ['#92988f'];
    if (!colorsB.length) colorsB = colorsA;

    /* 真实模式：地图区域留白，只画 HUD。
       本站不渲染游戏画面（OBS 里游戏是独立的采集源），
       画任何装饰地形都会让 HUD 对齐失去意义。
       小地图也一并留白：原版雷达是游戏自己的画面，我们的 HUD 不需要它，
       在它上面盖一块假地图只会把真实雷达挡住（2026-10-22 实测踩到）。 */
    if (m.live || state.overlay) {
      stage.classList.add('map-blank');
      stage.classList.remove('map-live');
      return;
    }

    stage.classList.remove('map-blank');
    addBase(21, 37, colorsA);
    addBase(77, 62, colorsB);

    for (var i = 0; i < 12; i++) {
      addDot(40 + Math.random() * 22, 42 + Math.random() * 18, colorsA[i % colorsA.length]);
      addDot(40 + Math.random() * 22, 42 + Math.random() * 18, colorsB[i % colorsB.length]);
    }

    for (var j = 0; j < 8; j++) {
      addDot(48 + Math.random() * 8, 44 + Math.random() * 10, '#92988f');
    }

    renderRadar(colorsA, colorsB);
  }

  function renderRadar(colorsA, colorsB) {
    $$('.blip', radarMap || radar).forEach(function (el) { el.remove(); });

    var m = activeModel();
    if (m.live || state.overlay) {
      /* 真实数据/覆盖层：整块小地图都不画（游戏自己的雷达就在那里，不能盖） */
      return;
    }

    var spots = [[21, 37], [27, 44], [25, 31], [17, 41], [77, 62], [70, 56], [83, 67], [73, 69]];
    spots.forEach(function (s, i) {
      var el = document.createElement('i');
      var colors = i < 4 ? colorsA : colorsB;
      el.className = 'blip';
      el.style.left = s[0] + '%';
      el.style.top = s[1] + '%';
      el.style.setProperty('--c', colors[i % colors.length]);
      (radarMap || radar).appendChild(el);
    });

    var box = $('.viewbox', radar);
    if (box) {
      box.style.left = '38%';
      box.style.top = '30%';
      box.style.width = '34%';
      box.style.height = '26%';
      box.style.display = '';
    }
  }

  /* 小地图整块不再由本页渲染（2026-10-23）：原版雷达是游戏自己的画面，
     我们的 HUD 不需要它，盖上去只会遮住真实雷达。radar_rect / radar_view_rect
     仍由桥输出，留给以后做"雷达警报时间轴"之类的独立模块用。 */

  /* --------------------------------------------------------------- layout */

  function fitStage() {
    /* 覆盖层模式：画布 = 窗口，不要缩放，否则 HUD 会跟窗口错位 */
    if (state.overlay) {
      stage.style.transform = 'none';
      return;
    }
    var pad = 28;
    var vw = Math.max(320, viewport.clientWidth - pad);
    var vh = Math.max(240, viewport.clientHeight - pad);
    var scale = Math.min(vw / state.canvasW, vh / state.canvasH);
    stage.style.transform = 'scale(' + scale + ')';
  }

  /* 广播布局锚定：
     - 顶栏 / 单位栏优先放进黑边
     - 生产队列覆盖原版建造栏区域（sidebar_rect 里小地图下方）
     live 且 screen.valid 时全部用真实像素；否则退回 game 宽度的比例估算。 */
  var GAME_SIDEBAR_RATIO = 0.155;
  /* 游戏侧栏内边距 1.1%（相对游戏宽度），边框 2 px */
  var SIDEBAR_PAD_RATIO = 0.011;
  var BAR_H = 88;
  /* 桥的数据超过这么久没变化就判定停摆（桥默认 500 ms 一帧，留足余量） */
  var STALE_SEC = 3;
  var RAIL_W = 152;
  /* 实测 158 = 雷达 110 + 标签行 48；侧栏顶到屏幕顶的那段是工具栏/资源条 */
  var SIDEBAR_TOP = 158;

  /* 把 data.screen 换成"相对游戏画面左上角的设计像素"。
     screen 里所有值都是游戏坐标系（相对屏幕 (0,0)），
     而 stage 里 .game 已经是"按目标宽高比 Fit 后的矩形"，两者只差一个缩放比。 */
  function liveGeom(g, u) {
    var m = activeModel();
    var sc = m && m.screen;
    if (state.source !== 'live' || !sc || !sc.valid) return null;
    if (!liveGeoChk.checked) return null;
    if (!sc.width || !sc.height) return null;

    var k = (g.w / u) / sc.width;   /* 游戏像素 → HUD 设计像素 */

    function R(r) {
      return [r[0] * k, r[1] * k, r[2] * k, r[3] * k];
    }

    var view = R(sc.view_rect);
    var side = R(sc.sidebar_rect);
    var radar = R(sc.radar_rect);

    /* radar_rect 的坐标空间（2026-10-22 实测 + 引擎布局常量印证）：
       - x 是侧栏局部（18 / 58，远小于 sidebar.x 的 1752 / 2392）
       - y 是屏幕绝对（49；雷达高 108，底边 157，正好是 sidebar_rect 的 158）
       侧栏表面是 168×整屏高，原点在 (sidebar.x, 0)。
       注意 sidebar_rect 是**建造区**矩形（从 158 起），不是整个侧栏。 */
    var radarAbs = [side[0] + radar[0], radar[1], radar[2], radar[3]];

    return {
      k: k,
      gameW: sc.width * k,
      gameH: sc.height * k,
      view: view,
      side: side,
      radar: radar,
      radarAbs: radarAbs,
      sidebarSide: sc.sidebar_side
    };
  }

  function applyAnchors(g, hudX, hudY, u) {
    var vx = (g.x - hudX) / u;
    var vy = (g.y - hudY) / u;
    var vw = g.w / u;
    var vh = g.h / u;

    var geom = liveGeom(g, u);
    state.liveGeom = geom;
    var viewW, viewTop, viewH, qLeft, qTop, qW, qH;

    if (geom) {
      /* 真实几何：view / sidebar / radar 都是相对游戏画面原点的设计像素 */
      viewW = geom.view[2];
      viewTop = geom.view[1];
      viewH = geom.view[3];
      /* 生产队列覆盖原版建造栏：sidebar_rect 就是建造区（y=158 起），
         宽度用侧栏 168 px 常量而非 radar_rect 宽——radar_rect 的宽会随分辨率缩
         （2560 时只有 56 px），拿它当队列宽会把 60 px 图标挤爆。 */
      qLeft = geom.side[0];
      qW = geom.side[2];
      qTop = geom.side[1] + 6;
      qH = Math.max(100, geom.gameH - qTop - 18);
    } else {
      var sbW0 = vw * GAME_SIDEBAR_RATIO;
      viewW = vw - (gameUiChk.checked ? sbW0 : 0);
      viewTop = 0;
      viewH = vh;

      var sbPad0 = vw * SIDEBAR_PAD_RATIO;
      var radarW0 = Math.max(80, sbW0 - 2 - sbPad0 * 2);
      qLeft = vw - sbW0 + 2 + sbPad0;
      qTop = sbPad0 + radarW0 + sbPad0 + 6;
      qW = radarW0;
      qH = Math.max(100, vh - qTop - 18);
    }

    var lift = 8;
    var gap = 14;
    var bottomPad = 18;

    /* 顶栏 */
    var barInMargin = vy >= BAR_H + lift;
    var barTop = barInMargin ? vy - BAR_H - lift : vy;

    var top = $('.top-bar');
    /* R10 顶栏左上让位：游戏的事件/超武文字消息画在视口左上角，让出一条
       不绘制的竖条，游戏自己的文字原样透出（零失真的"透传"）。开关走
       /control 的 yield_top_left，control-bridge.js 挂 body.yield-tl 类。 */
    var yieldTl = document.body.classList.contains('yield-tl');
    var msgW = yieldTl ? Math.max(240, Math.min(560, Math.round(viewW * 0.24))) : 0;
    if (msgW > Math.max(0, viewW - 200)) msgW = Math.max(0, viewW - 200);
    top.style.left = (vx + msgW) + 'px';
    top.style.top = barTop + 'px';
    top.style.width = (viewW - msgW) + 'px';
    top.style.right = 'auto';
    top.classList.toggle('in-margin', barInMargin);

    var railTop = barTop + BAR_H + gap;
    /* 侧栏只占可用高度的 65%：再往下就压住战场了。
       railH 同时作为 railMaxUnits() 的 clientHeight 来源，
       所以这里收窄后单位格数上限会自动跟着降。 */
    var railAvail = Math.max(120, (vy + viewH) - railTop - bottomPad);
    var railH = Math.max(120, Math.round(railAvail * RAIL_FILL));
    state._railAvail = railAvail;
    state._railH = railH;
    var railGap = 14;

    /* 1v1 用单列，宽度只够一格图标，减少遮挡 */
    var single = state.perTeam <= 1;
    var railW = single ? 84 : RAIL_W;

    /* 画布黑边留白：左右两侧都要跟**游戏整体**比，不能跟战术视口比。
       右侧那 168px 是游戏自带侧栏（小地图 + 建造区），不是可放 HUD 的黑边；
       拿视口右边缘去算会把右栏塞进侧栏里，压住小地图和生产队列。
       用 HUD 设计层的实际右边界（hudRight），不用 canvasW/u——
       后者是"画布能容下多少设计像素"，当 HUD 层居中留边时它比实际可用宽度大。 */
    var gameW = geom ? geom.gameW : vw;
    var hudRight = vx + 1920;   /* HUD 设计层宽固定 1920，右边界 = 左偏移 + 1920 */
    var railInLeft = vx >= railW + gap * 2;
    var railInRight = (hudRight - (vx + gameW)) >= railW + gap * 2;

    state._vx = vx;
    state._viewW = viewW;
    state._gameW = gameW;
    state._hudRight = hudRight;

    var leftRail = $('.rail-left');
    var rightRail = $('.rail-right');

    leftRail.style.left = (railInLeft ? vx - railW - gap : vx + railGap) + 'px';
    leftRail.style.top = railTop + 'px';
    leftRail.style.height = railH + 'px';
    leftRail.style.width = railW + 'px';
    leftRail.classList.toggle('single', single);

    /* 放不进黑边就压进视口内沿；必须在视口右侧收边，不能越过 sidebar */
    rightRail.style.left = (railInRight
      ? vx + gameW + gap
      : vx + viewW - railW - railGap) + 'px';
    rightRail.style.right = 'auto';
    rightRail.style.top = railTop + 'px';
    rightRail.style.height = railH + 'px';
    rightRail.style.width = railW + 'px';
    rightRail.classList.toggle('single', single);

    queueColumn.style.left = (vx + qLeft) + 'px';
    queueColumn.style.top = (vy + qTop) + 'px';
    queueColumn.style.width = qW + 'px';
    queueColumn.style.height = qH + 'px';
    queueColumn.style.bottom = 'auto';
    queueColumn.classList.toggle('live-geom', !!geom);
    /* 队列是 HUD 的一部分，不是"覆盖原版建造栏"的装饰：
       演示页里关掉「游戏 UI」就连同假侧栏一起隐藏；
       覆盖层模式没有本地假侧栏（游戏是 OBS 的独立采集源），只受「生产队列」开关控制。 */
    queueColumn.style.display =
      (queueChk.checked && (state.overlay || gameUiChk.checked)) ? '' : 'none';

    /* 队列每行能放几个 60px 图标；6 条通道固定 2 行 × 3 列，
       窄到放不下 3 列时退成 2 列 × 3 行 */
    /* 队列每行能放几个 60px 图标。侧栏真实宽 168 px、按画布缩放后可能只剩 ~126 设计 px，
       这时候只能放 1 列（2 列需要 124+3=127，会溢出）。 */
    state.queueCols = Math.max(1, Math.min(3, Math.floor((qW - 16 + 4) / 64)));

    /* 小地图整块不渲染（2026-10-23）：原版雷达在那块区域，我们的 HUD 不画雷达。
       这里只保留隐藏动作，不写任何位置——避免以后有人"顺手"把它再打开。 */
    var gameSidebar = $('#gameSidebar');
    if (gameSidebar) {
      gameSidebar.classList.toggle('live', !!geom);
    }

    /* 对线框：用真实 view_rect / sidebar_rect 覆盖 CSS 里的 84.5%/15.5% */
    var gView = $('.guide.view');
    var gSide = $('.guide.sidebar-g');
    if (geom && gView && gSide) {
      var gw = geom.gameW, gh = geom.gameH;
      gView.style.left = (geom.view[0] / gw * 100) + '%';
      gView.style.top = (geom.view[1] / gh * 100) + '%';
      gView.style.width = (geom.view[2] / gw * 100) + '%';
      gView.style.height = (geom.view[3] / gh * 100) + '%';
      gSide.style.left = (geom.side[0] / gw * 100) + '%';
      gSide.style.top = (geom.side[1] / gh * 100) + '%';
      gSide.style.width = (geom.side[2] / gw * 100) + '%';
      gSide.style.height = (geom.side[3] / gh * 100) + '%';
      gView.firstChild.textContent = 'view ' + geom.view.map(Math.round).join(',');
      gSide.firstChild.textContent = 'sidebar ' + geom.side.map(Math.round).join(',');
    } else {
      [gView, gSide].forEach(function (el) {
        if (!el) return;
        el.style.top = '0';
        el.style.height = '100%';
      });
      if (gView) {
        gView.style.left = '0';
        gView.style.width = '84.5%';
        gView.firstChild.textContent = 'view_rect';
      }
      if (gSide) {
        gSide.style.left = '84.5%';
        gSide.style.width = '15.5%';
        gSide.firstChild.textContent = 'sidebar_rect';
      }
    }

    fitChips(top);
  }

  function applyLayout() {
    /* 覆盖层模式：画布 = 浏览器窗口（OBS 里就是浏览器源尺寸），不做等比缩放 */
    if (state.overlay) {
      state.canvasW = Math.max(320, window.innerWidth);
      state.canvasH = Math.max(240, window.innerHeight);
    }

    var W = state.canvasW;
    var H = state.canvasH;
    var m = activeModel();

    /* live 有真实分辨率时，游戏画面按真实宽高比 Fit，不靠工具栏猜 */
    var aspect = state.gameAspect;
    if (m.screen && m.screen.valid && m.screen.width && m.screen.height && liveGeoChk.checked) {
      aspect = m.screen.width / m.screen.height;
    }

    stage.style.width = W + 'px';
    stage.style.height = H + 'px';

    var u = Math.min(W / 1920, H / 1080);
    var hudW = 1920 * u;
    var hudH = 1080 * u;
    var hudX = (W - hudW) / 2;
    var hudY = (H - hudH) / 2;

    hudScaler.style.transform = 'translate(' + hudX + 'px,' + hudY + 'px) scale(' + u + ')';

    var area = { x: hudX, y: hudY, w: 1920 * u, h: 1080 * u };
    /* 游戏矩形必须落在 HUD 设计层（area）里，两种模式一致。
       覆盖层模式下 OBS 浏览器源就是游戏采集源的尺寸，W/H 与游戏同比例 → area 正好铺满；
       若源尺寸设错（比例不符），HUD 会按 area 居中留边，不会跟着歪。 */
    var g = fitRect(area, aspect);

    game.style.left = g.x + 'px';
    game.style.top = g.y + 'px';
    game.style.width = g.w + 'px';
    game.style.height = g.h + 'px';
    game.style.fontSize = (g.w / 100) + 'px';

    applyAnchors(g, hudX, hudY, u);

    state._u = u;
    state._hudX = hudX;
    state._hudY = hudY;
    state._g = [Math.round(g.x), Math.round(g.y), Math.round(g.w), Math.round(g.h)];

    stage.classList.toggle('show-safe', safeChk.checked);
    stage.classList.toggle('show-guides', guideChk.checked);
    stage.classList.toggle('show-gameui', gameUiChk.checked);
    stage.classList.toggle('blocked-hud', !canRender(m));
    stage.classList.toggle('is-live', state.source === 'live');

    var geom = liveGeom(g, u);
    statusText.textContent =
      '画布 ' + W + '×' + H +
      ' · 游戏 ' + Math.round(g.w) + '×' + Math.round(g.h) +
      ' @ (' + Math.round(g.x) + ',' + Math.round(g.y) + ')' +
      ' · HUD ×' + u.toFixed(2) +
      ' · ' + (m.live ? (m.modeLabel || '') : modeLabel()) +
      (geom
        ? ' · 真实几何 ' + m.screen.width + '×' + m.screen.height +
          '（view ' + m.screen.view_rect[2] + '×' + m.screen.view_rect[3] +
          '，侧栏 ' + m.screen.sidebar_rect[2] + 'px）'
        : ' · 估算几何 · 安全区 5%');

    fitStage();

    /* 单位栏上限依赖实际高度，先布局再算 */
    state.railMax = railMaxUnits();
  }

  /* ------------------------------------------------------------ live source */

  function applyLiveModel(d) {
    if (!window.LIVE_DATA) {
      state.liveError = 'live-data.js 未加载';
      return false;
    }

    var model;
    try {
      model = window.LIVE_DATA.toModel(d);
    } catch (err) {
      state.liveError = '映射失败：' + (err && err.message ? err.message : err);
      return false;
    }

    var prev = state.liveModel;

    /* 桥在"大厅/加载中/本局结束"会输出空的 players[]。如果直接覆盖模型，
       perTeam 会被压成 1，退回菜单那一瞬间布局会闪成 1v1，再进第二局又跳回来。
       这里保留上一局的名单（只翻转 offline 状态），等新一局的真实名单到了再换。 */
    if (!model.ok && prev && prev.ok) {
      var held = prev;
      state.liveFetchedAt = Date.now();
      state.liveError = '';
      state.source = 'live';
      /* 只更新状态/时间字段，名单和几何继续用旧的（但会被 live-offline 隐藏） */
      held.phase = model.phase;
      held.clientRunning = model.clientRunning;
      held.meta.phase = model.meta.phase;
      held.meta.pid = model.meta.pid;
      held.meta.frame = model.meta.frame;
      held.meta.ts = model.meta.ts;
      held.meta.schema = model.meta.schema;
      syncToolbarState();
      return false;
    }

    var changed =
      !prev ||
      prev.meta.frame !== model.meta.frame ||
      prev.teams.length !== model.teams.length ||
      prev.map !== model.map ||
      prev.paused !== model.paused ||
      prev.menuOpen !== model.menuOpen ||
      prev.perTeam !== model.perTeam ||
      prev.meta.pid !== model.meta.pid;

    state.liveModel = model;
    state.liveError = '';
    state.liveFetchedAt = Date.now();
    state.source = 'live';

    /* 桥停摆时文件不变，fetch 仍成功。用 ts+frame 做签名判断内容是否真的在推进；
       内容变了才刷新 liveDataAt，供停滞判定用。 */
    var sig = (d.ts || 0) + ':' + (model.meta.frame || 0) + ':' + (d.pid || 0);
    if (sig !== state.liveLastSig) {
      state.liveLastSig = sig;
      state.liveDataAt = state.liveFetchedAt;
    }

    /* 人数由真实分队决定，不跟工具栏；工具栏的"人数"在 live 下禁用 */
    var perTeamChanged = state.perTeam !== model.perTeam;
    state.perTeam = model.perTeam;

    if (changed || perTeamChanged) {
      state.liveRev++;
    }
    syncToolbarState();
    return changed || perTeamChanged;
  }

  /* live 下把只对 mock 有效的控件禁用，避免误以为能改真实对局 */
  function syncToolbarState() {
    var live = state.source === 'live';
    var m = state.liveModel;

    scenarioSel.disabled = live;
    $('#shuffleBtn').disabled = live;
    pauseBtn.disabled = live;

    if (live && m) {
      scenarioSel.value = String(Math.max(1, Math.min(4, m.perTeam)));
    }
    /* 保留帧的 ok 仍是 true，但桥当前 phase 可能是 lobby/post_match ——
       用 phase 判断是否该隐藏 HUD，而不是用被保留的 ok。 */
    var liveOk = live && m && m.ok &&
      m.phase !== 'post_match' && m.phase !== 'lobby' &&
      m.phase !== 'loading' && m.phase !== 'no_client';
    stage.classList.toggle('live-offline', live && !liveOk);
  }

  function fetchLive() {
    var url = state.liveUrl;
    if (!url) return Promise.resolve(false);

    /* 加时间戳跳过缓存；桥是原子替换，不会读到半截文件 */
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    return fetch(url + sep + '_t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        var changed = applyLiveModel(d);
        if (changed) {
          renderFauxMap();
          relayoutAndRender();
        } else {
          renderHeader();
          renderTopBar();
          renderQueues();
        }
        return true;
      })
      .catch(function (err) {
        state.liveError = String(err && err.message ? err.message : err);
        renderLiveStatus();
        return false;
      });
  }

  function guessLiveUrl() {
    /* file:// 下 fetch 会被 CORS 拦；用本地服务时走 /state/ 路由（serve.py） */
    if (location.protocol === 'file:') {
      return (location.pathname.indexOf('/release/') !== -1 ? '../out/hud_state.json' : '../../release/out/hud_state.json');
    }
    return '/state/out/hud_state.json';
  }

  function setSource(src) {
    state.source = src;

    var live = src === 'live';
    liveUrl.disabled = !live;
    liveGeoChk.disabled = !live;
    stage.classList.toggle('is-live', live);
    stage.classList.toggle('live-error', live && !!state.liveError);

    if (live) {
      if (!state.liveUrl) state.liveUrl = guessLiveUrl();
      liveUrl.value = state.liveUrl;
      /* 先不猜人数，等第一帧真实数据；期间按 1v1 排，来了立刻改 */
      state.perTeam = 1;
      /* 切进 live 时清掉上一次的停滞计时，否则一进来就报"未更新" */
      state.liveLastSig = '';
      state.liveDataAt = 0;
      state.liveFetchedAt = 0;
      stage.classList.remove('live-stale');
      syncToolbarState();
      fetchLive().then(function () { relayoutAndRender(); });
    } else {
      state.liveModel = null;
      state.liveError = '';
      state.liveLastSig = '';
      state.liveDataAt = 0;
      state.perTeam = state.mockPerTeam || 3;
      scenarioSel.value = String(Math.min(4, state.perTeam));
      stage.classList.remove('live-stale');
      syncToolbarState();
      renderFauxMap();
      relayoutAndRender();
    }
    renderLiveStatus();
  }

  function renderLiveStatus() {
    var el = $('#liveStatus');
    if (!el) return;

    if (state.source !== 'live') {
      el.textContent = '';
      el.className = 'live-status';
      return;
    }
    if (state.liveError) {
      el.textContent = '连接失败：' + state.liveError;
      el.className = 'live-status bad';
      return;
    }

    var m = state.liveModel;
    if (!m) {
      el.textContent = '等待数据…';
      el.className = 'live-status';
      return;
    }

    /* 两个时间要分开看：
       fetchAge  = 上次成功读文件距今（服务/网络层面）
       dataAge   = 文件内容上次变化距今（桥是否还在推进） */
    var now = Date.now();
    var fetchAge = state.liveFetchedAt ? Math.round((now - state.liveFetchedAt) / 1000) : 0;
    var dataAge = state.liveDataAt ? Math.round((now - state.liveDataAt) / 1000) : fetchAge;
    /* post_match 期间桥不再采帧（frame 恒 0），ts 仍在推进；
       这时按 frame 判停摆会误报，所以只在 match 态判 stale。 */
    var ph0 = m.meta && m.meta.phase;
    var matchLike = !ph0 || ph0 === 'match';
    var stale = matchLike && dataAge > STALE_SEC;

    var bits = [];
    /* phase 来自桥的守护状态机：区分"桥停了"与"客户端/对局还没起"。
       老桥没有 phase 字段（m.meta.phase 为空），退回只看 ok。 */
    var ph = m.meta && m.meta.phase;
    if (ph === 'no_client') bits.push('客户端未启动');
    else if (ph === 'lobby') bits.push('已进大厅，等待开局');
    else if (ph === 'loading') bits.push('对局加载中');
    else if (ph === 'post_match') bits.push('本局已结束');
    else if (!m.ok) bits.push('未进入对局');
    else bits.push('pid ' + m.meta.pid, 'frame ' + m.meta.frame);
    bits.push('schema ' + m.meta.schema);
    if (stale) bits.push(dataAge + 's 未更新');
    /* 对局外的 phase 用的是"保留的上一局模型"，这些细节已经过时，别显示 */
    if (matchLike) {
      if (m.meta.out_of_sync) bits.push('不同步');
      if (m.ffa) bits.push('多阵营已并入两列');
      if (m.dropped_observer_houses) bits.push('剔除观察者房 ' + m.dropped_observer_houses);
    }

    el.textContent = bits.join(' · ');
    el.className = 'live-status' +
      (stale ? ' stale' : '') +
      (!m.ok ? ' wait' : '');

    /* 覆盖层模式下数据停了要让画面自己说明，而不是把旧人头留在直播间 */
    stage.classList.toggle('live-stale', state.source === 'live' && stale);
  }

  /* ---------------------------------------------------------------- events */

  function renderAll() {
    renderHeader();
    renderTopBar();
    renderRails();
    renderQueues();
  }

  function relayoutAndRender() {
    applyLayout();
    renderAll();
    reportCoverRegions();
  }

  /* R23 光标指示器遮挡区域上报：把"我们自己的不透明面板"的矩形报给 mo_hud，
     采样线程只在指针落进这些矩形时才推坐标，否则指示器不出。
     只在真实覆盖窗口里上报（?cursorregions=1，见 shell.rs）；控制台预览 iframe
     和 OBS 浏览器源虽然也是 overlay 形态，但尺寸/位置不同，报了会污染判定。
     没有 mo_hud（file:// 或 serve.py）时 fetch 静默失败，不影响渲染。
     上报时机：布局变化后（relayoutAndRender）与窗口 resize；节流 300 ms。 */
  var reportTimer = null, lastRegions = '';

  function coverRegionRects() {
    var els = [
      document.querySelector('.top-bar'),
      document.querySelector('.rail-left'),
      document.querySelector('.rail-right'),
      document.getElementById('queueColumn')
    ];
    var out = [];
    /* 用视口坐标：采样线程算出的光标坐标也是覆盖层客户区 CSS px */
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el) continue;
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      /* 手动关掉的队列列（.hidden）与 Esc 菜单收起的（.menu-hide）都不遮挡 */
      if (el.classList.contains('hidden') || el.classList.contains('menu-hide')) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out.push([
        Math.round(r.left), Math.round(r.top),
        Math.round(r.width), Math.round(r.height)
      ]);
    }
    return out;
  }

  function reportCoverRegions() {
    if (!/[?&]cursorregions=1/.test(location.search)) return;
    if (reportTimer) return;
    reportTimer = setTimeout(function () {
      reportTimer = null;
      sendCoverRegions();
    }, 300);
  }

  /* 真正发送。低频兜底轮询也直接用它（跳过 300ms 节流）。 */
  function sendCoverRegions() {
    if (!/[?&]cursorregions=1/.test(location.search)) return;
    var rects = coverRegionRects();
    var sig = JSON.stringify(rects);
    if (sig === lastRegions) return;   /* 矩形没变就不重复发 */
    lastRegions = sig;
    fetch('/cursor/regions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rects: rects })
    }).catch(function () { /* 无 mo_hud：静默 */ });
  }

  window.addEventListener('resize', reportCoverRegions);
  /* 兜底：有代码路径直接改 class 而不经过 relayoutAndRender/renderQueues
     （如 control-bridge.js 切「生产队列」时直接 toggle .hidden），
     靠 1 秒一次的矩形签名比对兜住。4 次 getBoundingClientRect/秒可忽略。 */
  setInterval(sendCoverRegions, 1000);

  function tick() {
    if (state.source === 'live') return;

    if (!MOCK.paused) {
      MOCK.elapsed++;

      visiblePlayers().forEach(function (p) {
        p.cash = Math.max(0, Math.min(99999, p.cash + Math.round((Math.random() - 0.45) * 220)));
        p.army = Math.max(500, p.army + Math.round((Math.random() - 0.5) * 120));
        p.score = Math.max(0, p.score + Math.round(Math.random() * 120));

        if (!p.power) p.power = [0, 0];
        p.power[1] = Math.max(0, p.power[1] + Math.round((Math.random() - 0.5) * 24));

        /* 6 条生产通道各自推进 */
        CHANNELS.forEach(function (ch) {
          var q = p.queues && p.queues[ch.key];
          if (!q) return;
          if (!q.id) {
            if (q.next && q.next.length) { q.id = q.next.shift(); q.pct = 0; }
            return;
          }
          q.pct = Math.min(100, (q.pct || 0) + Math.random() * 1.6);
          if (q.pct >= 100) {
            if (q.next && q.next.length) { q.id = q.next.shift(); q.pct = 0; }
            else { q.id = null; q.pct = 0; }
          }
        });
      });
    }

    renderHeader();
    renderTopBar();
    renderQueues();
  }

  /* 公平性门槛：默认关闭（与 bridge 的测试期开关一致，见 hud_bridge.c 的两处 #if 0）。
     勾上后按真实 observer 字段判断：is_observer / observer_mode 任一为真才渲染。
     mock 没有 observer 字段，勾上必然拦截——这是预期行为，不是 bug。 */
  function canRender(m) {
    if (!gateChk || !gateChk.checked) return true;
    var o = m && m.observer;
    if (!o) return false;
    return !!(o.is_observer || o.observer_mode);
  }

  function setPaused(paused) {
    MOCK.paused = paused;
    pauseBtn.textContent = paused ? '继续' : '暂停';
    pauseBtn.classList.toggle('on', paused);
    document.body.classList.toggle('paused', paused);
  }

  function shuffle() {
    MOCK.elapsed = 300 + Math.floor(Math.random() * 900);

    MOCK.teams.forEach(function (team) {
      team.players.forEach(function (p) {
        p.cash = 4000 + Math.floor(Math.random() * 16000);
        p.score = 20000 + Math.floor(Math.random() * 100000);
        p.power[0] = 250 + Math.floor(Math.random() * 500);
        p.power[1] = Math.round(p.power[0] * (0.35 + Math.random() * 0.9));
        p.qPct = Math.floor(Math.random() * 100);
        CHANNELS.forEach(function (ch) {
          var q = p.queues && p.queues[ch.key];
          if (q && q.id) q.pct = Math.floor(Math.random() * 100);
        });

        (p.units || []).forEach(function (u) {
          var per = Math.round(u.maxhp / Math.max(1, u.count));
          u.count = 1 + Math.floor(Math.random() * 8);
          u.maxhp = per * u.count;
          u.hp = Math.round(u.maxhp * (0.35 + Math.random() * 0.65));
        });
      });
    });

    renderFauxMap();
    relayoutAndRender();
  }

  /* ---------------------------------------------------------------- wiring */

  $('#canvasSel').addEventListener('change', function (e) {
    var parts = e.target.value.split('x');
    state.canvasW = Number(parts[0]);
    state.canvasH = Number(parts[1]);
    relayoutAndRender();
  });

  $('#gameSel').addEventListener('change', function (e) {
    var map = { '16:9': 16 / 9, '4:3': 4 / 3, '21:9': 21 / 9 };
    state.gameAspect = map[e.target.value] || 16 / 9;
    relayoutAndRender();
  });

  scenarioSel.addEventListener('change', function (e) {
    state.perTeam = Number(e.target.value) || 3;
    state.mockPerTeam = state.perTeam;
    state.railMax = 8;
    if (state.source !== 'live') renderFauxMap();
    relayoutAndRender();
  });

  sourceSel.addEventListener('change', function (e) {
    setSource(e.target.value);
  });

  liveUrl.addEventListener('change', function () {
    var v = liveUrl.value.trim();
    state.liveUrl = v;
    if (state.source === 'live') fetchLive();
  });

  liveUrl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      state.liveUrl = liveUrl.value.trim();
      if (state.source === 'live') fetchLive();
    }
  });

  liveGeoChk.addEventListener('change', relayoutAndRender);

  railChk.addEventListener('change', function () {
    relayoutAndRender();
  });

  queueChk.addEventListener('change', function () {
    if (queueChk.checked) queueColumn.classList.remove('hidden');
    renderQueues();
  });

  safeChk.addEventListener('change', function () {
    stage.classList.toggle('show-safe', safeChk.checked);
  });

  guideChk.addEventListener('change', function () {
    stage.classList.toggle('show-guides', guideChk.checked);
  });

  gameUiChk.addEventListener('change', relayoutAndRender);

  gateChk.addEventListener('change', relayoutAndRender);

  pauseBtn.addEventListener('click', function () {
    if (state.source === 'live') {
      /* 真实数据的暂停来自游戏，本地不伪造 */
      var paused = !(state.liveModel && state.liveModel.paused);
      pauseBtn.textContent = paused ? '继续' : '暂停';
      pauseBtn.classList.toggle('on', paused);
      return;
    }
    setPaused(!MOCK.paused);
  });

  $('#shuffleBtn').addEventListener('click', shuffle);

  window.addEventListener('resize', function () {
    if (state.overlay) {
      /* 覆盖层：画布就是窗口，尺寸变了要整套重排 */
      relayoutAndRender();
      return;
    }
    fitStage();
    state.railMax = railMaxUnits();
    renderRails();
  });

  /* ------------------------------------------------------------------ boot */

  /* ?probe=1：把关键布局/数据结果写进 <body data-probe>，供 --dump-dom 校验。
     只在调试时用，正常页面不输出。 */
  function writeProbe() {
    if (!/[?&]probe=1/.test(location.search)) return;
    var m = activeModel();
    var geom = state.liveGeom;
    var q = queueColumn.getBoundingClientRect();
    var stageR = stage.getBoundingClientRect();
    var scale = stageR.width / state.canvasW || 1;
    var top = $('.top-bar').getBoundingClientRect();
    var radarR = radar.getBoundingClientRect();

    /* 换算到"画布坐标"：先减掉 stage 的屏幕原点，再除缩放 */
    function toCanvas(r) {
      return [
        Math.round((r.left - stageR.left) / scale),
        Math.round((r.top - stageR.top) / scale),
        Math.round(r.width / scale),
        Math.round(r.height / scale)
      ];
    }

    var probes = {
      source: state.source,
      perTeam: state.perTeam,
      teams: (m.teams || []).map(function (t) {
        return t.key + ':' + t.players.map(function (p) { return p.name; }).join('|');
      }),
      map: m.map,
      modeLabel: m.modeLabel,
      hasGeom: !!geom,
      screen: m.screen && m.screen.valid ? [m.screen.width, m.screen.height] : null,
      viewRect: m.screen && m.screen.valid ? m.screen.view_rect : null,
      sidebarRect: m.screen && m.screen.valid ? m.screen.sidebar_rect : null,
      radarRect: m.screen && m.screen.valid ? m.screen.radar_rect : null,
      queueBox: toCanvas(q),
      topBarBox: toCanvas(top),
      radarBox: toCanvas(radarR),
      railLeftBox: toCanvas($('.rail-left').getBoundingClientRect()),
      railRightBox: toCanvas($('.rail-right').getBoundingClientRect()),
      stageBox: [Math.round(stageR.left), Math.round(stageR.top),
                 Math.round(stageR.width), Math.round(stageR.height)],
      canvasScale: Math.round(scale * 1000) / 1000,
      gridOf: { html: [window.innerWidth, window.innerHeight] },
      railIcons: $$('.ucell').length,
      /* 排序与限高的可核对字段：先英雄、再按数量；栏高不超过可用高度的 65% */
      railOrder: $$('[data-rail="A"] .rp').map(function (card) {
        return $$('.ucell', card).map(function (c) {
          var im = c.querySelector('img');
          var id = im ? im.getAttribute('data-id') : (c.querySelector('.uid') || {}).textContent;
          return { id: id || '', hero: c.classList.contains('hero'),
                   more: c.classList.contains('more') };
        });
      }),
      heroCount: $$('.ucell.hero').length,
      /* 纳米同步变体格：前身图标 + 左上角 fsnc 徽标（LIVE_ICON_SET.sync 驱动） */
      syncedCells: $$('.ucell.synced').length,
      syncedIds: $$('[data-rail] .ucell.synced img').map(function (im) {
        return im.getAttribute('data-id');
      }),
      syncBadgeVar: getComputedStyle(document.documentElement)
        .getPropertyValue('--sync-badge').trim().slice(0, 80) || null,
      railMax: state.railMax,
      railBox: [Math.round(state._railH || 0), Math.round(state._railAvail || 0)],
      railFillRatio: state._railAvail
        ? Math.round((state._railH / state._railAvail) * 1000) / 1000 : null,
      railFill: RAIL_FILL,
      noIconCells: $$('.ucell.noicon').length,
      noIconIds: $$('.ucell.noicon .uid').map(function (el) { return el.textContent; }),
      imgBroken: $$('.ucell img').filter(function (im) { return !im.complete || im.naturalWidth === 0; })
        .map(function (im) { return im.getAttribute('src'); }),
      /* 闪烁回归指标：live 500 ms 轮询不应销毁 <img>（键控更新后恒 0；
         回归到 innerHTML 全量重建会每帧上涨） */
      imgRecycled: typeof imgRecycled === 'number' ? imgRecycled : null,
      queuePanels: $$('.qpanel').length,
      queueNA: $$('.qpanel.na').length,
      queueUnavailableCells: $$('.qitem.idle.na').length,
      queueIdleCells: $$('.qitem.idle').length - $$('.qitem.idle.na').length,
      queueBusyCells: $$('.qitem:not(.idle)').length,
      livePhase: state.liveModel && state.liveModel.meta ? (state.liveModel.meta.phase || null) : null,
      liveError: state.liveError || null,
      liveAgeSec: state.liveFetchedAt ? Math.round((Date.now() - state.liveFetchedAt) / 1000) : null,
      liveDataAgeSec: state.liveDataAt ? Math.round((Date.now() - state.liveDataAt) / 1000) : null,
      liveStale: stage.classList.contains('live-stale'),
      liveStatusText: $('#liveStatus') ? $('#liveStatus').textContent : '',
      queueCols: state.queueCols,
      qPanelW: $$('.qpanel').length ? Math.round($$('.qpanel')[0].getBoundingClientRect().width / scale) : null,
      qGridCols: $$('.qgrid').length ? getComputedStyle($$('.qgrid')[0]).gridTemplateColumns : null,
      /* 面板底色实测（R7.14 加深后应为 0.9 深色，防回归到透明） */
      qpanelBg: $$('.qpanel').length ? getComputedStyle($$('.qpanel')[0]).backgroundColor : null,
      qitemIdleBg: $$('.qitem.idle').length ? getComputedStyle($$('.qitem.idle')[0]).backgroundColor : null,
      iconBase: window.LIVE_ICON_SET ? window.LIVE_ICON_SET.dir : null,
      status: statusText.textContent,
      overlay: state.overlay,
      bodyClass: document.body.className,
      bg: {
        html: getComputedStyle(document.documentElement).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
        viewport: getComputedStyle(viewport).backgroundColor,
        stage: getComputedStyle(stage).backgroundColor
      },
      gameShown: getComputedStyle(game).display,
      radarShown: getComputedStyle(radar).display,
      sidebarShown: (function () {
        var el = $('#gameSidebar');
        return el ? getComputedStyle(el).display : null;
      })(),
      geom: {
        canvas: [state.canvasW, state.canvasH],
        u: state._u,
        hud: [state._hudX, state._hudY],
        game: state._g,
        vx: state._vx,
        viewW: state._viewW,
        gameW: state._gameW
      }
    };
    document.body.setAttribute('data-probe', JSON.stringify(probes));

    /* 无头浏览器拿不到 console，回传给 serve.py 落盘 */
    if (location.protocol === 'http:') {
      try {
        fetch('/probe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(probes)
        }).catch(function () {});
      } catch (e) { /* 忽略 */ }
    }
  }

  /* 深链：?source=live&url=/state/out/hud_state.json
     供 OBS 浏览器源 / 自动化截图直接进入真实数据模式 */
  function bootFromQuery() {
    var q = {};
    location.search.replace(/^\?/, '').split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      var k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
      var v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1));
      q[k] = v;
    });

    if (q.canvas && /^\d+x\d+$/.test(q.canvas)) {
      state.canvasW = Number(q.canvas.split('x')[0]);
      state.canvasH = Number(q.canvas.split('x')[1]);
      var opt = $('#canvasSel').querySelector('option[value="' + q.canvas + '"]');
      if (opt) $('#canvasSel').value = q.canvas;
    }
    if (q.game === '4:3' || q.game === '21:9' || q.game === '16:9') {
      state.gameAspect = { '16:9': 16 / 9, '4:3': 4 / 3, '21:9': 21 / 9 }[q.game];
      $('#gameSel').value = q.game;
    }
    if (q.chrome === '0') document.body.classList.add('no-chrome');

    /* ?overlay=1：OBS 覆盖层（透明背景 + 画布跟随窗口 + 不渲染游戏画面） */
    if (q.overlay === '1') setOverlay(true);

    /* ?local=1：mo_hud 本地覆盖显示窗口（同为 overlay 形态，但无对局数据时
       显示"等待进入对局"占位——OBS 源保持全透明不挡画面，本地窗口要能自证活着） */
    if (q.local === '1') document.body.classList.add('local-window');

    /* 模拟数据下的人数和选项也能深链，便于截图回归 */
    if (q.n && /^[1-4]$/.test(q.n)) {
      state.perTeam = Number(q.n);
      state.mockPerTeam = state.perTeam;
      scenarioSel.value = q.n;
    }
    ['rail', 'queue', 'safe', 'guide', 'gameui'].forEach(function (k) {
      if (q[k] === '0') {
        var el = { rail: railChk, queue: queueChk, safe: safeChk,
                   guide: guideChk, gameui: gameUiChk }[k];
        if (el) el.checked = false;
      }
    });

    if (q.source === 'live') {
      if (q.url) state.liveUrl = q.url;
      sourceSel.value = 'live';
      setSource('live');
    } else {
      relayoutAndRender();
    }
  }

  /* OBS 覆盖层：透明背景、隐藏所有游戏画面、画布跟随窗口 */
  function setOverlay(on) {
    state.overlay = !!on;
    document.documentElement.classList.toggle('overlay-root', state.overlay);
    document.body.classList.toggle('overlay-mode', state.overlay);
    if (state.overlay) {
      document.body.classList.add('no-chrome');
      if (safeChk) safeChk.checked = false;
      if (guideChk) guideChk.checked = false;
      if (gameUiChk) gameUiChk.checked = false;
    }
    state.canvasW = Math.max(320, window.innerWidth);
    state.canvasH = Math.max(240, window.innerHeight);
    relayoutAndRender();
  }

  /* live 轮询：链式 setTimeout，避免请求叠加；间隔跟桥的 500 ms 对齐 */
  function liveLoop() {    if (state.source === 'live') {
      fetchLive().then(function () {
        renderLiveStatus();
        setTimeout(liveLoop, state.livePollMs);
      });
    } else {
      setTimeout(liveLoop, 500);
    }
  }

  /* 闪烁回归指标：live 500 ms 轮询不应销毁任何 <img>；
     若回归到 innerHTML 全量重建，这里会每帧上涨（写进 probe 的 imgRecycled）。 */
  var imgRecycled = 0;
  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var rm = muts[i].removedNodes;
      for (var j = 0; j < rm.length; j++) {
        if (rm[j].nodeName === 'IMG') imgRecycled++;
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  ensureIndexes();
  renderFauxMap();
  relayoutAndRender();
  setPaused(false);
  setSource('mock');
  bootFromQuery();

  /* R10：控制台切换"顶栏左上让位"后重排顶栏——applyLayout 只随数据/窗口尺寸
     触发，body.yield-tl 的增删不在其列，control-bridge 派发本事件补一拍。 */
  window.addEventListener('ctrl-yield', function () { applyLayout(); });

  /* R22：控制台切换「Esc 菜单时隐藏生产队列」后立即重算一次。
     demo.js 在 control-bridge.js 之后加载，开关值由它写在 window.__CTRL_STATE 上。 */
  window.addEventListener('ctrl-queue-hide', function () { renderQueues(); });

  /* R12：控制台改图标覆盖/隐藏配置后重展开 + 全量重渲染一次（事件驱动，
     不新增轮询；渲染路径上的额外成本只有 OVR[id]/HIDDEN[id] 两次查找）。 */
  rebuildUnitCustom();
  window.addEventListener('ctrl-units', function () {
    rebuildUnitCustom();
    relayoutAndRender();
  });

  /* R13 光标指示器：游戏是自绘光标（画在游戏画面里，位于覆盖层之下），
     移到不透明面板上就"消失"。exe 侧 /cursor/sse 推全局光标的覆盖层坐标，
     页内画一枚标记浮在面板之上；OBS 浏览器源同页可见（观赛流也受益）。
     非 exe 模式 404 → CLOSED 后关闭连接，静默降级。 */
  if (window.EventSource) {
    (function () {
      var marker = document.createElement('div');
      marker.className = 'cur-ind';
      document.body.appendChild(marker);
      var hideT = null;
      var es = new EventSource('/cursor/sse');
      es.onmessage = function (e) {
        try {
          var d = JSON.parse(e.data);
          if (!d || d.on === false || typeof d.x !== 'number') {
            marker.style.display = 'none';
            return;
          }
          marker.style.transform = 'translate(' + d.x + 'px,' + d.y + 'px)';
          marker.style.display = 'block';
          clearTimeout(hideT);
          hideT = setTimeout(function () { marker.style.display = 'none'; }, 400);
        } catch (err) { /* 忽略坏帧 */ }
      };
      es.onerror = function () {
        if (es.readyState === EventSource.CLOSED) es.close();
      };
    })();
  }

  setInterval(tick, 1000);
  liveLoop();

  /* probe 需要等 live 首次拉取和布局稳定 */
  setTimeout(writeProbe, 1600);
  setInterval(writeProbe, 1000);
})();
