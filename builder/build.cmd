@echo off
REM Builds the builder and, by default, opens it.
REM
REM   build.cmd              build in Release and run it (fast, small)
REM   build.cmd debug        build in Debug and run it
REM   build.cmd build        build only, do not run
REM   build.cmd publish      publish one self-contained .exe to builder\dist
REM
REM Nothing to install beyond the .NET SDK: the Windows App SDK arrives as a NuGet package the
REM first time this runs. Double-click it, or call it from anywhere.
REM
REM A failure holds the window open instead of vanishing with it.
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

set CONFIG=Release
set RUN=yes
set MODE=%1
if /i "%MODE%"=="debug" set CONFIG=Debug
if /i "%MODE%"=="build" set RUN=no
if /i "%MODE%"=="publish" goto publish

echo Building PiCode Builder (%CONFIG%)...
dotnet build -c %CONFIG%
set STATUS=%ERRORLEVEL%
if not "%STATUS%"=="0" goto failed

if "%RUN%"=="no" goto done

echo Running PiCode Builder...
dotnet run -c %CONFIG% --no-build
set STATUS=%ERRORLEVEL%
if not "%STATUS%"=="0" goto failed
goto done

:publish
echo Publishing one self-contained .exe...
call publish.cmd exe
set STATUS=%ERRORLEVEL%
goto done

:failed
echo.
echo The builder ended with an error (code %STATUS%). What it said is above this line.
echo.
pause
exit /b %STATUS%

:done
endlocal
exit /b 0
