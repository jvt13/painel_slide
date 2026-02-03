const multer = require('multer')
const path = require('path')

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let folder = 'uploads/images'

    if (file.mimetype.startsWith('video')) {
      folder = 'uploads/videos'
    } else if (file.mimetype === 'application/pdf') {
      folder = 'uploads/pdfs'
    }

    cb(null, folder)
  },

  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname
    cb(null, uniqueName)
  }
})

module.exports = multer({ storage })
