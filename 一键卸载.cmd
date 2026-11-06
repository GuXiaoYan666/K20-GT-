@echo off
setlocal

net session >nul 2>&1
if errorlevel 1 (
    powershell -NoProfile -Command "Start-Process '%~f0' -ArgumentList 'uninstall' -Verb RunAs"
    pause
    exit /b 0
)

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Mode Uninstall
exit /b %ERRORLEVEL%
