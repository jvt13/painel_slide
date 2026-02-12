const fs = require('fs')
const path = require('path')
const { open } = require('sqlite')
const sqlite3 = require('sqlite3')
const { hashPassword } = require('../utils/security')

const defaultDbPath = path.resolve(__dirname, '..', 'data', 'painel.sqlite')
let dbPromise = null

function getDbPath() {
  return process.env.DB_PATH
    ? path.resolve(process.cwd(), process.env.DB_PATH)
    : defaultDbPath
}

function ensureDbDirectory(filename) {
  const dir = path.dirname(filename)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

async function createSchema(db) {
  await db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      display_order INTEGER NOT NULL DEFAULT 0,
      background TEXT NOT NULL DEFAULT '#ffffff',
      default_image TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('master', 'group_user')),
      group_id INTEGER NULL,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY(group_id) REFERENCES groups(id)
    );

    CREATE TABLE IF NOT EXISTS slides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('image', 'video', 'pdf')),
      name TEXT NOT NULL,
      src TEXT NOT NULL,
      duration INTEGER NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(group_id) REFERENCES groups(id)
    );
  `)
}

async function ensureGroupOrderColumn(db) {
  const columns = await db.all('PRAGMA table_info(groups)')
  const hasOrder = columns.some((col) => col.name === 'display_order')
  if (!hasOrder) {
    await db.exec('ALTER TABLE groups ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0')
  }

  const zeroCount = await db.get(
    'SELECT COUNT(*) as total FROM groups WHERE display_order = 0'
  )
  if (zeroCount.total > 0) {
    const rows = await db.all('SELECT id FROM groups ORDER BY id')
    for (let index = 0; index < rows.length; index += 1) {
      await db.run('UPDATE groups SET display_order = ? WHERE id = ?', [
        index + 1,
        rows[index].id
      ])
    }
  }
}

async function seedGroups(db) {
  const groups = ['Operacao', 'Marketing', 'Comercial']
  for (let index = 0; index < groups.length; index += 1) {
    const name = groups[index]
    await db.run(
      `
      INSERT INTO groups (name, display_order)
      VALUES (?, ?)
      ON CONFLICT(name) DO NOTHING
      `,
      [name, index + 1]
    )
  }
}

async function seedUsers(db) {
  const masterUser = process.env.MASTER_USER || 'master'
  const masterPass = process.env.MASTER_PASS || 'admin123'
  const existingMaster = await db.get(
    'SELECT id FROM users WHERE username = ?',
    masterUser
  )

  if (!existingMaster) {
    await db.run(
      `
      INSERT INTO users (username, password_hash, role)
      VALUES (?, ?, 'master')
      `,
      [masterUser, hashPassword(masterPass)]
    )
  }

  const groups = await db.all('SELECT id, name FROM groups ORDER BY id')
  for (const group of groups) {
    const username = group.name.toLowerCase()
    const existingUser = await db.get(
      'SELECT id FROM users WHERE username = ?',
      username
    )
    if (!existingUser) {
      await db.run(
        `
        INSERT INTO users (username, password_hash, role, group_id)
        VALUES (?, ?, 'group_user', ?)
        `,
        [username, hashPassword('123456'), group.id]
      )
    }
  }
}

async function migrateJsonIfNeeded(db) {
  const slideCount = await db.get('SELECT COUNT(*) as total FROM slides')
  if (slideCount.total > 0) return

  const playlistFile = path.resolve(__dirname, '..', 'data', 'playlist.json')
  const settingsFile = path.resolve(__dirname, '..', 'data', 'settings.json')
  const operacao = await db.get('SELECT id FROM groups WHERE name = ?', 'Operacao')
  if (!operacao) return

  if (fs.existsSync(settingsFile)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
      if (settings.background) {
        await db.run(
          'UPDATE groups SET background = ? WHERE id = ?',
          [settings.background, operacao.id]
        )
      }
    } catch (error) {
      // ignore migration failure for settings
    }
  }

  if (!fs.existsSync(playlistFile)) return

  try {
    const items = JSON.parse(fs.readFileSync(playlistFile, 'utf8'))
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      if (!item || !item.src || !item.name) continue
      await db.run(
        `
        INSERT INTO slides (group_id, type, name, src, duration, position)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          operacao.id,
          item.type || 'image',
          item.name,
          item.src,
          Number(item.duration) || 5000,
          index
        ]
      )
    }
  } catch (error) {
    // ignore migration failure for playlist
  }
}

async function initializeDb() {
  const filename = getDbPath()
  ensureDbDirectory(filename)

  const db = await open({
    filename,
    driver: sqlite3.Database
  })

  await createSchema(db)
  await ensureGroupOrderColumn(db)
  await seedGroups(db)
  await seedUsers(db)
  await migrateJsonIfNeeded(db)

  return db
}

function getDb() {
  if (!dbPromise) {
    dbPromise = initializeDb()
  }
  return dbPromise
}

module.exports = { getDb }
