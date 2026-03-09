(function () {
  const EFFECTS = ['fade', 'slide-left', 'zoom', 'flip']
  const DEFAULT_EFFECT = 'fade'
  const DEFAULT_DURATION_MS = 800

  function normalizeTransitionEffect(value) {
    const normalized = String(value || '').trim().toLowerCase()
    return EFFECTS.includes(normalized) ? normalized : DEFAULT_EFFECT
  }

  function getKeyframes(effect) {
    if (effect === 'slide-left') {
      return {
        out: [
          { opacity: 1, transform: 'translateX(0%)' },
          { opacity: 0, transform: 'translateX(-12%)' }
        ],
        in: [
          { opacity: 0, transform: 'translateX(12%)' },
          { opacity: 1, transform: 'translateX(0%)' }
        ]
      }
    }

    if (effect === 'zoom') {
      return {
        out: [
          { opacity: 1, transform: 'scale(1)' },
          { opacity: 0, transform: 'scale(1.08)' }
        ],
        in: [
          { opacity: 0, transform: 'scale(1.08)' },
          { opacity: 1, transform: 'scale(1)' }
        ]
      }
    }

    if (effect === 'flip') {
      return {
        out: [
          { opacity: 1, transform: 'scale(1) rotate(0deg)' },
          { opacity: 0, transform: 'scale(0.92) rotate(-7deg)' }
        ],
        in: [
          { opacity: 0, transform: 'scale(0.92) rotate(7deg)' },
          { opacity: 1, transform: 'scale(1) rotate(0deg)' }
        ]
      }
    }

    return {
      out: [{ opacity: 1 }, { opacity: 0 }],
      in: [{ opacity: 0 }, { opacity: 1 }]
    }
  }

  function animateTransition(options) {
    const {
      container,
      fromLayer,
      toLayer,
      effect,
      durationMs = DEFAULT_DURATION_MS
    } = options || {}

    if (!container || !toLayer) return Promise.resolve()

    const normalized = normalizeTransitionEffect(effect)
    container.dataset.transitionEffect = normalized

    if (!fromLayer || !fromLayer.firstChild) {
      toLayer.classList.add('is-active')
      return Promise.resolve()
    }

    if (typeof toLayer.animate !== 'function' || typeof fromLayer.animate !== 'function') {
      fromLayer.classList.remove('is-active')
      toLayer.classList.add('is-active')
      return Promise.resolve()
    }

    fromLayer.getAnimations().forEach((animation) => animation.cancel())
    toLayer.getAnimations().forEach((animation) => animation.cancel())

    const keyframes = getKeyframes(normalized)
    const config = {
      duration: Math.max(200, Number(durationMs) || DEFAULT_DURATION_MS),
      easing: 'ease',
      fill: 'forwards'
    }

    const oldAnimation = fromLayer.animate(keyframes.out, config)
    const nextAnimation = toLayer.animate(keyframes.in, config)

    toLayer.classList.add('is-active')

    return Promise.all([
      oldAnimation.finished.catch(() => null),
      nextAnimation.finished.catch(() => null)
    ]).then(() => {
      fromLayer.classList.remove('is-active')
      fromLayer.style.transform = ''
      fromLayer.style.opacity = ''
      toLayer.style.transform = ''
      toLayer.style.opacity = ''
    })
  }

  window.VisualLoopPlayerEffects = {
    EFFECTS,
    DEFAULT_EFFECT,
    DEFAULT_DURATION_MS,
    normalizeTransitionEffect,
    animateTransition
  }
})()
