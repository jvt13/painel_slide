const express = require('express')
const fs = require('fs')
const path = require('path')
require('dotenv').config()
const http = require('http')
const { Server } = require('socket.io')

const { getDb } = require('./db')
const authRoutes = require('./routes/auth.routes')
const { attachUser, requireAuth, requireMaster } = require('./middlewares/auth.middleware')
const mediaRoutes = require('./routes/media.routes')
const { getUploadsDir } = require('./config/runtime-paths')

const app = express()

process.on('uncaughtException', (error) => {
  console.error('uncaughtException:', error && error.stack ? error.stack : error)
})

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason)
})

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
  express.static(getUploadsDir())
)

// rotas
app.use('/auth', authRoutes)
app.use('/media', mediaRoutes)

// admin
app.get('/admin', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'admin', 'index.html'))
})

app.get('/admin/sql', requireAuth, requireMaster, (req, res) => {
  res.sendFile(path.resolve(__dirname, 'private', 'sql-console.html'))
})

// player
app.get('/player', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public', 'player.html'))
})

const PORT = process.env.PORT || 3000

const server = http.createServer(app)
const io = new Server(server)
const activeCampaignByGroup = new Map()

// disponibiliza o io para as rotas
app.set('io', io)

io.on('connection', (socket) => {
  console.log('Player conectado:', socket.id)
})

function getCampaignStatus(startsAt, endsAt, enabled) {
  if (!enabled) return 'inativa'
  const now = Date.now()
  const startMs = new Date(startsAt).getTime()
  const endMs = new Date(endsAt).getTime()
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 'invalida'
  if (now < startMs) return 'agendada'
  if (now > endMs) return 'encerrada'
  return 'executando'
}

async function monitorCampaignTransitions() {
  try {
    const db = await getDb()
    const groups = await db.all('SELECT id FROM groups ORDER BY display_order, id')

    for (const group of groups) {
      const campaigns = await db.all(
        `
        SELECT id, starts_at, ends_at, active, priority
        FROM campaigns
        WHERE group_id = ?
        ORDER BY priority ASC, starts_at ASC, id ASC
        `,
        [group.id]
      )

      const activeCampaign = campaigns.find(
        (campaign) =>
          getCampaignStatus(campaign.starts_at, campaign.ends_at, Number(campaign.active) === 1) ===
          'executando'
      )

      const currentActiveId = activeCampaign ? activeCampaign.id : null
      const previousActiveId = activeCampaignByGroup.has(group.id)
        ? activeCampaignByGroup.get(group.id)
        : null

      if (currentActiveId !== previousActiveId) {
        activeCampaignByGroup.set(group.id, currentActiveId)
        io.emit('playlist:update', { groupId: group.id, reason: 'campaign-transition' })
      }
    }
  } catch (error) {
    console.error('Falha ao monitorar transicao de campanhas', error.message)
  }
}

function resolveUploadsPath(src) {
  if (!src || typeof src !== 'string') return null
  if (!src.startsWith('/uploads/')) return null
  return path.resolve(__dirname, src.replace('/uploads/', 'uploads/'))
}

async function cleanupExpiredCampaigns() {
  try {
    const graceRaw = Number(process.env.EXPIRED_CAMPAIGN_GRACE_MS)
    const graceMs = Number.isFinite(graceRaw)
      ? Math.max(60000, Math.min(30 * 24 * 60 * 60 * 1000, graceRaw))
      : 60 * 60 * 1000

    const now = Date.now()
    const db = await getDb()
    const campaigns = await db.all(
      `
      SELECT id, group_id, ends_at
      FROM campaigns
      ORDER BY id
      `
    )

    const expired = campaigns.filter((campaign) => {
      const endMs = new Date(campaign.ends_at).getTime()
      if (Number.isNaN(endMs)) return false
      return now - endMs > graceMs
    })
    if (!expired.length) return

    const affectedGroups = new Set()

    for (const campaign of expired) {
      const slides = await db.all(
        'SELECT src FROM slides WHERE campaign_id = ?',
        [campaign.id]
      )

      await db.run('BEGIN TRANSACTION')
      try {
        await db.run('DELETE FROM slides WHERE campaign_id = ?', [campaign.id])
        await db.run('DELETE FROM campaigns WHERE id = ?', [campaign.id])
        await db.run('COMMIT')
      } catch (error) {
        await db.run('ROLLBACK')
        throw error
      }

      const uniqueSrc = [...new Set(slides.map((slide) => slide.src).filter(Boolean))]
      for (const src of uniqueSrc) {
        const refs = await db.get('SELECT COUNT(*) as total FROM slides WHERE src = ?', [src])
        if (Number(refs?.total || 0) > 0) continue

        const filePath = resolveUploadsPath(src)
        if (filePath && fs.existsSync(filePath)) {
          fs.unlinkSync(filePath)
        }
      }

      affectedGroups.add(campaign.group_id)
      activeCampaignByGroup.delete(campaign.group_id)
    }

    for (const groupId of affectedGroups) {
      io.emit('playlist:update', { groupId, reason: 'expired-campaign-cleanup' })
    }
  } catch (error) {
    console.error('Falha ao limpar campanhas encerradas', error.message)
  }
}

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

    const checkMsRaw = Number(process.env.CAMPAIGN_CHECK_MS)
    const campaignCheckMs = Number.isFinite(checkMsRaw)
      ? Math.max(1000, Math.min(60000, checkMsRaw))
      : 5000
    const cleanupMsRaw = Number(process.env.EXPIRED_CAMPAIGN_CLEANUP_MS)
    const cleanupMs = Number.isFinite(cleanupMsRaw)
      ? Math.max(10000, Math.min(60 * 60 * 1000, cleanupMsRaw))
      : 60000

    monitorCampaignTransitions()
    setInterval(monitorCampaignTransitions, campaignCheckMs)
    cleanupExpiredCampaigns()
    setInterval(cleanupExpiredCampaigns, cleanupMs)
  })
  .catch((error) => {
    console.error('Falha ao inicializar banco SQLite', error)
    process.exit(1)
  })