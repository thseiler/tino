import { PREVIEW_PAGE_GAP_SIZE, SINGLE_ITEM } from './constants.js'
import { PreviewConnection } from './preview-connection.js'
import { decorateSvgElement } from './preview-renderer.js'
import { patchSvgToContainer } from './preview-patcher.js'

const ZOOM_BASE = 100
const VIEWPORT_BUFFER_PX = 2000

/**
 * Live incremental preview engine backed by Tinymist and a WASM renderer worker.
 */

export class TinymistPreview {

  constructor(app, renderer, diagnostics) {
    this.app = app
    this.renderer = renderer
    this.diagnostics = diagnostics
    this.connection = null
    this.worker = null
    this._spawnWorker()
  }

  bind(onAutoPin) {
    this._bindPreviewClicks(onAutoPin)
    this._bindScroll()
  }

  disconnect() {
    if (this.connection)
      this.connection.disconnect()
  }

  async connect(target) {
    if (!this._shouldConnect(target))
      return

    try {
      await this._prepareWasmSession()
      this.connection = this._createConnection(target)
      this.connection.connect()
    }
    catch {
      this.renderer.showError('Failed to load WebAssembly engine.')
    }
  }

  _spawnWorker() {
    if (this.worker)
      this.worker.terminate()

    this.worker = new Worker('./js/preview-worker.js', { type: 'module' })
    this.worker.onerror = evt => console.error('Worker Thread Error:', evt)
    this.workerInitPromise = new Promise(resolve => {
      this.worker.onmessage = msg => this._handleWorkerMessage(msg.data, resolve)
    })
    this.worker.postMessage({ action: 'init' })
  }

  _handleWorkerMessage(data, onInit) {
    if (data.type === 'initialized')
      onInit()
    if (data.type === 'session_panicked')
      this._recoverFromPanic()
    if (data.type === 'svg_patch')
      this._applySvgPatch(data.patchStr)
  }

  _recoverFromPanic() {
    console.warn('WASM engine panicked. Halting sync to prevent infinite loop.')
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
    const hasPlaceholder = !container.firstElementChild
      || container.querySelector('.preview-empty')
      || container.querySelector('.preview-errors')

    if (hasPlaceholder)
      container.innerHTML = ''

    patchSvgToContainer(container, patchStr, svgElem => decorateSvgElement(svgElem))
  }

  _shouldConnect(target) {
    if (!this.app.bucket || !target)
      return false
    if (this.connection) {
      if (this.connection.target === target && this.connection.isOpen)
        return false
      this.connection.disconnect()
    }
    return true
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
      onDocReady: () => this._resetForFreshDoc(),
      onEditorScroll: data => this.app.sync.jumpToSource(data),
      onJump: (page, xCoord, yCoord) => this.renderer.scrollToPosition(page, xCoord, yCoord),
      onPatch: payload => this.worker.postMessage({ action: 'process_diff', payload }, [payload.buffer]),
      onStatusChange: status => this.diagnostics.updateStatus(status),
    })
  }

  _resetForFreshDoc() {
    document.getElementById('typst-svg-resources')?.remove()
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
    const slot = pageNode?.closest('[data-preview-slot]')
    const bgRect = pageNode?.querySelector('.typst-paper-bg')
    if (!bgRect || !slot || !this.connection?.isOpen)
      return

    const frameLoc = TinymistPreview._computeFrameLoc(slot, bgRect, evt)
    this.connection.send(`src-point ${JSON.stringify(frameLoc)}`)
  }

  static _computeFrameLoc(slot, bgRect, evt) {
    const domRect = bgRect.getBoundingClientRect()
    const xRatio = (evt.clientX - domRect.left) / domRect.width
    const yRatio = (evt.clientY - domRect.top) / domRect.height
    return {
      page_no: Number(slot.getAttribute('data-preview-slot')) + SINGLE_ITEM,
      x: xRatio * parseFloat(bgRect.getAttribute('width')),
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
    const height = viewport.clientHeight / currentScale
    const pageCount = viewport.querySelectorAll('.typst-page').length
    const maxGapDrift = pageCount * PREVIEW_PAGE_GAP_SIZE

    this.worker.postMessage({
      action: 'update_window',
      window: {
        bottom: top + height + VIEWPORT_BUFFER_PX + maxGapDrift,
        top: Math.max(0, top - VIEWPORT_BUFFER_PX),
      },
    })
  }

}