/**
 * ComputerRouter — the unified "everything" driver.
 *
 * A human can operate a browser, a desktop app, the file manager, and
 * system settings in one session. This router gives computer_use the same
 * reach: `open` decides the surface automatically (a URL goes to the
 * Playwright browser driver; anything else — an app name, a path — goes to
 * the macOS desktop driver), and every observation/action routes to whatever
 * surface is currently active. The agent can switch back and forth freely.
 *
 * Modes:
 *  - auto (default): open() routes by target kind; screenshot/get_state/acts
 *    hit the last activated surface.
 *  - browser / desktop: pin computer_use to a single surface (old behaviour).
 */
import { BrowserDriver } from './browser.js'
import { DesktopDriver } from './desktop.js'

const URL_RE = /^(https?|file):\/\//i

export class ComputerRouter {
  constructor(options = {}) {
    this.mode = options.mode ?? 'auto' // 'auto' | 'browser' | 'desktop'
    this.browserConfig = options.browser ?? {}
    this.desktopConfig = options.desktop ?? {}
    this.logger = options.logger
    this.browser = null
    this.desktop = null
    this.active = null // 'browser' | 'desktop'
    this.activeLabel = null
  }

  #browser() {
    if (!this.browser) this.browser = new BrowserDriver({ ...this.browserConfig, logger: this.logger })
    return this.browser
  }

  #desktop() {
    if (!this.desktop) this.desktop = new DesktopDriver({ ...this.desktopConfig, logger: this.logger })
    return this.desktop
  }

  current() {
    if (this.mode === 'browser') return this.#browser()
    if (this.mode === 'desktop') return this.#desktop()
    if (this.active === 'desktop') return this.#desktop()
    return this.#browser()
  }

  surfaceOf() {
    if (this.mode === 'browser') return 'browser'
    if (this.mode === 'desktop') return 'desktop'
    return this.active ?? 'browser'
  }

  isUrlTarget(target) {
    return URL_RE.test(target) || target.startsWith('data:')
  }

  async open(target, signal) {
    if (this.mode === 'browser') {
      await this.#browser().ensure()
      await this.#browser().open(target, signal)
      return { surface: 'browser', url: target, ready: true }
    }
    if (this.mode === 'desktop') {
      const result = await this.#desktop().open(target, signal)
      return { surface: 'desktop', app: result.app, pid: result.pid, ready: true }
    }
    // auto: route by target kind
    if (this.isUrlTarget(target)) {
      this.active = 'browser'
      this.activeLabel = target
      await this.#browser().ensure()
      await this.#browser().open(target, signal)
      return { surface: 'browser', url: target, ready: true }
    }
    this.active = 'desktop'
    this.activeLabel = target
    const result = await this.#desktop().open(target, signal)
    return { surface: 'desktop', app: result.app, pid: result.pid, ready: true }
  }

  async screenshot() {
    const driver = this.current()
    const shot = await driver.screenshot()
    return { ...shot, surface: this.surfaceOf() }
  }

  async getState() {
    const driver = this.current()
    const state = await driver.getState()
    return { ...state, surface: this.surfaceOf(), activeTarget: this.activeLabel }
  }

  async click(x, y, options = {}) {
    const driver = this.current()
    return driver.click(x, y, options)
  }

  async type(text) {
    return this.current().type(text)
  }

  async keypress(key) {
    return this.current().keypress(key)
  }

  async scroll(x, y, deltaX, deltaY) {
    return this.current().scroll(x, y, deltaX, deltaY)
  }

  async wait(ms) {
    return this.current().wait(ms)
  }

  async close() {
    const driver = this.current()
    const surface = this.surfaceOf()
    await driver.close()
    this.active = null
    return { ok: true, closed: surface }
  }
}
