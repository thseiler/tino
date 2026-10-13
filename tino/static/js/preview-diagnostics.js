import { SINGLE_ITEM } from './constants.js'

/**
 * Manages compile status indicator and diagnostic error overlay.
 */

export class PreviewDiagnostics {

  constructor(app) {
    this.app = app
    this.status = null
    this._fetching = false
  }

  bind(getTarget) {
    document.getElementById('btn-compile-status')
      .addEventListener('click', () => this.fetchAndShow(getTarget()))
    document.getElementById('btn-close-errors')
      .addEventListener('click', () => this.hideOverlay())
  }

  static hideOverlay() {
    document.getElementById('preview-error-overlay').classList.add('hidden')
  }

  updateStatus(status) {
    const btn = document.getElementById('btn-compile-status')
    const icon = document.getElementById('compile-status-icon')
    this.status = status

    btn.classList.remove('hidden')
    icon.classList.remove('status-compiling', 'status-success', 'status-error')
    PreviewDiagnostics._applyStatusStyle(btn, icon, status)
    if (status === 'CompileSuccess')
      PreviewDiagnostics.hideOverlay()
  }

  static _applyStatusStyle(btn, icon, status) {
    if (status === 'Compiling') {
      icon.textContent = 'sync'
      icon.classList.add('status-compiling')
      btn.title = 'Compiling...'
    }
    else if (status === 'CompileSuccess') {
      icon.textContent = 'check_circle'
      icon.classList.add('status-success')
      btn.title = 'Compiled successfully'
    }
    else if (status === 'CompileError') {
      icon.textContent = 'error'
      icon.classList.add('status-error')
      btn.title = 'Compilation failed. Click to view errors.'
    }
  }

  async fetchAndShow(target) {
    if (this.status !== 'CompileError' || this._fetching || !target)
      return

    this._fetching = true
    try {
      await this._loadDiagnostics(target)
    }
    catch (err) {
      PreviewDiagnostics._showOverlayMessage(err.message || 'Failed to fetch compile errors')
    }
    finally {
      this._fetching = false
    }
  }

  async _loadDiagnostics(target) {
    const slug = encodeURIComponent(this.app.bucket)
    const res = await fetch(`/api/buckets/${slug}/compile/svg/${target}`)
    if (res.ok) {
      this.updateStatus('CompileSuccess')
      return
    }

    const errorData = await res.json().catch(() => null)
    const diagnostics = (errorData && errorData.detail && errorData.detail.diagnostics) || []
    const fallback = (errorData && errorData.detail && errorData.detail.message) 
       || `Compilation failed (HTTP ${res.status})`
    this._showOverlayContent(diagnostics, fallback)
  }

  _showOverlayContent(diagnostics, fallbackMessage) {
    const errorList = document.getElementById('preview-error-list')
    if (diagnostics.length > 0)
      errorList.replaceChildren(this.renderList(diagnostics))
    else
      errorList.replaceChildren(PreviewDiagnostics.renderRawError(fallbackMessage))
    document.getElementById('preview-error-overlay').classList.remove('hidden')
  }

  static _showOverlayMessage(message) {
    const errorList = document.getElementById('preview-error-list')
    errorList.replaceChildren(PreviewDiagnostics.renderRawError(message))
    document.getElementById('preview-error-overlay').classList.remove('hidden')
  }

  renderList(diagnostics) {
    const list = document.createElement('div')
    list.className = 'preview-errors'
    diagnostics.forEach(diag => list.appendChild(this._renderItem(diag)))
    return list
  }

  _renderItem(diag) {
    const item = document.createElement(diag.file ? 'button' : 'div')
    item.className = `preview-error-item preview-error-${diag.severity}`
    item.appendChild(PreviewDiagnostics._span('preview-error-message', diag.message))
    if (diag.file)
      this._makeClickable(item, diag)
    return item
  }

  _makeClickable(item, diag) {
    const loc = `${diag.file}:${diag.line}:${diag.column}`
    item.appendChild(PreviewDiagnostics._span('preview-error-loc', loc))
    item.type = 'button'
    item.addEventListener('click', () => this._jumpToDiagnostic(diag))
  }

  async _jumpToDiagnostic(diag) {
    await this.app.editor.openFile(diag.file)
    this.app.els.editor.setCursor(diag.line, Math.max(SINGLE_ITEM, diag.column))
  }

  static _span(className, text) {
    const span = document.createElement('span')
    span.className = className
    span.textContent = text
    return span
  }

  static renderRawError(message) {
    const pre = document.createElement('pre')
    pre.className = 'preview-error'
    pre.textContent = message
    return pre
  }

}