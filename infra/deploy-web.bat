@echo off
rem infra/deploy-web.bat - Windows twin of infra/deploy-web.sh: publishes the
rem landing and its sub-pages (web/) to the AegisLink VM, then smoke-tests them.
rem
rem Double-click it. Defaults (override by setting them before running):
rem   DEPLOY_HOST = aegislink.duckdns.org
rem   DEPLOY_USER = root
rem   SSH_KEY     = %USERPROFILE%\Desktop\keysVM\aegislink.pem
rem                 (if it is not there, the script asks you to drag the .pem in)
rem Needs Git for Windows (its bash, ssh and scp). The key never leaves this
rem machine: it is only passed to ssh/scp.

rem A double-clicked .bat closes its window on any error before a `pause`.
rem Re-open this script inside `cmd /k` so the window always stays open.
if "%~1"=="--in-window" goto :main
start "AegisLink - deploy web" cmd /k ""%~f0" --in-window"
exit /b 0

:main
setlocal EnableExtensions

if not defined DEPLOY_HOST set "DEPLOY_HOST=aegislink.duckdns.org"
if not defined DEPLOY_USER set "DEPLOY_USER=root"
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

if not exist "%SCRIPT_DIR%deploy-web.sh" goto :notinrepo

rem The pages this deploy publishes must exist in this checkout.
set "MISSING="
for %%F in (index.html privacy.html terms.html legal.html donate.html selfhost.html lang.js) do if not exist "%REPO%\web\%%F" set "MISSING=%%F"
if defined MISSING goto :nopage

if exist "%SSH_KEY%" goto :havekey
echo [deploy-web] No encuentro la clave en: "%SSH_KEY%"
echo [deploy-web] Arrastra aqui tu archivo .pem de la VM y pulsa Enter:
set "SSH_KEY="
set /p "SSH_KEY=> "
if not defined SSH_KEY goto :nokey
set "SSH_KEY=%SSH_KEY:"=%"
if not exist "%SSH_KEY%" goto :nokey

:havekey
echo [deploy-web] Destino: %DEPLOY_USER%@%DEPLOY_HOST%
echo [deploy-web] Clave:   %SSH_KEY%
echo.

rem Forward slashes so Git Bash's ssh/scp read the Windows paths correctly.
set "SSH_KEY=%SSH_KEY:\=/%"
set "DEPLOY_SH=%SCRIPT_DIR:\=/%deploy-web.sh"
"%GITBASH%" "%DEPLOY_SH%"
if errorlevel 1 goto :deployfailed

echo.
echo [deploy-web] Comprobando las paginas publicadas (todas deben dar 200):
for %%U in (index.html privacy.html terms.html legal.html donate.html selfhost.html lang.js) do curl -s -o NUL -w "  %%{http_code}  https://aegis-link.it/%%U\n" "https://aegis-link.it/%%U"
echo.
echo [deploy-web] Listo. Abre https://aegis-link.it/selfhost.html?lang=es para verlo.
goto :end

:nogit
echo [deploy-web] No encuentro Git for Windows. Instalalo desde https://git-scm.com/download/win
goto :end

:notinrepo
echo [deploy-web] Este .bat tiene que estar en la carpeta infra\ de tu copia del repo,
echo [deploy-web] junto a deploy-web.sh. Ahora esta en: %SCRIPT_DIR%
goto :end

:nopage
echo [deploy-web] Falta web\%MISSING% en esta copia del repo. Actualizala primero:
echo     git fetch origin
echo     git checkout claude/pensive-goodall-q0gebx   (o main, cuando la PR este mergeada)
goto :end

:nokey
echo [deploy-web] Sin clave no puedo desplegar. Vuelve a abrir el .bat y arrastra el .pem.
goto :end

:deployfailed
echo.
echo [deploy-web] El deploy fallo - lee los mensajes de arriba.
goto :end

:end
echo.
echo Puedes cerrar esta ventana.
endlocal
exit /b 0
