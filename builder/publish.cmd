@echo off
REM Builds the builder as ONE .exe that runs on a machine with nothing installed.
REM
REM   publish.cmd            the single file (default) -> builder\dist\PiCode.Builder.exe
REM   publish.cmd folder     a folder with the same program, and a zip of it, much smaller
REM
REM The single file is the biggest of the two and that is not a mistake: self-contained means the .NET
REM runtime and the Windows App SDK travel inside it. Measured here: 631 MB for the one file, 175 MB for
REM the folder, 66 MB for a zip of it.
REM
REM A failure holds the window open: a console that closes in the same instant takes the message away.
setlocal
cd /d "%~dp0"
set MODE=%1
if "%MODE%"=="" set MODE=exe

where dotnet >nul 2>&1
if errorlevel 1 (
  echo The .NET SDK was not found on PATH.
  echo Install it from https://dotnet.microsoft.com/download and run this again.
  echo.
  pause
  exit /b 1
)

if /i "%MODE%"=="exe" goto exe
if /i "%MODE%"=="folder" goto folder
echo usage: publish.cmd [exe^|folder]
exit /b 2

:exe
echo Publishing one .exe...
dotnet publish PiCode.Builder.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:DebugType=none -o dist
if errorlevel 1 goto failed
for %%A in (dist\PiCode.Builder.exe) do echo.
for %%A in (dist\PiCode.Builder.exe) do echo Done: builder\dist\PiCode.Builder.exe  (%%~zA bytes)
echo One file. Copy it anywhere and run it: nothing to install.
goto end

:folder
echo Publishing a folder...
dotnet publish PiCode.Builder.csproj -c Release -r win-x64 --self-contained true -o dist -p:DebugType=none
if errorlevel 1 goto failed
echo Trimming what this program never uses...
del /q "dist\Microsoft.Windows.AI.*" 2>nul
del /q "dist\Microsoft.Windows.Vision*" 2>nul
del /q "dist\Microsoft.Windows.SemanticSearch*" 2>nul
del /q "dist\Microsoft.Windows.Internal.AI.*" 2>nul
del /q "dist\Microsoft.Windows.Internal.Vision*" 2>nul
del /q "dist\Microsoft.Windows.ImageCreationInternal*" 2>nul
del /q "dist\Microsoft.ML.OnnxRuntime.dll" 2>nul
del /q "dist\onnxruntime.dll" 2>nul
del /q "dist\DirectML.dll" 2>nul
del /q "dist\NPUDetect.dll" 2>nul
del /q "dist\PerceptiveStreaming.dll" 2>nul
del /q "dist\createdump.exe" 2>nul
echo Packing the zip...
powershell -NoProfile -Command "Compress-Archive -Path 'dist\*' -DestinationPath 'PiCodeBuilder.zip' -Force"
if errorlevel 1 goto failed
for %%A in (PiCodeBuilder.zip) do echo.
for %%A in (PiCodeBuilder.zip) do echo Done: builder\PiCodeBuilder.zip  (%%~zA bytes)
echo The same program, a quarter of the weight, in a folder you unzip.
goto end

:failed
echo.
echo Publishing failed. What it said is above this line.
echo If a copy from dist is running, close it first: it cannot be overwritten while it runs.
echo.
pause

:end
endlocal
