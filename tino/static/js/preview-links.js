/**
 * Scroll Preview for document internal Links
 */

const TINYMIST_INDEX_OFFSET = 1
const ZOOM_BASE = 100

const getPageOffsets = targetPage => {
  const transform = targetPage.getAttribute('transform')
  if (!transform)
    return { pageXOffset: 0, pageYOffset: 0 }

  const match = transform.match(/translate\((?<xOffset>[^,]+),\s*(?<yOffset>[^)]+)\)/u)
  if (!match || !match.groups)
    return { pageXOffset: 0, pageYOffset: 0 }

  return {
    pageXOffset: parseFloat(match.groups.xOffset),
    pageYOffset: parseFloat(match.groups.yOffset),
  }
}

export const setupPreviewLinks = app => {
  // 'x' and 'y' renamed to 'xCoord' and 'yCoord'
  window.handleTypstLocation = (elem, pageNo, xCoord, yCoord) => {
    const viewport = app.els.previewPage.closest('.preview-viewport')
    const svg = app.els.previewPage.querySelector('svg')
    
    if (!viewport || !svg)
      return

    const targetPage = svg.querySelectorAll('.typst-page')[pageNo - TINYMIST_INDEX_OFFSET]
    
    if (!targetPage)
      return

    const { pageXOffset, pageYOffset } = getPageOffsets(targetPage)
    
    const scale = app.zoom / ZOOM_BASE

    viewport.scrollTo({
      behavior: 'smooth',
      left: (pageXOffset + xCoord) * scale,
      top: (pageYOffset + yCoord) * scale,
    })
  }
}
