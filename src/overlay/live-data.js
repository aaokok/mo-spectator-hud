/* 真实数据适配层：hud_state.json（schema 2）→ Demo 内部模型。
   只做映射，不碰 DOM；渲染仍在 demo.js。

   口径（对应 01-现状与数据契约.md）：
   - power[0]=产出/上限，power[1]=消耗/已用 → Demo 的 {used, cap}
   - unit_types[].veterancy → units[].vet（0 新兵 / 1 老兵 / 2 精英）
   - infiltration.barracks / war_factory → 队列换 AltCameo
   - allies_mask 是 HouseClass.ArrayIndex 位图，互置位才是同盟；team 字段恒 0 不可用
   - is_observer_house 的房不是参赛者，从对阵名单剔除（这不是公平性门槛，
     门槛仍看 observer.is_observer / observer_mode，按测试期要求暂不启用）
*/
(function () {
  'use strict';

  /* 仅用于 tooltip 的显示名；未列出的直接用 ID，不猜。 */
  var FACTION_CN = {
    UnitedStates: '美国',
    Europeans: '欧盟',
    Pacific: '太平洋阵线',
    USSR: '苏联',
    Latin: '拉丁同盟',
    Chinese: '中国',
    PsiCorps: '心灵军团',
    ScorpionCell: '天蝎组织',
    Headquaters: '厄普西隆总部',
    Guild1: '焚风',
    Guild2: '焚风',
    Guild3: '焚风'
  };

  var MODE_CN = { 3: 'LAN', 4: 'Internet', 5: '遭遇战' };

  function rgb2hex(c) {
    if (!c || c.length < 3) return '#92988f';
    function h(n) {
      n = Math.max(0, Math.min(255, Math.round(n)));
      return (n < 16 ? '0' : '') + n.toString(16);
    }
    return '#' + h(c[0]) + h(c[1]) + h(c[2]);
  }

  function displayName(p) {
    var n = (p.uiname || '').trim() || (p.name || '').trim();
    if (!n) n = p.human ? '玩家' : '电脑';
    return n;
  }

  /* 互置位并查集：bit = HouseClass.ArrayIndex */
  function groupTeams(players) {
    var parent = players.map(function (_, i) { return i; });

    function find(i) {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    }
    function union(a, b) {
      a = find(a); b = find(b);
      if (a !== b) parent[b] = a;
    }
    function bit(mask, idx) {
      return idx >= 0 && idx < 32 ? ((mask >>> idx) & 1) : 0;
    }

    for (var i = 0; i < players.length; i++) {
      for (var j = i + 1; j < players.length; j++) {
        var a = players[i], b = players[j];
        if (bit(a.allies_mask, b.index) && bit(b.allies_mask, a.index)) union(i, j);
      }
    }

    var buckets = {};
    players.forEach(function (p, i) {
      var r = find(i);
      (buckets[r] = buckets[r] || []).push(p);
    });

    return Object.keys(buckets).map(function (k) { return buckets[k]; });
  }

  /* Demo 只有左右两列。结盟组多于 2 时（自由混战）按人数降序交替塞进 A/B，
     这是排版兜底，不代表真实阵营——调用方要把 ffa 标记出来。 */
  function packTwoColumns(groups) {
    if (groups.length <= 2) {
      while (groups.length < 2) groups.push([]);
      return { groups: groups, ffa: false };
    }
    groups.sort(function (a, b) { return b.length - a.length; });
    var cols = [[], []], load = [0, 0];
    groups.forEach(function (g) {
      var k = load[0] <= load[1] ? 0 : 1;
      cols[k] = cols[k].concat(g);
      load[k] += g.length;
    });
    return { groups: cols, ffa: true };
  }

  /* bridge v6.6 的 queues：
     {"building":{"id","pct","suspended","next":[...]}, ...}
     只有"该通道有工厂"时才出现键；不出现的通道渲染端画"空闲"。
     老版本桥（v6.5 及以前）完全没有 queues 字段 → 返回 null，渲染端仍画"未接入"。 */
  function toQueues(q) {
    if (!q || typeof q !== 'object') return null;
    var out = {};
    Object.keys(q).forEach(function (key) {
      var v = q[key];
      if (!v || typeof v !== 'object') return;
      out[key] = {
        id: v.id || null,
        pct: Math.max(0, Math.min(100, Number(v.pct) || 0)),
        suspended: !!v.suspended,
        next: Array.isArray(v.next) ? v.next.slice() : []
      };
    });
    return out;
  }

  /* 支援技能（v7.2 桥的 supers[]）。
     drain: ChargeDrainState —— 0=充能中 1=就绪 2=运作中（火风暴/电池类）。
     运作中时 pct 是"剩余运作时间"，从 100 往下走，不是充能进度；
     drain_total 是那次的维持时长（帧），仅用于倒计时秒数换算。
     hidden: SW.ShowCameo=false（AI/剧情用），玩家侧栏本就不显示，默认不画。
     manual 是**类型级**的「需玩家手动起充」标志（Type+0xF5），
     不是"某个玩家能不能发射"，渲染端不要拿它过滤。 */
  function toSupers(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(function (s) {
      if (!s || !s.id) return null;
      var drain = (typeof s.drain === 'number') ? s.drain : -1;
      return {
        id: s.id,
        pct: Math.max(0, Math.min(100, Number(s.pct) || 0)),
        ready: !!s.ready,
        suspended: !!s.suspended,
        total: Number(s.total) || 0,
        left: Number(s.left) || 0,
        drain: drain,
        draining: drain === 2,
        drainTotal: Number(s.drain_total) || 0,
        manual: s.manual !== false,
        hidden: !!s.hidden
      };
    }).filter(Boolean);
  }

  function toPlayer(p, slot) {
    var units = (p.unit_types || []).map(function (u) {
      return {
        id: u.id,
        count: u.count,
        hp: u.hp,
        maxhp: u.maxhp,
        vet: u.veterancy
      };
    });

    return {
      name: displayName(p),
      uiname: p.uiname || '',
      country: p.country || '',
      faction: p.faction || p.country || '',
      factionCN: FACTION_CN[p.faction] || FACTION_CN[p.country] || p.faction || p.country || '',
      color: rgb2hex(p.color),
      cash: p.cash || 0,
      power: p.power || [0, 0, 0],
      kills: p.kills || 0,
      lost: p.lost || 0,
      score: p.score || 0,
      infiltration: p.infiltration || { side0: 0, side1: 0, side2: 0, barracks: 0, war_factory: 0 },
      flags: p.flags || {},
      base: p.base || null,
      owned: p.owned || null,
      human: !!p.human,
      /* R10：战败房从单位栏/生产队列移除。defeated 是持久位（flags.defeated），
         观察者房开局 defeated=1 的怪癖在 toModel 的 is_observer_house 过滤已排除。 */
      defeated: !!(p.flags && p.flags.defeated),
      inControl: !!p.in_control,
      spawn: p.spawn,
      side: p.side,
      aiDiff: p.ai_diff,
      units: units,
      /* v6.6 起桥会输出 queues；没有该字段（老桥或读取失败）时为 null，
         渲染端据此区分"未接入"与"该通道空闲"。 */
      queues: toQueues(p.queues),
      /* v7.2 起桥会输出 supers[]；老桥没有该键 → 空数组，渲染端画"未接入"。 */
      supers: toSupers(p.supers),
      slot: p.slot,
      _slot: slot
    };
  }

  function toModel(d) {
    var all = (d.players || []);
    /* 观察者房不是参赛者：spawn=-1 且被标记，直接剔除 */
    var roster = all.filter(function (p) { return !p.is_observer_house; });

    var groups = groupTeams(roster);
    var packed = packTwoColumns(groups);

    var teams = packed.groups.map(function (g, i) {
      var key = i === 0 ? 'A' : 'B';
      return {
        key: key,
        name: '分队 ' + key,
        players: g.map(function (p, j) {
          var pl = toPlayer(p, j);
          pl._team = key;
          pl._idx = j;
          return pl;
        })
      };
    });

    var perTeam = Math.max(1, Math.min(4,
      Math.max(teams[0].players.length, teams[1].players.length)));

    var name = (d.map_uiname || '').trim() ||
               (d.map || '').trim() ||
               (d.map_file || '').trim() ||
               (d.session_file || '').trim() ||
               '未知地图';

    var modeCn = MODE_CN[d.game_mode] || (d.ok ? ('mode ' + d.game_mode) : '未开局');
    var n = d.players_in_session || 0;

    return {
      live: true,
      ok: !!d.ok,
      phase: d.phase || '',
      clientRunning: !!d.client_running,
      map: name,
      paused: !!d.paused,
      /* v7.0/R22：Esc / 选项菜单。老桥没有这个键 → undefined → 假，行为退回 R11 之前。
         dialogs/owner_draw 是两条信号的原值，只用于排查，渲染端不消费。 */
      menuOpen: !!d.menu_open,
      menu: d.menu || null,
      elapsed: d.elapsed_sec || 0,
      series: null,
      modeLabel: modeCn + (n ? ' · ' + n + ' 人' : ''),
      view: d.view || null,
      screen: d.screen || null,
      observer: d.observer || { is_observer: false, observer_mode: 0 },
      meta: {
        pid: d.pid,
        frame: d.frame,
        schema: d.schema,
        ts: d.ts,
        phase: d.phase || '',
        client_running: !!d.client_running,
        players_in_session: d.players_in_session,
        players_max: d.players_max,
        game_mode: d.game_mode,
        out_of_sync: !!d.out_of_sync,
        uagg_dropped: d.uagg_dropped,
        node_names: d.node_names || [],
        session_file: d.session_file || '',
        map_file: d.map_file || ''
      },
      dropped_observer_houses: all.length - roster.length,
      ffa: packed.ffa,
      perTeam: perTeam,
      teams: teams
    };
  }

  window.LIVE_DATA = {
    toModel: toModel,
    FACTION_CN: FACTION_CN
  };
})();
