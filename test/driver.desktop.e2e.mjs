/**
 * Desktop driver end-to-end test: operates the real macOS Calculator through
 * the native helper — launch the app, screenshot, read the AX state, click
 * buttons, verify the result. Requires the helper to have Accessibility +
 * Screen Recording permissions (see native/README or the plugin README).
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

try {
  await driver.ensure()
  check('permissions granted (accessibility + screen recording)', true)

  await driver.open('Calculator')
  await driver.wait(1500)

  const state1 = await driver.getState()
  check('calculator is frontmost app', state1.app?.name?.toLowerCase().includes('calculator'), state1.app?.name)
  check('axstate exposes buttons', (state1.elements ?? []).length > 0, `${state1.elements.length} elements`)

  const shot1 = await driver.screenshot()
  check('screenshot captured', shot1.bytes.length > 0 && shot1.pixelWidth > 0, `${shot1.pixelWidth}x${shot1.pixelHeight} @${shot1.scaleFactor}x`)
  await writeFile(join(shots, 'desktop-1-calculator.png'), shot1.bytes)

  const state2 = await driver.getState()
  const find = (label) => state2.elements.find((el) => el.text === label || el.text?.includes(label))
  const seven = find('7')
  const plus = find('+')
  const three = find('3')
  const equals = find('=')
  check('locates 7/+ /3/= buttons', Boolean(seven && plus && three && equals),
    JSON.stringify([seven?.text, plus?.text, three?.text, equals?.text]))

  if (seven && plus && three && equals) {
    const click = async (el) => {
      const cx = Math.round(el.box.x + el.box.width / 2)
      const cy = Math.round(el.box.y + el.box.height / 2)
      await driver.click(cx, cy)
      await driver.wait(180)
    }
    await click(seven)
    await click(plus)
    await click(three)
    await click(equals)
    await driver.wait(500)

    const state3 = await driver.getState()
    const display = state3.elements.find((el) => el.text === '10' || el.text?.includes('10'))
    check('calculator shows 7+3=10', Boolean(display), JSON.stringify(state3.elements.map((e) => e.text).slice(0, 12)))
    const shot2 = await driver.screenshot()
    await writeFile(join(shots, 'desktop-2-calculated.png'), shot2.bytes)
  }
} catch (error) {
  console.error('ERROR:', error.code ?? '?', String(error.message))
} finally {
  await driver.close()
}

const failed = results.filter((r) => !r.ok)
console.log(failed.length === 0 ? '\nALL PASS' : `\n${failed.length} FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
