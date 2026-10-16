@echo off
setlocal
REM web-to-openapi native host launcher (pure ASCII)
REM Launched by Edge via native messaging; stdio pipes carry the protocol.

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "NODE_SCRIPT=%SCRIPT_DIR%\openapi-host.js"
set "LOG_DIR=%LOCALAPPDATA%\webtoopenapi\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" 2>nul

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
  exit /B 1
)

if not exist "%NODE_SCRIPT%" (
  echo [web-to-openapi] ERROR: %NODE_SCRIPT% not found 1>&2
  exit /B 1
)

"%NODE_EXEC%" "%NODE_SCRIPT%" --config "%SCRIPT_DIR%\config.json" 2>> "%LOG_DIR%\host-stderr.log"
exit /B %ERRORLEVEL%
