@echo off
REM Web To OpenAPI - one-click native host registration (no admin needed)
REM Double-click this file to register the native messaging host.
REM It writes HKCU registry keys pointing to com.webtoopenapi.host.json.
setlocal
set "SCRIPT=%~dp0install-host.ps1"
if not exist "%SCRIPT%" (
  echo ERROR: install-host.ps1 not found next to this script.
  echo Expected: %SCRIPT%
  pause
  exit /b 1
)
echo ======================================================
echo  Web To OpenAPI - Register Native Messaging Host
echo ======================================================
echo.
echo This writes the current-user registry (HKCU) so Edge/Chrome
echo can launch the local host. No administrator rights needed.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
echo.
echo ------------------------------------------------------
if errorlevel 1 (
  echo Registration failed. See output above.
) else (
  echo Success. Now load the extension in Edge:
  echo   edge://extensions  ->  Developer mode  ->  Load unpacked  ->  select the "extension/" folder
  echo The host will auto-start and listen on http://127.0.0.1:8090
)
echo.
pause
