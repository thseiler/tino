import { createTypstRenderer } from './vendor/preview.js'

const renderer = createTypstRenderer()
let rendererInitPromise = null
let session = null
let currentWindow = { bottom: 2000, top: 0 }

const initRenderer = async() => {
  if (!rendererInitPromise) {
    rendererInitPromise = renderer.init({
      beforeBuild: [],
      getModule: () => '/wasm/typst_ts_renderer_bg.wasm',
    })
  }
  await rendererInitPromise
  self.postMessage({ type: 'initialized' })
}

const processPayload = async payload => {
  if (!payload) 
return

  if (session) 
    await renderer.manipulateData({ action: 'merge', data: payload, renderSession: session })
   else {
    const newSession = await renderer.createModule(payload)
    // eslint-disable-next-line require-atomic-updates
    session = newSession
  }
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

const handleProcessDiff = async(action, payload, windowData) => {
  try {
    if (action === 'update_window') 
      currentWindow = windowData

    await processPayload(payload)
    renderDiff()
  }
  catch {
    session = null
    
    // Tell the main thread that the session panicked and needs a fresh doc sync
    self.postMessage({ type: 'session_panicked' })
  }
}

self.onmessage = async evt => {
  const { action, payload } = evt.data

  if (action === 'init') {
    await initRenderer()
    return
  }

  if (action === 'reset_session') {
    session = null
    return
  }

  if (action === 'process_diff' || action === 'update_window') 
    await handleProcessDiff(action, payload, evt.data.window)
}