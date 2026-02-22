param(
  [string]$AppDir = (Split-Path -Parent $MyInvocation.MyCommand.Path)
)

$exePath = Join-Path $AppDir "painel_slide.exe"
$icoPath = Join-Path $AppDir "painel_slide.ico"

if (-not (Test-Path $exePath)) {
  Write-Error "Executavel nao encontrado: $exePath"
  exit 1
}

if (-not (Test-Path $icoPath)) {
  Write-Error "Icone nao encontrado: $icoPath"
  exit 1
}

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Painel Slide.lnk"

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = $AppDir
$shortcut.IconLocation = "$icoPath,0"
$shortcut.Save()

Write-Output "Atalho criado em: $shortcutPath"
