@echo off
REM Mata processos usando a porta 3000
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000') do (
    taskkill /PID %%a /F >nul 2>&1
)
REM Inicia o servidor em modo dev
nodemon src/app.js