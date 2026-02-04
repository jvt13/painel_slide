const socket = io()

let playlist = []
let currentIndex = 0
let slideTimer = null
const container = document.getElementById('container')
const playerRoot = document.getElementById('player')

socket.on('playlist:update', async () => {
  console.log('Playlist atualizada')

  const oldLength = playlist.length
  await loadPlaylist()

  // só reinicia se mudou o tamanho ou estava vazia
  if (playlist.length !== oldLength) {
    currentIndex = 0
    showItem(playlist[currentIndex])
  }
})

socket.on('settings:update', (settings) => {
  if (settings && settings.background) {
    applyBackground(settings.background)
  }
})

function updateClock() {
  const now = new Date()
  const time = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const date = now.toLocaleDateString('pt-BR')
  document.getElementById('clock').innerText = `${date} ${time}`
}

setInterval(updateClock, 1000)
updateClock()

async function loadPlaylist() {
  const res = await fetch('/media/playlist')
  playlist = await res.json()

  console.log('Playlist carregada:', playlist)
}

async function loadSettings() {
  try {
    const res = await fetch('/media/settings', { cache: 'no-store' })
    const settings = await res.json()
    if (settings && settings.background) {
      applyBackground(settings.background)
    }
  } catch (err) {
    // ignore
  }
}

function applyBackground(color) {
  if (playerRoot) {
    playerRoot.style.backgroundColor = color
  }
  document.body.style.backgroundColor = color
}

function clearContainer() {
  container.innerHTML = ''
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
    // PDF ou qualquer outro tipo (ignora por enquanto)
    slideTimer = setTimeout(nextItem, item.duration || 3000)
  }
}

function nextItem() {
  if (!playlist.length) return
  currentIndex = (currentIndex + 1) % playlist.length
  showItem(playlist[currentIndex])
}

async function startPlayer() {
  await loadSettings()
  await loadPlaylist()

  if (!playlist.length) {
    console.warn('Playlist vazia')
    return
  }

  showItem(playlist[currentIndex])
}

startPlayer()
