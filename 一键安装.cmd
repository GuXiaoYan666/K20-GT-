@echo off
setlocal

rem ====================================================================
rem   lyric-hub Installer (1.0.0)
rem   NOTE: NO Chinese chars in this file -- cmd.exe reads as GBK
rem ====================================================================

set "LH_MODE=Install"
if /i "%~1"=="uninstall" set "LH_MODE=Uninstall"

rem ---- 1) Admin check ----
net session >nul 2>&1
if errorlevel 1 goto need_uac

rem ---- 2) Locate install.ps1 ----
set "LH_PS1=%~dp0install.ps1"
if not exist "%LH_PS1%" goto no_ps1

rem ---- 3) Run PowerShell installer ----
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%LH_PS1%" -Mode %LH_MODE%
set "LH_RC=%ERRORLEVEL%"
goto finish

:need_uac
powershell -NoProfile -Command "Start-Process '%~f0' -ArgumentList '%LH_MODE%' -Verb RunAs"
pause
exit /b 0

:no_ps1
echo.
echo [ERROR] install.ps1 not found next to this .cmd
echo Please UNZIP the full package first, then double-click again.
echo.
pause
exit /b 1

:finish
exit /b %LH_RC%
