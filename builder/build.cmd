@echo off
REM Builds the builder and opens it.
REM
REM Nothing to install: the .NET SDK is the only thing it needs, and the Windows App SDK arrives
REM as a package the first time this runs. Double-click it, or call it from anywhere.
REM
REM A failure holds the window open instead of vanishing with it: a console that closes in the
REM same instant takes the message with it, which is exactly what happened to the last launcher
REM written here.
setlocal
cd /d "%~dp0"

where dotnet >nul 2>&1
if errorlevel 1 (
  echo The .NET SDK was not found on PATH.
  echo Install it from https://dotnet.microsoft.com/download and run this again.
  echo.
  pause
  exit /b 1
)

echo Building PiCode Builder...
dotnet run
set STATUS=%ERRORLEVEL%

if not "%STATUS%"=="0" (
  echo.
  echo The builder ended with an error ^(code %STATUS%^). What it said is above this line.
  echo.
  pause
)
endlocal
