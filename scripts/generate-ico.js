const fs = require('fs')
const path = require('path')
const pngToIcoModule = require('png-to-ico')
const pngToIco = pngToIcoModule.default || pngToIcoModule

async function main() {
  const pngPath = path.resolve(__dirname, '..', 'src', 'public', 'assets', 'system-logo.png')
  const icoPath = path.resolve(__dirname, '..', 'src', 'public', 'assets', 'system-logo.ico')

  if (!fs.existsSync(pngPath)) {
    throw new Error(`Arquivo PNG nao encontrado: ${pngPath}`)
  }

  const icoBuffer = await pngToIco(pngPath)
  fs.writeFileSync(icoPath, icoBuffer)
  console.log(`ICO gerado com sucesso: ${icoPath}`)
}

main().catch((error) => {
  console.error('Falha ao gerar ICO:', error.message)
  process.exit(1)
})
