@echo off
setlocal

set "PLAYER_URL=http://localhost:3000/player"
set "EDGE_EXE="
set "CHROME_EXE="

where msedge >nul 2>nul
if %errorlevel%==0 (
  start "" msedge --new-window --app="%PLAYER_URL%" --start-fullscreen --autoplay-policy=no-user-gesture-required
  exit /b 0
)

where chrome >nul 2>nul
if %errorlevel%==0 (
  start "" chrome --new-window --app="%PLAYER_URL%" --start-fullscreen --autoplay-policy=no-user-gesture-required
  exit /b 0
)

if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE_EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%LocalAppData%\Microsoft\Edge\Application\msedge.exe" set "EDGE_EXE=%LocalAppData%\Microsoft\Edge\Application\msedge.exe"

if defined EDGE_EXE (
  start "" "%EDGE_EXE%" --new-window --app="%PLAYER_URL%" --start-fullscreen --autoplay-policy=no-user-gesture-required
  exit /b 0
)

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if defined CHROME_EXE (
  start "" "%CHROME_EXE%" --new-window --app="%PLAYER_URL%" --start-fullscreen --autoplay-policy=no-user-gesture-required
  exit /b 0
)

echo Nao foi encontrado Microsoft Edge ou Google Chrome no PATH.
echo Tambem nao encontramos instalacao padrao nos diretorios conhecidos.
echo Abra manualmente o navegador em modo kiosk com o caminho completo:
echo   "C:\Program Files\Microsoft\Edge\Application\msedge.exe" --new-window --app="%PLAYER_URL%" --start-fullscreen
echo   "C:\Program Files\Google\Chrome\Application\chrome.exe" --new-window --app="%PLAYER_URL%" --start-fullscreen
pause
exit /b 1
