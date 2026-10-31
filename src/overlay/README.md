# Demo（OBS 覆盖层 / 渲染端）

三种用法，同一套布局代码：

| 用途 | 怎么开 | 需要服务 | 需要游戏 |
|---|---|---|---|
| 看模拟数据 | 双击 `index.html` | 否 | 否 |
| 预览真实数据（带工具栏） | `python serve.py` → `http://127.0.0.1:8770/` → 数据源切「真实」 | 是 | 可选 |
| **OBS 覆盖层** | 双击 `启动覆盖层.bat` → OBS 里加 `http://127.0.0.1:8770/overlay` | 是 | 是 |

## OBS 接入（MVP 验证）

1. 先开游戏进对局（或先开本脚本再开游戏——桥是守护进程，会自己等）。
2. 双击 `启动覆盖层.bat`。它会起数据桥 + 本地服务，并打印地址。
3. OBS → 来源 → `+` → **浏览器**：

   | 项 | 值 |
   |---|---|
   | URL | `http://127.0.0.1:8770/overlay` |
   | 宽 / 高 | 1920 / 1080（与游戏分辨率一致） |
   | FPS | 30 |
   | 关闭源时关闭页面 | 勾选 |
   | 刷新浏览器当场景变为可见 | 勾选 |
   | 自定义 CSS | 留空 |

4. 把浏览器源叠在**游戏采集源之上**。页面背景是全透明的，不需要色键。

地址说明：`/overlay` 会 302 到 `/?overlay=1&source=live&url=/state/out/hud_state.json`，
即"覆盖层 + 真实数据 + 默认桥输出"。要换数据源用完整深链即可。

### 覆盖层模式做了什么

- 页面背景/画布全透明（实测角落 alpha=0），只有 HUD 元素不透明。
- 隐藏所有游戏画面装饰（`.game` / 假地形 / 假小地图 / 对齐框 / 安全区）。
- **不再画任何雷达/小地图**：原版雷达是游戏自己的画面，我们的 HUD 不需要它，
  盖上去只会遮挡真实雷达（2026-10-23 实测确认后移除）。
- 画布跟随浏览器窗口尺寸；OBS 源设成游戏同分辨率时 HUD 正好 1:1。
- 数据停更 > 3 s：HUD 淡到 25% 并在顶部显示「HUD 数据已停止更新」，
  避免把过期人头留在直播间。游戏退出/桥挂了都会触发。
- `ok=false`（未进对局）时 HUD 整体隐藏；状态栏按 `phase` 显示
  「客户端未启动 / 已进大厅，等待开局 / 对局加载中 / 本局已结束」。
- **500 ms 更新不重建 DOM**（R7.13）：顶栏/单位栏/生产队列按 key 增量更新，
  `<img>` 节点永不销毁重建（重建会导致图标重新解码，OBS 里表现为整屏闪烁）。
  probe 的 `imgRecycled` 是回归指标，键控更新下恒为 0。

### 跨局

桥 v6.6 起是守护进程：一局打完不会退出，回到等待态后每 1 s 扫一次
`gamemd.exe`，发现新进程在 2 s 内重挂。页面不用刷新，`applyLiveModel` 会
在菜单间隙保留上一局名单（避免布局闪回 1v1），新一局名单到了自动替换。

> **v6.7 修正**：v6.6 因 `OpenProcess` 少申请 `SYNCHRONIZE`，`WaitForSingleObject`
> 恒返回 `WAIT_FAILED`，"游戏退出"检测不到，守护模式实际不成立——症状是第二局
> 整局 `pid` 不变、`phase=loading`。用 v6.7 及以上版本才能跨局。

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` | 唯一页面；工具栏 + 画布 |
| `demo.js` | 布局、渲染、数据源切换、轮询、停滞检测 |
| `demo.css` | 全部样式（1920×1080 设计坐标） |
| `mock-data.js` | 模拟数据（`window.MOCK`） |
| `live-data.js` | 真实数据适配：`hud_state.json` → Demo 模型（`window.LIVE_DATA`），含 `queues` / `phase` |
| `icons-live.js` | **生成物**，勿手改：`base` 450 个 Type ID → `icons/byid/<ID>.png`（含 172 建筑 + 5 纳米同步变体）+ `alt` 145 AltCameo + `sync` 5 同步配对 |
| `heroes.js` | **生成物**，勿手改：15 个英雄 → `window.HERO_UNITS`（R7.11 口径：`Hero=yes` 14 段 + KRUKOV 补入，AI 专用 AIMORA 排除），单位栏据此优先排序 |
| `serve.py` | 本地只读服务 |
| `渗透科技栏位演示.html` | **设计评审页**（非正式 HUD）：已渗透科技建筑在生产队列栏位里的 6 种可视化方案 A/B/C/D/E/F + 细节台 G。方案 F 已**实装**到 `demo.js`/`demo.css`（见 `05-改动记录与验证.md` R38），本页保留全部变体供对照。方案 F 为「格内直接写阵营名 + 底部两段 pip」，条位于生产格**上方**；实际实现固定 1×4（`2×2` 仅本页可切）。静态规则表取自 MO 3.3.6 INI，队列几何与 `demo.css` 同口径。深链 `?v=A~G&n=2/4/6/8&w=168/126/202/252&cols=2/3&s=mix/none/half/pair/full&fcl=1x4\|2x2&detail=auto\|full\|vet-only&always=0&opt=0`；`?dump=1` 输出全组合实测矩阵（格尺寸 + 各人数内容高余量 + 标签截断诊断） |
| `启动覆盖层.bat` | 一键起桥 + 服务，打印 OBS 地址 |
| `_replay/` | 回放帧 fixtures（`live_frame` / `lobby_frame` / `post_match_frame` / `not_in_match` / `sync_frame[2]` / `hero_frame`）+ `_seq_server.py`（多局时序模拟，验证用） |

## serve.py 路由

```
/                        → Demo/index.html
/overlay                 → 302 到 ?overlay=1&source=live&url=/state/out/hud_state.json
/state/<相对路径>.json    → HUD-字段验证工具包/<相对路径>（只放行 .json/.txt）｜no-store
/icons/<path>            → HUD-字段验证工具包/icons/<path>｜immutable 长缓存
/probe, /probe-error     → POST，落盘 _probe.log / _probe_error.log
其余 Demo 静态文件        → no-cache 每次回源校验（改完 js/css 刷新即生效）
```

常用状态地址：

- `/state/out/hud_state.json` — 桥的实时输出（默认）
- `/state/_runs/20261022_010654/last_state.json` — 某次实测的最后一帧

## 深链参数

```
?source=live              直接进真实模式
&url=/state/out/hud_state.json
&overlay=1                覆盖层模式（透明背景、隐藏游戏画面、画布跟随窗口）
&canvas=1920x1080         画布尺寸（非覆盖层时生效）
&game=16:9                游戏宽高比（有 screen.valid 时自动用真实值）
&chrome=0                 隐藏工具栏与状态栏
&n=1..4                   模拟数据下强制人数
&rail=0&queue=0&safe=0&guide=0&gameui=0   关掉对应图层
&probe=1                  把布局结果 POST 回 /probe 并写进 body[data-probe]
```

## 无游戏预览真实数据长什么样

```
http://127.0.0.1:8770/?source=live&chrome=0&url=/_replay/live_frame.json
```

`_replay/live_frame.json` 是桥 v6.7 `--dry-run` 输出（契约与 v6.6 相同，含 3 条生产队列样例），
`_replay/lobby_frame.json` / `_replay/post_match_frame.json` 是验证 phase 切换用的帧。
因为文件内容不变，3 秒后会进入"数据已停止更新"态——这是预期行为。

要验证**多局连续**（第二局自动恢复），用时序模拟服务：

```
python _replay/_seq_server.py 8799
# 浏览器开 http://127.0.0.1:8799/?source=live&url=/seq.json
```

它按 24 s 循环 match → post_match → lobby → match（换新 pid），用来确认
页面不刷新也能自动恢复。

## 重新生成 icons-live.js / heroes.js

两者都是**生成物**，由工具包脚本全量重写（幂等），不要手改：

```bat
cd SpectatorResearch\notes\reports\HUD-字段验证工具包\_build
python gen_icons_index.py
```

纳米同步配对（`NANO_SYNC`）、英雄口径（`HERO_EXTRA`/`HERO_EXCLUDE`）等常量也都在该脚本里。

## 已知边界

- **`queues` 已接入（v6.6 起，v6.7 改采集路径）**，但只覆盖"主工厂"通道：同一通道开第二座工厂时那条队列看不到
  （引擎侧栏本身也只显示主工厂）。进度由 `Value/54` 换算，与原版进度条可能有 1–2% 取整差异。
  **AI 房目前不产生队列数据**（用户实机两局观察：只有真人玩家的通道有值，AI 房全空），
  这是引擎侧 AI 不走主工厂排队或采集路径未覆盖，待 `--diag-queues` 输出确认后再说。
- **单位栏限高 65%**：左右两列只用到可用高度的 65%，再往下会压住战场。
  超出上限的单位类型折成 `+N` 尾格，不滚动、不溢出（`demo.js` 的 `RAIL_FILL`）。
- **英雄优先**：`heroes.js` 列出 15 个英雄（R7.11 口径），这些单位永远排在单位栏最前
  （金色描边），组内和其余单位按数量降序，同数量按 ID 稳定。
- **建筑图标已补齐**：`byid/` 450 张（273 单位 + 172 建筑 + 5 纳米同步变体），覆盖 172 个可解析建筑。仍有 38 个建筑没有 PCX cameo
  （中立/装饰/围墙/假建筑或只有 SHP 图标），这些走文字回退，与游戏内表现一致。
- **地图区域留白**：真实/覆盖层模式不画任何地形，只画 HUD。游戏画面由 OBS 采集源提供。
  站点也不画单位位置——`unit_types` 只有聚合计数、没有坐标。
- **不画雷达**：`screen.radar_rect` / `radar_view_rect` 仍由桥输出，但本页不渲染。
- **观察者门槛默认关闭**：与 `hud_bridge.c` 的 `#if 0` 一致（测试期要求）。
  勾上后按 `observer.is_observer || observer_mode` 拦截；mock 没有该字段，勾上必然拦截。
- **未接真实对局验证**：队列读取路径全部来自 IDA 静态核验 + `--dry-run`，
  还没对着正在跑的对局端到端验证过真实 `queues` 取值。
  排查时先跑工具包里的 `诊断_生产队列.bat`（等价于 `hud_bridge.exe --diag-queues 6`），
  它会逐环打印 house 主槽、工厂数组、Owner 归属和类型解析。
