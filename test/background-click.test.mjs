import test from 'node:test'
import assert from 'node:assert/strict'
import { DesktopDriver } from '../drivers/desktop.js'

function driver() {
  const d = new DesktopDriver()
  d.permissionsChecked = true
  const calls = []
  d.daemon.call = async (command, args) => {
    calls.push({ command, args })
    return { ok: true, dispatched: true, verified: false, pid: 42, name: 'Fixture' }
  }
  return { d, calls }
}

test('background selection does not activate or restore another application', async () => {
  const { d, calls } = driver()
  await d.open('Fixture')
  assert.deepEqual(calls, [{ command: 'openapp', args: { query: 'Fixture', background: true } }])
  assert.equal(d.capture, null)
})

test('coordinate input requires a screenshot of the selected application', async () => {
  const { d, calls } = driver()
  d.targetPid = 42
  await assert.rejects(d.click(10, 20), { code: 'WINDOW_CAPTURE_REQUIRED' })
  d.capture = { pid: 41, windowId: 5, bounds: {} }
  await assert.rejects(d.click(10, 20), { code: 'WINDOW_CAPTURE_REQUIRED' })
  assert.deepEqual(calls, [])
})

test('custom surfaces use screenshot window identity and point coordinates without pressing an ancestor', async () => {
  const { d, calls } = driver()
  d.targetPid = 42
  d.scale = 2
  d.origin = { x: 100, y: 200 }
  d.capture = { pid: 42, windowId: 5, bounds: { X: 100, Y: 200, Width: 500, Height: 400 } }
  d.lastElements = [{ role: 'AXWindow', text: 'Fixture', box: { x: 0, y: 0, width: 1000, height: 800 } }]
  const result = await d.click(60, 80)
  assert.deepEqual(calls, [{ command: 'click', args: {
    pid: 42, windowId: 5, bounds: d.capture.bounds, x: 130, y: 240, button: 'left', clickCount: 1,
  } }])
  assert.equal(result.verified, false)
})

test('unsupported background gestures fail before dispatch', async () => {
  const { d, calls } = driver()
  for (const options of [{ button: 'right' }, { clickCount: 3 }, { holdMs: 1 }]) {
    await assert.rejects(d.click(10, 20, options), { code: 'BACKGROUND_UNSUPPORTED' })
  }
  assert.deepEqual(calls, [])
})

test('a failed coordinate dispatch is never replayed through another route', async () => {
  const { d } = driver()
  d.targetPid = 42
  d.capture = { pid: 42, windowId: 5, bounds: {} }
  let count = 0
  d.daemon.call = async () => { count++; throw Object.assign(new Error('stale'), { code: 'STALE_WINDOW' }) }
  await assert.rejects(d.click(10, 20), { code: 'STALE_WINDOW' })
  assert.equal(count, 1)
})

test('an older helper is refused before application selection can activate it', async () => {
  const d = new DesktopDriver()
  const calls = []
  d.daemon.call = async (command) => { calls.push(command); return { ok: true, accessibility: true } }
  await assert.rejects(d.open('Fixture'), { code: 'HELPER_REBUILD_REQUIRED' })
  assert.deepEqual(calls, ['permissions'])
})

test('background text and keys carry the screenshot window and retain unverified dispatch', async () => {
  const { d, calls } = driver()
  d.targetPid = 42
  d.getState = async () => ({ elements: [] })
  d.capture = { pid: 42, windowId: 5, bounds: { X: 10, Y: 20, Width: 500, Height: 400 } }
  assert.equal((await d.type('周杰伦😀')).verified, false)
  assert.equal((await d.keypress('return')).verified, false)
  assert.deepEqual(calls, [
    { command: 'type', args: { pid: 42, windowId: 5, bounds: d.capture.bounds, text: '周杰伦😀' } },
    { command: 'keypress', args: { pid: 42, windowId: 5, bounds: d.capture.bounds, key: 'return' } },
  ])
})

test('background keyboard refuses missing and wrong-app captures before dispatch', async () => {
  const { d, calls } = driver()
  d.targetPid = 42
  d.getState = async () => ({ elements: [] })
  await assert.rejects(d.type('test'), { code: 'WINDOW_CAPTURE_REQUIRED' })
  d.capture = { pid: 41, windowId: 5, bounds: {} }
  await assert.rejects(d.keypress('return'), { code: 'WINDOW_CAPTURE_REQUIRED' })
  assert.deepEqual(calls, [])
})
