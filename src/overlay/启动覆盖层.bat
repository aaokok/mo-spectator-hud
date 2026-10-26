@echo off
rem ============================================================
rem  MO Spectator HUD · OBS 覆盖层一键启动
rem  1) 起数据桥 hud_bridge.exe（守护模式，常驻）
rem  2) 起 serve.py，把 /state/ 与 /icons/ 暴露给浏览器
rem  3) 打印 OBS 浏览器源地址
rem
rem  数据桥从 v6.6 起是守护进程：先起脚本、后开游戏也可以，
rem  它会自己等客户端/对局，一局打完也不会退出，下一局自动接着出数据。
rem ============================================================
setlocal
cd /d "%~dp0"

set PORT=8770
set BRIDGE=..\..\SpectatorResearch\notes\reports\HUD-字段验证工具包\hud_bridge.exe
set STATE=..\..\SpectatorResearch\notes\reports\HUD-字段验证工具包\out\hud_state.json

if not exist "%BRIDGE%" (
  echo [x] 找不到数据桥：%BRIDGE%
  echo     请先编译 hud_bridge.exe，或检查目录层级。
  pause
  exit /b 1
)

rem 单实例：桥自己也有命名互斥体，这里先查一次只是为了给出更清楚的提示
tasklist /FI "IMAGENAME eq hud_bridge.exe" 2>nul | find /I "hud_bridge.exe" >nul
if not errorlevel 1 (
  echo [!] 已经有一个 hud_bridge.exe 在跑，跳过启动数据桥。
  echo     如果那是旧版本，请先关掉它的窗口再重新运行本脚本。
) else (
  echo [1/3] 启动数据桥（守护模式，只读，500 ms 一帧）...
  start "hud_bridge" "%BRIDGE%" --interval 500 --out "%STATE%" --no-text
)

echo [2/3] 启动本地服务（端口 %PORT%）...
start "hud_serve" cmd /c python serve.py %PORT%

timeout /t 2 >nul

echo [3/3] 完成。
echo.
echo   预览（带工具栏）：  http://127.0.0.1:%PORT%/
echo   OBS 浏览器源：      http://127.0.0.1:%PORT%/overlay
echo.
echo   OBS 浏览器源建议设置：
echo     宽 1920  高 1080  FPS 30
echo     勾选"关闭源时关闭页面"、"刷新浏览器当场景变为可见"
echo     自定义 CSS 留空；背景默认透明，不需要再做色键
echo.
echo   数据桥会一直运行，跨局自动续接；停止请关掉 "hud_bridge" 和 "hud_serve" 两个窗口。
pause
