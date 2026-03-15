const fs = require('fs')
const path = require('path')
const { open } = require('sqlite')
const sqlite3 = require('sqlite3')
const { hashPassword } = require('../utils/security')
const { getDefaultDbPath } = require('../config/runtime-paths')

const defaultDbPath = getDefaultDbPath()
let dbPromise = null
const LATEST_SCHEMA_VERSION = 6

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
      role TEXT NOT NULL CHECK(role IN ('master', 'admin', 'group_user')),
      group_id INTEGER NULL,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY(group_id) REFERENCES groups(id)
    );

    CREATE TABLE IF NOT EXISTS slides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      campaign_id INTEGER NULL,
      type TEXT NOT NULL CHECK(type IN ('image', 'video', 'pdf')),
      name TEXT NOT NULL,
      src TEXT NOT NULL,
      duration INTEGER NOT NULL,
      position INTEGER NOT NULL,
      is_locked INTEGER NOT NULL DEFAULT 0,
      created_by_user_id INTEGER NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(group_id) REFERENCES groups(id),
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id),
      FOREIGN KEY(created_by_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 1,
      is_api_automation INTEGER NOT NULL DEFAULT 0,
      created_by_user_id INTEGER NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(group_id) REFERENCES groups(id),
      FOREIGN KEY(created_by_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
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

async function ensureSlideProtectionColumns(db) {
  const columns = await db.all('PRAGMA table_info(slides)')
  const hasIsLocked = columns.some((col) => col.name === 'is_locked')
  const hasCreatedBy = columns.some((col) => col.name === 'created_by_user_id')

  if (!hasIsLocked) {
    await db.exec('ALTER TABLE slides ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasCreatedBy) {
    await db.exec('ALTER TABLE slides ADD COLUMN created_by_user_id INTEGER NULL')
  }
}

async function ensureSlideCampaignColumn(db) {
  const columns = await db.all('PRAGMA table_info(slides)')
  const hasCampaignId = columns.some((col) => col.name === 'campaign_id')
  if (!hasCampaignId) {
    await db.exec('ALTER TABLE slides ADD COLUMN campaign_id INTEGER NULL')
  }
}

async function ensureCampaignsTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 1,
      is_api_automation INTEGER NOT NULL DEFAULT 0,
      created_by_user_id INTEGER NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(group_id) REFERENCES groups(id),
      FOREIGN KEY(created_by_user_id) REFERENCES users(id)
    );
  `)
}

async function ensureSchemaMigrationsTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)

  await db.run(`
    INSERT INTO schema_migrations (id, version)
    VALUES (1, 0)
    ON CONFLICT(id) DO NOTHING
  `)
}

async function getSchemaVersion(db) {
  const row = await db.get('SELECT version FROM schema_migrations WHERE id = 1')
  return Number(row?.version || 0)
}

async function setSchemaVersion(db, version) {
  await db.run(
    `
    UPDATE schema_migrations
    SET version = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
    `,
    [version]
  )
}

function buildBackupPath(filename, fromVersion, toVersion) {
  const parsed = path.parse(filename)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(
    parsed.dir,
    `${parsed.name}.backup-v${fromVersion}-to-v${toVersion}-${stamp}${parsed.ext}`
  )
}

function backupDatabaseIfNeeded(filename, fromVersion, toVersion, shouldBackup) {
  if (!shouldBackup || !fs.existsSync(filename)) return null
  const backupPath = buildBackupPath(filename, fromVersion, toVersion)
  fs.copyFileSync(filename, backupPath)
  return backupPath
}

async function ensureCampaignAutomationColumn(db) {
  const columns = await db.all('PRAGMA table_info(campaigns)')
  const hasAutomationFlag = columns.some((col) => col.name === 'is_api_automation')
  if (!hasAutomationFlag) {
    await db.exec('ALTER TABLE campaigns ADD COLUMN is_api_automation INTEGER NOT NULL DEFAULT 0')
  }

  await db.run(`
    UPDATE campaigns
    SET is_api_automation = 1
    WHERE is_api_automation = 0
      AND lower(name) LIKE 'fluxo%'
  `)
}

async function ensureUsersAdminRoleSupport(db) {
  const usersTable = await db.get(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'"
  )
  const createSql = String(usersTable?.sql || '').toLowerCase()
  if (!createSql) return
  if (createSql.includes("'admin'")) return

  await db.exec('PRAGMA foreign_keys = OFF')
  try {
    await db.exec('BEGIN TRANSACTION')
    await db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('master', 'admin', 'group_user')),
        group_id INTEGER NULL,
        active INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY(group_id) REFERENCES groups(id)
      );
    `)
    await db.exec(`
      INSERT INTO users_new (id, username, password_hash, role, group_id, active)
      SELECT id, username, password_hash, role, group_id, active
      FROM users
    `)
    await db.exec('DROP TABLE users')
    await db.exec('ALTER TABLE users_new RENAME TO users')
    await db.exec('COMMIT')
  } catch (error) {
    await db.exec('ROLLBACK')
    throw error
  } finally {
    await db.exec('PRAGMA foreign_keys = ON')
  }
}

async function ensureAppSettingsTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}

async function seedGroups(db) {
  const groups = ['Operacao', 'Marketing', 'Comercial']
  for (const name of groups) {
    const existing = await db.get('SELECT id FROM groups WHERE name = ?', [name])
    if (existing) continue

    const nextOrder = await db.get(
      'SELECT COALESCE(MAX(display_order), 0) + 1 as nextOrder FROM groups'
    )

    await db.run(
      `
      INSERT INTO groups (name, display_order)
      VALUES (?, ?)
      `,
      [name, nextOrder.nextOrder]
    )
  }
}

async function seedUsers(db) {
  const masterUser = process.env.MASTER_USER || 'master'
  const masterPass = process.env.MASTER_PASS || 'admin123'
  const existingMaster = await db.get(
    "SELECT id FROM users WHERE username = ? OR role = 'master' ORDER BY id LIMIT 1",
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

async function runMigrations(db, options = {}) {
  const { filename, dbAlreadyExisted = false } = options
  await ensureSchemaMigrationsTable(db)

  const currentVersion = await getSchemaVersion(db)
  if (currentVersion >= LATEST_SCHEMA_VERSION) {
    return { currentVersion, backupPath: null }
  }

  const backupPath = backupDatabaseIfNeeded(
    filename,
    currentVersion,
    LATEST_SCHEMA_VERSION,
    dbAlreadyExisted
  )

  const migrations = [
    {
      version: 1,
      name: 'base-schema',
      up: async () => {
        await createSchema(db)
      }
    },
    {
      version: 2,
      name: 'group-order',
      up: async () => {
        await ensureGroupOrderColumn(db)
      }
    },
    {
      version: 3,
      name: 'slide-protection',
      up: async () => {
        await ensureSlideProtectionColumns(db)
      }
    },
    {
      version: 4,
      name: 'campaign-structure',
      up: async () => {
        await ensureCampaignsTable(db)
        await ensureSlideCampaignColumn(db)
      }
    },
    {
      version: 5,
      name: 'users-admin-role',
      up: async () => {
        await ensureUsersAdminRoleSupport(db)
      }
    },
    {
      version: 6,
      name: 'campaign-automation',
      up: async () => {
        await ensureCampaignAutomationColumn(db)
        await ensureAppSettingsTable(db)
      }
    }
  ]

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue
    await migration.up()
    await setSchemaVersion(db, migration.version)
  }

  return { currentVersion, backupPath }
}

async function initializeDb() {
  const filename = getDbPath()
  const dbAlreadyExisted = fs.existsSync(filename)
  ensureDbDirectory(filename)

  const db = await open({
    filename,
    driver: sqlite3.Database
  })

  const migrationInfo = await runMigrations(db, { filename, dbAlreadyExisted })
  await seedGroups(db)
  await seedUsers(db)
  await migrateJsonIfNeeded(db)

  if (migrationInfo.backupPath) {
    console.log(`[db] Backup do banco criado em: ${migrationInfo.backupPath}`)
  }
  console.log(
    `[db] Banco inicializado em ${filename} (schema v${LATEST_SCHEMA_VERSION})`
  )

  return db
}

function getDb() {
  if (!dbPromise) {
    dbPromise = initializeDb()
  }
  return dbPromise
}

module.exports = { getDb }
