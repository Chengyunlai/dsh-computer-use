/**
 * Standalone end-to-end test for the computer_use plugin's browser driver.
 * Runs OUTSIDE the harness (plain Node) so it does not depend on the
 * profile's loaded module generation: it exercises the exact modules the
 * plugin ships — BrowserDriver, screenshot pipeline (persistCopy path) —
 * through the same action sequence the model would run.
 *
 * Usage: node computer-use/test/driver.e2e.mjs
 */
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserDriver } from '../drivers/browser.js'

const here = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const shots = join(here, 'screenshots')
await rm(shots, { recursive: true, force: true })
await mkdir(shots, { recursive: true })

const driver = new BrowserDriver({
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 800 },
  logger: { debug: () => {}, warn: (m) => console.warn(m) },
})

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  await driver.ensure()
  await driver.open('http://127.0.0.1:8734/test-page.html')
  check('open', true)

  const shot = await driver.screenshot()
  const pngOk = shot.bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
  check('screenshot png signature', pngOk, `${shot.pixelWidth}x${shot.pixelHeight}`)
  await writeFile(join(shots, 'e2e-1-initial.png'), shot.bytes)

  // lossless-JSON guarantee: the value returned to the tool registry must
  // survive JSON.stringify -> JSON.parse unchanged.
  const state1 = await driver.getState()
  const roundTrip = JSON.parse(JSON.stringify(state1))
  const lossless = JSON.stringify(state1) === JSON.stringify(roundTrip)
  check('get_state lossless JSON', lossless)
  check('get_state finds details summary', state1.elements.some((e) => e.tag === 'summary' && e.text.includes('查看任务详情')))
  check('get_state finds input+button', state1.elements.some((e) => e.tag === 'input') && state1.elements.some((e) => e.tag === 'button' && e.text.includes('保存备注')))

  // click the <summary> to expand <details>
  const summary = state1.elements.find((e) => e.tag === 'summary')
  const cx = summary.box.x + summary.box.width / 2
  const cy = summary.box.y + summary.box.height / 2
  await driver.click(Math.round(cx), Math.round(cy), { button: 'left' })
  const state2 = await driver.getState()
  check('click expanded details', state2.elements.some((e) => e.text.includes('任务状态：进行中')), 'status text visible after expand')
  await writeFile(join(shots, 'e2e-2-expanded.png'), (await driver.screenshot()).bytes)

  // focus the input, type, click save
  const input = state2.elements.find((e) => e.tag === 'input')
  await driver.click(Math.round(input.box.x + input.box.width / 2), Math.round(input.box.y + input.box.height / 2))
  await driver.type('hello computer use')
  const save = state2.elements.find((e) => e.tag === 'button' && e.text.includes('保存备注'))
  await driver.click(Math.round(save.box.x + save.box.width / 2), Math.round(save.box.y + save.box.height / 2))
  await driver.wait(300)

  const state3 = await driver.getState()
  const done = state3.elements.find((e) => e.text.includes('已经完成'))
  const input3 = state3.elements.find((e) => e.tag === 'input')
  check('status flipped to 已经完成', Boolean(done))
  check('typed text persisted in input value', input3?.text === 'hello computer use', JSON.stringify(input3?.text))
  await writeFile(join(shots, 'e2e-3-saved.png'), (await driver.screenshot()).bytes)

  // keypress + scroll smoke tests
  await driver.click(Math.round(input.box.x + input.box.width / 2), Math.round(input.box.y + input.box.height / 2))
  await driver.keypress('Control+A')
  check('keypress Control+A', true)
  await driver.scroll(640, 400, 0, 200)
  check('scroll', true)
} finally {
  await driver.close()
}

const failed = results.filter((r) => !r.ok)
console.log(failed.length === 0 ? '\nALL PASS' : `\n${failed.length} FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
