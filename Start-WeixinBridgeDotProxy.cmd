@echo off
setlocal
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  powershell.exe -NoLogo -NoProfile -File "%~dp0tools\start-dot-egress.ps1" %*
) else (
  pwsh.exe -NoLogo -NoProfile -File "%~dp0tools\start-dot-egress.ps1" %*
)
if errorlevel 1 pause
