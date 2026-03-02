const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const fetch = require('node-fetch')

const {
  getLicenseFilePath,
  getPublicKeyPath
} = require('../utils/license-path')

const LICENSE_API_URL = process.env.LICENSE_API_URL || 'http://localhost:3001/api/license'
const CLOCK_SKEW_TOLERANCE_MS = 10 * 1000
const pendingPollRaw = Number(process.env.LICENSE_PENDING_POLL_MS)
const PENDING_POLL_INTERVAL_MS = Number.isFinite(pendingPollRaw)
  ? Math.max(2000, Math.min(5 * 60 * 1000, pendingPollRaw))
  : 10 * 1000
const APPROVED_REMOTE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

let licenseState = {
  status: 'pending',
  reason: 'not-initialized',
  machine_id: null,
  lastValidation: null,
  expiresAt: null,
  lastRemoteCheckAt: null
}

let pollingInterval = null

function generateMachineId() {
  const data = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.totalmem(),
    os.cpus().length
  ].join('|')

  return crypto.createHash('sha256').update(data).digest('hex')
}

function getMachineName() {
  return os.hostname()
}

function getMachineIp() {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    const addresses = interfaces[name] || []
    for (const address of addresses) {
      if (!address || address.internal) continue
      if (address.family === 'IPv4' || address.family === 4) {
        return address.address
      }
    }
  }
  return null
}

function readLicenseFile() {
  const file = getLicenseFilePath()
  if (!fs.existsSync(file)) {
    return null
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return null
  }
}

function saveLicenseFile(data) {
  const file = getLicenseFilePath()
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

function readPublicKey() {
  const file = getPublicKeyPath()
  if (!fs.existsSync(file)) {
    return null
  }
  return fs.readFileSync(file, 'utf8')
}

function savePublicKey(key) {
  const file = getPublicKeyPath()
  fs.writeFileSync(file, key, 'utf8')
}

async function ensurePublicKey() {
  const cached = readPublicKey()
  if (cached) {
    return cached
  }

  const response = await fetch(`${LICENSE_API_URL}/public-key`)
  if (!response.ok) {
    throw new Error(`Falha ao baixar public key: HTTP ${response.status}`)
  }

  const data = await response.json()
  if (!data.publicKey) {
    throw new Error('Public key nao retornada pelo servidor')
  }

  savePublicKey(data.publicKey)
  return data.publicKey
}

async function requestValidation(machine_id) {
  const machine_name = getMachineName()
  const machine_ip = getMachineIp()

  const response = await fetch(`${LICENSE_API_URL}/validate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ machine_id, machine_name, machine_ip })
  })

  if (!response.ok) {
    throw new Error(`Falha na validacao remota: HTTP ${response.status}`)
  }

  return response.json()
}

function validateToken(token, publicKey) {
  try {
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256']
    })

    return {
      valid: true,
      decoded
    }
  } catch (err) {
    return {
      valid: false,
      error: err.message
    }
  }
}

function updateState(nextState = {}) {
  licenseState = {
    ...licenseState,
    ...nextState
  }
  return { ...licenseState }
}

function readLastValidation(stored) {
  const ts = Number(stored?.last_validation)
  return Number.isFinite(ts) && ts > 0 ? ts : null
}

function clockRollbackDetected(lastValidation) {
  if (!lastValidation) return false
  return Date.now() + CLOCK_SKEW_TOLERANCE_MS < lastValidation
}

function checkClockRollback(stored) {
  const lastValidation = readLastValidation(stored)
  if (!clockRollbackDetected(lastValidation)) {
    return { ok: true }
  }

  console.error('Rollback de relogio detectado!')
  return {
    ok: false,
    reason: 'clock-rollback-detected'
  }
}

function saveApprovedLicense(stored, token, decoded) {
  const now = Date.now()
  const merged = {
    ...(stored || {}),
    token,
    machine_id: licenseState.machine_id,
    last_validation: now,
    expires_at: decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null
  }
  saveLicenseFile(merged)
  return merged
}

function applyApprovedState(decoded, reason) {
  return updateState({
    status: 'approved',
    reason,
    lastValidation: Date.now(),
    expiresAt: decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null
  })
}

function applyBlockedState(status, reason) {
  return updateState({
    status,
    reason
  })
}

function tryLocalApproval(stored, publicKey) {
  if (!stored?.token || !publicKey) return null

  const clockCheck = checkClockRollback(stored)
  if (!clockCheck.ok) {
    return applyBlockedState('expired', clockCheck.reason)
  }

  const local = validateToken(stored.token, publicKey)
  if (!local.valid) {
    return null
  }

  saveApprovedLicense(stored, stored.token, local.decoded)
  return applyApprovedState(local.decoded, 'local-token-valid')
}

function clearPendingPolling() {
  if (!pollingInterval) return
  clearInterval(pollingInterval)
  pollingInterval = null
}

async function validateWithServer(machine_id, publicKey, stored) {
  const serverResponse = await requestValidation(machine_id)
  updateState({ lastRemoteCheckAt: Date.now() })

  if (serverResponse.status === 'approved' && serverResponse.token) {
    const validated = validateToken(serverResponse.token, publicKey)
    if (!validated.valid) {
      console.error(`Token remoto invalido: ${validated.error}`)
      return applyBlockedState('pending', 'invalid-remote-token')
    }

    saveApprovedLicense(stored, serverResponse.token, validated.decoded)
    clearPendingPolling()
    console.log('Licenca aprovada/renovada pelo servidor.')
    return applyApprovedState(validated.decoded, 'remote-approved')
  }

  if (serverResponse.status === 'expired') {
    console.log('Licenca expirada.')
    startPendingPolling(machine_id)
    return applyBlockedState('expired', 'remote-expired')
  }

  console.log('Licenca pendente de aprovacao.')
  startPendingPolling(machine_id)
  return applyBlockedState('pending', 'remote-pending')
}

function startPendingPolling(machine_id) {
  if (pollingInterval) return

  const intervalSeconds = Math.round(PENDING_POLL_INTERVAL_MS / 1000)
  console.log(`Iniciando polling de validacao a cada ${intervalSeconds} segundos...`)

  const runAttempt = async () => {
    try {
      console.log('[license] Polling: tentando validar com servidor...')
      const publicKey = readPublicKey() || (await ensurePublicKey())
      const stored = readLicenseFile()
      const result = await validateWithServer(machine_id, publicKey, stored)
      console.log(`[license] Polling: status atual ${result.status} (${result.reason || 'no-reason'})`)
    } catch (err) {
      console.error('Erro ao revalidar em polling:', err.message)
    }
  }

  // Roda imediatamente na entrada do estado pending e depois no intervalo configurado.
  runAttempt()
  pollingInterval = setInterval(() => {
    runAttempt()
  }, PENDING_POLL_INTERVAL_MS)
}

async function initializeLicense() {
  const machine_id = generateMachineId()
  updateState({ machine_id })

  let publicKey = null
  try {
    publicKey = await ensurePublicKey()
  } catch (error) {
    console.error(`Falha ao garantir public key: ${error.message}`)
    startPendingPolling(machine_id)
    return applyBlockedState('pending', 'public-key-unavailable')
  }

  const stored = readLicenseFile()
  const localApproved = tryLocalApproval(stored, publicKey)
  if (localApproved?.status === 'approved') {
    console.log('Licenca valida localmente.')
    return localApproved
  }
  if (localApproved?.status === 'expired') {
    return localApproved
  }

  try {
    return await validateWithServer(machine_id, publicKey, stored)
  } catch (error) {
    const fallback = tryLocalApproval(stored, publicKey)
    if (fallback?.status === 'approved') {
      console.warn('Servidor de licenca indisponivel. Seguindo offline com token valido.')
      return updateState({
        ...fallback,
        reason: 'offline-token-valid'
      })
    }

    console.error(`Falha ao validar licenca no servidor: ${error.message}`)
    startPendingPolling(machine_id)
    return applyBlockedState('pending', 'license-server-unreachable')
  }
}

async function dailyLicenseCheck() {
  try {
    const machine_id = licenseState.machine_id || generateMachineId()
    updateState({ machine_id })
    const stored = readLicenseFile()
    const publicKey = readPublicKey() || (await ensurePublicKey())

    if (licenseState.status === 'approved') {
      const clockCheck = checkClockRollback(stored)
      if (!clockCheck.ok) {
        startPendingPolling(machine_id)
        return applyBlockedState('expired', clockCheck.reason)
      }

      if (!stored?.token || !publicKey) {
        startPendingPolling(machine_id)
        return applyBlockedState('pending', 'local-license-missing')
      }

      const local = validateToken(stored.token, publicKey)
      if (!local.valid) {
        startPendingPolling(machine_id)
        return applyBlockedState('expired', 'local-token-invalid-or-expired')
      }

      const now = Date.now()
      const lastRemote = Number(licenseState.lastRemoteCheckAt || 0)
      if (lastRemote > 0 && now - lastRemote < APPROVED_REMOTE_CHECK_INTERVAL_MS) {
        return applyApprovedState(local.decoded, 'local-token-valid')
      }
    }

    // Em approved, consulta remota no maximo 1x a cada 24h; em pending/expired segue tentando.
    return await validateWithServer(machine_id, publicKey, stored)
  } catch (error) {
    const stored = readLicenseFile()
    const publicKey = readPublicKey()
    const fallback = tryLocalApproval(stored, publicKey)

    if (fallback?.status === 'approved') {
      return updateState({
        ...fallback,
        reason: 'offline-token-valid'
      })
    }

    startPendingPolling(licenseState.machine_id || generateMachineId())
    return applyBlockedState('pending', 'daily-check-failed')
  }
}

function getLicenseState() {
  return { ...licenseState }
}

function buildBlockedMessage(state) {
  if (state.status === 'expired') {
    return 'Licenca expirada'
  }
  return 'Licenca pendente de aprovacao'
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderBlockedHtml(state) {
  const pollSeconds = Math.max(1, Math.round(PENDING_POLL_INTERVAL_MS / 1000))
  const title = state.status === 'expired' ? 'Licenca expirada' : 'Aguardando aprovacao'
  const subtitle =
    state.status === 'expired'
      ? 'A renovacao da licenca e necessaria para liberar o sistema.'
      : 'Esta maquina ainda nao foi aprovada no servidor de licencas.'
  const reason = escapeHtml(state.reason || 'no-reason')
  const machineId = escapeHtml(state.machine_id || 'nao-disponivel')
  const expiresAt = escapeHtml(state.expiresAt || '-')

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Painel Slide | Licenca</title>
  <style>
    :root {
      --bg: #0f172a;
      --panel: #111827;
      --line: #334155;
      --txt: #e2e8f0;
      --muted: #94a3b8;
      --warn: #f59e0b;
      --err: #ef4444;
      --ok: #22c55e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", Tahoma, sans-serif;
      background: radial-gradient(circle at top, #1e293b 0%, var(--bg) 48%);
      color: var(--txt);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      width: min(760px, 100%);
      background: linear-gradient(180deg, rgba(30,41,59,.88), rgba(15,23,42,.96));
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 24px;
      box-shadow: 0 10px 40px rgba(0,0,0,.35);
    }
    .badge {
      display: inline-block;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 12px;
      letter-spacing: .5px;
      text-transform: uppercase;
      border: 1px solid ${state.status === 'expired' ? 'var(--err)' : 'var(--warn)'};
      color: ${state.status === 'expired' ? 'var(--err)' : 'var(--warn)'};
      margin-bottom: 12px;
    }
    h1 { margin: 0 0 8px; font-size: clamp(24px, 4vw, 34px); }
    p { margin: 0 0 14px; color: var(--muted); }
    .grid {
      margin-top: 16px;
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
    }
    .item {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px 12px;
      background: rgba(2,6,23,.35);
    }
    .label { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
    .value { font-family: Consolas, monospace; font-size: 13px; word-break: break-all; }
    .footer {
      margin-top: 14px;
      font-size: 13px;
      color: var(--muted);
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--warn);
      animation: blink 1.2s infinite;
    }
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: .25; }
    }
    .ok { color: var(--ok); }
  </style>
</head>
<body>
  <main class="card">
    <span class="badge">${escapeHtml(state.status)}</span>
    <h1>${title}</h1>
    <p>${subtitle}</p>

    <section class="grid">
      <div class="item">
        <div class="label">Machine ID</div>
        <div class="value">${machineId}</div>
      </div>
      <div class="item">
        <div class="label">Motivo interno</div>
        <div class="value">${reason}</div>
      </div>
      <div class="item">
        <div class="label">Expiracao do token</div>
        <div class="value">${expiresAt}</div>
      </div>
    </section>

    <div class="footer">
      <span class="dot" id="dot"></span>
      <span id="status-text">Verificando status da licenca...</span>
    </div>
  </main>

  <script>
    (function () {
      const statusText = document.getElementById('status-text');
      const dot = document.getElementById('dot');
      const intervalMs = ${PENDING_POLL_INTERVAL_MS};

      async function checkStatus() {
        try {
          const res = await fetch('/license/status', { cache: 'no-store' });
          const data = await res.json();

          if (data && data.status === 'approved') {
            statusText.textContent = 'Licenca aprovada. Recarregando...';
            statusText.classList.add('ok');
            dot.style.background = '#22c55e';
            setTimeout(function () { window.location.reload(); }, 900);
            return;
          }

          statusText.textContent = 'Aguardando liberacao. Nova tentativa em ${pollSeconds}s.';
        } catch (error) {
          statusText.textContent = 'Sem conexao com o servidor local. Tentando novamente...';
        }
      }

      checkStatus();
      setInterval(checkStatus, intervalMs);
    })();
  </script>
</body>
</html>`
}

function licenseGuard(req, res, next) {
  const state = getLicenseState()
  if (state.status === 'approved') {
    return next()
  }

  if (req.path === '/license/status') {
    return next()
  }

  const message = buildBlockedMessage(state)
  const acceptsHtml = String(req.headers.accept || '').includes('text/html')

  if (acceptsHtml) {
    return res.status(423).send(renderBlockedHtml(state))
  }

  return res.status(423).json({
    error: message,
    license: state
  })
}

module.exports = {
  generateMachineId,
  readLicenseFile,
  saveLicenseFile,
  readPublicKey,
  savePublicKey,
  initializeLicense,
  dailyLicenseCheck,
  getLicenseState,
  licenseGuard,
  checkClockRollback
}


