/**
 * Main SVG Preview Patcher Facade.
 */

import { initOrPatchSvgHeader } from './svg-header-patcher.js'
import { patchRoot } from './svg-body-patcher.js'

export { isDummyPatchElem, TypstPatchAttrs } from './svg-body-patcher.js'

const noop = () => null

const prepareElement = (parentElem, patchStr, decorateSvgElement) => {
  parentElem.innerHTML = patchStr
  const targetChild = parentElem.firstElementChild
  initOrPatchSvgHeader(targetChild)
  decorateSvgElement(targetChild)
  return targetChild
}

export const patchSvgToContainer = (hookedElem, patchStr, decorateSvgElement = noop) => {
  const prevChild = hookedElem.firstElementChild

  if (!prevChild) {
    prepareElement(hookedElem, patchStr, decorateSvgElement)
    return
  }

  const wrapper = document.createElement('div')
  const nextChild = prepareElement(wrapper, patchStr, decorateSvgElement)
  patchRoot(prevChild, nextChild)
}