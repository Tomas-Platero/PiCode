@echo off
REM Builds the builder for somebody else's machine: one .exe that needs nothing installed.
REM
REM Three steps, and the middle one matters: a plain publish is 228 MB, and most of that is things
REM this program never touches - the Windows App SDK ships its AI and ONNX bits whether or not you
REM use them. Removing them takes it to about 173 MB, verified by running the result.
REM
REM What comes out is builder\dist\ (the folder, to run it here) and builder\dist\PiCodeBuilder.zip
REM (the one file to hand over). A single-file publish was tried and rejected: 631 MB, and 455 MB
REM even compressed - nearly three times the weight for one file.
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

echo Publishing...
dotnet publish PiCode.Builder.csproj -c Release -r win-x64 --self-contained true -o dist -p:DebugType=none
if errorlevel 1 goto failed

echo Trimming what this program never uses...
del /q "dist\Microsoft.Windows.AI.*" 2>nul
del /q "dist\Microsoft.Windows.Vision*" 2>nul
del /q "dist\Microsoft.Windows.SemanticSearch*" 2>nul
del /q "dist\Microsoft.Windows.Internal.AI.*" 2>nul
del /q "dist\Microsoft.Windows.Internal.ImageCreation*" 2>nul
del /q "dist\Microsoft.Windows.Internal.SemanticSearch*" 2>nul
del /q "dist\Microsoft.Windows.Internal.Vision*" 2>nul
del /q "dist\Microsoft.Windows.ImageCreationInternal*" 2>nul
del /q "dist\Microsoft.ML.OnnxRuntime.dll" 2>nul
del /q "dist\onnxruntime.dll" 2>nul
del /q "dist\DirectML.dll" 2>nul
del /q "dist\NPUDetect.dll" 2>nul
del /q "dist\PerceptiveStreaming.dll" 2>nul
del /q "dist\Microsoft.Asg.SemanticIndex.AiFabric.Compatibility.dll" 2>nul
del /q "dist\createdump.exe" 2>nul
del /q "dist\mscordaccore*.dll" 2>nul
del /q "dist\mscordbi.dll" 2>nul
del /q "dist\Microsoft.DiaSymReader.Native.amd64.dll" 2>nul

echo Packing the one file to hand over...
powershell -NoProfile -Command "Compress-Archive -Path 'dist\*' -DestinationPath 'PiCodeBuilder.zip' -Force"
if errorlevel 1 goto failed

for %%A in (PiCodeBuilder.zip) do echo.
for %%A in (PiCodeBuilder.zip) do echo Done: builder\PiCodeBuilder.zip  (%%~zA bytes)
echo It unzips to a folder with PiCode.Builder.exe in it. Nothing to install: that is the point.
goto end

:failed
echo.
echo Publishing failed. What it said is above this line.
echo If a copy from dist is running, close it first: it cannot be overwritten while it runs.
echo.
pause

:end
endlocal
