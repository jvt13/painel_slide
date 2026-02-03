const socket = io()

let playlist = []
let currentIndex = 0
const container = document.getElementById('container')

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



async function loadPlaylist() {
  const res = await fetch('/media/playlist')
  playlist = await res.json()

  console.log('Playlist carregada:', playlist)
}

function clearContainer() {
  container.innerHTML = ''
}

function showItem(item) {
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

    setTimeout(nextItem, item.duration || 5000)
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

  else {
    // PDF ou qualquer outro tipo (ignora por enquanto)
    setTimeout(nextItem, item.duration || 3000)
  }
}

function nextItem() {
  currentIndex = (currentIndex + 1) % playlist.length
  showItem(playlist[currentIndex])
}

async function startPlayer() {
  await loadPlaylist()

  if (!playlist.length) {
    console.warn('Playlist vazia')
    return
  }

  showItem(playlist[currentIndex])
}

startPlayer()
