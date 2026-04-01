const express = require('express')
const fs = require('fs')
const path = require('path')
const multer = require('multer')

const { getDb } = require('../db')
const { requireAuth, requireMaster } = require('../middlewares/auth.middleware')
const { getUploadsDir } = require('../config/runtime-paths')

const router = express.Router()
const uploadsPath = getUploadsDir()
function isAdminOrMaster(user) {
  return user && (user.role === 'master' || user.role === 'admin')
}

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
const MAX_SLIDE_DURATION_SECONDS = 30

const campaignUploadFields = upload.fields([
  { name: 'mediaFile', maxCount: 1 },
  { name: 'file', maxCount: 1 }
])

function getUploadedCampaignFile(req) {
  if (req.file) return req.file
  if (req.files?.mediaFile?.[0]) return req.files.mediaFile[0]
  if (req.files?.file?.[0]) return req.files.file[0]
  return null
}

function normalizeUploadDurationMs(rawValue, fallbackSeconds = 5) {
  const parsed = Number(rawValue)
  const fallback = Number.isFinite(fallbackSeconds) ? fallbackSeconds : 5
  const safeSeconds = Number.isFinite(parsed) ? parsed : fallback
  const clampedSeconds = Math.min(MAX_SLIDE_DURATION_SECONDS, Math.max(1, safeSeconds))
  return Math.round(clampedSeconds * 1000)
}

function calculateCycleTimes(receivedStartsAt) {
  const startDate = new Date(receivedStartsAt);
  const startOfHour = new Date(startDate);
  startOfHour.setMinutes(0, 0, 0); // Define o início da hora

  const endOfHour = new Date(startOfHour);
  endOfHour.setHours(endOfHour.getHours() + 1); // Próxima hora
  endOfHour.setSeconds(endOfHour.getSeconds() - 1); // Último segundo antes do próximo ciclo

  const startsAt = startDate.toISOString();
  const endsAt = endOfHour.toISOString();

  return { startsAt, endsAt };
}


function parseCampaignDateTime(rawValue) {
  const raw = String(rawValue || '').trim()
  if (!raw) return null

  if (/^\d+$/.test(raw)) {
    const timestamp = Number(raw)
    if (Number.isFinite(timestamp)) {
      const fromTimestamp = new Date(timestamp)
      if (!Number.isNaN(fromTimestamp.getTime())) return fromTimestamp.toISOString()
    }
  }

  if (/([zZ]|[+\-]\d{2}:\d{2})$/.test(raw)) {
    const directDate = new Date(raw)
    if (!Number.isNaN(directDate.getTime())) return directDate.toISOString()
  }

  const isoLocal = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/)
  if (isoLocal) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = isoLocal
    const localDate = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
    if (!Number.isNaN(localDate.getTime())) return localDate.toISOString()
  }

  const brLocal = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/)
  if (brLocal) {
    const [, day, month, year, hour = '0', minute = '0', second = '0'] = brLocal
    const localDate = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
    if (!Number.isNaN(localDate.getTime())) return localDate.toISOString()
  }

  const fallback = new Date(raw)
  if (!Number.isNaN(fallback.getTime())) return fallback.toISOString()
  return null
}

function resolveApiCampaignTimes(body) {
  const rawStartsAt = String(body?.startsAt || '').trim()
  const rawEndsAt = String(body?.endsAt || '').trim()

  if (rawStartsAt && rawEndsAt) {
    const startsAt = parseCampaignDateTime(rawStartsAt)
    const endsAt = parseCampaignDateTime(rawEndsAt)

    if (!startsAt || !endsAt) {
      const error = new Error('Datas da campanha invalidas')
      error.status = 400
      throw error
    }

    if (new Date(startsAt).getTime() >= new Date(endsAt).getTime()) {
      const error = new Error('Data/hora de fim deve ser maior que a de inicio')
      error.status = 400
      throw error
    }

    return { startsAt, endsAt, source: 'explicit-range' }
  }

  if (rawStartsAt) {
    const normalizedStartsAt = parseCampaignDateTime(rawStartsAt)
    if (!normalizedStartsAt) {
      const error = new Error('Data/hora de inicio invalida')
      error.status = 400
      throw error
    }

    return { ...calculateCycleTimes(normalizedStartsAt), source: 'cycle-fallback' }
  }

  return { ...calculateCycleTimes(new Date().toISOString()), source: 'cycle-fallback' }
}

function resolveUploadFilePath(src) {
  if (!src || !String(src).startsWith('/uploads/')) return null
  return path.resolve(__dirname, '..', String(src).replace('/uploads', 'uploads'))
}

async function deleteCampaignSlidesWithFiles(db, groupId, campaignId) {
  const slides = await db.all(
    `
    SELECT id, src
    FROM slides
    WHERE group_id = ? AND campaign_id = ?
    `,
    [groupId, campaignId]
  )

  for (const slide of slides) {
    const filePath = resolveUploadFilePath(slide.src)
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  }

  await db.run('DELETE FROM slides WHERE group_id = ? AND campaign_id = ?', [groupId, campaignId])
}


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

  if (user && !isAdminOrMaster(user)) {
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

function isCampaignReorderableStatus(status) {
  return status === 'executando' || status === 'agendada'
}

function getCampaignSortBucket(status) {
  return isCampaignReorderableStatus(status) ? 0 : 1
}

function isApiAutomationCampaign(row) {
  return Number(row.is_api_automation || row.isApiAutomation || 0) === 1
}

function sortCampaignRowsForDisplay(rows) {
  return [...rows].sort((left, right) => {
    const leftStatus = getCampaignStatus(left.starts_at || left.startsAt, left.ends_at || left.endsAt, Number(left.active) === 1)
    const rightStatus = getCampaignStatus(right.starts_at || right.startsAt, right.ends_at || right.endsAt, Number(right.active) === 1)

    const bucketDiff = getCampaignSortBucket(leftStatus) - getCampaignSortBucket(rightStatus)
    if (bucketDiff !== 0) return bucketDiff

    if (bucketDiff === 0 && getCampaignSortBucket(leftStatus) === 0) {
      const automationDiff =
        Number(isApiAutomationCampaign(right)) - Number(isApiAutomationCampaign(left))
      if (automationDiff !== 0) return automationDiff

      const leftPriority = Number(left.priority || 1)
      const rightPriority = Number(right.priority || 1)
      if (leftPriority !== rightPriority) return leftPriority - rightPriority
    }

    const leftStart = new Date(left.starts_at || left.startsAt).getTime()
    const rightStart = new Date(right.starts_at || right.startsAt).getTime()
    if (leftStart !== rightStart) return leftStart - rightStart

    return Number(left.id) - Number(right.id)
  })
}

async function resolveActiveCampaigns(db, groupId) {
  const campaigns = await db.all(
    `
    SELECT id, name, starts_at, ends_at, active, priority, is_api_automation
    FROM campaigns
    WHERE group_id = ?
    `,
    [groupId]
  )

  return sortCampaignRowsForDisplay(campaigns).filter(
    (campaign) =>
      getCampaignStatus(campaign.starts_at, campaign.ends_at, Number(campaign.active) === 1) ===
      'executando'
  )
}

async function buildActivePayload(groupId) {
  const db = await getDb()
  const activeCampaigns = await resolveActiveCampaigns(db, groupId)
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
  if (activeCampaigns.length) {
    for (const campaign of activeCampaigns) {
      const campaignRows = await db.all(
        `
        SELECT id, campaign_id, type, name, src, duration, is_locked
        FROM slides
        WHERE group_id = ? AND campaign_id = ?
        ORDER BY position, id
        `,
        [groupId, campaign.id]
      )
      rows.push(...campaignRows)
    }
  }

  return {
    campaign: activeCampaigns[0]
      ? {
          id: activeCampaigns[0].id,
          name: activeCampaigns[0].name
        }
      : null,
    activeCampaigns: activeCampaigns.map((item) => ({
      id: item.id,
      name: item.name
    })),
    coverSlides: coverRows.map(mapSlide),
    slides: rows.map(mapSlide)
  }
}

async function emitGroupUpdate(req, eventName, groupId, payload = {}) {
  const io = req.app.get('io')
  io.emit(eventName, { groupId, ...payload })
}

router.get('/runtime-config', async (req, res, next) => {
  try {
    const raw = Number(process.env.AUTO_REFRESH_MS)
    const autoRefreshMs = Number.isFinite(raw) ? Math.max(5000, Math.min(300000, raw)) : 15000
    return res.json({ autoRefreshMs })
  } catch (error) {
    return next(error)
  }
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
    if (req.user && !isAdminOrMaster(req.user)) {
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
      SELECT id, group_id as groupId, name, starts_at as startsAt, ends_at as endsAt, active, priority, is_api_automation as isApiAutomation
      FROM campaigns
      WHERE group_id = ?
      `,
      [groupId]
    )

    const sorted = sortCampaignRowsForDisplay(campaigns)
    return res.json(
      sorted.map((item) => ({
        ...item,
        active: Number(item.active) === 1,
        isApiAutomation: Number(item.isApiAutomation) === 1,
        status: getCampaignStatus(item.startsAt, item.endsAt, Number(item.active) === 1)
      }))
    )
  } catch (error) {
    return next(error)
  }
})

router.post('/campaigns/reorder', requireAuth, express.json(), async (req, res, next) => {
  try {
    const groupId = await resolveGroupId(req, { forWrite: true })
    const campaignId = Number(req.body?.campaignId)
    const dir = Number(req.body?.dir)
    if (!Number.isInteger(campaignId) || campaignId <= 0 || !Number.isInteger(dir)) {
      return res.status(400).json({ error: 'Dados invalidos para reordenacao' })
    }

    const db = await getDb()
    const campaigns = await db.all(
      `
      SELECT id, starts_at, ends_at, active, priority, is_api_automation
      FROM campaigns
      WHERE group_id = ?
      `,
      [groupId]
    )

    const reorderable = sortCampaignRowsForDisplay(campaigns).filter((item) =>
      isCampaignReorderableStatus(getCampaignStatus(item.starts_at, item.ends_at, Number(item.active) === 1)) &&
      !isApiAutomationCampaign(item)
    )

    const index = reorderable.findIndex((item) => item.id === campaignId)
    if (index < 0) {
      return res.status(400).json({ error: 'Campanhas da automacao ficam fixas no topo e nao podem ser reordenadas' })
    }

    const nextIndex = index + dir
    if (nextIndex < 0 || nextIndex >= reorderable.length) {
      return res.json({ ok: true, changed: false })
    }

    const temp = reorderable[index]
    reorderable[index] = reorderable[nextIndex]
    reorderable[nextIndex] = temp

    await db.run('BEGIN TRANSACTION')
    try {
      for (let orderIndex = 0; orderIndex < reorderable.length; orderIndex += 1) {
        await db.run('UPDATE campaigns SET priority = ? WHERE id = ? AND group_id = ?', [
          orderIndex + 1,
          reorderable[orderIndex].id,
          groupId
        ])
      }
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

router.post('/campaigns', requireAuth, express.json(), async (req, res, next) => {
  try {
    const groupId = await resolveGroupId(req, { forWrite: true })
    const name = String(req.body?.name || '').trim()
    const startsAt = String(req.body?.startsAt || '').trim()
    const endsAt = String(req.body?.endsAt || '').trim()

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
      VALUES (?, ?, ?, ?, 1, 1, ?)
      `,
      [groupId, name, startsAt, endsAt, req.user.id || null]
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
      SET name = ?, starts_at = ?, ends_at = ?
      WHERE id = ? AND group_id = ?
      `,
      [name, startsAt, endsAt, campaignId, groupId]
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
    if (!isAdminOrMaster(req.user) && !slide.campaign_id) {
      return res.status(403).json({ error: 'Somente master pode editar capas do grupo' })
    }
    if (!isAdminOrMaster(req.user) && Number(slide.is_locked) === 1) {
      return res.status(403).json({
        error: 'Slide protegido pelo master nao pode ser alterado'
      })
    }

    const duration = normalizeUploadDurationMs(durationSeconds, 5)
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
    if (!isAdminOrMaster(req.user) && !slide.campaign_id) {
      return res.status(403).json({ error: 'Somente master pode excluir capas do grupo' })
    }
    if (!isAdminOrMaster(req.user) && Number(slide.is_locked) === 1) {
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
    if (!isAdminOrMaster(req.user) && !current.campaign_id) {
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
      !isAdminOrMaster(req.user) &&
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


// rota API externa para cadastro de imagem de campanha
// - aceita multipart/form-data com campo `mediaFile` contendo o arquivo
// - outros campos seguem o mesmo formato da interface web (campaignId, campaignName, startsAt, endsAt, priority, duration, name, protectSlide, groupId/group)
// - é obrigatorio enviar header `x-api-key` (ou campo body apiKey) igual a process.env.API_UPLOAD_KEY
// - o usuário é simulado como ``master`` para permitir criacao de campanha e bloqueio
// - retorna JSON semelhante ao endpoint /campaigns/upload
router.post(
  '/api/campaigns/upload',
  campaignUploadFields,
  async (req, res, next) => {
    try {
      const apiKey = req.get('x-api-key') || req.body?.apiKey || ''
      if (!process.env.API_UPLOAD_KEY || apiKey !== process.env.API_UPLOAD_KEY) {
        return res.status(403).json({ error: 'API key invalida' })
      }
      // simula usuario master
      req.user = { role: 'master', id: null }

      const groupId = await resolveGroupId(req)
      const file = getUploadedCampaignFile(req)
      if (!file) {
        return res.status(400).json({ error: 'Selecione uma imagem' })
      }
      if (!file.mimetype.startsWith('image')) {
        return res.status(400).json({ error: 'Somente imagens sao permitidas' })
      }

      const db = await getDb()
      const duration = normalizeUploadDurationMs(req.body?.duration, 5)
      const inputName = String(req.body?.name || '').trim()
      const shouldLock =
        isAdminOrMaster(req.user) &&
        (req.body?.protectSlide === '1' || req.body?.protectSlide === 'true')
      // campanha existente identificada por nome fornecido
      const campaignName = String(req.body?.campaignName || '').trim()
      if (!campaignName) {
        return res.status(400).json({ error: 'Nome da campanha e obrigatorio' })
      }
      const { startsAt, endsAt } = resolveApiCampaignTimes(req.body)

      let campaignId = null
      const existingCampaign = await db.get(
        'SELECT id FROM campaigns WHERE lower(name) = lower(?) AND group_id = ?',
        [campaignName, groupId]
      )
      if (existingCampaign) {
        campaignId = existingCampaign.id
        await deleteCampaignSlidesWithFiles(db, groupId, campaignId)
        await db.run(
          `
          UPDATE campaigns
          SET starts_at = ?, ends_at = ?, active = 1, is_api_automation = 1
          WHERE id = ? AND group_id = ?
          `,
          [startsAt, endsAt, campaignId, groupId]
        )
      } else {
        const created = await db.run(
          `
          INSERT INTO campaigns (group_id, name, starts_at, ends_at, active, priority, is_api_automation, created_by_user_id)
          VALUES (?, ?, ?, ?, 1, 1, 1, ?)
          `,
          [groupId, campaignName, startsAt, endsAt, req.user.id]
        )
        campaignId = created.lastID
      }

      const isBaseUpload = !campaignId
      const lockAsCover = isAdminOrMaster(req.user) && isBaseUpload ? true : shouldLock
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
          req.user.id
        ]
      )

      await emitGroupUpdate(req, 'playlist:update', groupId)
      return res.json({ ok: true, campaignId, uploaded: 1 })
    } catch (error) {
      return next(error)
    }
  }
)

router.post(
  '/campaigns/upload',
  requireAuth,
  campaignUploadFields,
  async (req, res, next) => {
    try {
      const groupId = await resolveGroupId(req, { forWrite: true })
      const file = getUploadedCampaignFile(req)
      if (!file) {
        return res.status(400).json({ error: 'Selecione uma imagem' })
      }
      if (!file.mimetype.startsWith('image')) {
        return res.status(400).json({ error: 'Somente imagens sao permitidas nesta tela' })
      }

      const db = await getDb()
      const duration = normalizeUploadDurationMs(req.body?.duration, 5)
      const inputName = String(req.body?.name || '').trim()
      const shouldLock =
        isAdminOrMaster(req.user) &&
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
          VALUES (?, ?, ?, ?, 1, 1, ?)
          `,
          [groupId, name, startsAt, endsAt, req.user.id || null]
        )
        campaignId = created.lastID
      }

      if (!isAdminOrMaster(req.user) && !campaignId) {
        return res.status(400).json({
          error: 'Usuario de grupo deve selecionar ou criar uma campanha'
        })
      }

      const isBaseUpload = !campaignId
      const lockAsCover = isAdminOrMaster(req.user) && isBaseUpload ? true : shouldLock
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

    const duration = normalizeUploadDurationMs(req.body?.duration, 5)
    const campaignId = req.body?.campaignId ? Number(req.body.campaignId) : null
    const shouldLock =
      isAdminOrMaster(req.user) &&
      (req.body?.protectSlide === '1' || req.body?.protectSlide === 'true')

    if (!isAdminOrMaster(req.user) && !campaignId) {
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
      !isAdminOrMaster(req.user) &&
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
      !isAdminOrMaster(req.user) &&
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
