const crypto = require('crypto')

const HASH_ALGO = 'sha256'
const KEY_LENGTH = 64
const TOKEN_TTL_SECONDS = 60 * 60 * 12

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const digest = crypto
    .scryptSync(password, salt, KEY_LENGTH)
    .toString('hex')
  return `${salt}:${digest}`
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false
  const [salt, expected] = storedHash.split(':')
  const computed = crypto
    .scryptSync(password, salt, KEY_LENGTH)
    .toString('hex')

  const expectedBuffer = Buffer.from(expected, 'hex')
  const computedBuffer = Buffer.from(computed, 'hex')
  if (expectedBuffer.length !== computedBuffer.length) return false

  return crypto.timingSafeEqual(expectedBuffer, computedBuffer)
}

function encodeBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padding = normalized.length % 4
  const base64 = padding ? normalized + '='.repeat(4 - padding) : normalized
  return Buffer.from(base64, 'base64').toString('utf8')
}

function signAuthToken(payload, secret) {
  const body = encodeBase64Url(JSON.stringify(payload))
  const signature = crypto
    .createHmac(HASH_ALGO, secret)
    .update(body)
    .digest('hex')
  return `${body}.${signature}`
}

function verifyAuthToken(token, secret) {
  if (!token || !token.includes('.')) return null

  const [body, signature] = token.split('.')
  const expected = crypto
    .createHmac(HASH_ALGO, secret)
    .update(body)
    .digest('hex')

  const signatureBuffer = Buffer.from(signature, 'hex')
  const expectedBuffer = Buffer.from(expected, 'hex')
  if (signatureBuffer.length !== expectedBuffer.length) return null
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null

  try {
    const payload = JSON.parse(decodeBase64Url(body))
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return null
    }
    return payload
  } catch (error) {
    return null
  }
}

function createSessionPayload(user) {
  return {
    sub: user.id,
    role: user.role,
    groupId: user.group_id || null,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  }
}

module.exports = {
  TOKEN_TTL_SECONDS,
  createSessionPayload,
  hashPassword,
  signAuthToken,
  verifyAuthToken,
  verifyPassword
}
