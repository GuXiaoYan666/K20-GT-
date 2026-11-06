@echo off
setlocal EnableExtensions
title K20 GT Lyric Engine

rem ---- Log file for debugging ----
set "LOG=%~dp0run.log"

rem ---- cd to script dir ----
cd /d "%~dp0lyric-hub\backend"

rem ---- Locate Node.js ----
set "NODEEXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODEEXE set "NODEEXE=%%i"
if not defined NODEEXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODEEXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODEEXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODEEXE if exist "%TEMP%\lyric-hub-portable-node\node.exe" set "NODEEXE=%TEMP%\lyric-hub-portable-node\node.exe"

rem ---- Auto-download portable Node.js if missing ----
if not defined NODEEXE (
    echo Node.js not found, downloading portable version...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0download-node.ps1"
    if exist "%TEMP%\lyric-hub-portable-node\node.exe" (
        set "NODEEXE=%TEMP%\lyric-hub-portable-node\node.exe"
        echo Portable Node.js ready.
    )
)

rem ---- Final check ----
if not defined NODEEXE (
    echo.
    echo ================================================================
    echo   ERROR: Node.js not found!
    echo   Please install from https://nodejs.org/ or run as admin
    echo ================================================================
    echo.
    pause
    exit /b 1
)

if not exist "%NODEEXE%" (
    echo.
    echo ================================================================
    echo   ERROR: Node.js not found at "%NODEEXE%"
    echo ================================================================
    echo.
    pause
    exit /b 1
)

echo.
echo ================================================================
echo   K20 GT Lyric Engine - Standalone Mode
echo   Node.js: %NODEEXE%
echo   Web UI:  http://127.0.0.1:8720
echo   Close this window to stop
echo ================================================================
echo.

echo [%date% %time%] Starting lyric-hub/backend/server.js with Node.js at %NODEEXE% >> "%LOG%"
"%NODEEXE%" server.js
echo [%date% %time%] Server exited with code %ERRORLEVEL% >> "%LOG%"

echo.
echo Server stopped.
echo Log: %LOG%
echo.
pause
