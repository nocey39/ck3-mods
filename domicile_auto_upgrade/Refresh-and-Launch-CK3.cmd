@echo off
powershell.exe -NoLogo -NoProfile -File "%~dp0tools\Refresh-DauQuotes.ps1" -Launch
if errorlevel 1 pause
