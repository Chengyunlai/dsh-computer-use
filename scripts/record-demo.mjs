/**
 * Demo recorder — drives the plugin's own BrowserDriver through several
 * real-world scenarios, capturing a frame per step so the frames can be
 * assembled into README GIFs (docs/demos). Every action below goes through
 * the exact driver methods the computer_use tool calls, and element targets
 * are located via the same getState() the model uses (no hard-coded
 * coordinates).
 *
 * Usage:  node scripts/record-demo.mjs <case>
 *   cases: figma | wikipedia | github
 * Frames:  demos/frames/<case>/frame-%04d.png
 * Then:    ffmpeg -y -framerate 3 -i demos/frames/<case>/frame-%04d.png \
 *            -vf "scale=800:-2:flags=lanczos" -loop 0 demos/<case>.gif
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserDriver } from '../drivers/browser.js'

const CASES = {
  figma: {
    url: 'https://www.figma.com',
    steps: [
      ['wait', 2200],
      ['findAndClick', 'Allow all cookies'],
      ['wait', 900],
      ['scroll', 900],
      ['wait', 500],
      ['scroll', 900],
      ['wait', 500],
    ],
  },
  wikipedia: {
    url: 'https://en.wikipedia.org',
    steps: [
      ['wait', 2000],
      ['findAndClick', 'input:Search'],
      ['wait', 500],
      ['type', 'Computer use'],
      ['wait', 500],
      ['press', 'Enter'],
      ['wait', 2600],
    ],
  },
  github: {
    url: 'https://github.com/deepseek-ai/deepseek-harness',
    steps: [
      ['wait', 2600],
      ['findAndClick', 'packages'],
      ['wait', 2200],
      ['findAndClick', 'README.md'],
      ['wait', 2200],
      ['scroll', 500],
      ['wait', 600],
    ],
  },
}

const which = process.argv[2]
const scenario = CASES[which]
if (!scenario) {
  console.error(`unknown case '${which}'; expected one of: ${Object.keys(CASES).join(', ')}`)
  process.exit(1)
}

const driver = new BrowserDriver({
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 800 },
})

const dir = join('demos', 'frames', which)
await mkdir(dir, { recursive: true })
let frame = 0

async function snap() {
  const shot = await driver.screenshot()
  const name = `frame-${String(++frame).padStart(4, '0')}.png`
  await writeFile(join(dir, name), shot.bytes)
  console.log(`captured ${name}`)
}

function center(el) {
  return [Math.round(el.box.x + el.box.width / 2), Math.round(el.box.y + el.box.height / 2)]
}

async function find(needle) {
  const state = await driver.getState()
  const [kind, text] = needle.split(':')
  const target = kind === 'input' ? (text ?? '').toLowerCase() : needle.toLowerCase()
  const el = state.elements.find((e) => {
    const t = e.text || ''
    if (kind === 'input') return e.tag === 'input' && t.toLowerCase().includes(target)
    return t.toLowerCase().includes(target)
  })
  if (!el) throw new Error(`element matching '${needle}' not found`)
  return el
}

try {
  await driver.ensure()
  console.log(`case ${which}: opening ${scenario.url}`)
  await driver.open(scenario.url)
  await snap()

  for (const [op, arg] of scenario.steps) {
    switch (op) {
      case 'wait':
        await driver.wait(arg)
        break
      case 'findAndClick': {
        let el = await find(arg)
        for (let i = 0; i < 4 && (el.box.y > 620 || el.box.y < 120); i++) {
          const dy = Math.round(el.box.y - 300)
          await driver.scroll(640, 400, 0, dy)
          await driver.wait(250)
          el = await find(arg)
        }
        const [x, y] = center(el)
        console.log(`clicking '${el.text || el.tag}' at (${x}, ${y})`)
        await driver.click(x, y, { button: 'left' })
        const url = (await driver.describe()).url
        console.log(`  -> ${url}`)
        break
      }
      case 'type': {
        const el = await find('input')
        const [x, y] = center(el)
        await driver.click(x, y, { button: 'left' })
        await driver.type(arg)
        console.log(`typed '${arg}'`)
        break
      }
      case 'press':
        await driver.keypress(arg)
        console.log(`pressed ${arg}`)
        break
      case 'scroll':
        await driver.scroll(640, 400, 0, arg)
        console.log(`scrolled ${arg}px`)
        break
    }
    await snap()
  }

  await driver.wait(700)
  await snap()
} finally {
  await driver.close()
  console.log(`done — ${frame} frames in ${dir}`)
}
