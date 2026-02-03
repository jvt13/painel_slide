const express = require('express')
const path = require('path')
require('dotenv').config()

const mediaRoutes = require('./routes/media.routes')

const app = express()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// 🔥 SERVIR ARQUIVOS ESTÁTICOS DO FRONT
app.use(
  express.static(path.resolve(__dirname, 'public'))
)

// 🔥 SERVIR UPLOADS
app.use(
  '/uploads',
  express.static(path.resolve(__dirname, 'uploads'))
)

// rotas
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
const http = require('http')
const { Server } = require('socket.io')

const server = http.createServer(app)
const io = new Server(server)

// disponibiliza o io para as rotas
app.set('io', io)

io.on('connection', (socket) => {
  console.log('Player conectado:', socket.id)
})

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`)
})

