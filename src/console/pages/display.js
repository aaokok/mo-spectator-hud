/* pages/display.js — 直播画面
 * 左：画面模块 + 顶栏文案 + 顶栏布局
 * 右：覆盖窗口（仅本地）+ 热键 + 影响范围说明
 */
(function () {
'use strict';

const App = window.App;
const $ = window.$;

const MODULES = [
  {
    key: 'show_score', label: '比分 / 比赛名',
    descOn: '顶栏中央的局分与赛事名', descOff: '关闭后顶栏中央留空，左右分队布局不变',
  },
  {
    key: 'show_units', label: '单位栏',
    descOn: '左右两侧的玩家单位图标与数量', descOff: '关闭后左右两侧留空，游戏画面完整露出',
  },
  {
    key: 'show_queues', label: '生产队列',
    descOn: '右侧建造栏区域的 6 条生产通道', descOff: '关闭后右侧建造栏恢复游戏原样',
  },
  {
    key: 'show_supers', label: '支援技能栏',
    /* 只有 1v1 才插技能，所以两条副标题都把这句写进去，
       避免用户在 3v3 里开了没反应以为开关坏了 */
    descOn: '单位格下方显示支援技能，1v1 面板同时放宽为两列（仅 1v1 生效）',
    descOff: '不显示支援技能，1v1 维持单列窄栏（默认关，仅 1v1 生效）',
  },
  {
    key: 'hide_queue_on_menu', label: 'Esc 菜单时隐藏队列',
    descOn: '按 Esc 打开选项 / 退出菜单时自动收起队列列，回到游戏即恢复',
    descOff: '菜单打开时队列继续盖在建造栏上',
  },
  {
    key: 'show_wait_hint', label: '等待对局提示',
    descOn: '还没进入对局时显示「等待进入对局…」占位文字',
    descOff: '未进入对局时画面留空，不显示任何提示',
  },
  {
    key: 'observer_gate', label: '观察者门槛',
    descOn: '仅在观察者视角渲染 HUD', descOff: '关闭后非观察者对局也会渲染（默认关）',
  },
];

const LAYOUT = [
  {
    key: 'yield_top_left', label: '顶栏左上让位',
    descOn: '左上角留出竖条，游戏超武 / 事件文字可透出',
    descOff: '关闭后左上角被顶栏盖住，游戏事件文字不可见',
  },
];

const OVERLAY = [
  {
    key: 'topmost', label: '置顶显示', scope: 'local',
    descOn: '覆盖层始终显示在其他窗口之上',
    descOff: '关闭后，切到浏览器 / OBS 时 HUD 会被其他窗口盖住',
    via: 'overlay',
  },
  {
    key: 'auto_hide_on_blur', label: '游戏失焦时自动隐藏', scope: 'local',
    descOn: '切出游戏或最小化时自动隐藏，回到游戏即恢复',
    descOff: '关闭后切出游戏仍浮在桌面最上层，可能挡住其他软件',
    via: 'ctrl',
    defaultValue: true,
  },
  {
    key: 'cursor_indicator', label: '鼠标指针指示器', scope: 'sync',
    descOn: '面板遮挡游戏光标时，在覆盖层上补画指针位置',
    descOff: '指针移到不透明面板上时不可见',
    via: 'ctrl',
    defaultValue: true,
  },
  {
    key: 'cursor_only_when_covered', label: '仅在遮挡时显示指针', scope: 'sync',
    descOn: '只有指针压到 HUD 面板上才画指示器，游戏画面内完全不出现',
    descOff: '游戏在前台就常亮指示器（旧行为），画面内也会跟一个圈',
    via: 'ctrl',
    defaultValue: true,
  },
];

let moduleRows = [];
let layoutRows = [];

function init() {
  const mHost = $('moduleToggles');
  mHost.innerHTML = '';
  moduleRows = MODULES.map(o => {
    const row = App.ToggleRow({
      ...o,
      scope: 'sync',
      defaultValue: o.key !== 'observer_gate',
      onChange: updateModuleFlag,
    });
    mHost.appendChild(row);
    return row;
  });

  const lHost = $('layoutToggles');
  lHost.innerHTML = '';
  layoutRows = LAYOUT.map(o => {
    const row = App.ToggleRow({
      ...o,
      scope: 'sync',
      defaultValue: true,
      onChange: updateLayoutFlag,
    });
    lHost.appendChild(row);
    return row;
  });

  const oHost = $('overlayToggles');
  oHost.innerHTML = '';
  for (const o of OVERLAY) {
    oHost.appendChild(App.ToggleRow({
      ...o,
      scope: o.scope || 'local',
      defaultValue: o.defaultValue,
      get: () => o.via === 'overlay'
        ? !!(App.status && App.status.overlay.topmost)
        : !!(App.ctrl && App.ctrl[o.key]),
      set: async v => {
        if (o.via === 'overlay') {
          // 置顶走 /app/overlay：会同时写 ini 并立刻应用到窗口
          await App.setOverlay({ topmost: v });
        } else {
          await App.postControl({ [o.key]: v ? '1' : '0' });
        }
      },
      onChange: () => {
        if (App.status) App.renderOverlayPills(App.status);
        if (App.pages.overview && App.pages.overview.onCtrl) App.pages.overview.onCtrl();
      },
    }));
  }
}

function updateModuleFlag() {
  const n = moduleRows.filter(r => r._isMod()).length;
  const f = $('modModules');
  f.classList.toggle('show', n > 0);
  $('modModulesTxt').textContent = `${n} 项已修改`;
}

function updateLayoutFlag() {
  const n = layoutRows.filter(r => r._isMod()).length;
  const f = $('modLayout');
  f.classList.toggle('show', n > 0);
  $('modLayoutTxt').textContent = `${n} 项已修改`;
}

function onCtrl() {
  updateModuleFlag();
  updateLayoutFlag();
}

App.registerPage('display', {
  init,
  onCtrl,
  onStatus: () => updateModuleFlag(),
  onShow: () => { updateModuleFlag(); updateLayoutFlag(); },
});
})();
