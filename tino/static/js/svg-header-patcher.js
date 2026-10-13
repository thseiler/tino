/**
 * SVG Header and Resource Patcher for Typst preview.
 */

const SVG_HEADER_LENGTH = 3

const mergeDefsChild = (prevChild, nextChild) => {
  const childClass = prevChild.getAttribute('class')
  if (childClass === 'glyph' || childClass === 'clip-path')
    prevChild.append(...nextChild.children)
}

const mergeStyleRules = (prevChild, styleText) => {
  if (!styleText)
    return

  const doc = document.implementation.createHTMLDocument('')
  const styleElement = document.createElement('style')
  styleElement.textContent = styleText
  doc.body.appendChild(styleElement)

  const currentSvgSheet = prevChild.sheet
  const existingRules = new Set(
    Array.from(currentSvgSheet.cssRules).map(rule => rule.cssText),
  )

  const rulesToInsert = styleElement.sheet ? styleElement.sheet.cssRules : []
  Array.from(rulesToInsert).forEach(rule => {
    if (!existingRules.has(rule.cssText)) {
      existingRules.add(rule.cssText)
      currentSvgSheet.insertRule(rule.cssText)
    }
  })
}

const patchSvgHeaderItem = (prevChild, nextChild) => {
  nextChild.remove()

  if (prevChild.tagName === 'defs') {
    mergeDefsChild(prevChild, nextChild)
    return
  }

  if (prevChild.tagName === 'style' && nextChild.getAttribute('data-reuse') !== '1')
    mergeStyleRules(prevChild, nextChild.textContent)
}

const patchSvgHeader = (prev, next) => {
  Array.from({ length: SVG_HEADER_LENGTH }).forEach((unusedItem, index) => {
    const prevChild = prev.children[index]
    const nextChild = next.firstElementChild
    if (prevChild && nextChild)
      patchSvgHeaderItem(prevChild, nextChild)
  })
}

const createResourceHeader = svg => {
  const resourceHeader = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  resourceHeader.id = 'typst-svg-resources'
  resourceHeader.setAttribute('viewBox', '0 0 0 0')
  resourceHeader.setAttribute('width', '0')
  resourceHeader.setAttribute('height', '0')
  resourceHeader.style.opacity = '0'
  resourceHeader.style.position = 'absolute'

  Array.from({ length: SVG_HEADER_LENGTH }).forEach(() => {
    resourceHeader.append(svg.firstElementChild)
  })

  document.body.prepend(resourceHeader)
}

export const initOrPatchSvgHeader = svg => {
  if (!svg)
    throw new Error('no initial svg found')

  const prevResourceHeader = document.getElementById('typst-svg-resources')
  if (prevResourceHeader)
    patchSvgHeader(prevResourceHeader, svg)
  else
    createResourceHeader(svg)
}
