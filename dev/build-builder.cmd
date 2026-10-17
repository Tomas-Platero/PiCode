@echo off
REM Builds the PiCode Builder (the C# window) and runs it.
REM
REM Thin wrapper over builder\build.cmd so the builder is reachable the same way the rest of the
REM pipeline is: from dev\, with one name.
REM
REM   dev\build-builder.cmd            build in Release and run
REM   dev\build-builder.cmd debug      build in Debug and run
REM   dev\build-builder.cmd build      build only
REM   dev\build-builder.cmd publish    publish one self-contained .exe
setlocal
cd /d "%~dp0\.."
call builder\build.cmd %1
endlocal