const express = require('express')
const fs = require('fs')
const path = require('path')
const multer = require('multer')

const { getDb } = require('../db')
const { requireAuth, requireMaster } = require('../middlewares/auth.middleware')

const router = express.Router()
const uploadsPath = path.resolve(__dirname, '..', 'uploads')

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let folder = 'images'
    if (file.mimetype.startsWith('video')) folder = 'videos'
    if (file.mimetype === 'application/pdf') folder = 'pdfs'
    cb(null, path.join(uploadsPath, folder))
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`)
  }
})

const upload = multer({ storage })

async function listAllGroups() {
  const db = await getDb()
  return db.all('SELECT id, name, display_order as displayOrder FROM groups ORDER BY display_order, name')
}

async function resolveGroupId(req, options = {}) {
  const { forWrite = false } = options
  const db = await getDb()
  const user = req.user

  if (forWrite && !user) {
    const error = new Error('Nao autenticado')
    error.status = 401
    throw error
  }

  const queryGroupId = Number(
    req.query.groupId || req.body?.groupId || req.params?.groupId
  )
  const queryGroupName = String(req.query.group || req.body?.group || '')
    .trim()
    .toLowerCase()

  if (user && user.role !== 'master') {
    if (queryGroupId && queryGroupId !== user.group_id) {
      const error = new Error('Acesso negado para este grupo')
      error.status = 403
      throw error
    }
    return user.group_id
  }

  if (queryGroupId > 0) {
    const group = await db.get('SELECT id FROM groups WHERE id = ?', [queryGroupId])
    if (!group) {
      const error = new Error('Grupo nao encontrado')
      error.status = 404
      throw error
    }
    return group.id
  }

  if (queryGroupName) {
    const group = await db.get(
      'SELECT id FROM groups WHERE lower(name) = ?',
      [queryGroupName]
    )
    if (group) return group.id
  }

  const fallback = await db.get('SELECT id FROM groups ORDER BY id LIMIT 1')
  if (!fallback) {
    const error = new Error('Nenhum grupo cadastrado')
    error.status = 500
    throw error
  }
  return fallback.id
}

function mapSlide(row) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    src: row.src,
    duration: row.duration
  }
}

async function loadPlaylistByGroup(groupId) {
  const db = await getDb()
  const rows = await db.all(
    `
    SELECT id, type, name, src, duration
    FROM slides
    WHERE group_id = ?
    ORDER BY position, id
    `,
    [groupId]
  )
  return rows.map(mapSlide)
}

async function emitGroupUpdate(req, eventName, groupId, payload = {}) {
  const io = req.app.get('io')
  io.emit(eventName, { groupId, ...payload })
}

router.get('/groups', async (req, res, next) => {
  try {
    if (req.user && req.user.role !== 'master') {
      const groups = await getDb().then((db) =>
        db.all(
          'SELECT id, name, display_order as displayOrder FROM groups WHERE id = ? ORDER BY display_order, name',
          [req.user.group_id]
        )
      )
      return res.json(groups)
    }
    return res.json(await listAllGroups())
  } catch (error) {
    return next(error)
  }
})

router.post('/groups/reorder', requireAuth, requireMaster, express.json(), async (req, res, next) => {
  try {
    const order = Array.isArray(req.body?.order) ? req.body.order : []
    if (!order.length) {
      return res.status(400).json({ error: 'Informe a ordem dos grupos' })
    }

    const db = await getDb()
    const groupIds = order.map((id) => Number(id)).filter((id) => id > 0)
    const existing = await db.all(
      `SELECT id FROM groups WHERE id IN (${groupIds.map(() => '?').join(',')})`,
      groupIds
    )
    if (existing.length !== groupIds.length) {
      return res.status(400).json({ error: 'Lista de grupos invalida' })
    }

    await db.run('BEGIN TRANSACTION')
    try {
      for (let index = 0; index < groupIds.length; index += 1) {
        await db.run('UPDATE groups SET display_order = ? WHERE id = ?', [
          index + 1,
          groupIds[index]
        ])
      }
      await db.run('COMMIT')
    } catch (error) {
      await db.run('ROLLBACK')
      throw error
    }

    await emitGroupUpdate(req, 'groups:update', null)
    return res.json({ ok: true })
  } catch (error) {
    return next(error)
  }
})

router.get('/playlist', async (req, res, next) => {
  try {
    const groupId = await resolveGroupId(req)
    const playlist = await loadPlaylistByGroup(groupId)
    return res.json(playlist)
  } catch (error) {
    return next(error)
  }
})

router.get('/settings', async (req, res, next) => {
  try {
    const groupId = await resolveGroupId(req)
    const db = await getDb()
    const group = await db.get(
      'SELECT id, name, background, default_image FROM groups WHERE id = ?',
      [groupId]
    )
    return res.json({
      groupId: group.id,
      groupName: group.name,
      background: group.background || '#ffffff',
      defaultImage: group.default_image || null
    })
  } catch (error) {
    return next(error)
  }
})

router.post('/settings', requireAuth, express.json(), async (req, res, next) => {
  try {
    const groupId = await resolveGroupId(req, { forWrite: true })
    const background = String(req.body?.background || '#ffffff').trim() || '#ffffff'
    const defaultImage = req.body?.defaultImage
      ? String(req.body.defaultImage).trim()
      : null

    const db = await getDb()
    await db.run(
      `
      UPDATE groups
      SET background = ?, default_image = COALESCE(?, default_image)
      WHERE id = ?
      `,
      [background, defaultImage, groupId]
    )

    const settings = await db.get(
      'SELECT background, default_image as defaultImage FROM groups WHERE id = ?',
      [groupId]
    )
    await emitGroupUpdate(req, 'settings:update', groupId, settings)
    return res.json(settings)
  } catch (error) {
    return next(error)
  }
})

router.post(
  '/default-image',
  requireAuth,
  upload.single('defaultImage'),
  async (req, res, next) => {
    try {
      const groupId = await resolveGroupId(req, { forWrite: true })
      if (!req.file || !req.file.mimetype.startsWith('image')) {
        return res.status(400).json({ error: 'Envie uma imagem valida' })
      }

      const src = `/uploads/images/${req.file.filename}`
      const db = await getDb()
      await db.run(
        'UPDATE groups SET default_image = ? WHERE id = ?',
        [src, groupId]
      )

      await emitGroupUpdate(req, 'settings:update', groupId, {
        defaultImage: src
      })

      return res.json({ defaultImage: src })
    } catch (error) {
      return next(error)
    }
  }
)

router.post('/upload', requireAuth, upload.single('media'), async (req, res, next) => {
  try {
    const groupId = await resolveGroupId(req, { forWrite: true })
    const file = req.file
    if (!file) return res.sendStatus(400)

    const type = file.mimetype.startsWith('image')
      ? 'image'
      : file.mimetype.startsWith('video')
      ? 'video'
      : 'pdf'

    const src = `/uploads/${
      type === 'image' ? 'images' : type === 'video' ? 'videos' : 'pdfs'
    }/${file.filename}`

    const duration = Math.max(1000, Number(req.body?.duration || 5) * 1000)
    const db = await getDb()
    const positionInfo = await db.get(
      'SELECT COALESCE(MAX(position), -1) + 1 as nextPosition FROM slides WHERE group_id = ?',
      [groupId]
    )

    await db.run(
      `
      INSERT INTO slides (group_id, type, name, src, duration, position)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        groupId,
        type,
        String(req.body?.name || file.originalname),
        src,
        duration,
        positionInfo.nextPosition
      ]
    )

    await emitGroupUpdate(req, 'playlist:update', groupId)
    return res.redirect('/admin')
  } catch (error) {
    return next(error)
  }
})

router.post('/reorder', requireAuth, express.json(), async (req, res, next) => {
  try {
    const groupId = await resolveGroupId(req, { forWrite: true })
    const index = Number(req.body?.index)
    const dir = Number(req.body?.dir)
    if (!Number.isInteger(index) || !Number.isInteger(dir)) {
      return res.sendStatus(400)
    }

    const db = await getDb()
    const slides = await db.all(
      `
      SELECT id, position
      FROM slides
      WHERE group_id = ?
      ORDER BY position, id
      `,
      [groupId]
    )

    const newIndex = index + dir
    if (newIndex < 0 || newIndex >= slides.length) {
      return res.sendStatus(200)
    }

    const current = slides[index]
    const target = slides[newIndex]
    if (!current || !target) return res.sendStatus(400)

    await db.run('BEGIN TRANSACTION')
    try {
      await db.run('UPDATE slides SET position = ? WHERE id = ?', [
        target.position,
        current.id
      ])
      await db.run('UPDATE slides SET position = ? WHERE id = ?', [
        current.position,
        target.id
      ])
      await db.run('COMMIT')
    } catch (error) {
      await db.run('ROLLBACK')
      throw error
    }

    await emitGroupUpdate(req, 'playlist:update', groupId)
    return res.sendStatus(200)
  } catch (error) {
    return next(error)
  }
})

router.post('/delete', requireAuth, express.json(), async (req, res, next) => {
  try {
    const groupId = await resolveGroupId(req, { forWrite: true })
    const index = Number(req.body?.index)
    if (!Number.isInteger(index)) return res.sendStatus(400)

    const db = await getDb()
    const slides = await db.all(
      `
      SELECT id, src
      FROM slides
      WHERE group_id = ?
      ORDER BY position, id
      `,
      [groupId]
    )
    const item = slides[index]
    if (!item) return res.sendStatus(400)

    const filePath = path.resolve(
      __dirname,
      '..',
      item.src.replace('/uploads', 'uploads')
    )
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }

    await db.run('DELETE FROM slides WHERE id = ?', [item.id])

    const remaining = await db.all(
      `
      SELECT id
      FROM slides
      WHERE group_id = ?
      ORDER BY position, id
      `,
      [groupId]
    )
    for (let position = 0; position < remaining.length; position += 1) {
      await db.run('UPDATE slides SET position = ? WHERE id = ?', [
        position,
        remaining[position].id
      ])
    }

    await emitGroupUpdate(req, 'playlist:update', groupId)
    return res.sendStatus(200)
  } catch (error) {
    return next(error)
  }
})

module.exports = router
