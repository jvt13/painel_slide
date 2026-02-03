exports.upload = (req, res) => {
  const { duration } = req.body
  const file = req.file

  if (!file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado' })
  }

  // Depois você salva isso no banco
  console.log({
    filename: file.filename,
    type: file.mimetype,
    duration
  })

  res.redirect('/admin')
}
