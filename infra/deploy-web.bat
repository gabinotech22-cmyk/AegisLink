@echo off
rem infra/deploy-web.bat - Windows twin of infra/deploy-web.sh: publishes the
rem landing and its sub-pages (web/) to the AegisLink VM, then smoke-tests them.
rem
rem Double-click it, or run from cmd. Defaults (override by setting them first):
rem   DEPLOY_HOST = aegis-link.it
rem   SSH_KEY     = %USERPROFILE%\Desktop\keysVM\aegislink.pem
rem Needs Git for Windows (its bash, ssh and scp). The key never leaves this
rem machine: it is only passed to ssh/scp.
setlocal EnableExtensions

if not defined DEPLOY_HOST set "DEPLOY_HOST=aegis-link.it"
if not defined SSH_KEY set "SSH_KEY=%USERPROFILE%\Desktop\keysVM\aegislink.pem"

set "SCRIPT_DIR=%~dp0"
set "REPO=%~dp0.."

rem Git Bash, never WSL's System32\bash.exe (it can't see C:\ paths the same way).
set "GITBASH="
if exist "%ProgramFiles%\Git\bin\bash.exe" set "GITBASH=%ProgramFiles%\Git\bin\bash.exe"
if not defined GITBASH if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "GITBASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not defined GITBASH if exist "%LocalAppData%\Programs\Git\bin\bash.exe" set "GITBASH=%LocalAppData%\Programs\Git\bin\bash.exe"
rem Error paths use goto, not ( ) blocks: a path with ")" in it, such as
rem "Program Files (x86)", would end a block early.
if not defined GITBASH goto :nogit
if not exist "%SSH_KEY%" goto :nokey

rem The pages this deploy publishes must exist in this checkout.
set "MISSING="
for %%F in (index.html privacy.html terms.html legal.html donate.html selfhost.html lang.js) do if not exist "%REPO%\web\%%F" set "MISSING=%%F"
if defined MISSING goto :nopage

echo [deploy-web] Host: %DEPLOY_HOST%
echo [deploy-web] Key:  %SSH_KEY%
echo.

rem Forward slashes so Git Bash's ssh/scp read the Windows path correctly.
set "SSH_KEY=%SSH_KEY:\=/%"
set "DEPLOY_SH=%SCRIPT_DIR:\=/%deploy-web.sh"
"%GITBASH%" "%DEPLOY_SH%"
if errorlevel 1 goto :deployfailed

echo.
echo [deploy-web] Smoke test (expect 200):
for %%U in (index.html privacy.html terms.html legal.html donate.html selfhost.html lang.js) do (
  curl -s -o NUL -w "  %%{http_code}  https://aegis-link.it/%%U\n" "https://aegis-link.it/%%U"
)
echo.
echo [deploy-web] Done. Open https://aegis-link.it/selfhost.html?lang=es to check it.
pause
exit /b 0

:nogit
echo [deploy-web] Git for Windows not found. Install it from https://git-scm.com/download/win
goto :fail

:nokey
echo [deploy-web] SSH key not found: "%SSH_KEY%"
echo [deploy-web] Point SSH_KEY at the VM private key first, for example:
echo     set "SSH_KEY=D:\keys\aegislink.pem"
echo     infra\deploy-web.bat
goto :fail

:nopage
echo [deploy-web] Missing web\%MISSING% in this checkout. Update it first: git pull
goto :fail

:deployfailed
echo.
echo [deploy-web] The deploy failed - read the messages above.
goto :fail

:fail
echo.
pause
exit /b 1
