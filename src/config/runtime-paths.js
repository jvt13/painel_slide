const fs = require('fs')
const path = require('path')

function getSrcRuntimeDir() {
  if (process.pkg) {
    return path.resolve(path.dirname(process.execPath), 'src')
  }
  return path.resolve(__dirname, '..')
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function getUploadsDir() {
  const dir = path.resolve(getSrcRuntimeDir(), 'uploads')
  ensureDir(dir)
  ensureDir(path.join(dir, 'images'))
  ensureDir(path.join(dir, 'videos'))
  ensureDir(path.join(dir, 'pdfs'))
  return dir
}

function getDataDir() {
  const dir = path.resolve(getSrcRuntimeDir(), 'data')
  ensureDir(dir)
  return dir
}

function getDefaultDbPath() {
  return path.resolve(getDataDir(), 'painel.sqlite')
}

module.exports = {
  getSrcRuntimeDir,
  getUploadsDir,
  getDataDir,
  getDefaultDbPath
}
