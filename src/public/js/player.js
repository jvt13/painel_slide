const socket = typeof io === 'function' ? io() : { on: () => {} }

const DEFAULT_EMPTY_DURATION = 5000
const DEFAULT_AUTO_REFRESH_MS = 15000
const params = new URLSearchParams(window.location.search)
const forcedGroupId = Number(params.get('groupId'))
const isSingleGroupMode = Number.isInteger(forcedGroupId) && forcedGroupId > 0

let groups = []
let playQueue = []
let queueIndex = 0
let slideTimer = null
let isAutoRefreshing = false
let autoRefreshMs = DEFAULT_AUTO_REFRESH_MS
let currentEntryKey = null
let splashVisible = false
let entryWatchdogTimer = null

const groupPlaylists = new Map()
const groupSettings = new Map()

const container = document.getElementById('container')
const playerRoot = document.getElementById('player')
const splashEl = document.getElementById('startup-splash')
const splashLogo = document.getElementById('startup-logo')

function applyBackground(color) {
  const resolved = color || '#ffffff'
  if (playerRoot) {
    playerRoot.style.backgroundColor = resolved
  }
  document.body.style.backgroundColor = resolved
}

function clearContainer() {
  container.innerHTML = ''
}

function hideStartupSplash() {
  if (!splashEl) return
  splashVisible = false
  splashEl.classList.add('hidden')
}

function getStartupShownFlag() {
  try {
    return sessionStorage.getItem('player:startup-logo-shown') === '1'
  } catch (error) {
    return false
  }
}

function setStartupShownFlag() {
  try {
    sessionStorage.setItem('player:startup-logo-shown', '1')
  } catch (error) {
    // ignore storage errors (can happen in packaged environments)
  }
}

async function showStartupSplashIfNeeded() {
  if (!splashEl) return
  const alreadyShown = getStartupShownFlag()
  if (alreadyShown) {
    hideStartupSplash()
    return
  }

  splashVisible = true
  splashEl.classList.remove('hidden')

  try {
    const waitImage = new Promise((resolve) => {
      if (!splashLogo) return resolve()
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      if (splashLogo.complete) {
        return finish()
      }
      splashLogo.onload = finish
      splashLogo.onerror = finish
      setTimeout(finish, 1200)
    })

    // Hard fail-safe: never block player forever in splash mode.
    const hardTimeout = new Promise((resolve) => setTimeout(resolve, 4000))
    await Promise.race([
      (async () => {
        await waitImage
        await new Promise((resolve) => setTimeout(resolve, 1800))
      })(),
      hardTimeout
    ])
    setStartupShownFlag()
  } finally {
    hideStartupSplash()
  }
}

function getEntryKey(entry) {
  if (!entry || !entry.slide) return null
  const slide = entry.slide
  if (slide.id) return `${entry.groupId}:${slide.id}`
  return `${entry.groupId}:${slide.type || 'media'}:${slide.src || slide.name || 'unknown'}`
}

function clearSlideTimer() {
  if (slideTimer) {
    clearTimeout(slideTimer)
    slideTimer = null
  }
}

function clearEntryWatchdog() {
  if (entryWatchdogTimer) {
    clearTimeout(entryWatchdogTimer)
    entryWatchdogTimer = null
  }
}

function resolveDurationMs(value, fallback = DEFAULT_EMPTY_DURATION) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1000) return fallback
  return Math.min(parsed, 24 * 60 * 60 * 1000)
}

function scheduleEntryWatchdog(expectedMs) {
  clearEntryWatchdog()
  const safeMs = resolveDurationMs(expectedMs, DEFAULT_EMPTY_DURATION)
  // safety net: if any async race clears the main timer, force next slide
  entryWatchdogTimer = setTimeout(() => {
    nextEntry()
  }, safeMs + 3000)
}

function getGroupSettings(groupId) {
  return groupSettings.get(groupId) || { background: '#ffffff', defaultImage: null }
}

function updateClock() {
  const clockEl = document.getElementById('clock')
  if (!clockEl) return

  const now = new Date()
  const time = now.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit'
  })
  const date = now.toLocaleDateString('pt-BR')

  clockEl.innerText = `${date} ${time}`
}

setInterval(updateClock, 1000)
updateClock()

async function loadGroups() {
  const res = await fetch('/media/public/groups')
  const data = await res.json()
  const allGroups = Array.isArray(data) ? data : []
  if (isSingleGroupMode) {
    const selectedGroup = allGroups.find((group) => group.id === forcedGroupId)
    groups = selectedGroup ? [selectedGroup] : []
    return
  }
  groups = allGroups
}

async function loadGroupData(groupId) {
  const [playlistRes, settingsRes] = await Promise.all([
    fetch(`/media/public/playlist/active?groupId=${groupId}`),
    fetch(`/media/public/settings?groupId=${groupId}`, { cache: 'no-store' })
  ])

  const playlistPayload = await playlistRes.json()
  const coverSlides = Array.isArray(playlistPayload.coverSlides) ? playlistPayload.coverSlides : []
  const campaignSlides = Array.isArray(playlistPayload.slides) ? playlistPayload.slides : []
  const uniqueCoverSlides = []
  const seenCoverKeys = new Set()
  for (const slide of coverSlides) {
    const key = slide && slide.id ? `id:${slide.id}` : `src:${slide?.src || ''}`
    if (seenCoverKeys.has(key)) continue
    seenCoverKeys.add(key)
    uniqueCoverSlides.push(slide)
  }
  const groupPlaylist = [...uniqueCoverSlides, ...campaignSlides]
  const settings = await settingsRes.json()

  groupPlaylists.set(groupId, Array.isArray(groupPlaylist) ? groupPlaylist : [])
  groupSettings.set(groupId, {
    background: settings.background || '#ffffff',
    defaultImage: settings.defaultImage || null
  })
}

async function ensureGroupLoaded(groupId) {
  try {
    await loadGroupData(groupId)
  } catch (error) {
    groupPlaylists.set(groupId, [])
    groupSettings.set(groupId, { background: '#ffffff', defaultImage: null })
  }
}

async function preloadAllGroups() {
  await Promise.all(groups.map((group) => ensureGroupLoaded(group.id)))
}

function buildPlayQueue() {
  const oldKey = playQueue[queueIndex]
    ? `${playQueue[queueIndex].groupId}:${playQueue[queueIndex].slide.id}`
    : null

  const queue = []
  for (const group of groups) {
    const settings = getGroupSettings(group.id)
    const slides = groupPlaylists.get(group.id) || []

    if (slides.length) {
      for (const slide of slides) {
        queue.push({
          groupId: group.id,
          groupName: group.name,
          settings,
          slide,
          isDefault: false
        })
      }
    } else if (settings.defaultImage) {
      queue.push({
        groupId: group.id,
        groupName: group.name,
        settings,
        slide: {
          type: 'image',
          name: `default-${group.name}`,
          src: settings.defaultImage,
          duration: DEFAULT_EMPTY_DURATION
        },
        isDefault: true
      })
    }
  }

  playQueue = queue

  if (!playQueue.length) {
    queueIndex = 0
    return
  }

  if (!oldKey) {
    queueIndex = 0
    return
  }

  const found = playQueue.findIndex((item) => `${item.groupId}:${item.slide.id}` === oldKey)
  queueIndex = found >= 0 ? found : 0
}

function showCurrentEntry() {
  if (splashVisible) return
  if (!playQueue.length) {
    clearContainer()
    applyBackground('#ffffff')
    clearSlideTimer()
    clearEntryWatchdog()
    currentEntryKey = null
    return
  }

  const entry = playQueue[queueIndex]
  const nextEntryKey = getEntryKey(entry)
  if (nextEntryKey && nextEntryKey === currentEntryKey) {
    return
  }
  currentEntryKey = nextEntryKey
  const item = entry.slide
  applyBackground(entry.settings.background)

  clearSlideTimer()
  clearContainer()

  if (!item || !item.src) {
    clearEntryWatchdog()
    nextEntry()
    return
  }

  if (item.type === 'image') {
    const img = document.createElement('img')
    img.src = item.src
    img.onerror = () => nextEntry()
    container.appendChild(img)
    const durationMs = resolveDurationMs(item.duration)
    slideTimer = setTimeout(nextEntry, durationMs)
    scheduleEntryWatchdog(durationMs)
    return
  }

  if (item.type === 'video') {
    const video = document.createElement('video')
    video.src = item.src
    video.autoplay = true
    video.muted = true
    video.playsInline = true
    video.onerror = () => nextEntry()
    video.onended = nextEntry
    container.appendChild(video)
    scheduleEntryWatchdog(resolveDurationMs(item.duration, 10 * 60 * 1000))
    return
  }

  if (item.type === 'pdf') {
    const frame = document.createElement('iframe')
    frame.src = item.src
    frame.setAttribute('title', item.name || 'PDF')
    frame.onerror = () => nextEntry()
    container.appendChild(frame)
    const durationMs = resolveDurationMs(item.duration)
    slideTimer = setTimeout(nextEntry, durationMs)
    scheduleEntryWatchdog(durationMs)
    return
  }

  const durationMs = resolveDurationMs(item.duration)
  slideTimer = setTimeout(nextEntry, durationMs)
  scheduleEntryWatchdog(durationMs)
}

function nextEntry() {
  if (!playQueue.length) {
    clearContainer()
    applyBackground('#ffffff')
    clearEntryWatchdog()
    return
  }

  queueIndex = (queueIndex + 1) % playQueue.length
  showCurrentEntry()
}

async function refreshAll() {
  try {
    await loadGroups()
    await preloadAllGroups()
    buildPlayQueue()
  } catch (error) {
    groups = []
    playQueue = []
    queueIndex = 0
  }
}

async function loadRuntimeConfig() {
  try {
    const res = await fetch('/media/runtime-config', { cache: 'no-store' })
    if (!res.ok) return
    const payload = await res.json().catch(() => ({}))
    const value = Number(payload?.autoRefreshMs)
    if (Number.isFinite(value) && value >= 5000) {
      autoRefreshMs = value
    }
  } catch (error) {
    // keep default value
  }
}

async function autoRefreshTick() {
  if (isAutoRefreshing) return
  isAutoRefreshing = true
  try {
    await refreshAll()
    const current = playQueue[queueIndex]
    const currentKey = getEntryKey(current)
    if (!currentKey || currentKey !== currentEntryKey) {
      showCurrentEntry()
    }
  } finally {
    isAutoRefreshing = false
  }
}

socket.on('playlist:update', async (payload = {}) => {
  if (isSingleGroupMode && payload.groupId && Number(payload.groupId) !== forcedGroupId) return
  try {
    await refreshAll()
    showCurrentEntry()
  } catch (error) {
    // ignore transient realtime update errors
  }
})

socket.on('settings:update', async (payload = {}) => {
  if (isSingleGroupMode && payload.groupId && Number(payload.groupId) !== forcedGroupId) return
  try {
    await refreshAll()
    showCurrentEntry()
  } catch (error) {
    // ignore transient realtime update errors
  }
})

socket.on('groups:update', async () => {
  try {
    await refreshAll()
    showCurrentEntry()
  } catch (error) {
    // ignore transient realtime update errors
  }
})

async function startPlayer() {
  try {
    await showStartupSplashIfNeeded()
  } catch (error) {
    hideStartupSplash()
  }
  try {
    await loadRuntimeConfig()
    await refreshAll()
  } finally {
    showCurrentEntry()
  }
  setInterval(autoRefreshTick, autoRefreshMs)
}

startPlayer()

