/* pages/logs.js — 运行日志
 * 独占整页、单层滚动、级别过滤、搜索、滚离底部自动暂停跟随。
 */
(function () {
'use strict';

const App = window.App;
const $ = window.$;

let allLines = [];      // 原始日志
let lastSeq = -1;       // 服务端单调递增日志序号（满 500 行仍可准确检测新日志）
let lastSig = '';       // 数据内容签名，无变化跳过 innerHTML 重建（不打断选中文字）
let level = '';
let query = '';
let manualPause = false;
let autoPaused = false;

/** 按关键词给日志分级（服务端暂无 level 字段） */
function classify(line) {
  const s = line.toLowerCase();
  if (/失败|错误|异常|error|fail|panic|cannot|无法|崩溃/.test(s)) return 'err';
  if (/警告|warn|退避|重试|外部实例|占用|已暂停|失焦/.test(s)) return 'warn';
  return 'info';
}

function lvLabel(l) {
  return l === 'err' ? 'ERROR' : l === 'warn' ? 'WARN' : 'INFO';
}

/** 拆出时间戳与正文："[12:41:03] 覆盖窗口显隐 -> true" */
function splitLine(line) {
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
  return m ? { ts: m[1], msg: m[2] } : { ts: '', msg: line };
}

function visible() {
  const q = query.toLowerCase();
  return allLines.filter(line => {
    if (level && classify(line) !== level) return false;
    if (q && !line.toLowerCase().includes(q)) return false;
    return true;
  });
}

function render() {
  const box = $('logbox');
  const list = visible();
  if (!list.length) {
    box.innerHTML = `<div style="padding:16px 14px;color:#4f5d6b;font-size:12px">
      ${allLines.length ? '没有匹配的日志' : '（暂无日志）'}</div>`;
    updateFoot(list);
    return;
  }
  box.innerHTML = list.map(line => {
    const lv = classify(line);
    const { ts, msg } = splitLine(line);
    return `<div class="ln ${lv}">
      <span class="ts">${App.esc(ts)}</span>
      <span class="lv">${lvLabel(lv)}</span>
      <span class="msg">${App.esc(msg)}</span>
    </div>`;
  }).join('');
  updateFoot(list);
}

function updateFoot(list) {
  $('logFootTxt').textContent = manualPause || autoPaused
    ? '已暂停跟随 · 点「恢复跟随」回到最新'
    : `显示 ${list.length} / ${allLines.length} 条 · 滚离底部自动暂停`;
}

function nearBottom() {
  const box = $('logbox');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 24;
}

function scrollBottom() {
  const box = $('logbox');
  box.scrollTop = box.scrollHeight;
}

function setPaused(paused, auto) {
  if (auto) autoPaused = paused;
  else manualPause = paused;
  const btn = $('btnPauseFollow');
  const isPaused = manualPause || autoPaused;
  btn.textContent = isPaused ? '恢复跟随' : '暂停跟随';
  btn.classList.toggle('primary', isPaused);
  updateFoot(visible());
}

function setUnread(show) {
  const pill = $('logNew');
  if (pill) pill.classList.toggle('show', !!show);
}

/** 主控每 2 秒调用（仅在日志页可见时触发） */
function setLines(lines, seq) {
  const next = lines || [];
  const nextTail = next.length ? next[next.length - 1] : '';
  const sig = `${typeof seq === 'number' ? seq : 'x'}|${next.length}|${nextTail}`;
  if (sig === lastSig) return;

  const isFirst = lastSig === '';
  const prevCount = allLines.length;
  const prevTail = prevCount ? allLines[prevCount - 1] : '';
  const grew = typeof seq === 'number' && lastSeq >= 0
    ? seq > lastSeq
    : (next.length > prevCount || (next.length > 0 && nextTail !== prevTail));

  lastSig = sig;
  if (typeof seq === 'number') lastSeq = seq;
  allLines = next;

  const box = $('logbox');
  const prevScrollTop = box ? box.scrollTop : 0;
  const atBottom = nearBottom();
  render();
  if (isFirst || (grew && !manualPause && atBottom)) {
    scrollBottom();
    autoPaused = false;
    setPaused(false, true);
    setUnread(false);
  } else {
    if (box) box.scrollTop = prevScrollTop;
    if (grew && (manualPause || !atBottom)) {
      if (!manualPause) setPaused(true, true);
      setUnread(true);
    }
  }
}

function init() {
  const seg = $('lvlSeg');
  seg.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      level = b.dataset.lvl;
      render();
    };
  });

  let t = null;
  $('logSearch').oninput = e => {
    query = e.target.value.trim();
    clearTimeout(t);
    t = setTimeout(render, 140);
  };

  $('btnPauseFollow').onclick = () => {
    const next = !(manualPause || autoPaused);
    if (next) setPaused(true, false);
    else {
      manualPause = false;
      autoPaused = false;
      setPaused(false, false);
      setUnread(false);
      scrollBottom();
    }
  };

  // 滚离底部自动暂停；回到底部自动恢复并收起「新日志」提示
  $('logbox').addEventListener('scroll', () => {
    const atBottom = nearBottom();
    if (atBottom) setUnread(false);
    if (manualPause) return;
    if (!atBottom && !autoPaused) setPaused(true, true);
    else if (atBottom && autoPaused) setPaused(false, true);
  }, { passive: true });

  $('btnLogCopy').onclick = () => {
    App.copyText(visible().join('\n'), `已复制 ${visible().length} 行日志`);
  };

  $('logNew').onclick = () => {
    manualPause = false;
    autoPaused = false;
    setPaused(false, false);
    setUnread(false);
    scrollBottom();
  };
}

App.registerPage('logs', {
  init,
  setLines,
  onShow: () => {
    if (App.refreshLog) App.refreshLog();
  },
});
})();
