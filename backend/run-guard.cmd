@echo off
setlocal
set "MODE=%~1"
if "%MODE%"=="" set "MODE=manual"
if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\.dsh"
set "PWSH="
for /f "delims=" %%P in ('where pwsh.exe 2^>nul') do if not defined PWSH set "PWSH=%%P"
if not defined PWSH if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not defined PWSH if exist "%DSH_HOME%\profiles\desktop\node_modules\@dsh-ops\pwsh-win32-x64\bin\pwsh.exe" set "PWSH=%DSH_HOME%\profiles\desktop\node_modules\@dsh-ops\pwsh-win32-x64\bin\pwsh.exe"
if not defined PWSH if exist "%DSH_HOME%\profiles\web\node_modules\@dsh-ops\pwsh-win32-x64\bin\pwsh.exe" set "PWSH=%DSH_HOME%\profiles\web\node_modules\@dsh-ops\pwsh-win32-x64\bin\pwsh.exe"
if not defined PWSH (echo PowerShell 7 not found. & exit /b 9)
set "SNAPSHOT_ARG=-NoSnapshot"
if /I "%DSH_GUARD_ENABLE_SNAPSHOTS%"=="true" set "SNAPSHOT_ARG=-Snapshot"
if not defined DSH_GUARD_TAKEOVER_MODE set "DSH_GUARD_TAKEOVER_MODE=review"
"%PWSH%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0guard.ps1" -Mode "%MODE%" -Profiles all -TakeoverMode "%DSH_GUARD_TAKEOVER_MODE%" %SNAPSHOT_ARG%
exit /b %ERRORLEVEL%
