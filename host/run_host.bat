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
REM
REM The browser passes ITS OWN environment to this script - not the environment of
REM your cmd window. A node.exe that works in cmd can still be invisible here
REM (very common: node shipped inside another app's runtime folder, or installed
REM after the browser started). Hence the wide probe list + the node-path.txt pin.

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "NODE_SCRIPT=%SCRIPT_DIR%\openapi-host.js"
set "LOG_DIR=%LOCALAPPDATA%\webtoopenapi\logs"
set "LOG_FILE=%LOG_DIR%\host-stderr.log"
set "LAUNCHER_LOG=%LOG_DIR%\host-launcher.log"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" 2>nul

REM NOTE: do NOT log SCRIPT_DIR here. cmd expands %~dp0 to OEM (GBK) bytes; writing
REM a Chinese folder name into this UTF-8 log produces mojibake that makes the file
REM look binary to grep. The host itself logs its own absolute config path in UTF-8.
call :log "launcher invoked"

REM ---------------------------------------------------------------------------
REM node discovery, most explicit first:
REM   1. node-path.txt next to this file  (manual pin, survives reinstalls)
REM   2. WEBTOOPENAPI_NODE                (env var)
REM   3. PATH / where.exe                 (the browser's inherited PATH)
REM   4. known installer layouts          (msi / nvm / volta / scoop / choco)
REM   5. node bundled inside other apps   (WorkBuddy, DeepSeek Harness, ...)
REM ---------------------------------------------------------------------------
set "NODE_EXEC="
set "NODE_SRC="

if exist "%SCRIPT_DIR%\node-path.txt" (
  for /f "usebackq delims=" %%L in ("%SCRIPT_DIR%\node-path.txt") do if not defined NODE_EXEC call :trypin "%%~L"
)

if not defined NODE_EXEC if defined WEBTOOPENAPI_NODE call :try "env WEBTOOPENAPI_NODE" "%WEBTOOPENAPI_NODE%"

if not defined NODE_EXEC for %%I in (node.exe) do if exist "%%~$PATH:I" call :try "PATH" "%%~$PATH:I"

if not defined NODE_EXEC for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_EXEC call :try "where.exe" "%%I"

if not defined NODE_EXEC call :try "ProgramFiles" "%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXEC call :try "ProgramFiles(x86)" "%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXEC call :try "LOCALAPPDATA\Programs" "%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXEC if defined NVM_SYMLINK call :try "NVM_SYMLINK" "%NVM_SYMLINK%\node.exe"
if not defined NODE_EXEC if defined NVM_HOME call :try "NVM_HOME" "%NVM_HOME%\node.exe"
if not defined NODE_EXEC call :try "APPDATA\nvm" "%APPDATA%\nvm\node.exe"
if not defined NODE_EXEC call :try "Volta" "%LOCALAPPDATA%\Volta\bin\node.exe"
if not defined NODE_EXEC call :try "scoop" "%USERPROFILE%\scoop\apps\nodejs\current\node.exe"
if not defined NODE_EXEC call :try "scoop-lts" "%USERPROFILE%\scoop\apps\nodejs-lts\current\node.exe"
if not defined NODE_EXEC call :try "chocolatey" "%ProgramData%\chocolatey\bin\node.exe"
if not defined NODE_EXEC call :try "nvs" "%LOCALAPPDATA%\nvs\node.exe"

REM nvm-windows stores each version in its own folder
if not defined NODE_EXEC if exist "%APPDATA%\nvm" for /d %%D in ("%APPDATA%\nvm\v*") do if not defined NODE_EXEC call :try "APPDATA\nvm\v*" "%%~fD\node.exe"

REM WorkBuddy-style managed runtimes (versioned folders)
if not defined NODE_EXEC if exist "%USERPROFILE%\.workbuddy\binaries\node\versions" for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if not defined NODE_EXEC call :try "workbuddy runtime" "%%~fD\node.exe"

REM node bundled inside another installed app (Electron/CLI runtimes)
if not defined NODE_EXEC if exist "%LOCALAPPDATA%\Programs" for /d %%D in ("%LOCALAPPDATA%\Programs\*") do if not defined NODE_EXEC call :try "app runtime: %%~nxD" "%%~fD\resources\runtime\cli\bin\node.exe"
if not defined NODE_EXEC if exist "%LOCALAPPDATA%\Programs" for /d %%D in ("%LOCALAPPDATA%\Programs\*") do if not defined NODE_EXEC call :try "app runtime: %%~nxD" "%%~fD\resources\runtime\node.exe"

if not defined NODE_EXEC (
  echo [web-to-openapi] ERROR: node.exe not found 1>&2
  echo [web-to-openapi] install Node.js LTS, or write the full path of node.exe 1>&2
  echo [web-to-openapi] into "%SCRIPT_DIR%\node-path.txt" ^(one line, no quotes^) 1>&2
  call :log "ERROR: node.exe not found"
  REM No pipe/redirect characters in this argument: `call` re-parses its arguments,
  REM so "|" gets executed as a pipeline instead of being logged.
  call :log "searched: node-path.txt; WEBTOOPENAPI_NODE; PATH; where.exe; ProgramFiles\nodejs; ProgramFiles(x86)\nodejs; LOCALAPPDATA\Programs\nodejs; NVM_SYMLINK; NVM_HOME; APPDATA\nvm; APPDATA\nvm\v*; Volta\bin; scoop\apps\nodejs(-lts)\current; chocolatey\bin; LOCALAPPDATA\nvs; .workbuddy\binaries\node\versions\*; LOCALAPPDATA\Programs\*\resources\runtime"
  call :log "launcher PATH=%PATH%"
  call :log "hint: install Node.js LTS then FULLY quit and restart the browser - the native host inherits the browser's env, so a browser started before the install will never see it"
  exit /B 1
)

if not exist "%NODE_SCRIPT%" (
  echo [web-to-openapi] ERROR: %NODE_SCRIPT% not found 1>&2
  call :log "ERROR: host script not found: %NODE_SCRIPT%"
  exit /B 1
)

REM No "->" here: the ">" would be re-parsed as a redirection by call.
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
REM Same as :try but explains a bad pin file instead of failing silently
if "%~1"=="" exit /B 0
if exist "%~1" (
  call :try "node-path.txt" "%~1"
) else (
  call :log "WARN: node-path.txt line does not exist: %~1"
)
exit /B 0

:log
REM %TIME% only: %DATE% expands to a localized day name (non-ASCII on zh-CN Windows)
REM whose GBK bytes would corrupt this UTF-8 log. Launcher lines sit right next to the
REM host's own ISO-timestamped startup line, so no date is lost.
echo [%TIME%] [launcher] %~1>> "%LAUNCHER_LOG%"
exit /B 0
