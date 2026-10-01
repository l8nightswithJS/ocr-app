@echo off
setlocal
cd /d "%~dp0"

echo =====================================================
echo Smart Cartridge Build Tracker - Fresh Electron Build
echo =====================================================
echo.

echo Closing packaged app and deleting stale dist/out folders...
call npm run clean
if errorlevel 1 (
  echo.
  echo CLEAN FAILED. Close the Electron app and any File Explorer window opened inside the out folder, then run this again.
  pause
  exit /b 1
)

echo.
echo Building fresh Vite/Electron app...
call npm run build
if errorlevel 1 (
  echo.
  echo BUILD FAILED. Do not run make until this is fixed.
  pause
  exit /b 1
)

echo.
echo Packaging Electron app...
call npm run make
if errorlevel 1 (
  echo.
  echo MAKE FAILED.
  pause
  exit /b 1
)

echo.
echo Done. Launching fresh packaged app if found...
if exist "out\ocr-app-win32-x64\ocr-app.exe" (
  start "" "out\ocr-app-win32-x64\ocr-app.exe"
) else (
  echo Could not find out\ocr-app-win32-x64\ocr-app.exe. Open the newest EXE inside the out folder.
)

echo.
echo Confirm the app header shows: GNM-HYBRID-2026-06-24.5
pause
