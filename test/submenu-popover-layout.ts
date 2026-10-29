import assert from 'node:assert/strict'
import { computeSubmenuPlacement } from '../src/renderer/components/SubmenuPopover.tsx'

const alignedRight = computeSubmenuPlacement({
  anchor: { top: 400, left: 100, right: 300 },
  popover: { width: 216, height: 260 },
  viewport: { width: 1280, height: 900 }
})
assert.deepEqual(alignedRight, {
  left: 212,
  top: -6,
  placement: 'right'
})

const shiftedAboveBottomEdge = computeSubmenuPlacement({
  anchor: { top: 700, left: 100, right: 300 },
  popover: { width: 216, height: 300 },
  viewport: { width: 1280, height: 800 }
})
assert.deepEqual(shiftedAboveBottomEdge, {
  left: 212,
  top: -212,
  placement: 'right'
})

const flippedAtRightEdge = computeSubmenuPlacement({
  anchor: { top: 200, left: 1000, right: 1200 },
  popover: { width: 216, height: 260 },
  viewport: { width: 1280, height: 900 }
})
assert.deepEqual(flippedAtRightEdge, {
  left: -228,
  top: -6,
  placement: 'left'
})

const clampedInsideNarrowViewport = computeSubmenuPlacement({
  anchor: { top: 20, left: 30, right: 230 },
  popover: { width: 216, height: 500 },
  viewport: { width: 260, height: 520 }
})
assert.deepEqual(clampedInsideNarrowViewport, {
  left: 2,
  top: -8,
  placement: 'viewport'
})

console.log('submenu popover layout tests passed')
