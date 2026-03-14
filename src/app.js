const express = require('express')
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const dotenv = require('dotenv')
const http = require('http')
const { Server } = require('socket.io')

function loadEnv() {
  const candidates = process.pkg
    ? [
        path.resolve(path.dirname(process.execPath), '.env'),
        path.resolve(path.dirname(process.execPath), '..', '.env'),
        path.resolve(process.cwd(), '.env')
      ]
    : [path.resolve(process.cwd(), '.env')]

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue
    dotenv.config({ path: envPath, override: true })
    return envPath
  }

  dotenv.config({ override: true })
  return null
}

const loadedEnvPath = loadEnv()

if (process.pkg) {
  // For packaged executables, ensure environment variables are loaded correctly
  process.env.NODE_ENV = process.env.NODE_ENV || 'production'
  process.env.LICENSE_API_URL = process.env.LICENSE_API_URL || 'https://production-license-api.com/api/license'
  // Valores fixos para o executável
  process.env.LICENSE_API_URL = 'https://license.srv-jvt.com/api/license';
  process.env.PORT = '3000';
  process.env.NODE_ENV = 'production';
  process.env.AUTH_SECRET = 'troque-para-um-segredo-forte';
  process.env.MASTER_USER = 'master';
  process.env.MASTER_PASS = 'admin123';
  process.env.LICENSE_APP_ID = 'painel_slide';
  process.env.LICENSE_PENDING_POLL_MS = '10000';
  process.env.LICENSE_CHECK_INTERVAL_MS = '10000';
  process.env.API_UPLOAD_KEY = 'chv1N9bKq7rXz3uH';
}

if (!process.env.LICENSE_API_URL) {
  console.error('[ERROR] LICENSE_API_URL não está definido. Verifique o arquivo .env ou as variáveis de ambiente.');
  process.exit(1);
}

// Valores fixos como fallback para evitar problemas em outros ambientes
process.env.LICENSE_API_URL = process.env.LICENSE_API_URL || 'https://license.srv-jvt.com/api/license';
process.env.PORT = process.env.PORT || '3000';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'default-secret';

const { getDb } = require('./db')
const authRoutes = require('./routes/auth.routes')
const { attachUser, requireAuth, requireMaster, requireAdminOrMaster } = require('./middlewares/auth.middleware')
const mediaRoutes = require('./routes/media.routes')
const { getUploadsDir } = require('./config/runtime-paths')
const {
  initializeLicense,
  dailyLicenseCheck,
  getLicenseState,
  licenseGuard
} = require('./services/license.service')

const app = express()
if (loadedEnvPath) {
  console.log(`[env] carregado de: ${loadedEnvPath}`)
} else {
  console.log('[env] .env nao encontrado; usando variaveis do ambiente/suporte padrao')
}
console.log(`[license] LICENSE_API_URL efetiva: ${process.env.LICENSE_API_URL || 'http://localhost:3001/api/license'}`)

process.on('uncaughtException', (error) => {
  console.error('uncaughtException:', error && error.stack ? error.stack : error)
})

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason)
})

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(attachUser)
app.get('/license/status', (req, res) => {
  res.json(getLicenseState())
})
app.use(licenseGuard)

// servir arquivos estaticos do front
app.use(express.static(path.resolve(__dirname, 'public')))

// admin static (css/js)
app.use(
  '/admin',
  express.static(path.resolve(__dirname, 'admin'))
)

// servir uploads
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
const playerAutoOpenEnabled = String(process.env.PLAYER_AUTO_OPEN || '1') !== '0'
const playerAutoOpenUrl = process.env.PLAYER_AUTO_OPEN_URL || `http://localhost:${PORT}/player`
const playerAutoOpenForceF11 = String(process.env.PLAYER_AUTO_OPEN_FORCE_F11 || '1') !== '0'

const server = http.createServer(app)
const io = new Server(server)
const activeCampaignByGroup = new Map()
let playerBrowserProcess = null
let shuttingDown = false
let currentLicenseStatus = 'unknown'

// disponibiliza o io para as rotas
app.set('io', io)

io.on('connection', (socket) => {
  console.log('Player conectado:', socket.id)
})

function resolveBrowserExecutable() {
  const candidates = [
    'msedge',
    'chrome',
    'chromium',
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LocalAppData || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LocalAppData || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    if (candidate.endsWith('.exe')) {
      if (fs.existsSync(candidate)) return candidate
      continue
    }
    const probe = spawnSync('where', [candidate], { stdio: 'ignore', windowsHide: true })
    if (!probe.error && probe.status === 0) return candidate
  }
  return null
}

function resolveForceF11ScriptPath() {
  const candidates = [
    path.resolve(process.cwd(), 'scripts', 'force-f11.py'),
    path.resolve(process.cwd(), 'force-f11.py'),
    path.resolve(path.dirname(process.execPath), 'scripts', 'force-f11.py'),
    path.resolve(path.dirname(process.execPath), 'force-f11.py')
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

function detectPythonCommand() {
  const probes = [
    { cmd: 'python', args: ['--version'], runArgs: [] },
    { cmd: 'py', args: ['-3', '--version'], runArgs: ['-3'] },
    { cmd: 'py', args: ['--version'], runArgs: [] }
  ]

  for (const probe of probes) {
    const result = spawnSync(probe.cmd, probe.args, { stdio: 'ignore', windowsHide: true })
    if (!result.error && result.status === 0) {
      return { cmd: probe.cmd, runArgs: probe.runArgs }
    }
  }
  return null
}

function triggerAutoOpenF11() {
  if (!playerAutoOpenForceF11 || process.platform !== 'win32') return
  const scriptPath = resolveForceF11ScriptPath()
  if (!scriptPath) return
  const python = detectPythonCommand()
  if (!python) return

  const windowTitleHint = process.env.PLAYER_WINDOW_TITLE_HINT || 'Player'
  const urlHint = process.env.PLAYER_WINDOW_URL_HINT || playerAutoOpenUrl
  const args = [...python.runArgs, scriptPath, windowTitleHint, urlHint]
  try {
    const child = spawn(python.cmd, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.unref()
  } catch (error) {
    console.warn('Falha ao disparar F11 automatico:', error.message)
  }
}

function openPlayerInFullscreen() {
  if (!playerAutoOpenEnabled) return
  if (process.env.NODE_ENV === 'test') return
  if (playerBrowserProcess && playerBrowserProcess.pid) return

  const browser = resolveBrowserExecutable()
  if (!browser) {
    console.warn('Nao foi possivel localizar Edge/Chrome para abrir o Player automaticamente.')
    return
  }

  const args = [
    '--new-window',
    `--app=${buildManagedPlayerUrl(playerAutoOpenUrl)}`,
    '--start-fullscreen',
    '--autoplay-policy=no-user-gesture-required'
  ]

  try {
    playerBrowserProcess = spawn(browser, args, {
      detached: false,
      stdio: 'ignore',
      windowsHide: true
    })
    setTimeout(triggerAutoOpenF11, 1200)
  } catch (error) {
    console.warn('Falha ao abrir Player automaticamente:', error.message)
  }
}

function buildManagedPlayerUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    url.searchParams.set('managed', '1')
    return url.toString()
  } catch (error) {
    const hasQuery = rawUrl.includes('?')
    const hasManaged = rawUrl.includes('managed=')
    if (hasManaged) return rawUrl
    return `${rawUrl}${hasQuery ? '&' : '?'}managed=1`
  }
}

function closeAutoOpenedPlayerWindow() {
  if (!playerBrowserProcess || !playerBrowserProcess.pid) {
    // Se não temos o PID, tenta fechar por título da janela
    try {
      spawn('powershell', ['-WindowStyle', 'Hidden', '-command', `
        $wshell = New-Object -ComObject wscript.shell
        $wshell.AppActivate('Player')
        Start-Sleep -Milliseconds 200
        $wshell.SendKeys('%{F4}')
      `], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
    } catch (error) {
      // ignore
    }
    return
  }

  try {
    if (process.platform === 'win32') {
      // Tenta fechar usando taskkill
      spawnSync('taskkill', ['/PID', String(playerBrowserProcess.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
      
      // Como alternativa, tenta enviar Alt+F4 para fechar a janela
      setTimeout(() => {
        try {
          spawn('powershell', ['-WindowStyle', 'Hidden', '-command', "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('%{F4}')"], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          })
        } catch (error) {
          // ignore
        }
      }, 500)
    } else {
      playerBrowserProcess.kill('SIGTERM')
    }
  } catch (error) {
    // ignore close errors
  } finally {
    playerBrowserProcess = null
  }
}

function enforceLicenseRuntime(licenseState, context = 'runtime') {
  const nextStatus = licenseState?.status || 'pending'
  const previousStatus = currentLicenseStatus
  const changed = previousStatus !== nextStatus
  currentLicenseStatus = nextStatus

  if (nextStatus === 'approved') {
    if (changed) {
      console.log(`[license] ${context}: licenca aprovada, liberando player.`)
      io.emit('license:update', {
        status: nextStatus,
        reason: licenseState?.reason || null
      })
    }
    openPlayerInFullscreen()
    return
  }

  if (changed) {
    console.warn(`[license] ${context}: licenca ${nextStatus}, bloqueando player.`)
    io.emit('license:update', {
      status: nextStatus,
      reason: licenseState?.reason || null
    })
    // Se ainda nao houver janela, abre uma para cair no painel de licenca.
    if (!playerBrowserProcess || !playerBrowserProcess.pid) {
      openPlayerInFullscreen()
    }
    return
  }

  // Evita reabrir janela em loop quando o estado bloqueado permanece igual.
  if (!playerBrowserProcess || !playerBrowserProcess.pid) {
    openPlayerInFullscreen()
  }
}

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  closeAutoOpenedPlayerWindow()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGUSR2', () => shutdown('SIGUSR2'))
process.on('exit', closeAutoOpenedPlayerWindow)
process.on('beforeExit', closeAutoOpenedPlayerWindow)
process.on('uncaughtException', (error) => {
  console.error('uncaughtException:', error && error.stack ? error.stack : error)
  closeAutoOpenedPlayerWindow()
  process.exit(1)
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

      const activeCampaignIds = campaigns
        .filter(
          (campaign) =>
            getCampaignStatus(campaign.starts_at, campaign.ends_at, Number(campaign.active) === 1) ===
            'executando'
        )
        .map((campaign) => campaign.id)
      const currentActiveKey = activeCampaignIds.join(',')
      const previousActiveKey = activeCampaignByGroup.has(group.id)
        ? activeCampaignByGroup.get(group.id)
        : ''

      if (currentActiveKey !== previousActiveKey) {
        activeCampaignByGroup.set(group.id, currentActiveKey)
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
    return initializeLicense().then((licenseState) => {
      console.log(
        `Licenca inicial: ${licenseState.status} (${licenseState.reason || 'no-reason'})`
      )
      server.listen(PORT, "0.0.0.0", () => {
        console.log(`Servidor rodando na porta ${PORT}`)
        enforceLicenseRuntime(licenseState, 'startup')
      })
    })
  })
  .then(() => {
    const licenseCheckRaw = Number(process.env.LICENSE_CHECK_INTERVAL_MS)
    const licenseCheckMs = Number.isFinite(licenseCheckRaw)
      ? Math.max(10000, Math.min(24 * 60 * 60 * 1000, licenseCheckRaw))
      : 24 * 60 * 60 * 1000

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
    setInterval(async () => {
      const licenseState = await dailyLicenseCheck()
      enforceLicenseRuntime(licenseState, 'periodic-check')
    }, licenseCheckMs)
  })
  .catch((error) => {
    console.error('Falha ao inicializar banco SQLite', error)
    process.exit(1)
  })
