@echo off
REM PiCode's build window: what the build needs, one button to start it, and how much is left.
REM
REM Double-click this, or run it from a terminal. It is PowerShell under the hood because that is
REM on every Windows machine and the repository should not carry a GUI toolchain.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-window.ps1" %*
endlocal
