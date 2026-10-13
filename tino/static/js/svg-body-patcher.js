/**
 * SVG DOM Body Patcher for tinymist preview.
 */

import { INDEX_NOT_FOUND, SINGLE_ITEM } from './constants.js'

export const TypstPatchAttrs = Object.freeze({
  BadEquality: 'data-bad-equality',
  Dummy: 'data-dummy',
  ReuseFrom: 'data-reuse-from',
  Tid: 'data-tid',
})

export const isDummyPatchElem = elem => elem.getAttribute('data-dummy') === '1'

const isGElem = node => node.tagName === 'g'

const equalPatchElem = (prev, next) => {
  const prevDataTid = prev.getAttribute('data-tid')
  const nextDataTid = next.getAttribute('data-tid')
  const nextBadEquality = next.getAttribute('data-bad-equality')
  return Boolean(!nextBadEquality && prevDataTid && prevDataTid === nextDataTid)
}

const preReplaceNonSVGElements = (prev, next) => {
  Array.from(prev.children)
    .filter(child => !isGElem(child))
    .forEach(child => child.remove())

  const frozenReplacement = { inserts: [] }
  let elements = []
  Array.from(next.children).forEach(nextChild => {
    if (isGElem(nextChild)) {
      frozenReplacement.inserts.push(elements)
      elements = []
    }
    else
      elements.push(nextChild)
  })
  frozenReplacement.inserts.push(elements)
  return frozenReplacement
}

const postReplaceNonSVGElements = (prev, frozen) => {
  const gElements = Array.from(prev.children).filter(isGElem)
  if (gElements.length + SINGLE_ITEM !== frozen.inserts.length) {
    throw new Error(
      'invalid frozen replacement: gElements.length ' +
      `(${gElements.length}) current: ${prev.outerHTML}`,
    )
  }

  gElements.forEach((prevChild, index) => {
    frozen.inserts[index].forEach(elem => prev.insertBefore(elem, prevChild))
  })

  frozen.inserts[gElements.length].forEach(elem => prev.append(elem))
}

const areAttributesIdentical = (prevAttrs, nextAttrs) => {
  if (prevAttrs.length !== nextAttrs.length)
    return false
  return Array.from(prevAttrs).every(prevAttr => {
    const nextAttr = nextAttrs.getNamedItem(prevAttr.name)
    return nextAttr !== null && prevAttr.value === nextAttr.value
  })
}

const patchAttributes = (prev, next) => {
  if (areAttributesIdentical(prev.attributes, next.attributes))
    return

  Array.from(prev.attributes).forEach(attr => prev.removeAttribute(attr.name))
  Array.from(next.attributes).forEach(attr => prev.setAttribute(attr.name, attr.value))
}

const buildOwnedResources = (originChildren, tIsU, targetView) => {
  const availableOwnedResource = new Map()
  Array.from(originChildren).forEach((prevChild, index) => {
    if (!tIsU(prevChild))
      return

    const dataTid = prevChild.getAttribute('data-tid')
    if (!dataTid) {
      targetView.push(['remove', index])
      return
    }
    if (!availableOwnedResource.has(dataTid))
      availableOwnedResource.set(dataTid, { indices: [], node: prevChild })
    availableOwnedResource.get(dataTid).indices.push(index)
  })
  return availableOwnedResource
}

const getReusabilityInfo = (nextChild, availableOwnedResource) => {
  const nextDataTid = nextChild.getAttribute('data-tid')
  if (!nextDataTid)
    throw new Error(`not data tid for reusing g element for ${nextDataTid}`)

  const reuseTargetTid = nextChild.getAttribute('data-reuse-from')
  const resource = reuseTargetTid ? availableOwnedResource.get(reuseTargetTid) : null
  const prevIdx = resource && resource.indices.length > 0 ? resource.indices.shift() : null
  return { nextDataTid, prevIdx, resource, reuseTargetTid }
}

const handleFallbackTarget = (nextChild, resource, fallbackContext) => {
  const { isPatchingSvg, nextDataTid, reuseTargetTid, targetView, toPatch } = fallbackContext

  if (resource && nextDataTid === reuseTargetTid && isPatchingSvg) {
    const clonedNode = resource.node.cloneNode(true)
    toPatch.push([clonedNode, nextChild])
    targetView.push(['append', clonedNode])
  }
  else
    targetView.push(['append', nextChild])
}

const processTargetChild = (nextChild, context) => {
  const { originChildren, availableOwnedResource, targetView, toPatch } = context
  const info = getReusabilityInfo(nextChild, availableOwnedResource)

  if (info.prevIdx === null) {
    handleFallbackTarget(nextChild, info.resource, { ...context, ...info })
    return
  }

  toPatch.push([originChildren[info.prevIdx], nextChild])
  targetView.push(['reuse', info.prevIdx])
}

const interpretTargetView = (originChildren, targetChildren, isPatchingSvg, tIsU) => {
  const targetView = []
  const toPatch = []
  const availableOwnedResource = buildOwnedResources(originChildren, tIsU, targetView)
  const context = { availableOwnedResource, isPatchingSvg, originChildren, targetView, toPatch }

  Array.from(targetChildren).forEach(nextChild => {
    if (tIsU(nextChild))
      processTargetChild(nextChild, context)
  })

  availableOwnedResource.forEach(({ indices }) => {
    indices.forEach(unused => targetView.push(['remove', unused]))
  })

  return [targetView, toPatch]
}

const buildRemoveShift = (removeIndices, originLength, originView) => {
  const sortedRemoves = [...removeIndices].sort((itemA, itemB) => itemA - itemB)
  const removeShift = []
  let cursor = 0

  sortedRemoves.forEach((removeIndex, index) => {
    while (cursor < removeIndex) {
      removeShift.push(cursor - index)
      cursor += SINGLE_ITEM
    }
    removeShift.push(null)
    originView.push(['remove', removeIndex - index])
    cursor += SINGLE_ITEM
  })

  while (cursor <= originLength) {
    removeShift.push(cursor - sortedRemoves.length)
    cursor += SINGLE_ITEM
  }

  return removeShift
}

const processTargetViewInst = (inst, removeShift, state) => {
  const [op, value] = inst

  if (op === 'append') {
    state.inserts.push(['insert', state.appendOffset, value])
    state.appendOffset += SINGLE_ITEM
  }
  else if (op === 'reuse') {
    if (value >= removeShift.length || removeShift[value] === null)
      throw new Error(`invalid offset ${value} for getShift ${removeShift}`)

    state.swapIns.push(removeShift[value])
    state.appendOffset += SINGLE_ITEM
  }
}

const simulateSwaps = (swapIns, originView) => {
  const simulated = swapIns.map((unusedItem, index) => index)

  swapIns.forEach((targetOffset, index) => {
    const foundIndex = simulated.indexOf(targetOffset)
    if (foundIndex !== INDEX_NOT_FOUND) {
      simulated.splice(foundIndex, SINGLE_ITEM)
      const insertAt = index <= foundIndex ? index : index + SINGLE_ITEM
      simulated.splice(insertAt, 0, targetOffset)
      if (foundIndex !== index)
        originView.push(['swap_in', index, foundIndex])
    }
  })
}

const changeViewPerspective = (originChildren, targetView, tIsU) => {
  const originView = []
  const removeIndices = targetView.filter(([op]) => op === 'remove').map(([, index]) => index)
  const removeShift = buildRemoveShift(removeIndices, originChildren.length, originView)
  const state = { appendOffset: 0, cursor: 0, inserts: [], swapIns: [] }

  const consumeTargetView = () => {
    while (state.cursor < targetView.length) {
      processTargetViewInst(targetView[state.cursor], removeShift, state)
      state.cursor += SINGLE_ITEM
    }
  }

  Array.from(originChildren).forEach((prevChild, offset) => {
    if (removeShift[offset] !== null) {
      if (tIsU(prevChild))
        consumeTargetView()
      else {
        state.swapIns.push(removeShift[offset])
        state.appendOffset += SINGLE_ITEM
      }
    }
  })

  consumeTargetView()
  simulateSwaps(state.swapIns, originView)
  return [...originView, ...state.inserts]
}

const runOriginViewInstructions = (prev, originView) => {
  originView.forEach(([op, offset, fromIndex]) => {
    switch (op) {
      case 'insert':
        prev.insertBefore(fromIndex, prev.children[offset])
        break
      case 'swap_in':
        prev.insertBefore(prev.children[fromIndex], prev.children[offset])
        break
      case 'remove':
        prev.children[offset].remove()
        break
      default:
        throw new Error(`unknown op ${op}`)
    }
  })
}

const reuseOrPatchElem = (prev, next, reconcileChildren) => {
  const canReuse = equalPatchElem(prev, next)
  next.removeAttribute(TypstPatchAttrs.ReuseFrom)
  patchAttributes(prev, next)
  if (canReuse)
    return true

  const frozen = preReplaceNonSVGElements(prev, next)
  reconcileChildren(prev, next)
  postReplaceNonSVGElements(prev, frozen)
  return false
}

const patchChildren = (prev, next) => {
  const [targetView, toPatch] = interpretTargetView(prev.children, next.children, true, isGElem)
  toPatch.forEach(([prevChild, nextChild]) => {
    reuseOrPatchElem(prevChild, nextChild, patchChildren)
  })
  const originView = changeViewPerspective(prev.children, targetView, isGElem)
  runOriginViewInstructions(prev, originView)
}

export const patchRoot = (prev, next) => {
  patchAttributes(prev, next)
  const frozen = preReplaceNonSVGElements(prev, next)
  patchChildren(prev, next)
  postReplaceNonSVGElements(prev, frozen)
}
