@echo off
rem ============================================================
rem  Trae Work daily check-in - Windows one-click launcher
rem  - Double-click: run multi-account check-in (scripts\checkin-all.js)
rem  - Argument /s : silent mode, no pause at the end (for Task Scheduler)
rem  - Retries up to 3 times with a 20s wait when the script fails
rem  - Appends the output of every run to checkin.log in this folder
rem  Prerequisite: Node.js installed and "node" available on PATH
rem  Note: comments stay in English on purpose - cmd.exe mis-parses
rem        non-ANSI (UTF-8) Chinese characters in batch files.
rem ============================================================

chcp 65001 >nul
rem setlocal keeps variables local to this script; /d also switches drive
setlocal
cd /d "%~dp0"

rem LOG = persistent log file; OUT = temp file capturing one node run
set "LOG=%~dp0checkin.log"
set "OUT=%TEMP%\trae-checkin.out"
rem Interactive mode by default; /s (case-insensitive) enables silent mode
set SILENT=0
if /i "%~1"=="/s" set SILENT=1

rem TRIES counts attempts; :retry is the loop entry label
set TRIES=0
:retry
set /a TRIES+=1
rem Run batch check-in; redirect stdout and stderr together into OUT
node "%~dp0scripts\checkin-all.js" > "%OUT%" 2>&1
rem Save exit code immediately (0 = all accounts ok, 1 = some failed)
set RC=%ERRORLEVEL%

rem Show output in console and append timestamp + code + output to the log
type "%OUT%"
echo. >> "%LOG%"
echo [%date% %time%] run #%TRIES%, exit code %RC% >> "%LOG%"
type "%OUT%" >> "%LOG%"

rem Success -> finish; otherwise retry until 3 attempts
if %RC%==0 goto done
if %TRIES% LSS 3 (
    echo.
    echo [Retry in 20s, attempt %TRIES%/3...]
    rem timeout in interactive mode; ping trick (~20s) in silent mode
    if "%SILENT%"=="0" timeout /t 20 /nobreak >nul
    if "%SILENT%"=="1" ( ping -n 21 127.0.0.1 >nul )
    goto retry
)

:done
echo.
echo Result appended to %LOG%
rem Pause on double-click so the window stays open; skip in silent mode
if "%SILENT%"=="0" pause
rem Propagate the node exit code so Task Scheduler can detect failure
exit /b %RC%
