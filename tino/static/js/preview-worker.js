import { createTypstRenderer } from './vendor/preview.js'

let renderer = createTypstRenderer()
let rendererInitPromise = null
let session = null
let currentWindow = { bottom: 2000, top: 0 }

const ensureRenderer = async() => {
  if (!rendererInitPromise) {
    rendererInitPromise = renderer.init({
      beforeBuild: [],
      getModule: () => '/js/vendor/typst_ts_renderer_bg.wasm',
    })
  }
  await rendererInitPromise
}

const initRenderer = async() => {
  await ensureRenderer()
  self.postMessage({ type: 'initialized' })
}

const processPayload = async(command, payload) => {
  if (!payload)
    return

  if (session && command && command.startsWith('diff')) {
    await renderer.manipulateData({ action: 'merge', data: payload, renderSession: session })
    return
  }

  if (session) {
    // Re-create the WASM renderer instance so internal font/glyph tables reset cleanly
    renderer = createTypstRenderer()
    rendererInitPromise = null
    session = null
    await ensureRenderer()
  }

  // eslint-disable-next-line require-atomic-updates
  session = await renderer.createModule(payload)
}

const renderDiff = () => {
  if (!session)
    return

  const patchStr = session.renderSvgDiff({
    window: {
      // eslint-disable-next-line id-length
      hi: { x: 1e33, y: currentWindow.bottom },
      // eslint-disable-next-line id-length
      lo: { x: 0, y: currentWindow.top },
    },
  })

  self.postMessage({ patchStr, type: 'svg_patch' })
}

const handleProcessDiff = async(action, command, payload, windowData) => {
  try {
    if (action === 'update_window')
      currentWindow = windowData

    await processPayload(command, payload)
    renderDiff()
  }
  catch (err) {
    session = null
    const message = err instanceof Error ? err.message : 'Failed to process preview payload'
    self.postMessage({
      message,
      type: 'session_panicked',
    })
  }
}

self.onmessage = async evt => {
  const { action, command, payload } = evt.data

  if (action === 'init') {
    await initRenderer()
    return
  }

  if (action === 'reset_session') {
    session = null
    return
  }

  if (action === 'process_diff' || action === 'update_window')
    await handleProcessDiff(action, command, payload, evt.data.window)
}