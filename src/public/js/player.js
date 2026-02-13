const socket = io()

const DEFAULT_EMPTY_DURATION = 5000

let groups = []
let playQueue = []
let queueIndex = 0
let slideTimer = null

const groupPlaylists = new Map()
const groupSettings = new Map()

const container = document.getElementById('container')
const playerRoot = document.getElementById('player')

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

function clearSlideTimer() {
  if (slideTimer) {
    clearTimeout(slideTimer)
    slideTimer = null
  }
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
  const res = await fetch('/media/groups')
  const data = await res.json()
  groups = Array.isArray(data) ? data : []
}

async function loadGroupData(groupId) {
  const [playlistRes, settingsRes] = await Promise.all([
    fetch(`/media/playlist?groupId=${groupId}`),
    fetch(`/media/settings?groupId=${groupId}`, { cache: 'no-store' })
  ])

  const groupPlaylist = await playlistRes.json()
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
  if (!playQueue.length) {
    clearContainer()
    applyBackground('#ffffff')
    clearSlideTimer()
    return
  }

  const entry = playQueue[queueIndex]
  const item = entry.slide
  applyBackground(entry.settings.background)

  clearSlideTimer()
  clearContainer()

  if (!item || !item.src) {
    nextEntry()
    return
  }

  if (item.type === 'image') {
    const img = document.createElement('img')
    img.src = item.src
    img.onerror = () => nextEntry()
    container.appendChild(img)
    slideTimer = setTimeout(nextEntry, item.duration || DEFAULT_EMPTY_DURATION)
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
    return
  }

  if (item.type === 'pdf') {
    const frame = document.createElement('iframe')
    frame.src = item.src
    frame.setAttribute('title', item.name || 'PDF')
    frame.onerror = () => nextEntry()
    container.appendChild(frame)
    slideTimer = setTimeout(nextEntry, item.duration || DEFAULT_EMPTY_DURATION)
    return
  }

  slideTimer = setTimeout(nextEntry, item.duration || DEFAULT_EMPTY_DURATION)
}

function nextEntry() {
  if (!playQueue.length) {
    clearContainer()
    applyBackground('#ffffff')
    return
  }

  queueIndex = (queueIndex + 1) % playQueue.length
  showCurrentEntry()
}

async function refreshAll() {
  await loadGroups()
  await preloadAllGroups()
  buildPlayQueue()
}

socket.on('playlist:update', async () => {
  await refreshAll()
  showCurrentEntry()
})

socket.on('settings:update', async () => {
  await refreshAll()
  showCurrentEntry()
})

socket.on('groups:update', async () => {
  await refreshAll()
  showCurrentEntry()
})

async function startPlayer() {
  await refreshAll()
  showCurrentEntry()
}

startPlayer()
