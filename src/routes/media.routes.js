const express = require('express')
const fs = require('fs')
const path = require('path')
const multer = require('multer')

const { getDb } = require('../db')
const { requireAuth, requireMaster } = require('../middlewares/auth.middleware')
const { getUploadsDir } = require('../config/runtime-paths')

const router = express.Router()
const uploadsPath = getUploadsDir()

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
    campaignId: row.campaign_id || null,
    type: row.type,
    name: row.name,
    src: row.src,
    duration: row.duration,
    isLocked: Number(row.is_locked) === 1
  }
}

async function loadPlaylistByGroup(groupId) {
  const db = await getDb()
  const rows = await db.all(
    `
    SELECT id, campaign_id, type, name, src, duration, is_locked
    FROM slides
    WHERE group_id = ?
    ORDER BY position, id
    `,
    [groupId]
  )
  return rows.map(mapSlide)
}

async function resolvePublicGroupId(rawGroupId) {
  const db = await getDb()
  const groupId = Number(rawGroupId)
  if (Number.isInteger(groupId) && groupId > 0) {
    const group = await db.get('SELECT id FROM groups WHERE id = ?', [groupId])
    if (group) return group.id
  }
  const fallback = await db.get('SELECT id FROM groups ORDER BY display_order, id LIMIT 1')
  if (!fallback) {
    const error = new Error('Nenhum grupo cadastrado')
    error.status = 500
    throw error
  }
  return fallback.id
}

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

async function resolveActiveCampaign(db, groupId) {
  const campaigns = await db.all(
    `
    SELECT id, name, starts_at, ends_at, active, priority
    FROM campaigns
    WHERE group_id = ?
    ORDER BY priority ASC, starts_at ASC, id ASC
    `,
    [groupId]
  )

  const active = campaigns.find(
    (campaign) =>
      getCampaignStatus(campaign.starts_at, campaign.ends_at, Number(campaign.active) === 1) ===
      'executando'
  )
  return active || null
}

async function buildActivePayload(groupId) {
  const db = await getDb()
  const activeCampaign = await resolveActiveCampaign(db, groupId)
  const coverRows = await db.all(
    `
    SELECT id, campaign_id, type, name, src, duration, is_locked
    FROM slides
    WHERE group_id = ? AND campaign_id IS NULL
    ORDER BY position, id
    `,
    [groupId]
  )

  let rows = []
  if (activeCampaign) {
    rows = await db.all(
      `
      SELECT id, campaign_id, type, name, src, duration, is_locked
      FROM slides
      WHERE group_id = ? AND campaign_id = ?
      ORDER BY position, id
      `,
      [groupId, activeCampaign.id]
    )
  } else {
    rows = []
  }

  return {
    campaign: activeCampaign
      ? {
          id: activeCampaign.id,
          name: activeCampaign.name
        }
      : null,
    coverSlides: coverRows.map(mapSlide),
    slides: rows.map(mapSlide)
  }
}

async function emitGroupUpdate(req, eventName, groupId, payload = {}) {
  const io = req.app.get('io')
  io.emit(eventName, { groupId, ...payload })
}

router.get('/runtime-config', (req, res) => {
  const raw = Number(process.env.AUTO_REFRESH_MS)
  const autoRefreshMs = Number.isFinite(raw) ? Math.max(5000, Math.min(300000, raw)) : 15000
  return res.json({ autoRefreshMs })
})

router.get('/public/groups', async (req, res, next) => {
  try {
    return res.json(await listAllGroups())
  } catch (error) {
    return next(error)
  }
})

router.get('/public/settings', async (req, res, next) => {
  try {
    const groupId = await resolvePublicGroupId(req.query.groupId)
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

router.get('/public/playlist/active', async (req, res, next) => {
  try {
    const groupId = await resolvePublicGroupId(req.query.groupId)
    return res.json(await buildActivePayload(groupId))
  } catch (error) {
    return next(error)
  }
})

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

router.get('/playlist/active', async (req, res, next) => {
  try {
    const groupId = await resolveGroupId(req)
    return res.json(await buildActivePayload(groupId))
  } catch (error) {
    return next(error)
  }
})

router.get('/campaigns', requireAuth, async (req, res, next) => {
  try {
    const groupId = await resolveGroupId(req, { forWrite: true })
    const db = await getDb()
    const campaigns = await db.all(
      `
      SELECT id, group_id as groupId, name, starts_at as startsAt, ends_at as endsAt, active, priority
      FROM campaigns
      WHERE group_id = ?
      ORDER BY starts_at ASC, id ASC
      `,
      [groupId]
    )

    return res.json(
      campaigns.map((item) => ({
        ...item,
        active: Number(item.active) === 1,
        status: getCampaignStatus(item.startsAt, item.endsAt, Number(item.active) === 1)
      }))
    )
  } catch (error) {
    return next(error)
  }
})

router.post('/campaigns', requireAuth, express.json(), async (req, res, next) => {
  try {
    const groupId = await resolveGroupId(req, { forWrite: true })
    const name = String(req.body?.name || '').trim()
    const startsAt = String(req.body?.startsAt || '').trim()
    const endsAt = String(req.body?.endsAt || '').trim()
    const priority = Number(req.body?.priority || 1)

    if (!name || !startsAt || !endsAt) {
      return res.status(400).json({ error: 'Nome, inicio e fim sao obrigatorios' })
    }
    if (new Date(startsAt).getTime() >= new Date(endsAt).getTime()) {
      return res.status(400).json({ error: 'Data/hora de fim deve ser maior que a de inicio' })
    }

    const db = await getDb()
    const created = await db.run(
      `
      INSERT INTO campaigns (group_id, name, starts_at, ends_at, active, priority, created_by_user_id)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      `,
      [groupId, name, startsAt, endsAt, Math.max(1, priority), req.user.id || null]
    )

    await emitGroupUpdate(req, 'playlist:update', groupId)
    return res.status(201).json({ id: created.lastID })
  } catch (error) {
    return next(error)
  }
})

router.post('/campaigns/update', requireAuth, express.json(), async (req, res, next) => {
  try {
    const groupId = await resolveGroupId(req, { forWrite: true })
    const campaignId = Number(req.body?.campaignId)
    const name = String(req.body?.name || '').trim()
    const startsAt = String(req.body?.startsAt || '').trim()
    const endsAt = String(req.body?.endsAt || '').trim()
    const priority = Number(req.body?.priority || 1)

    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: 'Campanha invalida' })
    }
    if (!name || !startsAt || !endsAt) {
      return res.status(400).json({ error: 'Nome, inicio e fim sao obrigatorios' })
    }
    if (new Date(startsAt).getTime() >= new Date(endsAt).getTime()) {
      return res.status(400).json({ error: 'Data/hora de fim deve ser maior que a de inicio' })
    }

    const db = await getDb()
    const campaign = await db.get(
      'SELECT id FROM campaigns WHERE id = ? AND group_id = ?',
      [campaignId, groupId]
    )
    if (!campaign) {
      return res.status(404).json({ error: 'Campanha nao encontrada' })
    }

    await db.run(
      `
      UPDATE campaigns
      SET name = ?, starts_at = ?, ends_at = ?, priority = ?
      WHERE id = ? AND group_id = ?
      `,
      [name, startsAt, endsAt, Math.max(1, priority), campaignId, groupId]
    )

    await emitGroupUpdate(req, 'playlist:update', groupId)
    return res.json({ ok: true })
  } catch (error) {
    return next(error)
  }
})

router.post('/campaigns/delete', requireAuth, express.json(), async (req, res, next) => {
  try {
    const groupId = await resolveGroupId(req, { forWrite: true })
    const campaignId = Number(req.body?.campaignId)
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: 'Campanha invalida' })
    }

    const db = await getDb()
    const campaign = await db.get(
      'SELECT id FROM campaigns WHERE id = ? AND group_id = ?',
      [campaignId, groupId]
    )
    if (!campaign) {
      return res.status(404).json({ error: 'Campanha nao encontrada' })
    }

    const slides = await db.all(
      `
      SELECT id, src
      FROM slides
      WHERE group_id = ? AND campaign_id = ?
      `,
      [groupId, campaignId]
    )

    await db.run('BEGIN TRANSACTION')
    try {
      await db.run('DELETE FROM slides WHERE group_id = ? AND campaign_id = ?', [groupId, campaignId])
      await db.run('DELETE FROM campaigns WHERE id = ?', [campaignId])
      await db.run('COMMIT')
    } catch (error) {
      await db.run('ROLLBACK')
      throw error
    }

    for (const slide of slides) {
      const refs = await db.get(
        'SELECT COUNT(*) as total FROM slides WHERE src = ?',
        [slide.src]
      )
      if (Number(refs?.total || 0) > 0) continue

      const filePath = path.resolve(
        __dirname,
        '..',
        slide.src.replace('/uploads', 'uploads')
      )
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    }

    await emitGroupUpdate(req, 'playlist:update', groupId)
    return res.json({ ok: true })
  } catch (error) {
    return next(error)
  }
})

router.get('/campaigns/slides', requireAuth, async (req, res, next) => {
  try {
    const groupId = await resolveGroupId(req, { forWrite: true })
    const campaignRaw = String(req.query?.campaignId || '').trim()
    const isBaseScope = campaignRaw === 'base'
    const campaignId = Number(campaignRaw)
    if (!isBaseScope && (!Number.isInteger(campaignId) || campaignId <= 0)) {
      return res.status(400).json({ error: 'Campanha invalida' })
    }

    const db = await getDb()
    if (!isBaseScope) {
      const campaign = await db.get(
        'SELECT id FROM campaigns WHERE id = ? AND group_id = ?',
        [campaignId, groupId]
      )
      if (!campaign) {
        return res.status(404).json({ error: 'Campanha nao encontrada' })
      }
    }

    const rows = isBaseScope
      ? await db.all(
          `
          SELECT id, campaign_id, type, name, src, duration, is_locked
          FROM slides
          WHERE group_id = ? AND campaign_id IS NULL
          ORDER BY position, id
          `,
          [groupId]
        )
      : await db.all(
          `
          SELECT id, campaign_id, type, name, src, duration, is_locked
          FROM slides
          WHERE group_id = ? AND campaign_id = ?
          ORDER BY position, id
          `,
          [groupId, campaignId]
        )

    return res.json(rows.map(mapSlide))
  } catch (error) {
    return next(error)
  }
})

router.post('/campaigns/slides/update', requireAuth, express.json(), async (req, res, next) => {
  try {
    const groupId = await resolveGroupId(req, { forWrite: true })
    const slideId = Number(req.body?.slideId)
    const durationSeconds = Number(req.body?.duration)

    if (!Number.isInteger(slideId) || slideId <= 0) {
      return res.status(400).json({ error: 'Slide invalido' })
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return res.status(400).json({ error: 'Duracao invalida' })
    }

    const db = await getDb()
    const slide = await db.get(
      `
      SELECT id, campaign_id, is_locked
      FROM slides
      WHERE id = ? AND group_id = ?
      `,
      [slideId, groupId]
    )
    if (!slide) {
      return res.status(404).json({ error: 'Slide nao encontrado' })
    }
    if (req.user.role !== 'master' && !slide.campaign_id) {
      return res.status(403).json({ error: 'Somente master pode editar capas do grupo' })
    }
    if (req.user.role !== 'master' && Number(slide.is_locked) === 1) {
      return res.status(403).json({
        error: 'Slide protegido pelo master nao pode ser alterado'
      })
    }

    const duration = Math.max(1000, Math.round(durationSeconds * 1000))
    await db.run('UPDATE slides SET duration = ? WHERE id = ?', [duration, slideId])

    await emitGroupUpdate(req, 'playlist:update', groupId)
    return res.json({ ok: true })
  } catch (error) {
    return next(error)
  }
})

router.post('/campaigns/slides/delete', requireAuth, express.json(), async (req, res, next) => {
  try {
    const groupId = await resolveGroupId(req, { forWrite: true })
    const slideId = Number(req.body?.slideId)
    if (!Number.isInteger(slideId) || slideId <= 0) {
      return res.status(400).json({ error: 'Slide invalido' })
    }

    const db = await getDb()
    const slide = await db.get(
      `
      SELECT id, src, campaign_id, is_locked
      FROM slides
      WHERE id = ? AND group_id = ?
      `,
      [slideId, groupId]
    )
    if (!slide) {
      return res.status(404).json({ error: 'Slide nao encontrado' })
    }
    if (req.user.role !== 'master' && !slide.campaign_id) {
      return res.status(403).json({ error: 'Somente master pode excluir capas do grupo' })
    }
    if (req.user.role !== 'master' && Number(slide.is_locked) === 1) {
      return res.status(403).json({
        error: 'Slide protegido pelo master nao pode ser excluido'
      })
    }

    const filePath = path.resolve(
      __dirname,
      '..',
      slide.src.replace('/uploads', 'uploads')
    )
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }

    await db.run('DELETE FROM slides WHERE id = ?', [slideId])

    const remaining = await db.all(
      `
      SELECT id
      FROM slides
      WHERE group_id = ? AND (
        (campaign_id = ?)
        OR (campaign_id IS NULL AND ? IS NULL)
      )
      ORDER BY position, id
      `,
      [groupId, slide.campaign_id, slide.campaign_id]
    )
    for (let position = 0; position < remaining.length; position += 1) {
      await db.run('UPDATE slides SET position = ? WHERE id = ?', [
        position,
        remaining[position].id
      ])
    }

    await emitGroupUpdate(req, 'playlist:update', groupId)
    return res.json({ ok: true })
  } catch (error) {
    return next(error)
  }
})

router.post('/campaigns/slides/reorder', requireAuth, express.json(), async (req, res, next) => {
  try {
    const groupId = await resolveGroupId(req, { forWrite: true })
    const slideId = Number(req.body?.slideId)
    const dir = Number(req.body?.dir)
    if (!Number.isInteger(slideId) || slideId <= 0 || !Number.isInteger(dir)) {
      return res.status(400).json({ error: 'Dados invalidos para reordenacao' })
    }

    const db = await getDb()
    const current = await db.get(
      `
      SELECT id, campaign_id, position, is_locked
      FROM slides
      WHERE id = ? AND group_id = ?
      `,
      [slideId, groupId]
    )
    if (!current) {
      return res.status(404).json({ error: 'Slide nao encontrado' })
    }
    if (req.user.role !== 'master' && !current.campaign_id) {
      return res.status(403).json({ error: 'Somente master pode ordenar capas do grupo' })
    }

    const scopeRows = await db.all(
      `
      SELECT id, position, is_locked
      FROM slides
      WHERE group_id = ? AND (
        (campaign_id = ?)
        OR (campaign_id IS NULL AND ? IS NULL)
      )
      ORDER BY position, id
      `,
      [groupId, current.campaign_id, current.campaign_id]
    )
    const index = scopeRows.findIndex((row) => row.id === current.id)
    const nextIndex = index + dir
    if (index < 0 || nextIndex < 0 || nextIndex >= scopeRows.length) {
      return res.json({ ok: true, changed: false })
    }

    const target = scopeRows[nextIndex]
    if (
      req.user.role !== 'master' &&
      (Number(current.is_locked) === 1 || Number(target.is_locked) === 1)
    ) {
      return res.status(403).json({
        error: 'Slide protegido pelo master nao pode ter posicao alterada'
      })
    }

    await db.run('BEGIN TRANSACTION')
    try {
      await db.run('UPDATE slides SET position = ? WHERE id = ?', [target.position, current.id])
      await db.run('UPDATE slides SET position = ? WHERE id = ?', [current.position, target.id])
      await db.run('COMMIT')
    } catch (error) {
      await db.run('ROLLBACK')
      throw error
    }

    await emitGroupUpdate(req, 'playlist:update', groupId)
    return res.json({ ok: true, changed: true })
  } catch (error) {
    return next(error)
  }
})

router.post(
  '/campaigns/upload',
  requireAuth,
  upload.single('mediaFile'),
  async (req, res, next) => {
    try {
      const groupId = await resolveGroupId(req, { forWrite: true })
      const file = req.file
      if (!file) {
        return res.status(400).json({ error: 'Selecione uma imagem' })
      }
      if (!file.mimetype.startsWith('image')) {
        return res.status(400).json({ error: 'Somente imagens sao permitidas nesta tela' })
      }

      const db = await getDb()
      const duration = Math.max(1000, Number(req.body?.duration || 5) * 1000)
      const inputName = String(req.body?.name || '').trim()
      const shouldLock =
        req.user.role === 'master' &&
        (req.body?.protectSlide === '1' || req.body?.protectSlide === 'true')
      const incomingCampaignId = req.body?.campaignId
        ? String(req.body.campaignId).trim()
        : ''
      let campaignId = null

      if (incomingCampaignId && incomingCampaignId !== '__create__') {
        const existingCampaign = await db.get(
          'SELECT id FROM campaigns WHERE id = ? AND group_id = ?',
          [Number(incomingCampaignId), groupId]
        )
        if (!existingCampaign) {
          return res.status(400).json({ error: 'Campanha invalida para este grupo' })
        }
        campaignId = existingCampaign.id
      } else if (incomingCampaignId === '__create__') {
        const name = String(req.body?.campaignName || '').trim()
        const startsAt = String(req.body?.startsAt || '').trim()
        const endsAt = String(req.body?.endsAt || '').trim()
        const priority = Math.max(1, Number(req.body?.priority || 1))

        if (!name || !startsAt || !endsAt) {
          return res.status(400).json({
            error: 'Para criar campanha, informe nome, inicio e fim'
          })
        }
        if (new Date(startsAt).getTime() >= new Date(endsAt).getTime()) {
          return res.status(400).json({
            error: 'Data/hora de fim deve ser maior que a de inicio'
          })
        }

        const created = await db.run(
          `
          INSERT INTO campaigns (group_id, name, starts_at, ends_at, active, priority, created_by_user_id)
          VALUES (?, ?, ?, ?, 1, ?, ?)
          `,
          [groupId, name, startsAt, endsAt, priority, req.user.id || null]
        )
        campaignId = created.lastID
      }

      if (req.user.role !== 'master' && !campaignId) {
        return res.status(400).json({
          error: 'Usuario de grupo deve selecionar ou criar uma campanha'
        })
      }

      const isBaseUpload = !campaignId
      const lockAsCover = req.user.role === 'master' && isBaseUpload ? true : shouldLock
      let insertPosition = 0

      if (isBaseUpload && lockAsCover) {
        await db.run(
          'UPDATE slides SET position = position + 1 WHERE group_id = ? AND campaign_id IS NULL',
          [groupId]
        )
        insertPosition = 0
      } else {
        const positionInfo = campaignId
          ? await db.get(
              'SELECT COALESCE(MAX(position), -1) + 1 as nextPosition FROM slides WHERE group_id = ? AND campaign_id = ?',
              [groupId, campaignId]
            )
          : await db.get(
              'SELECT COALESCE(MAX(position), -1) + 1 as nextPosition FROM slides WHERE group_id = ? AND campaign_id IS NULL',
              [groupId]
            )
        insertPosition = positionInfo.nextPosition
      }

      await db.run(
        `
        INSERT INTO slides (group_id, campaign_id, type, name, src, duration, position, is_locked, created_by_user_id)
        VALUES (?, ?, 'image', ?, ?, ?, ?, ?, ?)
        `,
        [
          groupId,
          campaignId,
          inputName || file.originalname,
          `/uploads/images/${file.filename}`,
          duration,
          insertPosition,
          lockAsCover ? 1 : 0,
          req.user.id || null
        ]
      )

      await emitGroupUpdate(req, 'playlist:update', groupId)
      return res.json({ ok: true, campaignId, uploaded: 1 })
    } catch (error) {
      return next(error)
    }
  }
)

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

router.post('/default-image/remove', requireAuth, express.json(), async (req, res, next) => {
  try {
    const groupId = await resolveGroupId(req, { forWrite: true })
    const db = await getDb()
    const current = await db.get(
      'SELECT default_image FROM groups WHERE id = ?',
      [groupId]
    )

    if (current && current.default_image) {
      const filePath = path.resolve(
        __dirname,
        '..',
        current.default_image.replace('/uploads', 'uploads')
      )
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    }

    await db.run('UPDATE groups SET default_image = NULL WHERE id = ?', [groupId])
    await emitGroupUpdate(req, 'settings:update', groupId, { defaultImage: null })
    return res.json({ ok: true })
  } catch (error) {
    return next(error)
  }
})

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
    const campaignId = req.body?.campaignId ? Number(req.body.campaignId) : null
    const shouldLock =
      req.user.role === 'master' &&
      (req.body?.protectSlide === '1' || req.body?.protectSlide === 'true')

    if (req.user.role !== 'master' && !campaignId) {
      return res.status(400).json({
        error: 'Selecione ou crie uma campanha antes de enviar a midia'
      })
    }

    const db = await getDb()
    if (campaignId) {
      const campaign = await db.get(
        'SELECT id FROM campaigns WHERE id = ? AND group_id = ?',
        [campaignId, groupId]
      )
      if (!campaign) {
        return res.status(400).json({ error: 'Campanha invalida para este grupo' })
      }
    }

    let insertPosition = 0
    if (shouldLock) {
      // Master-protected slides are pinned to the top on insert.
      await db.run(
        'UPDATE slides SET position = position + 1 WHERE group_id = ?',
        [groupId]
      )
      insertPosition = 0
    } else {
      const positionInfo = await db.get(
        'SELECT COALESCE(MAX(position), -1) + 1 as nextPosition FROM slides WHERE group_id = ?',
        [groupId]
      )
      insertPosition = positionInfo.nextPosition
    }

    await db.run(
      `
      INSERT INTO slides (group_id, campaign_id, type, name, src, duration, position, is_locked, created_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        groupId,
        campaignId,
        type,
        String(req.body?.name || file.originalname),
        src,
        duration,
        insertPosition,
        shouldLock ? 1 : 0,
        req.user.id || null
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
      SELECT id, campaign_id, position, is_locked
      FROM slides
      WHERE group_id = ?
      ORDER BY position, id
      `,
      [groupId]
    )

    const newIndex = index + dir
    if (newIndex < 0 || newIndex >= slides.length) {
      return res.json({ ok: true, changed: false })
    }

    const current = slides[index]
    const target = slides[newIndex]
    if (!current || !target) return res.sendStatus(400)
    if (
      req.user.role !== 'master' &&
      (Number(current.is_locked) === 1 ||
        Number(target.is_locked) === 1 ||
        current.campaign_id == null ||
        target.campaign_id == null)
    ) {
      return res.status(403).json({
        error: 'Slide protegido pelo master nao pode ter posicao alterada'
      })
    }

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
    return res.json({ ok: true, changed: true })
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
      SELECT id, src, campaign_id, is_locked
      FROM slides
      WHERE group_id = ?
      ORDER BY position, id
      `,
      [groupId]
    )
    const item = slides[index]
    if (!item) return res.sendStatus(400)
    if (
      req.user.role !== 'master' &&
      (Number(item.is_locked) === 1 || item.campaign_id == null)
    ) {
      return res.status(403).json({
        error: 'Slide protegido pelo master nao pode ser excluido'
      })
    }

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
    return res.json({ ok: true })
  } catch (error) {
    return next(error)
  }
})

module.exports = router
