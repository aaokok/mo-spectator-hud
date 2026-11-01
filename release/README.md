# Release 运行与部署目录

> [!TIP]
> 本目录为绿色便携免安装运行环境。可直接从 GitHub Releases 下载解压获得，或通过根目录运行 pack.bat 一键自动打包生成。

---

## 🛠️ 编译发布版

1. **编译数据桥 (`hud_bridge.exe`)**：
   - 进入 `src/bridge/` 目录运行批处理：
     ```cmd
     build_bridge.bat
     ```
   - 编译产物位于 `src/bridge/hud_bridge.exe`。

2. **编译客户端正式版 (`mo_hud.exe`)**：
   - 进入 `src/app/` 目录执行 Release 构建：
     ```cmd
     cargo build --release
     ```
   - 编译产物位于 `src/app/target/release/mo_hud.exe`。

---

## 📦 本地便携包组装规范

完成编译后，可在仓库根目录下运行 `pack.bat` 一键自动打包同步，或按照以下结构手动组装：

```text
release/
├── mo_hud.exe              # Tauri 2 客户端主程序
├── hud_bridge.exe          # 底层数据读取桥 (Win32 C 原生进程)
├── demo/                   # 渲染核前端 (复制自 src/overlay/)
├── hud/                    # 管理控制台 (复制自 src/console/)
├── icons/                  # Cameo 图标库 (复制自 assets/icons/)
├── icons_manifest.json     # 图标映射字典 (复制自 assets/icons_manifest.json)
├── heroes.json             # 英雄数据字典 (复制自 assets/heroes.json)
└── out/                    # 运行时动态数据输出目录 (新建空文件夹)
```

组装完成后，双击 `mo_hud.exe` 即可直接一键启动全部服务。
