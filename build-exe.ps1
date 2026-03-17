$ErrorActionPreference = 'Stop'

Write-Host '==> Build EXE (Painel Slide)' -ForegroundColor Cyan

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

$localCacheDir = Join-Path $projectRoot '.pkg-cache'
$localCacheV34Dir = Join-Path $localCacheDir 'v3.4'
$localFetched = Join-Path $localCacheV34Dir 'fetched-v18.5.0-win-x64'
$globalFetched = Join-Path $env:USERPROFILE '.pkg-cache\v3.4\fetched-v18.5.0-win-x64'
$exePath = Join-Path $projectRoot 'dist\VisualLoop.exe'
$iconPath = Join-Path $projectRoot 'src\public\assets\icon_256x256.ico'

if (!(Test-Path $localCacheV34Dir)) {
  New-Item -ItemType Directory -Path $localCacheV34Dir -Force | Out-Null
}

if (!(Test-Path $localFetched) -and (Test-Path $globalFetched)) {
  Copy-Item -Path $globalFetched -Destination $localFetched -Force
  Write-Host "Cache pkg copiado para $localFetched"
}

$env:PKG_CACHE_PATH = $localCacheDir

Write-Host '==> Gerando executavel base (pkg --no-bytecode)...'
if (!(Test-Path $iconPath)) {
  throw "Icone nao encontrado em: $iconPath"
}
npx pkg . --targets node18-win-x64 --out-path dist --no-bytecode --icon $iconPath

Write-Host '==> Copiando binarios/assets auxiliares...'
npm run build:exe:native
npm run build:exe:iconfile
npm run build:exe:shortcut-script
npm run build:exe:kiosk-script
npm run build:exe:force-f11-assets

if (!(Test-Path $exePath)) {
  throw "Executavel nao encontrado em: $exePath"
}
Write-Host '==> Nota: o patch de icone no EXE via rcedit permanece desativado neste ambiente porque corrompe o binario do pkg.'
Write-Host '==> O icone ja vai embutido pelo proprio pkg e o arquivo dist\\painel_slide.ico continua disponivel para atalho/instalador.'

Write-Host '==> Build concluido com sucesso.' -ForegroundColor Green
Get-Item $exePath | Select-Object FullName, Length, LastWriteTime
