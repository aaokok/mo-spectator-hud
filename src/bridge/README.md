# Data Bridge (`hud_bridge`)

数据桥是 MO Spectator HUD 的底层对局数据提取程序。

## 功能概述
- 通过 Win32 API 以只读（ReadProcessMemory）方式对接《心灵终结 3.3.6》游戏主进程 `gamemd.exe`。
- 提取当前比赛计时、地图、玩家阵营、实时电力（产出/消耗）、实时资金、存活单位统计、超级武器倒计时、建造中生产队列等核心数据。
- 默认采用原子写入方式每 500ms 将数据快照输出到 `out/hud_state.json`。

## 编译方法
需安装 MSVC 工具链（Visual Studio Build Tools x86）。
直接在当前目录运行：
```cmd
build_bridge.bat
```
或执行：
```cmd
cl /nologo /MT /O2 hud_bridge.c /Fe:hud_bridge.exe /link psapi.lib winmm.lib advapi32.lib
```
编译产物 `hud_bridge.exe` 配合 `icons/` 资源即可独立运行或由 `mo_hud.exe` 自动托管。
