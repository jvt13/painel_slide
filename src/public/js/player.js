const socket = io()

const DEFAULT_EMPTY_DURATION = 5000

let groups = []
let groupIndex = 0
let currentGroupId = null
let playlist = []
let currentIndex = 0
let slideTimer = null

const groupPlaylists = new Map()
const groupSettings = new Map()

const container = document.getElementById('container')
const playerRoot = document.getElementById('player')

function applyBackground(color) {
  if (playerRoot) {
    playerRoot.style.backgroundColor = color
  }
  document.body.style.backgroundColor = color
}

function clearContainer() {
  container.innerHTML = ''
}

function getGroupSettings(groupId) {
  return groupSettings.get(groupId) || { background: '#ffffff', defaultImage: null }
}

function showDefaultImage(groupId) {
  clearContainer()
  const settings = getGroupSettings(groupId)
  if (!settings.defaultImage) return

  const img = document.createElement('img')
  img.src = settings.defaultImage
  img.alt = 'Imagem padrao do grupo'
  container.appendChild(img)
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
  groups = await res.json()
  if (!Array.isArray(groups)) groups = []
  if (!groups.length) {
    groupIndex = 0
    return
  }

  if (currentGroupId) {
    const idx = groups.findIndex((group) => group.id === currentGroupId)
    if (idx >= 0) {
      groupIndex = idx
      return
    }
  }

  groupIndex = 0
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
  if (!groupPlaylists.has(groupId) || !groupSettings.has(groupId)) {
    await loadGroupData(groupId)
  }
}

function setCurrentGroup(groupId) {
  currentGroupId = groupId
  playlist = groupPlaylists.get(groupId) || []
  currentIndex = 0
  const settings = getGroupSettings(groupId)
  applyBackground(settings.background)
}

function scheduleNextGroup(delayMs = 0) {
  if (slideTimer) {
    clearTimeout(slideTimer)
    slideTimer = null
  }
  slideTimer = setTimeout(() => {
    goToNextGroup()
  }, delayMs)
}

function showItem(item) {
  if (slideTimer) {
    clearTimeout(slideTimer)
    slideTimer = null
  }

  if (!item || !item.src) {
    nextItem()
    return
  }

  clearContainer()

  if (item.type === 'image') {
    const img = document.createElement('img')
    img.src = item.src

    img.onerror = () => nextItem()
    container.appendChild(img)

    slideTimer = setTimeout(nextItem, item.duration || 5000)
  }

  else if (item.type === 'video') {
    const video = document.createElement('video')
    video.src = item.src
    video.autoplay = true
    video.muted = true
    video.playsInline = true

    video.onerror = () => nextItem()
    video.onended = nextItem

    container.appendChild(video)
  }

  else if (item.type === 'pdf') {
    const frame = document.createElement('iframe')
    frame.src = item.src
    frame.setAttribute('title', item.name || 'PDF')
    frame.onerror = () => nextItem()

    container.appendChild(frame)
    slideTimer = setTimeout(nextItem, item.duration || 5000)
  }

  else {
    slideTimer = setTimeout(nextItem, item.duration || 3000)
  }
}

function nextItem() {
  if (!playlist.length) {
    showDefaultImage(currentGroupId)
    scheduleNextGroup(DEFAULT_EMPTY_DURATION)
    return
  }

  const nextIndex = currentIndex + 1
  if (nextIndex >= playlist.length) {
    scheduleNextGroup(0)
    return
  }

  currentIndex = nextIndex
  showItem(playlist[currentIndex])
}

async function goToNextGroup() {
  if (!groups.length) return
  groupIndex = (groupIndex + 1) % groups.length
  const nextGroup = groups[groupIndex]
  await ensureGroupLoaded(nextGroup.id)
  setCurrentGroup(nextGroup.id)

  if (!playlist.length) {
    showDefaultImage(nextGroup.id)
    scheduleNextGroup(DEFAULT_EMPTY_DURATION)
    return
  }

  showItem(playlist[currentIndex])
}

socket.on('playlist:update', async (payload = {}) => {
  if (payload.groupId) {
    await loadGroupData(payload.groupId)
    if (payload.groupId === currentGroupId) {
      setCurrentGroup(currentGroupId)
      if (!playlist.length) {
        showDefaultImage(currentGroupId)
        scheduleNextGroup(DEFAULT_EMPTY_DURATION)
      } else {
        showItem(playlist[currentIndex])
      }
    }
  }
})

socket.on('settings:update', async (payload = {}) => {
  if (payload.groupId) {
    await loadGroupData(payload.groupId)
    if (payload.groupId === currentGroupId) {
      const settings = getGroupSettings(currentGroupId)
      applyBackground(settings.background)
      if (!playlist.length) showDefaultImage(currentGroupId)
    }
  }
})

socket.on('groups:update', async () => {
  await loadGroups()
})

async function startPlayer() {
  await loadGroups()
  if (!groups.length) return

  const initialGroup = groups[groupIndex]
  await ensureGroupLoaded(initialGroup.id)
  setCurrentGroup(initialGroup.id)

  if (!playlist.length) {
    showDefaultImage(initialGroup.id)
    scheduleNextGroup(DEFAULT_EMPTY_DURATION)
    return
  }

  showItem(playlist[currentIndex])
}

startPlayer()
