const fs = require('fs')
const path = require('path')

function copyFileOrThrow(source, target) {
  if (!fs.existsSync(source)) {
    throw new Error(`Arquivo nao encontrado: ${source}`)
  }
  fs.copyFileSync(source, target)
}

function main() {
  const distDir = path.resolve(__dirname, '..', 'dist')
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true })
  }

  const files = [
    { source: path.resolve(__dirname, 'force-f11.py'), target: path.resolve(distDir, 'force-f11.py') },
    { source: path.resolve(__dirname, 'start-exe-and-force-f11.bat'), target: path.resolve(distDir, 'start-exe-and-force-f11.bat') }
  ]

  for (const file of files) {
    copyFileOrThrow(file.source, file.target)
    console.log(`Copiado: ${file.target}`)
  }
}

try {
  main()
} catch (error) {
  console.error('Falha ao copiar assets de F11:', error.message)
  process.exit(1)
}
