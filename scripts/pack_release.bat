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

if not exist "src\app\target\release\mo_hud.exe" (
    echo [!] Missing src\app\target\release\mo_hud.exe, please run cargo build --release!
    set "MISSING=1"
) else (
    copy /y "src\app\target\release\mo_hud.exe" "%RELEASE_DIR%\mo_hud.exe" >nul
    echo  - Synced mo_hud.exe
)

echo.
echo [2/4] Syncing frontend and console...
if not exist "%RELEASE_DIR%\demo" mkdir "%RELEASE_DIR%\demo"
xcopy /e /y /q "src\overlay" "%RELEASE_DIR%\demo\" >nul
echo  - Synced overlay (src/overlay to release/demo)

if not exist "%RELEASE_DIR%\hud" mkdir "%RELEASE_DIR%\hud"
xcopy /e /y /q "src\console" "%RELEASE_DIR%\hud\" >nul
echo  - Synced web console (src/console to release/hud)

echo.
echo [3/4] Syncing icons and metadata...
if not exist "%RELEASE_DIR%\icons" mkdir "%RELEASE_DIR%\icons"
xcopy /e /y /q "assets\icons" "%RELEASE_DIR%\icons\" >nul
copy /y "assets\icons_manifest.json" "%RELEASE_DIR%\" >nul
copy /y "assets\heroes.json" "%RELEASE_DIR%\" >nul
echo  - Synced 532 Cameo icons and data dictionaries

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
