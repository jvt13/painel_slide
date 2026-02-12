const express = require('express')
const path = require('path')
require('dotenv').config()
const http = require('http')
const { Server } = require('socket.io')

const { getDb } = require('./db')
const authRoutes = require('./routes/auth.routes')
const { attachUser } = require('./middlewares/auth.middleware')
const mediaRoutes = require('./routes/media.routes')

const app = express()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(attachUser)

// 🔥 SERVIR ARQUIVOS ESTÁTICOS DO FRONT
app.use(
  express.static(path.resolve(__dirname, 'public'))
)

// admin static (css/js)
app.use(
  '/admin',
  express.static(path.resolve(__dirname, 'admin'))
)

// 🔥 SERVIR UPLOADS
app.use(
  '/uploads',
  express.static(path.resolve(__dirname, 'uploads'))
)

// rotas
app.use('/auth', authRoutes)
app.use('/media', mediaRoutes)

// admin
app.get('/admin', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'admin', 'index.html'))
})

// player
app.get('/player', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public', 'player.html'))
})

const PORT = process.env.PORT || 3000

const server = http.createServer(app)
const io = new Server(server)

// disponibiliza o io para as rotas
app.set('io', io)

io.on('connection', (socket) => {
  console.log('Player conectado:', socket.id)
})

app.use((err, req, res, next) => {
  console.error(err)
  const status = err.status || 500
  res.status(status).json({ error: err.message || 'Erro interno' })
})

getDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Servidor rodando na porta ${PORT}`)
    })
  })
  .catch((error) => {
    console.error('Falha ao inicializar banco SQLite', error)
    process.exit(1)
  })

