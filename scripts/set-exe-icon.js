const fs = require('fs')
const path = require('path')

async function main() {
  const exePath = path.resolve(__dirname, '..', 'dist', 'VisualLoop.exe')
  const iconPath = path.resolve(__dirname, '..', 'src', 'public', 'assets', 'icon_256x256.ico')

  if (!fs.existsSync(exePath)) {
    throw new Error(`Executavel nao encontrado: ${exePath}`)
  }
  if (!fs.existsSync(iconPath)) {
    throw new Error(`Icone nao encontrado: ${iconPath}`)
  }

  console.log('Patch via rcedit desativado para evitar corrupcao do binario do pkg.')
  console.log(`Use o icone embutido pelo pkg em ${exePath} e o arquivo auxiliar ${iconPath}.`)
}

main().catch((error) => {
  console.error('Falha ao aplicar icone no executavel:', error.message)
  process.exit(1)
})
