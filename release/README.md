# Release 运行与部署目录

>  **本仓库未提供编译版本，如需要请自行编译**。

可按照根目录 [README.md](../README.md) 的指引完成源码编译后，将编译产物与资源组装至本目录，即可享受完全独立的便携免安装运行环境。

---

## 📦 本地便携包组装规范

```text
release/
├── mo_hud.exe              # 自行编译的 Tauri 2 主程序 (来自 src/app/target/release/)
├── hud_bridge.exe          # 自行编译的数据读取桥 (来自 src/bridge/)
├── demo/                   # 渲染核前端 (复制自 src/overlay/)
├── hud/                    # 管理控制台 (复制自 src/console/)
├── icons/                  # Cameo 图标库 (复制自 assets/icons/)
├── icons_manifest.json     # 图标映射字典 (复制自 assets/icons_manifest.json)
├── heroes.json             # 英雄数据字典 (复制自 assets/heroes.json)
└── out/                    # 运行时动态数据输出目录 (新建空文件夹)
```

组装完成后，双击 `mo_hud.exe` 即可直接一键启动全部服务。
