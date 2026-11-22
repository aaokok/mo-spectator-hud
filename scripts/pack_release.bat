@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo   MO Spectator HUD - Release Package Assembler
echo ===================================================

cd /d "%~dp0.."
set "RELEASE_DIR=release"

if not exist "%RELEASE_DIR%" mkdir "%RELEASE_DIR%"
if not exist "%RELEASE_DIR%\out" mkdir "%RELEASE_DIR%\out"

echo.
echo [1/4] Checking binaries...
set "MISSING=0"
if not exist "src\bridge\hud_bridge.exe" (
    echo [!] Missing src\bridge\hud_bridge.exe, please build it first!
    set "MISSING=1"
) else (
    copy /y "src\bridge\hud_bridge.exe" "%RELEASE_DIR%\hud_bridge.exe" >nul
    echo  - Synced hud_bridge.exe
)
if exist "src\bridge\unit_count_rules.default.ini" (
    copy /y "src\bridge\unit_count_rules.default.ini" "%RELEASE_DIR%\unit_count_rules.default.ini" >nul
    echo  - Synced unit_count_rules.default.ini
)

if not exist "src\app\target\release\mo_hud.exe" (
    echo [!] Missing src\app\target\release\mo_hud.exe, please run cargo build --release!
    set "MISSING=1"
) else (
    copy /y "src\app\target\release\mo_hud.exe" "%RELEASE_DIR%\mo_hud.exe" >nul
    echo  - Synced mo_hud.exe
)

echo.
echo [2/4] Cleaning old asset dirs and syncing frontend/console...
if exist "%RELEASE_DIR%\demo" rmdir /s /q "%RELEASE_DIR%\demo"
if exist "%RELEASE_DIR%\hud" rmdir /s /q "%RELEASE_DIR%\hud"
if exist "%RELEASE_DIR%\icons" rmdir /s /q "%RELEASE_DIR%\icons"
if exist "%RELEASE_DIR%\icons_manifest.json" del /f /q "%RELEASE_DIR%\icons_manifest.json"
if exist "%RELEASE_DIR%\heroes.json" del /f /q "%RELEASE_DIR%\heroes.json"

mkdir "%RELEASE_DIR%\demo"
robocopy "src\overlay" "%RELEASE_DIR%\demo" /E /NFL /NDL /NJH /NJS /NC /NS /NP ^
    /XD tests _pcx __pycache__ ^
    /XF *.log *.log.* _probe*.log _panic.log _control.json mo_hud.ini serve.py *.bat README.md *.pcx *.test.cjs
if errorlevel 8 (
    echo [!] Failed to sync src\overlay
    exit /b 1
)
echo  - Synced overlay (src/overlay to release/demo)

mkdir "%RELEASE_DIR%\hud"
robocopy "src\console" "%RELEASE_DIR%\hud" /E /NFL /NDL /NJH /NJS /NC /NS /NP ^
    /XD tests __pycache__ ^
    /XF *.log *.log.* _probe*.log _panic.log _control.json mo_hud.ini README.md
if errorlevel 8 (
    echo [!] Failed to sync src\console
    exit /b 1
)
echo  - Synced web console (src/console to release/hud)

echo.
echo [3/4] Syncing icons...
mkdir "%RELEASE_DIR%\icons"
robocopy "assets\icons" "%RELEASE_DIR%\icons" /E /NFL /NDL /NJH /NJS /NC /NS /NP ^
    /XD _pcx __pycache__ ^
    /XF *.pcx morph_map.json _unique_icons.json _sw_manifest.json *.log *.log.*
if errorlevel 8 (
    echo [!] Failed to sync assets\icons
    exit /b 1
)
echo  - Synced Cameo icons (excluding build leftovers)

echo.
echo [4/4] Ensuring runtime directory...
if not exist "%RELEASE_DIR%\out\.gitkeep" type nul > "%RELEASE_DIR%\out\.gitkeep"
echo  - Ready release/out directory

echo.
echo ===================================================
if "!MISSING!"=="1" (
    echo  Assets packaged, but binary executables are missing!
    echo  Please compile the executables and re-run.
) else (
    echo  [SUCCESS] Portable release package ready!
    echo  You can now run release\mo_hud.exe
)
echo ===================================================
echo.

if not "%1"=="--no-pause" (
    pause
)
exit /b 0
