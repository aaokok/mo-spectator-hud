/* control-bridge.js — mo_hud.exe 控制台桥(2026-10-25,契约见 exe_New/00-技术栈与架构.md §2)
 *
 * 轮询内嵌服务的 /control/state,把控制状态应用到:
 *   - 工具栏 checkbox(单位栏/生产队列/观察者门槛)——渲染函数直接读这些
 *     checkbox,赋值即在下一次渲染生效,零新增渲染逻辑;
 *   - 顶栏比分/比赛名块显隐(hud.no-score);
 *   - 数据模型覆盖(window.__ctrlPatch,demo.js 的 activeModel 出口调用):
 *     match_name 非空时覆盖比赛名与局分(live 数据里 bridge 本就不输出这两项)。
 *
 * 无 mo_hud.exe(file:// 直开、老版 serve.py)时 fetch 静默失败,一切保持现状,
 * 不影响 OBS 场景。
 */
(function () {
  var CTRL = null;
  var lastCustom = null;

  /* R12 单位自定义：/control 的三个 JSON 串 + 计数口径 + R13 优先顺序解析成
     __UNIT_CUSTOM，内容有变化才派发 ctrl-units（demo.js 展开成 OVR/HIDDEN/PRIO
     后全量重渲染一次）。解析失败（非法 JSON）静默忽略，保持上一份生效配置。 */
  function applyUnitCustom() {
    var ovr = null, hid = null, tags = null, prio = null;
    try { ovr = CTRL.unit_icon_overrides ? JSON.parse(CTRL.unit_icon_overrides) : null; } catch (e) {}
    try { hid = CTRL.hidden_units ? JSON.parse(CTRL.hidden_units) : null; } catch (e) {}
    try { tags = CTRL.hidden_tags ? JSON.parse(CTRL.hidden_tags) : null; } catch (e) {}
    try { prio = CTRL.unit_priority ? JSON.parse(CTRL.unit_priority) : null; } catch (e) {}
    if (Array.isArray(prio) && !prio.length) prio = null;
    var mode = CTRL.hidden_count_mode === 'drop' ? 'drop' : '';
    var cur = JSON.stringify([ovr, hid, tags, mode, prio]);
    if (cur === lastCustom) return;
    lastCustom = cur;
    window.__UNIT_CUSTOM = (ovr || hid || tags || mode || prio)
      ? { ovr: ovr || null, hid: hid || null, tags: tags || null, mode: mode, prio: prio || null }
      : null;
    try { window.dispatchEvent(new CustomEvent('ctrl-units')); } catch (e) {}
  }

  function apply() {
    if (!CTRL) return;
    var railChk = document.getElementById('railChk');
    var queueChk = document.getElementById('queueChk');
    var gateChk = document.getElementById('gateChk');
    var queueColumn = document.getElementById('queueColumn');
    var hud = document.getElementById('hud');

    if (railChk && railChk.checked !== CTRL.show_units) railChk.checked = CTRL.show_units;
    if (gateChk && gateChk.checked !== CTRL.observer_gate) gateChk.checked = CTRL.observer_gate;
    if (queueChk && queueChk.checked !== CTRL.show_queues) {
      queueChk.checked = CTRL.show_queues;
      /* 与 demo.js 工具栏 queueChk 的 change 处理保持同一行为 */
      if (queueColumn) queueColumn.classList.toggle('hidden', !CTRL.show_queues);
    }
    /* 比分块:保占位隐藏,顶栏左右分队布局不跳动 */
    if (hud) hud.classList.toggle('no-score', !CTRL.show_score);
    /* R22：未进入对局时在本地窗口/预览里显示「等待进入对局…」提示。
       键缺省视为开（老控制台不传该键时保持原有观感）。
       覆盖层的透明压制另由 overlay-mode 规则处理，与这个开关无关。 */
    var waitHint = CTRL.show_wait_hint !== false;
    document.body.classList.toggle('no-wait-hint', !waitHint);
    /* R22：Esc/选项菜单自动隐藏队列列的开关。渲染时由 demo.js 的 renderQueues
       读取（菜单是否开着只有那一侧知道），这里只负责写入 + 触发一次重渲染。
       非 boolean（老控制台不传该键）→ 开，与默认值一致。 */
    var hideOnMenu = CTRL.hide_queue_on_menu !== false;
    var changed = !window.__CTRL_STATE || window.__CTRL_STATE.hide_queue_on_menu !== hideOnMenu;
    window.__CTRL_STATE = { hide_queue_on_menu: hideOnMenu };
    if (changed) {
      try { window.dispatchEvent(new CustomEvent('ctrl-queue-hide')); } catch (e) {}
    }
    /* R10 顶栏左上让位:游戏自己的事件/超武文字从让出的竖条透出
       (demo.js 按 body.yield-tl 让位;键缺省视为开,与控制台默认一致)。
       状态翻转时派发事件让 demo.js 立即重排顶栏。 */
    var yOn = CTRL.yield_top_left !== false;
    var had = document.body.classList.contains('yield-tl');
    document.body.classList.toggle('yield-tl', yOn);
    if (yOn !== had) {
      try { window.dispatchEvent(new CustomEvent('ctrl-yield')); } catch (e) {}
    }
    applyUnitCustom();
  }

  window.__ctrlPatch = function (m) {
    if (!CTRL || !m) return m;
    if (CTRL.match_name) {
      m.map = CTRL.match_name;
      m.series = { A: CTRL.score_l, B: CTRL.score_r };
    }
    /* R11：模式标签覆盖（LAN/遭遇战/自定义文案）；空 = 用桥数据原值 */
    if (CTRL.mode_label) m.modeLabel = CTRL.mode_label;
    return m;
  };

  function poll() {
    fetch('/control/state')
      .then(function (r) { return r.json(); })
      .then(function (j) { CTRL = j; apply(); })
      .catch(function () { /* file:// 或无 mo_hud:静默,保持现状 */ });
  }

  poll();
  setInterval(poll, 1500);
})();
