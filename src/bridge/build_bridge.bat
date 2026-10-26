@echo off
setlocal enabledelayedexpansion

set "VS_PATH="
if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" (
    for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
        set "VS_PATH=%%i"
    )
)

if defined VS_PATH (
    if exist "!VS_PATH!\VC\Auxiliary\Build\vcvarsall.bat" (
        call "!VS_PATH!\VC\Auxiliary\Build\vcvarsall.bat" x86 >nul
        goto :compile
    )
)

if exist "E:\Microsoft Visual Studio\Community\VC\Auxiliary\Build\vcvarsall.bat" (
    call "E:\Microsoft Visual Studio\Community\VC\Auxiliary\Build\vcvarsall.bat" x86 >nul
    goto :compile
)

if exist "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" (
    call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x86 >nul
    goto :compile
)

:compile
cl /nologo /MT /O2 hud_bridge.c /Fe:hud_bridge.exe /link psapi.lib winmm.lib advapi32.lib user32.lib
