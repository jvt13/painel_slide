@echo off
setlocal

set "BASE_DIR=%~dp0"
set "EXE_PATH=%BASE_DIR%painel_slide.exe"
set "PY_SCRIPT=%BASE_DIR%force-f11.py"

if not exist "%PY_SCRIPT%" set "PY_SCRIPT=%BASE_DIR%scripts\force-f11.py"

if exist "%EXE_PATH%" (
  start "" "%EXE_PATH%"
)

timeout /t 6 /nobreak >nul

if not exist "%PY_SCRIPT%" (
  echo Script force-f11.py nao encontrado.
  exit /b 1
)

where python >nul 2>nul
if %errorlevel%==0 (
  start "" /min python "%PY_SCRIPT%"
  exit /b 0
)

where py >nul 2>nul
if %errorlevel%==0 (
  start "" /min py -3 "%PY_SCRIPT%"
  exit /b 0
)

echo Python launcher nao encontrado (python/py).
echo Instale Python para automatizar F11.
exit /b 1
