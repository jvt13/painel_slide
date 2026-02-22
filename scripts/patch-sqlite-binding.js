const fs = require('fs')
const path = require('path')

const target = path.resolve(__dirname, '..', 'node_modules', 'sqlite3', 'lib', 'sqlite3-binding.js')
const content = `const path = require('path')

if (process.pkg) {
  module.exports = require(path.resolve(path.dirname(process.execPath), 'node_sqlite3.node'))
} else {
  module.exports = require('bindings')('node_sqlite3.node')
}
`

function main() {
  if (!fs.existsSync(target)) {
    throw new Error(`Arquivo nao encontrado: ${target}`)
  }
  fs.writeFileSync(target, content, 'utf8')
  console.log('sqlite3-binding.js ajustado para modo pkg')
}

try {
  main()
} catch (error) {
  console.error('Falha ao ajustar sqlite3-binding.js:', error.message)
  process.exit(1)
}
