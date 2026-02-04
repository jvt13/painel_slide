const express = require('express')
const router = express.Router()
const fs = require('fs')
const path = require('path')
const multer = require('multer')

// caminhos
const uploadsPath = path.resolve(__dirname, '..', 'uploads')
const playlistFile = path.resolve(__dirname, '..', 'data', 'playlist.json')

// storage do multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let folder = 'images'
    if (file.mimetype.startsWith('video')) folder = 'videos'
    if (file.mimetype === 'application/pdf') folder = 'pdfs'
    cb(null, path.join(uploadsPath, folder))
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname)
  }
})

const upload = multer({ storage })

// 🔹 PLAYLIST
router.get('/playlist', (req, res) => {
  const playlist = fs.existsSync(playlistFile)
    ? JSON.parse(fs.readFileSync(playlistFile))
    : []

  res.json(playlist)
})

// 🔹 UPLOAD
router.post('/upload', upload.single('media'), (req, res) => {
  const playlist = fs.existsSync(playlistFile)
    ? JSON.parse(fs.readFileSync(playlistFile))
    : []

  const file = req.file
  const { name, duration } = req.body
  if (!file) return res.sendStatus(400)

  const type = file.mimetype.startsWith('image')
    ? 'image'
    : file.mimetype.startsWith('video')
    ? 'video'
    : 'pdf'

  playlist.push({
    type,
    name,
    src: `/uploads/${
      type === 'image' ? 'images' : type === 'video' ? 'videos' : 'pdfs'
    }/${file.filename}`,
    duration: Number(duration) * 1000 // segundos → ms
  })

  fs.writeFileSync(playlistFile, JSON.stringify(playlist, null, 2))

  req.app.get('io').emit('playlist:update')
  res.redirect('/admin')
})


// 🔹 REORDENAR
router.post('/reorder', express.json(), (req, res) => {
  const { index, dir } = req.body
  const playlist = JSON.parse(fs.readFileSync(playlistFile))

  const newIndex = index + dir
  if (newIndex < 0 || newIndex >= playlist.length) {
    return res.sendStatus(200)
  }

  ;[playlist[index], playlist[newIndex]] = [playlist[newIndex], playlist[index]]

  fs.writeFileSync(playlistFile, JSON.stringify(playlist, null, 2))
  req.app.get('io').emit('playlist:update')
  res.sendStatus(200)
})

router.post('/delete', express.json(), (req, res) => {
  const { index } = req.body

  const playlistFile = path.resolve(__dirname, '..', 'data', 'playlist.json')
  const playlist = JSON.parse(fs.readFileSync(playlistFile))

  const item = playlist[index]
  if (!item) return res.sendStatus(400)

  // caminho físico do arquivo
  const filePath = path.resolve(
    __dirname,
    '..',
    item.src.replace('/uploads', 'uploads')
  )

  // remove arquivo físico
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }

  // remove da playlist
  playlist.splice(index, 1)
  fs.writeFileSync(playlistFile, JSON.stringify(playlist, null, 2))

  // avisa os players
  req.app.get('io').emit('playlist:update')

  res.sendStatus(200)
})


module.exports = router
