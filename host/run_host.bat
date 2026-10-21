@echo off
setlocal
REM web-to-openapi native host launcher. Pure ASCII (cmd parses this file in the
REM OEM codepage - non-ASCII bytes here corrupt line parsing).
REM
REM node is resolved the normal Windows way: PATH. Nothing else. The browser hands
REM this script the environment of the BROWSER process, so node has to be on the
REM PATH that the browser sees - i.e. the system/user PATH, which Explorer passes
REM down. Editing PATH therefore requires a FULL browser restart (closing windows
REM is not enough; check Task Manager for leftover msedge/chrome processes).
REM
REM Two optional overrides, only for machines where PATH cannot be edited:
REM   node-path.txt            next to this file, one line, absolute path, no quotes
REM   WEBTOOPENAPI_NODE        environment variable
REM
REM Why the logging: the browser discards this script's stderr pipe, so a failed
REM spawn used to leave no trace at all. Breadcrumbs go to host-launcher.log - a
REM separate file, because a live host holds a handle on host-stderr.log and
REM Windows refuses a second appender ("another program is using this file").

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "NODE_SCRIPT=%SCRIPT_DIR%\openapi-host.js"
set "LOG_DIR=%LOCALAPPDATA%\webtoopenapi\logs"
set "LOG_FILE=%LOG_DIR%\host-stderr.log"
set "LAUNCHER_LOG=%LOG_DIR%\host-launcher.log"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" 2>nul

REM No SCRIPT_DIR in the log: %~dp0 is OEM/GBK bytes and would turn this UTF-8 log
REM into mojibake (grep then treats it as binary).
call :log "launcher invoked"

set "NODE_EXEC="
set "NODE_SRC="

if exist "%SCRIPT_DIR%\node-path.txt" for /f "usebackq delims=" %%L in ("%SCRIPT_DIR%\node-path.txt") do if not defined NODE_EXEC call :trypin "%%~L"

if not defined NODE_EXEC if defined WEBTOOPENAPI_NODE call :try "env WEBTOOPENAPI_NODE" "%WEBTOOPENAPI_NODE%"

REM The standard lookup: whatever PATH resolves node.exe to.
if not defined NODE_EXEC for %%I in (node.exe) do if exist "%%~$PATH:I" call :try "PATH" "%%~$PATH:I"

REM Same PATH, second opinion (%%~$PATH:I can miss quoted entries).
if not defined NODE_EXEC for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_EXEC call :try "PATH (where.exe)" "%%I"

if not defined NODE_EXEC (
  echo [web-to-openapi] ERROR: node.exe is not on PATH 1>&2
  echo [web-to-openapi] install Node.js, or add an existing node folder to the 1>&2
  echo [web-to-openapi] system PATH, then FULLY quit and restart the browser 1>&2
  call :log "ERROR: node.exe is not on PATH"
  call :log "launcher PATH=%PATH%"
  call :log "hint: install Node.js (the installer adds itself to PATH), or add your node folder to the system PATH; then quit the browser completely and start it again"
  exit /B 1
)

if not exist "%NODE_SCRIPT%" (
  echo [web-to-openapi] ERROR: %NODE_SCRIPT% not found 1>&2
  call :log "ERROR: host script not found: %NODE_SCRIPT%"
  exit /B 1
)

REM No "->" in this message: call re-parses its arguments, ">" becomes a redirect.
call :log "launcher: node source=%NODE_SRC% path=%NODE_EXEC%; starting host"
"%NODE_EXEC%" "%NODE_SCRIPT%" --config "%SCRIPT_DIR%\config.json" 2>> "%LOG_FILE%"
exit /B %ERRORLEVEL%

REM ---------------------------------------------------------------------------
:try
REM %1 = source label, %2 = candidate path. First hit wins.
if defined NODE_EXEC exit /B 0
if "%~2"=="" exit /B 0
if not exist "%~2" exit /B 0
set "NODE_EXEC=%~2"
set "NODE_SRC=%~1"
exit /B 0

:trypin
REM Hand-written pin: validate loudly instead of failing silently. A 0-byte file
REM must never be executed - Windows answers with a "this app can't run on your PC"
REM dialog, which looks like a virus warning to the user.
if "%~1"=="" exit /B 0
if not exist "%~1" (
  call :log "WARN: node-path.txt line does not exist: %~1"
  exit /B 0
)
for %%A in ("%~1") do if %%~zA LEQ 0 (
  call :log "WARN: node-path.txt points at an empty file, ignored: %~1"
  exit /B 0
)
call :try "node-path.txt" "%~1"
exit /B 0

:log
REM %TIME% only: %DATE% expands to a localized day name (non-ASCII on zh-CN Windows)
REM whose GBK bytes would corrupt this UTF-8 log. Launcher lines sit next to the
REM host's own ISO-timestamped line, so no date is lost.
REM Keep this argument free of | > < & ^ ( - call re-parses it and would execute them.
echo [%TIME%] [launcher] %~1>> "%LAUNCHER_LOG%"
exit /B 0
