const fs = require('fs')
const path = require('path')

function main() {
  const source = path.resolve(__dirname, 'start-player-kiosk.bat')
  const target = path.resolve(__dirname, '..', 'dist', 'start-player-kiosk.bat')

  if (!fs.existsSync(source)) {
    throw new Error(`Script nao encontrado: ${source}`)
  }

  fs.copyFileSync(source, target)
  console.log(`Script kiosk copiado para: ${target}`)
}

try {
  main()
} catch (error) {
  console.error('Falha ao copiar script kiosk:', error.message)
  process.exit(1)
}
