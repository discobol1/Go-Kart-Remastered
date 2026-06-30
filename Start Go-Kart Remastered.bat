@echo off
title Go-Kart Remastered
cd /d "%~dp0"
set "PORT=8765"
set "URL=http://localhost:%PORT%/"

if exist "go-kart-remastered.exe" (
  echo.
  echo   Go-Kart Remastered — race server
  echo.
  timeout /t 1 /nobreak >nul
  start "" "%URL%"
  echo   Setup page: %URL%
  echo   Keep this window open. Press Ctrl+C to stop the server.
  echo.
  go-kart-remastered.exe
  if errorlevel 1 pause
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   Download from https://nodejs.org/ or use the standalone release build.
  echo.
  pause
  exit /b 1
)

node scripts\launch.js
if errorlevel 1 pause
