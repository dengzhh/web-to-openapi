@echo off
REM Web To OpenAPI - one-click native host UNREGISTER (no admin needed)
REM Double-click to remove the HKCU registry keys for the native host.
setlocal
set "SCRIPT=%~dp0install-host.ps1"
if not exist "%SCRIPT%" (
  echo ERROR: install-host.ps1 not found next to this script.
  echo Expected: %SCRIPT%
  pause
  exit /b 1
)
echo ======================================================
echo  Web To OpenAPI - Unregister Native Messaging Host
echo ======================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Uninstall
echo.
echo Done. You may also remove/disable the extension at edge://extensions or chrome://extensions
echo.
pause
