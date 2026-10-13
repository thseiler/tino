import { PreviewDiagnostics } from './preview-diagnostics.js'
import { PreviewRenderer } from './preview-renderer.js'
import { PreviewZoom } from './preview-zoom.js'
import { SINGLE_ITEM } from './constants.js'
import { TinymistPreview } from './tinymist-preview.js'
import { setupPreviewLinks } from './preview-links.js'

/**
 * Coordinates preview rendering, pinning, zoom, and format exports.
 */

export class PreviewManager {

  constructor(app) {
    this.app = app
    setupPreviewLinks(this.app)
    this.renderer = new PreviewRenderer(this.app.els.previewPage)
    this.diagnostics = new PreviewDiagnostics(this.app)
    this.engine = new TinymistPreview(this.app, this.renderer, this.diagnostics)
  }

  get connection() {
    return this.engine.connection
  }

  get target() {
    return this.app.pinnedPreview || this.app.currentFile
  }

  update() {
    const isTyp = Boolean(this.target && this.target.endsWith('.typ'))
    this._renderPinControls()
    this._toggleExportButtons(isTyp)
    if (isTyp)
      this._startPreview()
    else {
      this.engine.disconnect()
      this.renderer.clear()
    }
  }

  _toggleExportButtons(isTyp) {
    document.getElementById('btn-pdf').classList.toggle('hidden', !isTyp)
    document.getElementById('btn-docx')
      .classList.toggle('hidden', !isTyp || !this.app.config.docxExport)
  }

  _startPreview() {
    if (this.app.config.tinymist === false)
      this.compile()
    else
      this.engine.connect(this.target)
  }

  togglePin() {
    if (this.app.pinnedPreview)
      this.app.pinnedPreview = null
    else if (this.app.currentFile && this.app.currentFile.endsWith('.typ'))
      this.app.pinnedPreview = this.app.currentFile
    this.update()
  }

  _autoPinCurrent() {
    if (!this.app.pinnedPreview && this.app.currentFile && this.app.currentFile.endsWith('.typ')) {
      this.app.pinnedPreview = this.app.currentFile
      this.update()
    }
  }

  _renderPinControls() {
    const pinned = this.app.pinnedPreview
    const cur = this.app.currentFile
    const canPin = Boolean(pinned) || Boolean(cur && cur.endsWith('.typ'))
    const btn = document.getElementById('btn-pin-preview')
    if (!btn)
      return

    btn.classList.toggle('hidden', !canPin)
    btn.classList.toggle('active', Boolean(pinned))
    btn.title = PreviewManager._pinTitle(pinned)
    PreviewManager._renderPinLabel(pinned)
  }

  static _pinTitle(pinned) {
    return pinned ? `Preview pinned to ${pinned} — click to unpin` : 'Pin preview to this file'
  }

  static _renderPinLabel(pinned) {
    const label = document.getElementById('preview-pin-label')
    if (!label)
      return
    label.classList.toggle('hidden', !pinned)
    if (pinned) {
      label.textContent = pinned.split('/').pop()
      label.title = pinned
    }
  }

  /** Fallback static SVG compiler when Tinymist is unavailable. */

  async compile() {
    if (!this.app.bucket || !this.target)
      return
    this._renderGen = (this._renderGen || 0) + SINGLE_ITEM
    const gen = this._renderGen

    try {
      const result = await this.app.api.compile(this.app.bucket, this.target)
      if (gen === this._renderGen)
        PreviewManager._renderPages(this.app.els.previewPage, result.pages)
    }
    catch (err) {
      if (gen === this._renderGen)
        this._renderInlineError(err)
    }
  }

  _renderInlineError(err) {
    const diagnostics = err.diagnostics || []
    if (diagnostics.length)
      this.app.els.previewPage.replaceChildren(this.diagnostics.renderList(diagnostics))
    else
      this.app.els.previewPage.replaceChildren(PreviewDiagnostics.renderRawError(err.message))
  }

  static _renderPages(preview, pages) {
    const fragment = document.createDocumentFragment()
    pages.forEach(svg => {
      const page = document.createElement('div')
      page.className = 'preview-svg-page'
      page.innerHTML = svg
      fragment.appendChild(page)
    })
    preview.replaceChildren(fragment)
  }

  download(format) {
    if (!this.app.bucket || !this.target)
      return
    const slug = encodeURIComponent(this.app.bucket)
    const link = document.createElement('a')
    link.href = `api/buckets/${slug}/compile/${format}/${this.target}`
    link.download = ''
    link.click()
  }

  bind() {
    this.bindZoom()
    this.diagnostics.bind(() => this.target)
    this.engine.bind(() => this._autoPinCurrent())
  }

  bindZoom() {
    new PreviewZoom(this.app).bind()
    document.getElementById('btn-pdf').addEventListener('click', () => this.download('pdf'))
    document.getElementById('btn-docx').addEventListener('click', () => this.download('docx'))
    document.getElementById('btn-pin-preview').addEventListener('click', () => this.togglePin())
  }

}