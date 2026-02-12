const { getDb } = require('../db')
const { verifyAuthToken } = require('../utils/security')

const COOKIE_NAME = 'painel_auth'

function parseCookies(cookieHeader) {
  const result = {}
  if (!cookieHeader) return result

  const pairs = cookieHeader.split(';')
  for (const pair of pairs) {
    const index = pair.indexOf('=')
    if (index < 0) continue
    const key = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    result[key] = decodeURIComponent(value)
  }
  return result
}

function buildAuthCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`
}

function buildClearAuthCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

async function attachUser(req, res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie)
    const token = cookies[COOKIE_NAME]
    if (!token) return next()

    const secret = process.env.AUTH_SECRET || 'change-this-secret'
    const payload = verifyAuthToken(token, secret)
    if (!payload || !payload.sub) return next()

    const db = await getDb()
    const user = await db.get(
      `
      SELECT u.id, u.username, u.role, u.group_id, u.active, g.name as group_name
      FROM users u
      LEFT JOIN groups g ON g.id = u.group_id
      WHERE u.id = ?
      `,
      [payload.sub]
    )

    if (!user || Number(user.active) !== 1) return next()
    req.user = user
    return next()
  } catch (error) {
    return next(error)
  }
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Nao autenticado' })
  }
  return next()
}

function requireMaster(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Nao autenticado' })
  }
  if (req.user.role !== 'master') {
    return res.status(403).json({ error: 'Acesso permitido apenas para master' })
  }
  return next()
}

module.exports = {
  COOKIE_NAME,
  attachUser,
  buildAuthCookie,
  buildClearAuthCookie,
  parseCookies,
  requireAuth,
  requireMaster
}
