import { ONE_BASED_OFFSET } from './constants.js'

const CURSOR_MOVE_DEBOUNCE_MS = 100
const COMPILE_FALLBACK_MS = 3000
const COLLAB_SWITCH_DELAY_MS = 100
const TERMINAL_COMPILE_STATUSES = new Set(['CompileSuccess', 'CompileError'])

export class PreviewSyncMediator {

  constructor(app) {
    this.app = app
    this._syncTimer = null
    this._pendingCursor = null
  }

  // EDITOR -> PREVIEW (Forward Sync)

  /**
   * Called when the user types or moves the cursor in the text editor.
   * Document edits wait for Tinymist's compileStatus before resolving coordinates;
   * cursor-only moves resolve after a short debounce.
   */

  syncPreviewToCursor(filepath, line, col, docChanged = false) {
    const { connection } = this.app.preview
    if (!filepath || !connection || !connection.isOpen)
      return

    clearTimeout(this._syncTimer)
    this._pendingCursor = { col, filepath, line }

    const delay = docChanged ? COMPILE_FALLBACK_MS : CURSOR_MOVE_DEBOUNCE_MS
    this._syncTimer = setTimeout(() => this._flushPendingCursor(), delay)
  }

  /**
   * Called when Tinymist reports compileStatus. Refreshes the safety timeout
   * while compiling, and flushes the queued cursor once compilation finishes.
   */

  onCompileStatus(status) {
    if (!this._pendingCursor)
      return

    if (status === 'Compiling') {
      clearTimeout(this._syncTimer)
      this._syncTimer = setTimeout(() => this._flushPendingCursor(), COMPILE_FALLBACK_MS)
      return
    }

    if (TERMINAL_COMPILE_STATUSES.has(status)) {
      clearTimeout(this._syncTimer)
      this._flushPendingCursor()
    }
  }

  _flushPendingCursor() {
    const pending = this._pendingCursor
    this._pendingCursor = null
    this._syncTimer = null

    const { connection } = this.app.preview
    if (!pending || !connection || !connection.isOpen)
      return

    const payload = {
      character: Math.max(0, pending.col - ONE_BASED_OFFSET),
      event: 'panelScrollTo',
      filepath: pending.filepath,
      line: Math.max(0, pending.line - ONE_BASED_OFFSET),
    }
    connection.send(JSON.stringify(payload))
  }

  // PREVIEW -> EDITOR (Backward Sync)

  /**
   * Called when the WebSocket receives an 'editorScrollTo' command from Tinymist
   * (e.g., the user double-clicked the PDF preview).
   */

  async jumpToSource(data) {
    if (!data || !data.filepath)
      return

    const line = (data.start ? data.start[0] : data.line) + ONE_BASED_OFFSET
    const col = (data.start ? data.start[1] : data.character) + ONE_BASED_OFFSET

    if (data.filepath !== this.app.currentFile) {
      await this.app.editor.openFile(data.filepath)
      await new Promise(resolve => {
        setTimeout(resolve, COLLAB_SWITCH_DELAY_MS)
      })
    }

    this.app.els.editor.setCursor(line, col)
    this.app.tabPositions[data.filepath] = { col, line }
    this.app.editor.saveTabs()
  }

}