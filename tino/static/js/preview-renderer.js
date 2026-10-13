import {
  JUMP_HIGHLIGHT_DURATION_MS,
  ONE_BASED_OFFSET,
  PREVIEW_PAGE_GAP_SIZE,
  SINGLE_ITEM,
} from './constants.js'

const COLLAB_HIGHLIGHT_TTL_MS = 4000
const DEFAULT_COLLAB_COLOR = '#3b82f6'

/**
 * Lightweight UI wrapper for the Typst preview container.
 * Actual DOM patching is handled natively by preview-patcher.js.
 */

const VIEWBOX_MIN_LENGTH = 4
const VIEWBOX_HEIGHT_INDEX = 3
const CENTER_DIVISOR = 2
const SCROLL_TOP_MARGIN_PX = 50
const SCROLL_BOTTOM_MARGIN_PX = 150
const LINE_BAND_HEIGHT_PT = 16
const BASELINE_OFFSET_RATIO = 0.72
const MARGIN_BAR_WIDTH_PX = 3
const MARGIN_BAR_INSET_PX = 6

const adjustPageTransform = (page, index) => {
  const currentTransform = page.getAttribute('transform')
  if (!currentTransform)
    return

  const match = currentTransform.match(/translate\((?<xOffset>[^,]+),\s*(?<yOffset>[^)]+)\)/u)
  if (!match || !match.groups)
    return

  const xOffset = parseFloat(match.groups.xOffset)
  const yOffset = parseFloat(match.groups.yOffset)

  page.setAttribute(
    'transform', `translate(${xOffset}, ${yOffset + (index * PREVIEW_PAGE_GAP_SIZE)})`)
}

const ensurePageBackground = page => {
  if (page.querySelector('.typst-paper-bg'))
    return

  const pageWidth = page.getAttribute('data-page-width')
  const pageHeight = page.getAttribute('data-page-height')

  if (!pageWidth || !pageHeight)
    return

  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  bg.setAttribute('width', pageWidth)
  bg.setAttribute('height', pageHeight)
  bg.setAttribute('class', 'typst-paper-bg')
  bg.setAttribute('fill', '#ffffff')
  page.insertBefore(bg, page.firstChild)
}

const getPageElement = (container, page) => {
  const pages = container.querySelectorAll('.typst-page, [data-preview-slot]')
  return pages[page - ONE_BASED_OFFSET]
}

const calculateTargetScroll = (container, pageEl, yPos) => {
  const containerRect = container.getBoundingClientRect()
  const pageRect = pageEl.getBoundingClientRect()

  const pdfHeight = parseFloat(pageEl.getAttribute('data-page-height'))
  const scale = pageRect.height / pdfHeight

  const pageTopRelativeToContainer = (pageRect.top - containerRect.top) + container.scrollTop
  const targetScrollTop = pageTopRelativeToContainer + (yPos * scale)

  return { scale, targetScrollTop }
}

const ensureVisible = (container, targetScrollTop) => {
  const viewportTop = container.scrollTop
  const viewportBottom = container.scrollTop + container.clientHeight

  if (targetScrollTop < viewportTop + SCROLL_TOP_MARGIN_PX
   || targetScrollTop > viewportBottom - SCROLL_BOTTOM_MARGIN_PX) {
    const centerOffset = container.clientHeight / CENTER_DIVISOR
    const newScrollTop = targetScrollTop - centerOffset

    container.scrollTo({
      behavior: 'smooth',
      top: Math.max(0, newScrollTop),
    })
  }
}

const adjustSvgDimensions = (svg, pageCount) => {
  if (pageCount === 0)
    return

  const totalGap = pageCount * PREVIEW_PAGE_GAP_SIZE
  const currentHeight = parseFloat(svg.getAttribute('height') || 0)
  const viewBox = (svg.getAttribute('viewBox') || '').split(/[\s,]+/u)

  if (currentHeight && viewBox.length >= VIEWBOX_MIN_LENGTH) {
    svg.setAttribute('height', currentHeight + totalGap)
    viewBox[VIEWBOX_HEIGHT_INDEX] = parseFloat(viewBox[VIEWBOX_HEIGHT_INDEX]) + totalGap
    svg.setAttribute('viewBox', viewBox.join(' '))
  }
}

/**
 * Called by the patcher after mutating the DOM to ensure pages
 * are wrapped in `[data-preview-slot]` for double-click hit-testing.
 */

export const decorateSvgElement = svg => {
  const pages = svg.querySelectorAll('.typst-page')

  pages.forEach((page, index) => {
    page.setAttribute('data-preview-slot', String(index))
    adjustPageTransform(page, index)
    ensurePageBackground(page)
  })

  adjustSvgDimensions(svg, pages.length)
}

const typstLineBandToContainer = (container, pageEl, yPos) => {
  const bgRect = pageEl.querySelector('.typst-paper-bg')
  if (!bgRect)
    return null

  const containerRect = container.getBoundingClientRect()
  const domRect = bgRect.getBoundingClientRect()
  const dataHeight = parseFloat(bgRect.getAttribute('height'))
  const cssZoom = parseFloat(container.style.zoom) || SINGLE_ITEM
  const scale = domRect.height / dataHeight

  const yViewport = domRect.top + ((yPos / dataHeight) * domRect.height)
  const height = (LINE_BAND_HEIGHT_PT * scale) / cssZoom

  return {
    height,
    left: (domRect.left - containerRect.left) / cssZoom,
    top: ((yViewport - containerRect.top) / cssZoom) - (height * BASELINE_OFFSET_RATIO),
    width: domRect.width / cssZoom,
  }
}

const applyBandGeometry = (elem, band) => {
  Object.assign(elem.style, {
    height: `${band.height}px`,
    left: `${band.left}px`,
    top: `${band.top}px`,
    width: `${band.width}px`,
  })
}

const getOrCreateJumpMarker = (container, band) => {
  let marker = container.querySelector('.tino-jump-highlight')
  if (!marker) {
    marker = document.createElement('div')
    marker.className = 'tino-jump-highlight'
    applyBandGeometry(marker, band)
    container.append(marker)
  }
  return marker
}

const showJumpHighlight = (container, pageEl, yPos) => {
  const lineBand = typstLineBandToContainer(container, pageEl, yPos)
  if (!lineBand)
    return

  const barBand = {
    ...lineBand,
    left: lineBand.left + MARGIN_BAR_INSET_PX,
    width: MARGIN_BAR_WIDTH_PX,
  }
  const marker = getOrCreateJumpMarker(container, barBand)
  applyBandGeometry(marker, barBand)
  marker.classList.remove('is-fading')
  clearTimeout(marker._fadeTimer)
  marker._fadeTimer = setTimeout(() => marker.classList.add('is-fading'),
    JUMP_HIGHLIGHT_DURATION_MS)
}

const createCollabBadge = userName => {
  const badge = document.createElement('span')
  badge.className = 'tino-collab-badge'
  badge.textContent = userName
  return badge
}

const resolvePageBand = (container, focus) => {
  if (!Number.isFinite(focus.xCoord) || !Number.isFinite(focus.yCoord))
    return null

  const viewport = container.closest('.preview-viewport')
  if (!viewport)
    return null

  const pageEl = getPageElement(viewport, focus.page)
  return pageEl ? typstLineBandToContainer(container, pageEl, focus.yCoord) : null
}

const toRightMarginBand = lineBand => ({
  ...lineBand,
  left: lineBand.left + lineBand.width - MARGIN_BAR_INSET_PX - MARGIN_BAR_WIDTH_PX,
  width: MARGIN_BAR_WIDTH_PX,
})

const createCollabMarker = (clientId, user, band) => {
  const marker = document.createElement('div')
  marker.className = 'tino-collab-highlight'
  marker.dataset.clientId = String(clientId)
  marker.append(createCollabBadge(user.name))
  applyBandGeometry(marker, band)
  return marker
}

const getOrCreateCollabMarker = (container, clientId, user, band) => {
  const selector = `.tino-collab-highlight[data-client-id="${clientId}"]`
  let marker = container.querySelector(selector)
  if (!marker) {
    marker = createCollabMarker(clientId, user, band)
    container.append(marker)
  }
  return marker
}

const updateCollabMarker = (marker, user, barBand) => {
  applyBandGeometry(marker, barBand)
  marker.style.setProperty('--collab-color', user.color || DEFAULT_COLLAB_COLOR)
  clearTimeout(marker._fadeTimer)
  marker._fadeTimer = setTimeout(() => marker.remove(), COLLAB_HIGHLIGHT_TTL_MS)
}

export class PreviewRenderer {

  constructor(containerElement) {
    this.container = containerElement
  }

  clear() {
    const res = document.getElementById('typst-svg-resources')
    if (res)
      res.remove()
    this.container.innerHTML = '<p class="preview-empty">No preview available for this file.</p>'
  }

  showLoading(message) {
    this.container.innerHTML = `<p class="preview-empty">${message}</p>`
  }

  showError(message) {
    this.container.innerHTML = `<p class="preview-error">${message}</p>`
  }

  scrollToPosition(page, xPos, yPos) {
    if (!Number.isFinite(xPos) || !Number.isFinite(yPos))
      return

    const container = this.container.closest('.preview-viewport')
    if (!container)
      return

    const pageEl = getPageElement(container, page)
    if (!pageEl)
      return

    const { targetScrollTop } = calculateTargetScroll(container, pageEl, yPos)

    ensureVisible(container, targetScrollTop)
    showJumpHighlight(this.container, pageEl, yPos)
  }

  showCrashRecovery(onRecoverCallback) {
    this.container.innerHTML = `
      <div class="preview-error">
        <p><strong>Preview Engine Crashed</p>
        <button id="btn-recover-preview">Restart</button>
      </div>
    `
    const btn = this.container.querySelector('#btn-recover-preview')
    if (btn)
      btn.addEventListener('click', () => onRecoverCallback())
  }

  showCollabHighlight(clientId, user, focus) {
    const lineBand = resolvePageBand(this.container, focus)
    if (!lineBand)
      return false

    const barBand = toRightMarginBand(lineBand)
    const marker = getOrCreateCollabMarker(this.container, clientId, user, barBand)
    updateCollabMarker(marker, user, barBand)
    return true
  }

  clearCollabHighlights(activeClientIds = null) {
    this.container.querySelectorAll('.tino-collab-highlight').forEach(elem => {
      const id = Number(elem.dataset.clientId)
      if (!activeClientIds || !activeClientIds.has(id)) {
        clearTimeout(elem._fadeTimer)
        elem.remove()
      }
    })
  }

}