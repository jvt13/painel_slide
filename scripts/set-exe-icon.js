const fs = require('fs')
const path = require('path')
const rcedit = require('rcedit')

async function main() {
  const exePath = path.resolve(__dirname, '..', 'dist', 'painel_slide.exe')
  const iconPath = path.resolve(__dirname, '..', 'src', 'public', 'assets', 'system-logo.ico')

  if (!fs.existsSync(exePath)) {
    throw new Error(`Executavel nao encontrado: ${exePath}`)
  }
  if (!fs.existsSync(iconPath)) {
    throw new Error(`Icone nao encontrado: ${iconPath}`)
  }

  await rcedit(exePath, {
    icon: iconPath
  })

  console.log(`Icone aplicado com sucesso em: ${exePath}`)
}

main().catch((error) => {
  console.error('Falha ao aplicar icone no executavel:', error.message)
  process.exit(1)
})
