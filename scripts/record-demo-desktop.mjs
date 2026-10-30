/**
 * Desktop demo recorder — operates the real macOS Calculator and captures a
 * target-window frame per step, for a local GIF (docs/demos/desktop-calculator.gif).
 *
 * Requires the helper to have Accessibility + Screen Recording permissions.
 * Captures contain only the Calculator window; missing targets fail closed.
 *
 * Usage:  node scripts/record-demo-desktop.mjs
 * Frames: demos/frames/desktop/frame-%04d.png
 * Then:   ffmpeg -y -framerate 2 -i demos/frames/desktop/frame-%04d.png \
 *           -vf "scale=800:-2:flags=lanczos" -loop 0 demos/desktop-calculator.gif
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DesktopDriver } from '../drivers/desktop.js'

// background mode: AX press actions — the real mouse never moves, and the
// launched app is operated without stealing focus. We activate Calculator at
// capture time so the GIF shows the window being operated.
const driver = new DesktopDriver({ inputMode: 'background' })
const dir = join('demos', 'frames', 'desktop')
await mkdir(dir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let frame = 0
async function snap(label) {
  const shot = await driver.screenshot()
  if (shot.scope !== 'window') throw new Error('Recording requires a target-window capture')
  const name = `frame-${String(++frame).padStart(4, '0')}.png`
  await writeFile(join(dir, name), shot.bytes)
  console.log(`captured ${name} (${label})`)
}

function locate(state, want) {
  const names = { '+': ['加', '+', 'add'], '=': ['等于', '=', 'equals'] }
  const candidates = names[want] ?? [want]
  return (state.elements ?? []).find((el) => candidates.some((n) => el.text === n || el.text?.includes(n)))
}

try {
  await driver.ensure()
  await driver.open('Calculator')
  let state = null
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    state = await driver.getState()
    const name = state.app?.name ?? ''
    if (name.includes('计算器') || name.toLowerCase().includes('calc')) break
    const win = (state.windows ?? []).find((w) => (w.ownerName ?? '').includes('计算器'))
    if (win) await driver.activate(win.pid)
  }
  if (!(state.app?.name ?? '').includes('计算器')) throw new Error('Calculator never became frontmost')
  // Keep Calculator visible for the GIF (the app stays frontmost during the
  // demo; input still goes through background AX presses that do not move
  // the real pointer).
  console.log('Capturing Calculator window only')

  await snap('calculator ready')
  state = await driver.getState()
  const click = async (el, label) => {
    const cx = Math.round(el.box.x + el.box.width / 2)
    const cy = Math.round(el.box.y + el.box.height / 2)
    await driver.click(cx, cy)
    await sleep(350)
    await snap(`clicked ${label}`)
  }

  await click(locate(state, '7'), '7')
  state = await driver.getState()
  await click(locate(state, '+'), '+')
  state = await driver.getState()
  await click(locate(state, '3'), '3')
  state = await driver.getState()
  await click(locate(state, '='), '=')
  await sleep(500)
  await snap('result 7+3=10')
} finally {
  await driver.close()
  console.log(`done — ${frame} frames in ${dir}`)
}
