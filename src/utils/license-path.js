const fs = require('fs')
const path = require('path')
const os = require('os')

function getLicenseDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const dir = path.join(appData, 'PainelSlide')

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  return dir
}

function getLicenseFilePath() {
  return path.join(getLicenseDir(), 'license.json')
}

function getPublicKeyPath() {
  return path.join(getLicenseDir(), 'public.key')
}

module.exports = {
  getLicenseDir,
  getLicenseFilePath,
  getPublicKeyPath
}