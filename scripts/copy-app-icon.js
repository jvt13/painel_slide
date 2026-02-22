const fs = require('fs')
const path = require('path')

function main() {
  const source = path.resolve(__dirname, '..', 'src', 'public', 'assets', 'system-logo.ico')
  const target = path.resolve(__dirname, '..', 'dist', 'painel_slide.ico')

  if (!fs.existsSync(source)) {
    throw new Error(`Icone nao encontrado: ${source}`)
  }

  fs.copyFileSync(source, target)
  console.log(`Icone copiado para: ${target}`)
}

try {
  main()
} catch (error) {
  console.error('Falha ao copiar icone:', error.message)
  process.exit(1)
}
