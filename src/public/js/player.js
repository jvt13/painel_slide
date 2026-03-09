const socket = typeof io === 'function' ? io() : { on: () => {} }

const DEFAULT_EMPTY_DURATION = 5000
const DEFAULT_AUTO_REFRESH_MS = 15000
const effectsApi = window.VisualLoopPlayerEffects || {
  DEFAULT_EFFECT: 'fade',
  DEFAULT_DURATION_MS: 800,
  normalizeTransitionEffect: (value) => String(value || 'fade').trim().toLowerCase(),
  animateTransition: () => Promise.resolve()
}
const params = new URLSearchParams(window.location.search)
const forcedGroupId = Number(params.get('groupId'))
const isSingleGroupMode = Number.isInteger(forcedGroupId) && forcedGroupId > 0
const isManagedPlayerWindow = params.get('managed') === '1'

let groups = []
let playQueue = []
let queueIndex = 0
let slideTimer = null
let isAutoRefreshing = false
let autoRefreshMs = DEFAULT_AUTO_REFRESH_MS
let currentEntryKey = null
let splashVisible = false
let entryWatchdogTimer = null
let offlineFailures = 0
let transitionEffect = effectsApi.DEFAULT_EFFECT
let transitionScope = 'all'
let renderCycleId = 0
let activeLayerIndex = 0
let lastRenderedEntry = null

const groupPlaylists = new Map()
const groupSettings = new Map()

const container = document.getElementById('container')
const playerRoot = document.getElementById('player')
const splashEl = document.getElementById('startup-splash')
const splashLogo = document.getElementById('startup-logo')
const playerStatusEl = document.getElementById('player-status')

function setPlayerStatus(message) {
  if (!playerStatusEl) return
  if (!message) {
    playerStatusEl.classList.add('hidden')
    playerStatusEl.textContent = ''
    return
  }
  playerStatusEl.textContent = message
  playerStatusEl.classList.remove('hidden')
}

function handleOfflineFailure(reason) {
  offlineFailures += 1
  if (!isManagedPlayerWindow) return
  if (offlineFailures < 2) return
  try {
    window.close()
  } catch (error) {
    // ignore
  }
}

async function fetchJsonOrThrow(url, options = {}) {
  const res = await fetch(url, options)
  const text = await res.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch (error) {
    payload = null
  }
  if (!res.ok) {
    const detail = payload && payload.error ? ` - ${payload.error}` : ''
    throw new Error(`Falha ${res.status} em ${url}${detail}`)
  }
  return payload
}

function applyBackground(color) {
  const resolved = color || '#ffffff'
  if (playerRoot) {
    playerRoot.style.backgroundColor = resolved
  }
  document.body.style.backgroundColor = resolved
}

function createLayer() {
  const layer = document.createElement('div')
  layer.className = 'slide-layer'
  return layer
}

function ensureLayers() {
  if (!container) return []
  let layers = Array.from(container.querySelectorAll('.slide-layer'))
  if (layers.length >= 2) return layers

  container.innerHTML = ''
  const first = createLayer()
  const second = createLayer()
  first.classList.add('is-active')
  container.appendChild(first)
  container.appendChild(second)
  activeLayerIndex = 0
  return [first, second]
}

function getLayers() {
  return ensureLayers()
}

function getActiveLayer() {
  const layers = getLayers()
  const activeFromDom = layers.find((layer) => layer.classList.contains('is-active'))
  if (activeFromDom) {
    activeLayerIndex = layers.indexOf(activeFromDom)
    return activeFromDom
  }
  return layers[activeLayerIndex] || layers[0] || null
}

function getInactiveLayer() {
  const layers = getLayers()
  if (layers.length < 2) return null
  const active = getActiveLayer()
  const activeIndex = layers.indexOf(active)
  const inactiveIndex = activeIndex === 0 ? 1 : 0
  return layers[inactiveIndex] || null
}

function clearLayer(layer) {
  if (!layer) return
  while (layer.firstChild) {
    const node = layer.firstChild
    if (node.tagName === 'VIDEO' && typeof node.pause === 'function') {
      try {
        node.pause()
      } catch (error) {
        // ignore
      }
    }
    layer.removeChild(node)
  }
}

function clearContainer() {
  const layers = getLayers()
  layers.forEach((layer) => {
    clearLayer(layer)
    layer.classList.remove('is-active')
  })
  if (layers[0]) layers[0].classList.add('is-active')
  activeLayerIndex = 0
  lastRenderedEntry = null
}

function normalizeTransitionEffect(value) {
  return effectsApi.normalizeTransitionEffect(value || effectsApi.DEFAULT_EFFECT)
}

function setTransitionEffect(value) {
  transitionEffect = normalizeTransitionEffect(value)
  if (container) {
    container.dataset.transitionEffect = transitionEffect
  }
}

function normalizeTransitionScope(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'campaign' || normalized === 'cover') return normalized
  return 'all'
}

function setTransitionScope(value) {
  transitionScope = normalizeTransitionScope(value)
  if (container) {
    container.dataset.transitionScope = transitionScope
  }
}

function isCampaignEntry(entry) {
  return Number.isInteger(Number(entry?.slide?.campaignId)) && Number(entry.slide.campaignId) > 0
}

function shouldAnimateTransition(previousEntry, nextEntry) {
  if (!previousEntry || !nextEntry) return false
  if (transitionScope === 'all') return true
  if (transitionScope === 'campaign') {
    return isCampaignEntry(previousEntry) && isCampaignEntry(nextEntry)
  }
  if (transitionScope === 'cover') {
    return !isCampaignEntry(previousEntry) && !isCampaignEntry(nextEntry)
  }
  return true
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
  return groupSettings.get(groupId) || {
    background: '#ffffff',
    defaultImage: null,
    transitionEffect: effectsApi.DEFAULT_EFFECT,
    transitionScope: 'all'
  }
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
  const data = await fetchJsonOrThrow('/media/public/groups')
  const allGroups = Array.isArray(data) ? data : []
  if (isSingleGroupMode) {
    const selectedGroup = allGroups.find((group) => group.id === forcedGroupId)
    groups = selectedGroup ? [selectedGroup] : []
    return
  }
  groups = allGroups
}

async function loadGroupData(groupId) {
  const [playlistPayload, settings] = await Promise.all([
    fetchJsonOrThrow(`/media/public/playlist/active?groupId=${groupId}`),
    fetchJsonOrThrow(`/media/public/settings?groupId=${groupId}`, { cache: 'no-store' })
  ])

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
  groupPlaylists.set(groupId, Array.isArray(groupPlaylist) ? groupPlaylist : [])
  groupSettings.set(groupId, {
    background: settings.background || '#ffffff',
    defaultImage: settings.defaultImage || null,
    transitionEffect: normalizeTransitionEffect(settings.transitionEffect),
    transitionScope: normalizeTransitionScope(settings.transitionScope)
  })
}

async function ensureGroupLoaded(groupId) {
  try {
    await loadGroupData(groupId)
  } catch (error) {
    groupPlaylists.set(groupId, [])
    groupSettings.set(groupId, {
      background: '#ffffff',
      defaultImage: null,
      transitionEffect: effectsApi.DEFAULT_EFFECT,
      transitionScope: 'all'
    })
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

function createEntryNode(item) {
  if (item.type === 'image') {
    const img = document.createElement('img')
    img.loading = 'eager'
    img.decoding = 'async'
    img.src = item.src
    img.onerror = () => nextEntry()
    return img
  }

  if (item.type === 'video') {
    const video = document.createElement('video')
    video.src = item.src
    video.autoplay = true
    video.muted = true
    video.playsInline = true
    video.onerror = () => nextEntry()
    video.onended = nextEntry
    return video
  }

  if (item.type === 'pdf') {
    const frame = document.createElement('iframe')
    frame.src = item.src
    frame.setAttribute('title', item.name || 'PDF')
    frame.onerror = () => nextEntry()
    return frame
  }

  return null
}

function isImageReady(imgNode) {
  return Boolean(imgNode && imgNode.complete && imgNode.naturalWidth > 0)
}

function isLayerRenderable(layer) {
  if (!layer || !layer.firstChild) return false
  const node = layer.firstChild
  const tag = String(node.tagName || '').toUpperCase()
  if (tag === 'IMG') {
    return Boolean(node.complete && node.naturalWidth > 0)
  }
  if (tag === 'VIDEO') {
    return true
  }
  if (tag === 'IFRAME' || tag === 'EMBED') {
    return true
  }
  return true
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
  const entryItem = entry?.slide || null
  if (nextEntryKey && nextEntryKey === currentEntryKey) {
    const activeLayer = getActiveLayer()
    const stillRenderable = isLayerRenderable(activeLayer)
    if (stillRenderable && entryItem) {
      clearSlideTimer()
      clearEntryWatchdog()
      const durationMs = resolveDurationMs(entryItem.duration)
      if (entryItem.type === 'video') {
        scheduleEntryWatchdog(resolveDurationMs(entryItem.duration, 10 * 60 * 1000))
      } else {
        slideTimer = setTimeout(nextEntry, durationMs)
        scheduleEntryWatchdog(durationMs)
      }
      return
    }
  }
  renderCycleId += 1
  const currentRenderCycle = renderCycleId
  currentEntryKey = nextEntryKey
  const item = entryItem
  applyBackground(entry.settings.background)
  setTransitionEffect(entry.settings.transitionEffect)
  setTransitionScope(entry.settings.transitionScope)

  clearSlideTimer()

  if (!item || !item.src) {
    clearContainer()
    clearEntryWatchdog()
    nextEntry()
    return
  }

  const activeLayer = getActiveLayer()
  const inactiveLayer = getInactiveLayer()
  if (!activeLayer || !inactiveLayer) return
  const layers = getLayers()
  const currentActiveIndex = layers.indexOf(activeLayer)

  const nextNode = createEntryNode(item)
  if (!nextNode) {
    clearContainer()
    const durationMs = resolveDurationMs(item.duration)
    slideTimer = setTimeout(nextEntry, durationMs)
    scheduleEntryWatchdog(durationMs)
    return
  }

  const performLayerSwap = () => {
    if (currentRenderCycle !== renderCycleId) return

    clearLayer(inactiveLayer)
    inactiveLayer.appendChild(nextNode)
    inactiveLayer.classList.remove('is-active')

    const firstRender = !activeLayer.firstChild
    const applyAnimatedTransition = !firstRender && shouldAnimateTransition(lastRenderedEntry, entry)
    if (firstRender) {
      clearLayer(activeLayer)
      activeLayer.appendChild(nextNode)
      activeLayer.classList.add('is-active')
      activeLayerIndex = currentActiveIndex >= 0 ? currentActiveIndex : 0
      lastRenderedEntry = entry
      return
    }

    if (applyAnimatedTransition) {
      const previousLayerIndex = currentActiveIndex
      effectsApi
        .animateTransition({
          container,
          fromLayer: activeLayer,
          toLayer: inactiveLayer,
          effect: transitionEffect,
          durationMs: effectsApi.DEFAULT_DURATION_MS
        })
        .catch(() => null)
        .finally(() => {
          if (currentRenderCycle !== renderCycleId) return
          clearLayer(activeLayer)
          activeLayerIndex = previousLayerIndex === 0 ? 1 : 0
        })
      lastRenderedEntry = entry
      return
    }

    clearLayer(activeLayer)
    activeLayer.classList.remove('is-active')
    inactiveLayer.classList.add('is-active')
    activeLayerIndex = currentActiveIndex === 0 ? 1 : 0
    lastRenderedEntry = entry
  }

  if (item.type === 'image' && !isImageReady(nextNode)) {
    nextNode.addEventListener(
      'load',
      () => {
        performLayerSwap()
      },
      { once: true }
    )
    nextNode.addEventListener(
      'error',
      () => {
        if (currentRenderCycle !== renderCycleId) return
        nextEntry()
      },
      { once: true }
    )
  } else {
    performLayerSwap()
  }

  const durationMs = resolveDurationMs(item.duration)
  if (item.type === 'video') {
    scheduleEntryWatchdog(resolveDurationMs(item.duration, 10 * 60 * 1000))
    return
  }

  slideTimer = setTimeout(nextEntry, durationMs)
  scheduleEntryWatchdog(durationMs)
}

function nextEntry() {
  if (!playQueue.length) {
    clearContainer()
    applyBackground('#ffffff')
    clearEntryWatchdog()
    clearSlideTimer()
    return
  }

  queueIndex = (queueIndex + 1) % playQueue.length
  showCurrentEntry()
}

async function refreshAll() {
  await loadGroups()
  await preloadAllGroups()
  buildPlayQueue()
  setPlayerStatus('')
  offlineFailures = 0
  if (!playQueue.length) {
    lastRenderedEntry = null
  }
}

async function loadRuntimeConfig() {
  try {
    const payload = await fetchJsonOrThrow('/media/runtime-config', { cache: 'no-store' })
    const value = Number(payload?.autoRefreshMs)
    if (Number.isFinite(value) && value >= 5000) {
      autoRefreshMs = value
    }
    if (payload?.transitionEffect) {
      setTransitionEffect(payload.transitionEffect)
    }
    if (payload?.transitionScope) {
      setTransitionScope(payload.transitionScope)
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
  } catch (error) {
    setPlayerStatus(error.message || 'Falha no auto refresh do player')
    handleOfflineFailure(error.message)
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
    setPlayerStatus(error.message || 'Falha ao atualizar playlist')
    handleOfflineFailure(error.message)
  }
})

socket.on('settings:update', async (payload = {}) => {
  if (isSingleGroupMode && payload.groupId && Number(payload.groupId) !== forcedGroupId) return
  try {
    await refreshAll()
    showCurrentEntry()
  } catch (error) {
    setPlayerStatus(error.message || 'Falha ao atualizar configuracoes')
    handleOfflineFailure(error.message)
  }
})

socket.on('transition:update', async () => {
  try {
    await refreshAll()
    showCurrentEntry()
  } catch (error) {
    setPlayerStatus(error.message || 'Falha ao atualizar efeito de transicao')
    handleOfflineFailure(error.message)
  }
})

socket.on('groups:update', async () => {
  try {
    await refreshAll()
    showCurrentEntry()
  } catch (error) {
    setPlayerStatus(error.message || 'Falha ao atualizar grupos')
    handleOfflineFailure(error.message)
  }
})

socket.on('license:update', (payload = {}) => {
  const status = String(payload.status || '')
  if (status === 'approved') {
    return
  }
  // Forca nova requisicao da rota /player para que o license guard renderize a tela bloqueada.
  window.location.reload()
})

socket.on('disconnect', () => {
  handleOfflineFailure('socket disconnect')
})

socket.on('connect_error', () => {
  handleOfflineFailure('socket connect error')
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
  } catch (error) {
    setPlayerStatus(error.message || 'Falha ao carregar dados do player')
    handleOfflineFailure(error.message)
  } finally {
    showCurrentEntry()
  }
  setInterval(autoRefreshTick, autoRefreshMs)
}

startPlayer()


