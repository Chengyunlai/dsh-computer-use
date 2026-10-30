/**
 * Router end-to-end test — the "everything" surface.
 *
 * One computer_use router operating BOTH surfaces in a single session:
 *   1. open a web page  -> browser driver (Playwright)
 *   2. open Calculator  -> desktop driver (background AX press, focus kept,
 *      real mouse untouched)
 *   3. back to the web page -> browser driver again
 * Every observation/action follows the surface opened last.
 *
 * Requires the desktop helper to have Accessibility + Screen Recording
 * permissions. The browser runs headless; the Calculator demo briefly
 * activates the app at launch, then hands focus back.
 *
 * Usage: node test/driver.router.e2e.mjs
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComputerRouter } from '../drivers/router.js'

const helperPath = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'native', 'macos-helper')
const helperRun = (cmd, args = {}) => JSON.parse(execFileSync(helperPath, [cmd, JSON.stringify(args)], { encoding: 'utf8' }))
const norm = (s) => (s ?? '').replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim()

const router = new ComputerRouter({
  mode: 'auto',
  browser: { channel: 'chrome', headless: true, viewport: { width: 1280, height: 800 } },
  desktop: { inputMode: 'background' },
})
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  const front0 = helperRun('axstate')
  const frontName = front0.app?.name ?? ''
  const mouse0 = helperRun('mousepos')

  // 1) browser
  const opened1 = await router.open('http://127.0.0.1:8734/test-page.html')
  check('open url -> browser surface', opened1.surface === 'browser', opened1.surface)
  const shot1 = await router.screenshot()
  check('browser screenshot works', shot1.bytes.length > 0 && shot1.surface === 'browser', `${shot1.pixelWidth}x${shot1.pixelHeight}`)
  const page1 = await router.getState()
  check('browser get_state has page elements', page1.elements.some((e) => e.text?.includes('查看任务详情')), page1.surface)

  // 2) desktop Calculator in the background
  const opened2 = await router.open('Calculator')
  check('open app -> desktop surface', opened2.surface === 'desktop', `${opened2.surface} (${opened2.app})`)
  await sleep(1200)
  const front1 = helperRun('axstate')
  check('desktop open did NOT steal focus', (front1.app?.name ?? '') === frontName, `${frontName} -> ${front1.app?.name}`)

  const calc = await router.getState()
  check('desktop get_state reads background app', calc.surface === 'desktop' && (calc.app?.name ?? '').includes('计算器'), `${calc.elements.length} elements`)
  const locate = (want) => calc.elements.find((el) => norm(el.text) === want)
  const clickEl = async (el) => {
    const m0 = helperRun('mousepos')
    const r = await router.click(Math.round(el.box.x + el.box.width / 2), Math.round(el.box.y + el.box.height / 2))
    const m1 = helperRun('mousepos')
    check(`click ${el.text} (${r.via})`, r.ok && Math.abs(m1.x - m0.x) < 2 && Math.abs(m1.y - m0.y) < 2, r.via)
    await sleep(240)
  }
  const clear = locate('全部清除') ?? locate('清除')
  if (clear) await clickEl(clear)
  for (const want of ['7', '加', '3', '等于']) {
    const el = locate(want)
    if (el) await clickEl(el)
  }
  await sleep(500)
  const calc2 = await router.getState()
  const labels = calc2.elements.map((el) => norm(el.text))
  check('calculator shows 7+3=10', labels.includes('10'), JSON.stringify(labels.slice(0, 4)))

  // 3) back to the browser
  const opened3 = await router.open('http://127.0.0.1:8734/test-page.html')
  check('re-open url -> browser surface again', opened3.surface === 'browser', opened3.surface)
  const page2 = await router.getState()
  check('browser state again (same page)', page2.surface === 'browser' && (page2.url ?? '').includes('test-page.html'), page2.url)

  await router.close()
  check('close ends session', true)
} catch (error) {
  console.error('ERROR:', error.code ?? '?', String(error.message))
} finally {
  await router.close()
}

const failed = results.filter((r) => !r.ok)
console.log(failed.length === 0 ? '\nALL PASS' : `\n${failed.length} FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
