@echo off
rem ==========================================================================
rem  Trae cloud check-in - one-click GitHub deploy launcher
rem  All Chinese text is printed by Node.js to avoid cmd.exe encoding issues.
rem ==========================================================================
setlocal
chcp 65001 >nul
title Trae Cloud Deploy

set "ROOT=%~dp0"
rem Prefer the Node.js bundled in the portable package; fall back to PATH.
set "NODE=%ROOT%runtime\node.exe"
if not exist "%NODE%" set "NODE=node"

"%NODE%" "%ROOT%deploy\deploy.js"

echo.
pause
endlocal
