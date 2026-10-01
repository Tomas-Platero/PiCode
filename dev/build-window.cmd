@echo off
REM PiCode's build window: what the build needs, one button to start it, and how much is left.
REM
REM Double-click this, or run it from a terminal. It is PowerShell under the hood because that is
REM on every Windows machine and the repository should not carry a GUI toolchain.
REM
REM Everything it prints is also written to `.scratch\build-window.log`, and a failure holds the
REM window open instead of vanishing with it: a PowerShell script that cannot be parsed never runs,
REM so a message shown only on screen would be gone before it could be read. That happened once —
REM the script carried two encoding marks at its start, the parser rejected it, and the window
REM closed in the same instant.
setlocal
set "LOG=%~dp0..\.scratch\build-window.log"
if not exist "%~dp0..\.scratch" mkdir "%~dp0..\.scratch" >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Transcript -Path '%LOG%' -Force | Out-Null; & '%~dp0build-window.ps1' %*; $code = $LASTEXITCODE; Stop-Transcript | Out-Null; exit $code"
set STATUS=%ERRORLEVEL%

if not "%STATUS%"=="0" (
  echo.
  echo The build window ended with an error ^(code %STATUS%^). Whatever it said is above this line,
  echo and the whole run is in:
  echo   %LOG%
  echo.
  pause
)
endlocal
