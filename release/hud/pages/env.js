/* pages/env.js — 运行环境
 * 检测项分组渲染在 control.js（renderEnv）里完成，本页只负责：
 * 进入页面时确保有数据、重检按钮的高亮反馈。
 */
(function () {
'use strict';

const App = window.App;
const $ = window.$;

function init() {
  // 按钮在 HTML 里，事件已在 control.js 绑定；这里只补首次进入的懒加载
}

function onShow() {
  if (!App.envChecks) App.loadEnv(false).catch(() => {});
}

App.registerPage('env', { init, onShow });
})();
