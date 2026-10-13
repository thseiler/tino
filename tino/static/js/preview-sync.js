import { ONE_BASED_OFFSET, PREVIEW_DEBOUNCE_TIMEOUT } from './constants.js'

export class PreviewSyncMediator {
  
  constructor(app) {
    this.app = app
    this._syncTimer = null
  }

  // EDITOR -> PREVIEW (Forward Sync)
  
  /** 
   * Called when the user types or clicks in the text editor.
   * Scrolls the preview to bring the cursor position into view.
   */

  syncPreviewToCursor(filepath, line, col) {
    const {connection} = this.app.preview
    
    if (!filepath || !connection || !connection.isOpen)
        return

    clearTimeout(this._syncTimer)
    this._syncTimer = setTimeout(() => {
      // Tinymist expects 0-indexed coordinates
      const payload = {
        character: Math.max(0, col - ONE_BASED_OFFSET),
        event: 'panelScrollTo',
        filepath,
        line: Math.max(0, line - ONE_BASED_OFFSET),
      }
      connection.send(JSON.stringify(payload))
    }, PREVIEW_DEBOUNCE_TIMEOUT)
  }

  // PREVIEW -> EDITOR (Backward Sync)

  /** 
   * Called when the WebSocket receives a 'jump' command from Tinymist 
   * (e.g., the user clicked the PDF preview).
   */

  async jumpToSource(data) {
    if (!data || !data.filepath)
        return

    const line = (data.start ? data.start[0] : data.line) + ONE_BASED_OFFSET
    const col = (data.start ? data.start[1] : data.character) + ONE_BASED_OFFSET

    // If clicking a link to a different file, open it first
    if (data.filepath !== this.app.currentFile) {
      await this.app.editor.openFile(data.filepath)
      
      // Wait for the Yjs collab module to finish sync before jumping
      await new Promise(resolve => {
        setTimeout(resolve, 100)
      })
    }

    // Command the editor to move its cursor
    this.app.els.editor.setCursor(line, col)
    
    // Update state
    this.app.tabPositions[data.filepath] = { col, line }
    this.app.editor.saveTabs()
  }

}