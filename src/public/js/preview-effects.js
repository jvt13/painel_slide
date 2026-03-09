(function () {
  function getApi() {
    return window.VisualLoopPlayerEffects || {
      DEFAULT_EFFECT: 'fade',
      normalizeTransitionEffect: (value) => String(value || 'fade').toLowerCase(),
      animateTransition: () => Promise.resolve()
    }
  }

  function createPreviewSlides(container) {
    if (!container) return []
    if (container.querySelector('.preview-slide')) {
      return Array.from(container.querySelectorAll('.preview-slide'))
    }

    const first = document.createElement('div')
    first.className = 'preview-slide is-active'
    first.innerHTML = '<span>Slide A</span>'

    const second = document.createElement('div')
    second.className = 'preview-slide'
    second.innerHTML = '<span>Slide B</span>'

    container.appendChild(first)
    container.appendChild(second)

    return [first, second]
  }

  function applyPreviewEffect(container, effect) {
    const api = getApi()
    const slides = createPreviewSlides(container)
    if (slides.length < 2) return

    const normalized = api.normalizeTransitionEffect(effect)
    const active = slides.findIndex((slide) => slide.classList.contains('is-active'))
    const fromIndex = active >= 0 ? active : 0
    const toIndex = fromIndex === 0 ? 1 : 0

    api
      .animateTransition({
        container,
        fromLayer: slides[fromIndex],
        toLayer: slides[toIndex],
        effect: normalized,
        durationMs: 900
      })
      .catch(() => null)
  }

  window.VisualLoopPreviewEffects = {
    applyPreviewEffect
  }
})()
