@echo off
REM Script para gerar o executável com o ícone atualizado

REM Caminho para o ícone atualizado
set ICON_PATH=src\public\assets\icon_256x256.ico

REM Gerar o executável com o ícone
pkg . --targets node18-win-x64 --out-path dist --icon %ICON_PATH%

REM Mensagem de conclusão
echo Executável gerado com sucesso na pasta dist\
pause