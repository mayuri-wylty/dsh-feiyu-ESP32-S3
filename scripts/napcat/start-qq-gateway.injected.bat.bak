@echo off
REM ---------------------------------------------------------------
REM  QQ gateway (NapCat) launcher helper for dsh-feiyu.
REM  Installed to deps\napcat\napcat\ by scripts\setup-deps.ps1.
REM  - elevates to administrator (NapCat injects into QQ, admin needed)
REM  - registers the "DSH-Feiyu-NapCat" logon task (highest privileges)
REM  - starts the gateway: NapCatWinBootMain.exe <QQ.exe> <hook.dll>
REM
REM  usage:  start-qq-gateway.bat            (self-elevate, register task, start)
REM          start-qq-gateway.bat elevated   (already elevated, register task, start)
REM          start-qq-gateway.bat run        (called by the scheduled task, just start)
REM ---------------------------------------------------------------
setlocal DisableDelayedExpansion
cd /d "%~dp0" || exit /b 1
chcp 65001 >nul

set "NAPCAT_WORKDIR=%cd%"
set "TASK_NAME=DSH-Feiyu-NapCat"
set "MODE=%~1"

REM ---- need administrator? (NapCat injects a DLL into QQ.exe) ----
net session >nul 2>&1
if not errorlevel 1 goto :admin
if /i "%MODE%"=="elevated" goto :admin
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher-elevate.ps1" wt.exe "%~f0" %*
exit /b %ERRORLEVEL%

:admin
if /i "%MODE%"=="run" goto :start_gateway
call :register_task

:start_gateway
set "NAPCAT_PATCH_PACKAGE=%cd%\qqnt.json"
set "NAPCAT_LOAD_PATH=%cd%\loadNapCat.js"
set "NAPCAT_INJECT_PATH=%cd%\NapCatWinBootHook.dll"
set "NAPCAT_LAUNCHER_PATH=%cd%\NapCatWinBootMain.exe"
set "NAPCAT_MAIN_PATH=%cd%\napcat.mjs"

set "RetString="
for /f "tokens=2*" %%a in ('reg query "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ" /v "UninstallString"') do (
    set "RetString=%%~b"
    goto :napcat_boot
)
echo [NapCat] QQ installation was not found in the registry.
exit /b 1

:napcat_boot
for %%a in ("%RetString%") do (
    set "pathWithoutUninstall=%%~dpa"
)
set "QQPath=%pathWithoutUninstall%QQ.exe"
if not exist "%QQPath%" (
    echo [NapCat] QQ path is invalid: %QQPath%
    exit /b 1
)

echo [NapCat] starting QQ gateway, QQ=%QQPath%
set "QQACC="
if exist "%~dp0qq-account.txt" set /p QQACC=<"%~dp0qq-account.txt"
"%NAPCAT_LAUNCHER_PATH%" "%QQPath%" "%NAPCAT_INJECT_PATH%" %QQACC%
exit /b %ERRORLEVEL%

:register_task
REM  Prefer the ASCII junction path (D:\NapCat) so the task survives codepage issues.
set "TARGET=%~dp0start-qq-gateway.bat"
if exist "D:\NapCat\start-qq-gateway.bat" set "TARGET=D:\NapCat\start-qq-gateway.bat"
schtasks.exe /Delete /TN "%TASK_NAME%" /F >nul 2>&1
schtasks.exe /Create /TN "%TASK_NAME%" /SC ONLOGON /RL HIGHEST /TR "cmd.exe /c \"%TARGET%\" run" /F
if errorlevel 1 (
    echo [NapCat] failed to register scheduled task "%TASK_NAME%".
    exit /b 1
)
echo [NapCat] scheduled task "%TASK_NAME%" registered (logon, highest privileges).
exit /b 0
