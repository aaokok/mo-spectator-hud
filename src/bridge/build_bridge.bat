@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x86 >nul
cl /nologo /MT /O2 hud_bridge.c /Fe:hud_bridge.exe /link psapi.lib winmm.lib advapi32.lib
