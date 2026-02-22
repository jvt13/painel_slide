const fs = require('fs')
const path = require('path')

function copyFileSafe(from, to) {
  const targetDir = path.dirname(to)
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
  }
  fs.copyFileSync(from, to)
}

function main() {
  const source = path.resolve(
    __dirname,
    '..',
    'node_modules',
    'sqlite3',
    'build',
    'Release',
    'node_sqlite3.node'
  )
  const target = path.resolve(__dirname, '..', 'dist', 'node_sqlite3.node')

  if (!fs.existsSync(source)) {
    throw new Error(`Binary sqlite3 nao encontrado: ${source}`)
  }

  copyFileSafe(source, target)
  console.log(`Binary sqlite3 copiado para: ${target}`)
}

try {
  main()
} catch (error) {
  console.error('Falha ao copiar binary sqlite3:', error.message)
  process.exit(1)
}
