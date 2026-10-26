# MO Spectator HUD · 心灵终结 3.3.6 观战 HUD 插件

[![Platform](https://img.shields.io/badge/Platform-Windows-blue.svg)](https://github.com)
[![Game](https://img.shields.io/badge/Game-Mental%20Omega%203.3.6-red.svg)](https://mentalomega.com)
[![Framework](https://img.shields.io/badge/Client-Tauri%202-brightgreen.svg)](https://tauri.app)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**前言** 本人纯属业余研究，本项目使用了大量AI辅助创建。可读性、可维护性可能较差。

**MO Spectator HUD** 是专为《命令与征服：尤里的复仇》大型 Mod《心灵终结 3.3.6 (Mental Omega 3.3.6)》打造的现代化观战实时浮层系统。系统采用**“底层只读数据桥 + 统一渲染核心 + 双外壳（桌面透明浮层 / OBS 浏览器源）”**的高内聚架构，为直播、解说提供赛事实时数据透视与 UI 渲染。
---

##  基本功能(控制台可调节)

-  **自适应赛事顶栏**：根据对局规模（1v1 ~ 3v3）自适应调整紧凑度。清晰展示玩家阵营旗帜、ID、电力状态（消耗/上限对比，超载高亮告警）、资金余额与自定义比分看板。
-  **智能侧栏与生产队列**：
  - 两侧悬浮展示各玩家存活战斗单位与防御设施实时统计；
  - 生产队列紧密对齐小地图宽度，实时展示正在建造的单位与进度；
  - 英雄光效与渗透科技变体图标自动切换。
-  **双形态展示与零第二套渲染器**：
  - **桌面覆盖层**：基于 Tauri 2 + Rust，原生支持透明穿透、窗口置顶并跟随游戏窗口贴位；
  - **OBS 直播推流**：内置 Axum 本地 Web 服务，直接提供 `/overlay` 地址给 OBS 浏览器源。
- 🎛️ **实时 Web 管理控制台**：一键切换 1v1~3v3 布局、动态配置比赛名与局分、单位栏开关、阵营/单位过滤规则及自动化环境自检。
- 🛡️ **安全只读与轻量化**：底层数据桥仅对游戏进程做只读（`ReadProcessMemory`）快照采集，Windows Job Object 进程树看护，不修改游戏内存或注入钩子，游戏退出即自动析构。

---

##  架构设计

```mermaid
flowchart TD
    subgraph GameLayer["游戏底层"]
        Game["游戏主程序 (gamemd.exe)"]
    end

    subgraph BridgeLayer["数据桥 (Data Bridge)"]
        Bridge["hud_bridge.exe (Win32 C)"]
        StateOut["out/hud_state.json (500ms 原子写入)"]
    end

    subgraph HostLayer["桌面宿主 (mo_hud.exe / Tauri 2)"]
        JobGuard["Win32 Job Object 进程托管"]
        Axum["内嵌 Axum Web 服务器 (端口 8770)"]
        Follower["Win32 窗口枚举与跟随贴位线程"]
        ControlPage["Web 管理控制台 (/control)"]
        OverlayWin["透明穿透浮层窗口 (/overlay)"]
    end

    subgraph StreamLayer["导播层"]
        OBS["OBS Studio (浏览器源)"]
    end

    Game -->|只读内存采集| Bridge
    JobGuard -.->|生命周期管理与守护| Bridge
    Bridge --> StateOut
    StateOut --> Axum
    Axum --> OverlayWin
    Axum --> ControlPage
    Axum -.->|局域网/本机拉流| OBS
    Follower -.->|锁定屏幕坐标| OverlayWin
```

---

##  源码构建与组装指南

由于本仓库不提供二进制成品，使用前请先自行编译底层桥与客户端外壳：

### 1. 编译底层数据桥 (`hud_bridge.exe`)
- **环境需求**：Visual Studio（包含 C++ 桌面开发工作负载，x86 模式）。
- 进入 `src/bridge/` 目录，执行构建批处理：
  ```cmd
  build_bridge.bat
  ```
  编译完成后，将在该目录下生成 `hud_bridge.exe`。

### 2. 编译桌面客户端外壳 (`mo_hud.exe`)
- **环境需求**：安装 Rust 工具链（`rustc`、`cargo`）及 Windows 10/11 系统自带的 WebView2。
- 进入 `src/app/` 目录，执行 Release 模式构建：
  ```cmd
  cargo build --release
  ```
  编译产物位于 `src/app/target/release/mo_hud.exe`。

### 3. 组装便携 Release 包
为了拥有开箱即用的独立运行环境，建议将产物组装至 `release/` 目录（详见 [`release/README.md`](release/README.md)）：
1. 将 `src/bridge/hud_bridge.exe` 复制到 `release/`；
2. 将 `src/app/target/release/mo_hud.exe` 复制到 `release/`；
3. 将 `src/overlay/` 整体复制并命名为 `release/demo/`；
4. 将 `src/console/` 整体复制并命名为 `release/hud/`；
5. 将 `assets/icons/` 整体复制到 `release/icons/`；
6. 将 `assets/icons_manifest.json` 与 `assets/heroes.json` 复制到 `release/`；
7. 在 `release/` 下创建空的 `out/` 文件夹。

---

##  运行与使用

组装好 Release 包后，即可按以下方式使用：

### 方案 1：桌面客户端一键启动（推荐）
1. 启动游戏《心灵终结 3.3.6》并进入对局；
2. 双击运行 `release/mo_hud.exe`；
3. 程序将自动拉起数据桥子进程、启动本地服务，并在游戏画面上方浮现透明 HUD 覆盖层；
4. 同时会自动弹出 Web 控制台窗口，可随时修改比赛名、局分或排查环境；
5. 游戏一定要使用窗口化或者无边框窗口化，否则覆盖层无法置顶显示。 

### 方案 2：OBS 直播导播推流
1. 运行客户端启动服务（或运行 `src/overlay/serve.py`）；
2. 在 OBS 来源面板中添加 **「浏览器」 (Browser Source)**；
3. 参数配置：
   - **URL**：`http://127.0.0.1:8770/overlay`
   - **宽度**：`1920` / **高度**：`1080`（建议与游戏主分辨率一致）
   - **帧率**：`30` 或 `60`
4. 背景天然全透明，无需添加色键滤镜即可完美叠放在游戏画面上。

### 方案 3：开发者调试运行
开发者无需组装 Release 目录，直接在 `src/app/` 下运行：
```cmd
cargo run
```
内置路径解析机制会自动向上索引 `src/overlay/` 与 `assets/` 资源目录。

---

## 📂 目录结构说明

```text
mo-spectator-hud/
├── .gitignore               # 排除构建缓存、动态运行日志与私有配置
├── README.md                # 统一项目说明文档
├── LICENSE                  # MIT 开源协议
│
├── src/                     # 源代码目录
│   ├── bridge/              # 底层只读数据桥 (Win32 C 原生实现)
│   │   ├── hud_bridge.c     # 内存字段采集与状态序列化
│   │   ├── build_bridge.bat # MSVC x86 快速构建脚本
│   │   └── README.md
│   │
│   ├── app/                 # 桌面客户端外壳 (Tauri 2 + Rust)
│   │   ├── Cargo.toml       # Rust 依赖声明
│   │   ├── tauri.conf.json  # Tauri 窗口属性与静态资源映射
│   │   └── src/             # Axum 服务、窗口跟随、托盘与 Job 托管
│   │
│   ├── overlay/             # HUD 浮层渲染核心 (HTML / CSS / JS)
│   │   ├── index.html       # 唯一渲染核主入口
│   │   ├── demo.js          # UI 渲染驱动与数据更新通道
│   │   ├── live-data.js     # 数据适配层 (hud_state.json → 视图模型)
│   │   ├── serve.py         # 独立轻量 HTTP 桥接服务器
│   │   └── assets/          # 旗帜图与公共特效资产
│   │
│   └── console/             # Web 控制台管理面板
│       ├── control.html     # 观战员控制台前端
│       └── pages/           # 概览、显示、单位过滤与日志模块
│
├── assets/                  # 共享静态资源
│   ├── icons/               # 532 张单位 Cameo 图标 (含 byid/ 索引)
│   ├── icons_manifest.json  # 图标元数据映射表
│   └── heroes.json          # 英雄单位口径与特效映射
│
└── release/                 # 便携发布与部署目录（供用户放置自行编译产物）
    ├── README.md            # 便携包组装规范指引
    └── .gitkeep             # 目录占位保持
```

---

##  免责声明

1. 本项目仅供《心灵终结 3.3.6》赛事观战、解说录播与对局复盘使用。
2. 数据桥采用只读方式读取公共对局状态，请勿将其用于非法用途或破坏游戏公平竞争环境。
3. 《心灵终结》(Mental Omega) 相关美术与游戏资产版权归属原制作组所有。

---

##  开源许可证

本项目采用 [MIT 许可证](LICENSE) 授权。
