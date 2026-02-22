const fs = require('fs')
const path = require('path')

function main() {
  const source = path.resolve(__dirname, 'create-shortcut.ps1')
  const target = path.resolve(__dirname, '..', 'dist', 'create-shortcut.ps1')

  if (!fs.existsSync(source)) {
    throw new Error(`Script nao encontrado: ${source}`)
  }

  fs.copyFileSync(source, target)
  console.log(`Script de atalho copiado para: ${target}`)
}

try {
  main()
} catch (error) {
  console.error('Falha ao copiar script de atalho:', error.message)
  process.exit(1)
}
