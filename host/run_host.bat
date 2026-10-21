@echo off
setlocal
REM web-to-openapi native host launcher (pure ASCII - cmd parses this file in the
REM OEM/GBK codepage, so any non-ASCII byte here corrupts the line parsing).
REM Launched by the browser (Edge/Chrome) via native messaging; stdio carries the protocol.
REM
REM Why the logging below matters: the browser DISCARDS this launcher's stderr pipe,
REM so a failed spawn (node not found, script missing) used to leave zero trace in
REM the logs - indistinguishable from "the browser never tried". Every attempt and
REM every failure reason is now appended to host-launcher.log.
REM NOTE: launcher lines go to their OWN file, not host-stderr.log: a running host
REM holds an open handle on host-stderr.log, and Windows denies a second append
REM handle while it is open ("another program is using this file"), which silently
REM swallowed launcher breadcrumbs whenever a host was alive.

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "NODE_SCRIPT=%SCRIPT_DIR%\openapi-host.js"
set "LOG_DIR=%LOCALAPPDATA%\webtoopenapi\logs"
set "LOG_FILE=%LOG_DIR%\host-stderr.log"
set "LAUNCHER_LOG=%LOG_DIR%\host-launcher.log"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" 2>nul

call :log "launcher invoked; script_dir=%SCRIPT_DIR%"

REM node discovery: env override -> PATH -> common install locations
set "NODE_EXEC="
if defined WEBTOOPENAPI_NODE if exist "%WEBTOOPENAPI_NODE%" set "NODE_EXEC=%WEBTOOPENAPI_NODE%"
if not defined NODE_EXEC for %%I in (node.exe) do if exist "%%~$PATH:I" set "NODE_EXEC=%%~$PATH:I"
if not defined NODE_EXEC if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXEC=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXEC if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXEC=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXEC if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXEC=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXEC (
  echo [web-to-openapi] ERROR: node.exe not found 1>&2
  echo [web-to-openapi] set WEBTOOPENAPI_NODE to your node.exe path 1>&2
  call :log "ERROR: node.exe not found via WEBTOOPENAPI_NODE / PATH / common install dirs"
  call :log "launcher PATH=%PATH%"
  call :log "hint: install Node.js LTS, or set WEBTOOPENAPI_NODE to your node.exe, then FULLY restart the browser (it passes its own env to this launcher)"
  exit /B 1
)

if not exist "%NODE_SCRIPT%" (
  echo [web-to-openapi] ERROR: %NODE_SCRIPT% not found 1>&2
  call :log "ERROR: host script not found: %NODE_SCRIPT%"
  exit /B 1
)

call :log "launcher: node=%NODE_EXEC%; starting host"
"%NODE_EXEC%" "%NODE_SCRIPT%" --config "%SCRIPT_DIR%\config.json" 2>> "%LOG_FILE%"
exit /B %ERRORLEVEL%

:log
REM %TIME% only: %DATE% expands to a localized day name (non-ASCII on zh-CN Windows)
REM whose GBK bytes would corrupt this UTF-8 log. Launcher lines sit right next to the
REM host's own ISO-timestamped startup line, so no date is lost.
echo [%TIME%] [launcher] %~1>> "%LAUNCHER_LOG%"
exit /B 0
