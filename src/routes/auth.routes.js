const express = require('express')
const router = express.Router()

const { getDb } = require('../db')
const {
  buildAuthCookie,
  buildClearAuthCookie,
  requireAuth,
  requireMaster
} = require('../middlewares/auth.middleware')
const {
  createSessionPayload,
  hashPassword,
  signAuthToken,
  verifyPassword
} = require('../utils/security')

function toUserDto(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    groupId: user.group_id || null,
    groupName: user.group_name || null
  }
}

async function getAllowedGroups(user) {
  const db = await getDb()
  if (!user) return []
  if (user.role === 'master') {
    return db.all('SELECT id, name FROM groups ORDER BY display_order, name')
  }
  return db.all(
    'SELECT id, name FROM groups WHERE id = ? ORDER BY display_order, name',
    [user.group_id]
  )
}

router.post('/login', express.json(), async (req, res, next) => {
  try {
    const { username, password } = req.body || {}
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario e senha sao obrigatorios' })
    }

    const db = await getDb()
    const user = await db.get(
      `
      SELECT u.id, u.username, u.password_hash, u.role, u.group_id, u.active, g.name as group_name
      FROM users u
      LEFT JOIN groups g ON g.id = u.group_id
      WHERE u.username = ?
      `,
      [String(username).trim()]
    )

    if (!user || Number(user.active) !== 1) {
      return res.status(401).json({ error: 'Credenciais invalidas' })
    }

    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Credenciais invalidas' })
    }

    const payload = createSessionPayload(user)
    const secret = process.env.AUTH_SECRET || 'change-this-secret'
    const token = signAuthToken(payload, secret)
    res.setHeader('Set-Cookie', buildAuthCookie(token))

    const groups = await getAllowedGroups(user)
    return res.json({
      user: toUserDto(user),
      groups
    })
  } catch (error) {
    return next(error)
  }
})

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', buildClearAuthCookie())
  res.json({ ok: true })
})

router.get('/me', async (req, res, next) => {
  try {
    if (!req.user) {
      return res.json({ authenticated: false })
    }

    const groups = await getAllowedGroups(req.user)
    return res.json({
      authenticated: true,
      user: toUserDto(req.user),
      groups
    })
  } catch (error) {
    return next(error)
  }
})

router.get('/groups', requireAuth, async (req, res, next) => {
  try {
    const groups = await getAllowedGroups(req.user)
    return res.json(groups)
  } catch (error) {
    return next(error)
  }
})

router.post('/groups', requireAuth, requireMaster, express.json(), async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim()
    if (!name) {
      return res.status(400).json({ error: 'Informe o nome do grupo' })
    }
    if (name.length < 2) {
      return res.status(400).json({ error: 'Nome do grupo muito curto' })
    }

    const db = await getDb()
    const existing = await db.get('SELECT id FROM groups WHERE lower(name) = lower(?)', [name])
    if (existing) {
      return res.status(409).json({ error: 'Grupo ja existe' })
    }

    const nextOrder = await db.get(
      'SELECT COALESCE(MAX(display_order), 0) + 1 as nextOrder FROM groups'
    )

    const result = await db.run(
      `
      INSERT INTO groups (name, display_order, background, default_image)
      VALUES (?, ?, '#ffffff', NULL)
      `,
      [name, nextOrder.nextOrder]
    )

    const created = await db.get(
      'SELECT id, name, display_order as displayOrder FROM groups WHERE id = ?',
      [result.lastID]
    )

    const io = req.app.get('io')
    io.emit('groups:update', { groupId: created.id })

    return res.status(201).json(created)
  } catch (error) {
    return next(error)
  }
})

router.get('/users', requireAuth, requireMaster, async (req, res, next) => {
  try {
    const db = await getDb()
    const users = await db.all(
      `
      SELECT u.id, u.username, u.role, u.group_id as groupId, u.active, g.name as groupName
      FROM users u
      LEFT JOIN groups g ON g.id = u.group_id
      ORDER BY u.id
      `
    )
    return res.json(users)
  } catch (error) {
    return next(error)
  }
})

router.post('/users', requireAuth, requireMaster, express.json(), async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim()
    const password = String(req.body?.password || '')
    const groupId = Number(req.body?.groupId)
    const active = req.body?.active === false ? 0 : 1

    if (!username || !password || !Number.isInteger(groupId) || groupId <= 0) {
      return res.status(400).json({ error: 'Informe usuario, senha e grupo validos' })
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Senha deve ter pelo menos 4 caracteres' })
    }

    const db = await getDb()
    const group = await db.get('SELECT id FROM groups WHERE id = ?', [groupId])
    if (!group) {
      return res.status(404).json({ error: 'Grupo nao encontrado' })
    }

    const existing = await db.get('SELECT id FROM users WHERE username = ?', [username])
    if (existing) {
      return res.status(409).json({ error: 'Usuario ja existe' })
    }

    const result = await db.run(
      `
      INSERT INTO users (username, password_hash, role, group_id, active)
      VALUES (?, ?, 'group_user', ?, ?)
      `,
      [username, hashPassword(password), groupId, active]
    )

    const created = await db.get(
      `
      SELECT u.id, u.username, u.role, u.group_id as groupId, u.active, g.name as groupName
      FROM users u
      LEFT JOIN groups g ON g.id = u.group_id
      WHERE u.id = ?
      `,
      [result.lastID]
    )

    return res.status(201).json(created)
  } catch (error) {
    return next(error)
  }
})

router.get('/sql/schema', requireAuth, requireMaster, async (req, res, next) => {
  try {
    const db = await getDb()
    const tables = await db.all(
      `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
      `
    )

    const result = []
    for (const table of tables) {
      const columns = await db.all(`PRAGMA table_info(${table.name})`)
      result.push({
        name: table.name,
        columns: columns.map((col) => ({
          name: col.name,
          type: col.type,
          notNull: Number(col.notnull) === 1,
          pk: Number(col.pk) === 1
        }))
      })
    }

    return res.json({ tables: result })
  } catch (error) {
    return next(error)
  }
})

router.post('/sql/execute', requireAuth, requireMaster, express.json(), async (req, res, next) => {
  try {
    const sql = String(req.body?.sql || '').trim()
    if (!sql) {
      return res.status(400).json({ error: 'Informe um SQL para executar' })
    }
    if (sql.length > 20000) {
      return res.status(400).json({ error: 'SQL muito grande (maximo 20000 caracteres)' })
    }

    const statements = sql
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
    if (statements.length > 1) {
      return res.status(400).json({ error: 'Execute apenas um comando por vez' })
    }

    const normalized = statements[0] || sql
    const command = (normalized.match(/^\s*([a-z]+)/i) || [null, ''])[1].toUpperCase()
    const db = await getDb()

    if (['SELECT', 'PRAGMA', 'WITH', 'EXPLAIN'].includes(command)) {
      const rows = await db.all(normalized)
      return res.json({
        mode: 'query',
        rowCount: rows.length,
        rows
      })
    }

    const runResult = await db.run(normalized)
    return res.json({
      mode: 'exec',
      changes: Number(runResult?.changes || 0),
      lastID: runResult?.lastID || null
    })
  } catch (error) {
    return next(error)
  }
})

module.exports = router
