import { 
  JUMP_HIGHLIGHT_DURATION_MS,
  ONE_BASED_OFFSET,
  PREVIEW_PAGE_GAP_SIZE,
  SINGLE_ITEM,
} from './constants.js'

/*/
 * Lightweight UI wrapper for the Typst preview container.
 * Actual DOM patching is handled natively by preview-patcher.js.
 */

const VIEWBOX_MIN_LENGTH = 4
const VIEWBOX_HEIGHT_INDEX = 3
const CENTER_DIVISOR = 2
const SCROLL_TOP_MARGIN_PX = 50
const SCROLL_BOTTOM_MARGIN_PX = 150
const HALF_LINE_HEIGHT_PX = 6
const LEFT_ARROW_OFFSET_PX = 22
const RIGHT_ARROW_OFFSET_PX = 8

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

const computeJumpGeometry = (container, pageEl, scale, yPos) => {
  const containerRect = container.getBoundingClientRect()
  const pageRect = pageEl.getBoundingClientRect()
  const cssZoom = parseFloat(container.style.zoom) || SINGLE_ITEM
  const top = ((pageRect.top - containerRect.top) + (yPos * scale)) / cssZoom
  const pageLeft = (pageRect.left - containerRect.left) / cssZoom
  const pageWidth = pageRect.width / cssZoom

  return {
    leftPos: pageLeft - LEFT_ARROW_OFFSET_PX,
    rightPos: pageLeft + pageWidth + RIGHT_ARROW_OFFSET_PX,
    top,
  }
}

const createJumpArrow = (symbol, top, left) => {
  const arrow = document.createElement('div')
  arrow.className = 'tino-jump-arrow'
  arrow.textContent = symbol
  arrow.style.top = `${top}px`
  arrow.style.left = `${left}px`
  return arrow
}

const showJumpHighlight = (container, pageEl, scale, yPos) => {
  container.querySelectorAll('.tino-jump-arrow').forEach(elem => elem.remove())

  const { top, leftPos, rightPos } = computeJumpGeometry(container, pageEl, scale, yPos)
  const leftArrow = createJumpArrow('▶', top, leftPos)
  const rightArrow = createJumpArrow('◀', top, rightPos)

  container.append(leftArrow, rightArrow)
  setTimeout(() => {
    leftArrow.remove()
    rightArrow.remove()
  }, JUMP_HIGHLIGHT_DURATION_MS)
}

export class PreviewRenderer {
  
  constructor(containerElement) {
    this.container = containerElement
  }
  
  clear() {
    this.container.innerHTML = '<p class="preview-empty">No preview available for this file.</p>'
  }
  
  showLoading(message) {
    this.container.innerHTML = `<p class="preview-empty">${message}</p>`
  }
  
  showError(message) {
    this.container.innerHTML = `<p class="preview-error">${message}</p>`
  }

  scrollToPosition(page, xPos, yPos) {
    const container = this.container.closest('.preview-viewport')
    if (!container) 
      return

    const pageEl = getPageElement(container, page)
    if (!pageEl)
      return

    const { scale, targetScrollTop } = calculateTargetScroll(container, pageEl, yPos)

    ensureVisible(container, targetScrollTop)
    showJumpHighlight(this.container, pageEl, scale, yPos)
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

}
