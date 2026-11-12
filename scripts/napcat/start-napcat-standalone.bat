@echo off
REM Standalone NapCat 4.18.19 (bundled QQ runtime, no injection, no admin).
REM Lives in deps\napcat-old; D:\NapCatOld is an ASCII junction to it (created by hand/setup).
setlocal
set "ROOT=D:\NapCatOld"
if not exist "%ROOT%\node.exe" set "ROOT=%~dp0..\..\deps\napcat-old"
cd /d "%ROOT%" || exit /b 1
set "QQACC="
if exist "qq-account.txt" set /p QQACC=<"qq-account.txt"
if defined QQACC (node.exe index.js -q %QQACC%) else (node.exe index.js)
