@echo off
REM Script para gerar o executável com o ícone atualizado

setlocal
set "PROJECT_ROOT=%~dp0"
set "ICON_PATH=%PROJECT_ROOT%src\public\assets\icon_256x256.ico"

if not exist "%ICON_PATH%" (
  echo [ERRO] Icone nao encontrado em:
  echo        %ICON_PATH%
  pause
  exit /b 1
)

REM Gerar o executável com o ícone
pkg . --targets node18-win-x64 --out-path dist --icon "%ICON_PATH%"

REM Mensagem de conclusão
echo Executável gerado com sucesso na pasta dist\
pause
