/**
 * Desktop driver end-to-end test — BACKGROUND mode.
 *
 * Launches the macOS Calculator and operates it in the background:
 *  - the user's frontmost app keeps focus (the launched app is handed back),
 *  - the real mouse pointer never moves (AX press actions, not CGEvent),
 *  - state is read via the Accessibility API on the target pid.
 *
 * Requires the helper to have Accessibility + Screen Recording permissions.
 * The demo briefly activates Calculator at launch (macOS launch), then hands
 * focus back to the user's app.
 *
 * Usage: node test/driver.desktop.e2e.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { DesktopDriver } from '../drivers/desktop.js'

const shots = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'screenshots')
await mkdir(shots, { recursive: true })
const helperPath = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'native', 'macos-helper')
const helperRun = (cmd, args = {}) => JSON.parse(execFileSync(helperPath, [cmd, JSON.stringify(args)], { encoding: 'utf8' }))
const norm = (s) => (s ?? '').replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim()

const driver = new DesktopDriver({ inputMode: 'background' })
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  await driver.ensure()
  check('permissions granted (accessibility + screen recording)', true)

  const front0 = helperRun('axstate') // real frontmost (helper, not the driver's target app)
  const frontName = front0.app?.name ?? ''
  const mouse0 = helperRun('mousepos')

  await driver.open('Calculator')
  await sleep(1800) // wait for open()'s internal focus hand-back to settle

  // Background guarantees:
  const front1 = helperRun('axstate')
  check('focus NOT stolen (user app still frontmost)', (front1.app?.name ?? '') === frontName, `${frontName} -> ${front1.app?.name}`)
  const mouse1 = helperRun('mousepos')
  check('real mouse did NOT move', Math.abs(mouse1.x - mouse0.x) < 5 && Math.abs(mouse1.y - mouse0.y) < 5,
    `${mouse0.x.toFixed(0)},${mouse0.y.toFixed(0)} -> ${mouse1.x.toFixed(0)},${mouse1.y.toFixed(0)}`)

  // Read the Calculator AX tree while it is in the background.
  const state = await driver.getState()
  const labels = state.elements.map((el) => norm(el.text))
  check('background AX read works', (state.app?.name ?? '').includes('计算器'), `${state.elements.length} elements`)

  const locate = (want) => state.elements.find((el) => norm(el.text) === want)
  const btn = (want) => {
    const el = locate(want)
    if (!el) { check(`locates ${want}`, false); return null }
    return el
  }
  const clickEl = async (el) => {
    const cx = Math.round(el.box.x + el.box.width / 2)
    const cy = Math.round(el.box.y + el.box.height / 2)
    const m0 = helperRun('mousepos')
    const r = await driver.click(cx, cy)
    const m1 = helperRun('mousepos')
    const pointerStill = Math.abs(m1.x - m0.x) < 2 && Math.abs(m1.y - m0.y) < 2
    check(`click ${el.text} via ${r.via}`, r.ok && pointerStill, pointerStill ? '' : 'pointer moved during click')
    await sleep(260)
  }

  const clear = locate('全部清除') ?? locate('清除')
  check('locates clear', Boolean(clear))
  if (clear) await clickEl(clear)
  for (const want of ['7', '加', '3', '等于']) {
    const el = btn(want)
    if (el) await clickEl(el)
  }
  await sleep(600)

  const state2 = await driver.getState()
  const labels2 = state2.elements.map((el) => norm(el.text))
  check('calculator shows 7+3=10', labels2.includes('10'), JSON.stringify(labels2.slice(0, 4)))

  const front2 = helperRun('axstate')
  check('focus still on user app', (front2.app?.name ?? '') === frontName)

  // Screenshot (requires Screen Recording) — briefly activate Calculator so
  // its window is visible, capture, then hand focus back to the user's app.
  try {
    const shot = await driver.screenshot()
    check('window screenshot captured', shot.bytes.length > 0 && shot.scope === 'window' && shot.pixelHeight > 100, `${shot.pixelWidth}x${shot.pixelHeight} @${shot.scaleFactor}x`)
    await writeFile(join(shots, 'desktop-3-background-calculated.png'), shot.bytes)
    if (frontName) await driver.activate(front0.app.pid)
  } catch (error) {
    check('window screenshot captured', false, error.code ?? String(error.message))
  }
} catch (error) {
  check('desktop execution', false, error.code ?? String(error.message))
} finally {
  await driver.close()
}

const failed = results.filter((r) => !r.ok)
console.log(failed.length === 0 ? '\nALL PASS' : `\n${failed.length} FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
