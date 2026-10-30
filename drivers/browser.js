/**
 * BrowserDriver — Playwright-backed Computer Use driver.
 *
 * One private, isolated browser session per Agent. Screenshots are captured
 * in CSS viewport pixels, which is exactly the coordinate space the model
 * acts on (no Retina scaling ambiguity inside a controlled viewport).
 */
import { createRequire } from 'node:module'

// playwright-core is a CommonJS package whose ESM wrapper (`index.mjs`) trips
// the harness loader's CJS default-export interop on module reloads. Loading it
// through createRequire avoids that entirely and works in any Node/Electron host.
const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')

export class BrowserDriver {
  constructor(options = {}) {
    this.channel = options.channel ?? 'chrome'
    this.executablePath = options.executablePath
    this.headless = options.headless ?? false
    this.viewport = options.viewport ?? { width: 1280, height: 800 }
    this.blockExternal = options.blockExternal ?? false
    this.logger = options.logger
    this.browser = null
    this.context = null
    this.page = null
    this.lastUrl = undefined
    this.lastTitle = undefined
  }

  async ensure() {
    if (this.page) return
    const launchOptions = { headless: this.headless, args: ['--disable-blink-features=AutomationControlled'] }
    if (this.executablePath) launchOptions.executablePath = this.executablePath
    else if (this.channel) launchOptions.channel = this.channel
    try {
      this.browser = await chromium.launch(launchOptions)
    } catch (error) {
      if (this.channel && !this.executablePath) {
        this.logger?.warn?.(`channel '${this.channel}' unavailable (${String(error)}); falling back to bundled chromium`)
        this.browser = await chromium.launch({ headless: this.headless })
      } else {
        throw error
      }
    }
    this.context = await this.browser.newContext({ viewport: this.viewport, acceptDownloads: true })
    this.page = await this.context.newPage()
    this.page.on('close', () => { this.page = null })
    if (this.blockExternal) {
      await this.page.route('**/*', (route) => {
        try {
          const origin = new URL(route.request().url()).origin
          const current = new URL(this.page.url()).origin
          if (origin === current) route.continue()
          else route.abort()
        } catch {
          route.abort()
        }
      })
    }
  }

  async open(url, signal) {
    await this.ensure()
    signal?.throwIfAborted()
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await this.page.waitForTimeout(600) // let the page paint before the next screenshot
    return this.describe()
  }

  async describe() {
    if (!this.page) return { url: null, title: null, ready: false }
    try {
      this.lastUrl = this.page.url()
      this.lastTitle = await this.page.title()
    } catch {
      // navigating pages may be mid-teardown; keep the last known values
    }
    return { url: this.lastUrl ?? null, title: this.lastTitle ?? null, ready: true }
  }

  async screenshot() {
    await this.ensure()
    const viewport = this.page.viewportSize()
    const bytes = await this.page.screenshot({ type: 'png' })
    const state = await this.describe()
    return {
      bytes,
      mimeType: 'image/png',
      pixelWidth: viewport.width,
      pixelHeight: viewport.height,
      url: state.url,
      title: state.title,
    }
  }

  async getState() {
    await this.ensure()
    const state = await this.page.evaluate(() => {
      const selectors = [
        'a', 'button', 'input', 'textarea', 'select', 'summary', 'label', 'iframe', 'details',
        '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
        '[role="checkbox"]', '[role="radio"]', '[role="combobox"]', '[role="textbox"]',
      ]
      const elements = [...document.querySelectorAll(selectors.join(','))]
        .map((el) => {
          const rect = el.getBoundingClientRect()
          const value = el.value
          const text = (typeof value === 'string' && value.length > 0
            ? value
            : (el.innerText ?? el.getAttribute('aria-label') ?? el.placeholder ?? el.textContent ?? ''))
            .trim().replace(/\s+/g, ' ').slice(0, 200)
          const item = {
            tag: el.tagName.toLowerCase(),
            text,
            box: {
              x: Math.round(rect.x), y: Math.round(rect.y),
              width: Math.round(rect.width), height: Math.round(rect.height),
            },
          }
          const type = el.getAttribute('type')
          const role = el.getAttribute('role')
          const href = el.getAttribute('href')
          if (type !== null) item.type = type
          if (role !== null) item.role = role
          if (href !== null) item.href = href
          if (el.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio')) item.checked = el.checked
          return item
        })
        .filter((item) => item.box.width > 0 && item.box.height > 0)
      return {
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        elements: elements.slice(0, 250),
        truncated: elements.length > 250,
      }
    })
    return state
  }

  async click(x, y, { button = 'left', clickCount = 1, holdMs } = {}) {
    await this.ensure()
    await this.page.mouse.move(x, y)
    if (holdMs && holdMs > 0) {
      await this.page.mouse.down({ button })
      await this.page.waitForTimeout(holdMs)
      await this.page.mouse.up({ button })
    } else {
      await this.page.mouse.click(x, y, { button, clickCount })
    }
    return { ok: true, x, y, button, clickCount }
  }

  async type(text) {
    await this.ensure()
    await this.page.keyboard.type(text, { delay: 15 })
    return { ok: true, length: text.length }
  }

  async keypress(key) {
    await this.ensure()
    await this.page.keyboard.press(key)
    return { ok: true, key }
  }

  async scroll(x, y, deltaX, deltaY) {
    await this.ensure()
    await this.page.mouse.move(x, y)
    await this.page.mouse.wheel(deltaX, deltaY)
    return { ok: true, x, y, deltaX, deltaY }
  }

  async wait(ms) {
    await this.ensure()
    await this.page.waitForTimeout(ms)
    return { ok: true, waitedMs: ms }
  }

  async close() {
    if (!this.browser) return
    const browser = this.browser
    this.browser = null
    this.context = null
    this.page = null
    await browser.close().catch(() => {})
  }
}
