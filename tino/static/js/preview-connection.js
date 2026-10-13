
import { INDEX_NOT_FOUND, PREVIEW_SOCKET_TIMEOUT, SINGLE_ITEM } from './constants.js'

const IGNORED_DATA_COMMANDS = new Set([
  'cursor',
  'cursor-paths',
  'invert-colors',
  'outline',
  'partial-rendering',
  'viewport',
])

const COMMA_BYTE = 44 // ASCII ','

export class PreviewConnection {

  constructor(bucket, target, callbacks) {
    this.bucket = bucket
    this.target = target
    this.callbacks = callbacks
    
    this.ws = null
    this.pollInterval = null
    this.isIntentionalDisconnect = false
    this.hasReceivedDoc = false
  }

  connect() {
    this._clearReconnect()
    this._clearPoll()
    this.isIntentionalDisconnect = false
    this.hasReceivedDoc = false

    this.ws = new WebSocket(this._buildUrl())
    this.ws.binaryType = 'arraybuffer'

    this._bindEvents()
  }

  _buildUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const slug = encodeURIComponent(this.bucket)
    return `${protocol}//${window.location.host}/api/buckets/${slug}/preview/${this.target}`
  }

  _bindEvents() {
    this._bindOnOpen()
    this._bindOnMessage()
    this._bindOnClose()
    this._bindOnError()
  }

  disconnect() {
    this.isIntentionalDisconnect = true
    this._clearReconnect()
    this._clearPoll()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  _clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  get isOpen() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN)
  }

  send(data) {
    if (this.isOpen)
      this.ws.send(data)
  }

  _clearPoll() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
  }

  _bindOnOpen() {
    this.ws.onopen = () => {
      this.ws.send('current')
      this.pollInterval = setInterval(() => {
        if (!this.hasReceivedDoc && this.isOpen)
          this.ws.send('current')
      }, PREVIEW_SOCKET_TIMEOUT)
    }
  }

  _bindOnMessage() {
    this.ws.onmessage = async event => {
      if (typeof event.data === 'string') {
        await this._handleTextMessage(event.data)
        return
      }
      this._handleBinaryMessage(event.data)
    }
  }

  async _handleTextMessage(raw) {
    if (!raw.startsWith('{'))
      return
    try {
      await this._dispatchControlEvent(JSON.parse(raw))
    }
    catch (err) {
      console.error('Failed to parse Control Plane response:', err)
    }
  }

  async _dispatchControlEvent(data) {
    if (data.event === 'editorScrollTo')
      await this.callbacks.onEditorScroll(data)
    if (data.event === 'compileStatus' && this.callbacks.onStatusChange)
      this.callbacks.onStatusChange(data.kind)
  }

  _handleBinaryMessage(buffer) {
    const messageData = new Uint8Array(buffer)
    const commaIdx = messageData.indexOf(COMMA_BYTE)
    if (commaIdx === INDEX_NOT_FOUND)
      return

    const command = new TextDecoder().decode(messageData.slice(0, commaIdx))
    this._routeBinaryCommand(command, messageData.slice(commaIdx + SINGLE_ITEM))
  }

  _routeBinaryCommand(command, payload) {
    if (IGNORED_DATA_COMMANDS.has(command))
      return
    if (command === 'jump')
      this._handleJump(payload)
    else
      this._handleDocPatch(command, payload)
  }

  _handleJump(payload) {
    const payloadStr = new TextDecoder().decode(payload).trim()
    const targets = payloadStr.split(',')
    const bestTarget = targets[targets.length - SINGLE_ITEM].trim()
    if (!bestTarget)
      return

    const [page, xCoord, yCoord] = bestTarget.split(' ').map(Number)
    this.callbacks.onJump(page, xCoord, yCoord)
  }

  _handleDocPatch(command, payload) {
    if (!this.hasReceivedDoc) {
      if (command.startsWith('diff')) {
        console.warn(`[Tino] Ignored early ${command} patch before base document arrived.`)
        return
      }
      this.hasReceivedDoc = true
      this._clearPoll()
      this.callbacks.onDocReady()
    }
    this.callbacks.onPatch(payload)
  }

  _bindOnClose() {
    this.ws.onclose = () => {
      this._clearPoll()
      if (!this.isIntentionalDisconnect)
        this.reconnectTimer = setTimeout(() => this.connect(), PREVIEW_SOCKET_TIMEOUT)
    }
  }

  _bindOnError() {
    this.ws.onerror = () => {
      this._clearPoll()
    }
  }

}