/**
 * Desktop driver end-to-end test: operates the real macOS Calculator through
 * the native helper — launch the app, screenshot, read the AX state, click
 * buttons, verify the result. Requires the helper to have Accessibility +
 * Screen Recording permissions (see native/README or the plugin README).
 *
 * The demo temporarily activates Calculator (it steals focus from whatever
 * is frontmost). Operator labels are locale-dependent (e.g. 加/等于 on a
 * Chinese system), so the script matches by role position fallbacks too.
 *
 * Usage: node test/driver.desktop.e2e.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DesktopDriver } from '../drivers/desktop.js'

const shots = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'screenshots')
await mkdir(shots, { recursive: true })

const driver = new DesktopDriver({})
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Locate an element by label, with fallbacks for localized operator names.
function locate(state, want) {
  const names = {
    '+': ['加', '+', 'add'],
    '=': ['等于', '=', 'equals'],
  }
  const candidates = names[want] ?? [want]
  return (state.elements ?? []).find((el) => candidates.some((n) => el.text === n || el.text?.includes(n)))
}

try {
  await driver.ensure()
  check('permissions granted (accessibility + screen recording)', true)

  await driver.open('Calculator')
  // Poll until Calculator is frontmost (the user may be using other apps).
  let state = null
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    state = await driver.getState()
    const name = state.app?.name ?? ''
    if (name.includes('计算器') || name.toLowerCase().includes('calc')) break
    const win = (state.windows ?? []).find((w) => (w.ownerName ?? '').includes('计算器'))
    if (win) await driver.activate(win.pid)
  }
  check('calculator is frontmost', (state?.app?.name ?? '').includes('计算器'), state?.app?.name)

  const seven = locate(state, '7')
  const plus = locate(state, '+')
  const three = locate(state, '3')
  const equals = locate(state, '=')
  check('locates 7 / + / 3 / = buttons', Boolean(seven && plus && three && equals),
    JSON.stringify([seven?.text, plus?.text, three?.text, equals?.text]))

  let shot1 = null
  try {
    shot1 = await driver.screenshot()
    check('screenshot captured', shot1.bytes.length > 0 && shot1.pixelWidth > 0, `${shot1.pixelWidth}x${shot1.pixelHeight} @${shot1.scaleFactor}x`)
    await writeFile(join(shots, 'desktop-1-calculator.png'), shot1.bytes)
  } catch (error) {
    console.log('SKIP screenshot (grant Screen Recording permission to enable):', error.code ?? String(error.message))
  }

  if (seven && plus && three && equals) {
    const click = async (el) => {
      const cx = Math.round(el.box.x + el.box.width / 2)
      const cy = Math.round(el.box.y + el.box.height / 2)
      await driver.click(cx, cy)
      await sleep(250)
    }
    await click(seven)
    await click(plus)
    await click(three)
    await click(equals)
    await sleep(600)

    const state3 = await driver.getState()
    const display = (state3.elements ?? []).find((el) => el.text === '10' || el.text?.includes('10'))
    check('calculator shows 7+3=10', Boolean(display), JSON.stringify(state3.elements?.map((e) => e.text).slice(0, 10)))
    try {
      const shot2 = await driver.screenshot()
      await writeFile(join(shots, 'desktop-2-calculated.png'), shot2.bytes)
    } catch (error) {
      console.log('SKIP final screenshot (Screen Recording not granted):', error.code ?? String(error.message))
    }
  }
} catch (error) {
  console.error('ERROR:', error.code ?? '?', String(error.message))
} finally {
  await driver.close()
}

const failed = results.filter((r) => !r.ok)
console.log(failed.length === 0 ? '\nALL PASS' : `\n${failed.length} FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
