@echo off
rem All-in setup. Runs scripts\setup\setup.ps1 without changing this PC's execution policy.
rem Usage: setup.cmd [-Dev] [-CheckOnly] [-InstallOnly] [-NonInteractive] [-DataDir C:\all-in-db] [-Port 5432]
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup\setup.ps1" %*
exit /b %ERRORLEVEL%
