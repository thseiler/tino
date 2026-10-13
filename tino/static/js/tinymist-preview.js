import { PREVIEW_PAGE_GAP_SIZE, SINGLE_ITEM } from './constants.js'
import { PreviewConnection } from './preview-connection.js'
import { decorateSvgElement } from './preview-renderer.js'
import { patchSvgToContainer } from './preview-patcher.js'

const ZOOM_BASE = 100
const VIEWPORT_BUFFER_PX = 2000
const AWARENESS_POLL_INTERVAL_MS = 200
const AWARENESS_POLL_MAX_ATTEMPTS = 10

/** Live incremental preview engine backed by Tinymist and a WASM renderer worker. */

export class TinymistPreview {

  constructor(app, renderer, diagnostics) {
    this.app = app
    this.renderer = renderer
    this.diagnostics = diagnostics
    this.connection = null
    this._connectingTarget = null
    this.worker = null
    this._boundAwareness = null
    this._awarenessHandler = null
    this._lastSeenFocusTs = new Map()
    this._spawnWorker()
  }

  bind(onAutoPin) {
    this._bindPreviewClicks(onAutoPin)
    this._bindScroll()
  }

  disconnect() {
    this._connectingTarget = null
    const awareness = this._getAwareness()
    if (awareness)
      awareness.setLocalStateField('previewFocus', null)
    this.renderer.clearCollabHighlights()
    this._closeConnection()
  }

  async connect(target) {
    if (!this._shouldConnect(target)) {
      this._bindCollabAwareness()
      return
    }

    this._connectingTarget = target
    try {
      await this._openConnection(target)
    }
    catch {
      this.renderer.showError('Failed to load WebAssembly engine.')
    }
    finally {
      if (this._connectingTarget === target)
        this._connectingTarget = null
    }
  }

  async _openConnection(target) {
    await this._prepareWasmSession()
    if (this._connectingTarget !== target)
      return
    this._pollAwarenessUntilBound()
    this._closeConnection()
    this.connection = this._createConnection(target)
    this.connection.connect()
  }

  _closeConnection() {
    if (!this.connection)
      return
    this.connection.disconnect()
    this.connection = null
  }

  _shouldConnect(target) {
    if (!this.app.bucket || !target || this._connectingTarget === target)
      return false
    if (this.connection && this.connection.target === target && this.connection.isOpen)
      return false
    this._closeConnection()
    return true
  }

  _getAwareness() {
    const session = this.app.editor.collab._session
    const provider = session && session._provider
    return (provider && provider.awareness) || null
  }

  _publishCollabFocus(page, xCoord, yCoord) {
    this._bindCollabAwareness()
    const awareness = this._getAwareness()
    const target = this.connection && this.connection.target
    if (!awareness || !target)
      return

    awareness.setLocalStateField('previewFocus', { page, target, ts: Date.now(), xCoord, yCoord })
  }

  _bindCollabAwareness() {
    const awareness = this._getAwareness()
    if (!awareness)
      return false
    if (this._boundAwareness === awareness)
      return true

    if (this._boundAwareness && this._awarenessHandler)
      this._boundAwareness.off('change', this._awarenessHandler)

    this._boundAwareness = awareness
    this._lastSeenFocusTs = new Map()
    this._awarenessHandler = () => this._handleAwarenessChange(awareness)
    awareness.on('change', this._awarenessHandler)
    this._handleAwarenessChange(awareness)
    return true
  }

  _pollAwarenessUntilBound(attemptsLeft = AWARENESS_POLL_MAX_ATTEMPTS) {
    if (this._bindCollabAwareness() || attemptsLeft <= 0)
      return
    const nextPoll = () => this._pollAwarenessUntilBound(attemptsLeft - SINGLE_ITEM)
    setTimeout(nextPoll, AWARENESS_POLL_INTERVAL_MS)
  }

  _handleAwarenessChange(awareness) {
    const states = awareness.getStates()
    this.renderer.clearCollabHighlights(new Set(states.keys()))
    states.forEach((state, clientId) => this._renderRemoteFocus(awareness, state, clientId))
  }

  _renderRemoteFocus(awareness, state, clientId) {
    if (clientId === awareness.clientID)
      return

    const focus = state.previewFocus
    const activeTarget = this.connection && this.connection.target
    if (!focus || focus.target !== activeTarget || this._lastSeenFocusTs.get(clientId) === focus.ts)
      return

    const user = state.user || {}
    const info = { color: user.color, name: user.name || user.username || 'Collaborator' }
    if (this.renderer.showCollabHighlight(clientId, info, focus))
      this._lastSeenFocusTs.set(clientId, focus.ts)
  }

  _spawnWorker() {
    if (this.worker)
      this.worker.terminate()

    this.worker = new Worker('./js/preview-worker.js', { type: 'module' })
    this.worker.onerror = evt => this.app.toast.error(evt.message)
    this.workerInitPromise = new Promise(resolve => {
      this.worker.onmessage = msg => this._handleWorkerMessage(msg.data, resolve)
    })
    this.worker.postMessage({ action: 'init' })
  }

  _handleWorkerMessage(data, onInit) {
    if (data.type === 'initialized')
      onInit()
    if (data.type === 'session_panicked') {
      if (data.message && this.app.toast)
        this.app.toast.error(data.message)
      this._recoverFromPanic()
    }
    if (data.type === 'svg_patch')
      this._applySvgPatch(data.patchStr)
  }

  _recoverFromPanic() {
    this.app.toast.error('WASM engine panicked. Halting sync to prevent infinite loop.')
    this.worker.postMessage({ action: 'reset_session' })
    this.disconnect()
    this.renderer.showCrashRecovery(() => {
      this._spawnWorker()
      if (this.connection)
        this.connect(this.connection.target)
    })
  }

  _applySvgPatch(patchStr) {
    const container = this.app.els.previewPage
    if (!container.firstElementChild || container.querySelector('.preview-empty, .preview-errors'))
      container.innerHTML = ''

    patchSvgToContainer(container, patchStr, svgElem => decorateSvgElement(svgElem))
    if (this._boundAwareness)
      this._handleAwarenessChange(this._boundAwareness)
  }

  async _prepareWasmSession() {
    if (!this.workerInitPromise)
      this.renderer.showLoading('Loading WebAssembly engine...')
    await this.workerInitPromise
    this.renderer.showLoading('Loading preview...')
    this.worker.postMessage({ action: 'reset_session' })
  }

  _createConnection(target) {
    return new PreviewConnection(this.app.bucket, target, {
      onDocReady: () => {
        this._pollAwarenessUntilBound()
        this._resetForFreshDoc()
      },
      onEditorScroll: data => this.app.sync.jumpToSource(data),
      onError: message => this.app.toast.error(message),
      onJump: (page, xCoord, yCoord) => {
        this.renderer.scrollToPosition(page, xCoord, yCoord)
        this._publishCollabFocus(page, xCoord, yCoord)
      },
      onPatch: (command, payload) => this.worker.postMessage(
        { action: 'process_diff', command, payload }, [payload.buffer]),
      onStatusChange: status => {
        this._pollAwarenessUntilBound()
        this.diagnostics.updateStatus(status)
        if (this.app.sync)
          this.app.sync.onCompileStatus(status)
      },
    })
  }

  _resetForFreshDoc() {
    const res = document.getElementById('typst-svg-resources')
    if (res)
      res.remove()
    this.worker.postMessage({ action: 'reset_session' })
    this.renderer.showLoading('Compiling document...')
  }

  _bindPreviewClicks(onAutoPin) {
    this.app.els.previewPage.addEventListener('dblclick', evt => {
      onAutoPin()
      this._sendClickLocation(evt)
    })
  }

  _sendClickLocation(evt) {
    const pageNode = evt.target.closest('.typst-page')
    if (!pageNode || !this.connection || !this.connection.isOpen)
      return

    const slot = pageNode.closest('[data-preview-slot]')
    const bgRect = pageNode.querySelector('.typst-paper-bg')
    if (!bgRect || !slot)
      return

    const frameLoc = TinymistPreview._computeFrameLoc(slot, bgRect, evt)
    this.connection.send(`src-point ${JSON.stringify(frameLoc)}`)
  }

  static _computeFrameLoc(slot, bgRect, evt) {
    const domRect = bgRect.getBoundingClientRect()
    const pageNo = Number(slot.getAttribute('data-preview-slot')) + SINGLE_ITEM
    const xRatio = (evt.clientX - domRect.left) / domRect.width
    const yRatio = (evt.clientY - domRect.top) / domRect.height
    return {
      page_no: pageNo,
      // eslint-disable-next-line id-length
      x: xRatio * parseFloat(bgRect.getAttribute('width')),
      // eslint-disable-next-line id-length
      y: yRatio * parseFloat(bgRect.getAttribute('height')),
    }
  }

  _bindScroll() {
    const viewport = this.app.els.previewPage.closest('.preview-viewport')
    if (!viewport)
      return

    let isScrolling = false
    viewport.addEventListener('scroll', () => {
      if (isScrolling)
        return
      isScrolling = true
      requestAnimationFrame(() => {
        this._postScrollWindow(viewport)
        isScrolling = false
      })
    }, { passive: true })

    viewport.dispatchEvent(new Event('scroll'))
  }

  _postScrollWindow(viewport) {
    const currentScale = (this.app.zoom || ZOOM_BASE) / ZOOM_BASE
    const top = viewport.scrollTop / currentScale
    const maxGapDrift = viewport.querySelectorAll('.typst-page').length * PREVIEW_PAGE_GAP_SIZE
    const bottom = top + (viewport.clientHeight / currentScale) + VIEWPORT_BUFFER_PX + maxGapDrift

    this.worker.postMessage({
      action: 'update_window',
      window: { bottom, top: Math.max(0, top - VIEWPORT_BUFFER_PX) },
    })
  }

}