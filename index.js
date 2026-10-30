/**
 * @local/dsh-computer-use — Computer Use tools for DeepSeek Harness.
 *
 * The plugin provides the "Computer Use Tool + Driver" layer (L2/L3 in the
 * classic Computer Use architecture): the model observes a live browser
 * through screenshots and state snapshots, reasons, and acts with
 * click / type / keypress / scroll. DSH's own agent loop (L1) drives the
 * observe → reason → act → verify cycle, so this package only supplies the
 * tool and the driver; no model loop is reimplemented here.
 */
import Schema from '@deepseek-ai/schemastery'
import { BrowserDriver } from './drivers/browser.js'
import { DesktopDriver } from './drivers/desktop.js'
import { renderComputerResult, captureScreenshot } from './lib/screenshot.js'
import { guidance } from './lib/guidance.js'

export const Config = Schema.object({
  /** Which driver serves the computer_use tool. 'browser' is the working v1. */
  driver: Schema.union(['browser', 'desktop']).default('browser'),
  browser: Schema.object({
    /** Playwright browser channel; 'chrome' reuses the installed Google Chrome. */
    channel: Schema.string().default('chrome'),
    /** Absolute path to a browser executable; overrides `channel`. */
    executablePath: Schema.string(),
    /** Show a real browser window (headed) instead of headless. */
    headless: Schema.boolean().default(false),
    viewport: Schema.object({
      width: Schema.number().min(320).max(4096).default(1280),
      height: Schema.number().min(240).max(4096).default(800),
    }).default({ width: 1280, height: 800 }),
    /** Abort every request whose origin differs from the current page's origin. */
    blockExternal: Schema.boolean().default(false),
  }).default({}),
  desktop: Schema.object({
    /** Reserved for a future native desktop helper (macOS Accessibility/ScreenCaptureKit bridge). */
    helperPath: Schema.string(),
  }).default({}),
  /** Where viewport screenshots are also saved for the user, relative to the harness working directory. */
  screenshotDir: Schema.string().default('computer-use/screenshots'),
})

const ACTIONS = ['open', 'screenshot', 'get_state', 'click', 'type', 'keypress', 'scroll', 'wait', 'close']

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description: [
        'Which computer operation to perform.',
        'open: navigate the browser to `url` (starts the session).',
        'screenshot: capture the current viewport and return its image; coordinates in later actions use this image\'s pixels.',
        'get_state: return the current page url/title and a list of interactive elements with their on-screen boxes.',
        'click: click at pixel (`x`, `y`); optional `button` (left|right|middle), `clickCount`, `holdMs`.',
        'type: type `text` into the focused element.',
        'keypress: press a key or chord, e.g. "Enter", "Tab", "Control+A", "Meta+Shift+P".',
        'scroll: move the pointer to (`x`, `y`) and wheel by (`deltaX`, `deltaY`).',
        'wait: wait `ms` milliseconds for the page to settle (default 1000).',
        'close: close the browser session.',
      ].join(' '),
    },
    url: { type: 'string', description: 'Destination URL for action=open. http(s), file, or data: URLs are accepted.' },
    x: { type: 'integer', description: 'Horizontal pixel coordinate in the last screenshot (action=screenshot/click/scroll).' },
    y: { type: 'integer', description: 'Vertical pixel coordinate in the last screenshot (action=screenshot/click/scroll).' },
    button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for action=click. Defaults to left.' },
    clickCount: { type: 'integer', description: 'Number of clicks for action=click. Defaults to 1.' },
    holdMs: { type: 'integer', description: 'Hold the button for this many milliseconds on action=click.' },
    text: { type: 'string', description: 'Text to type for action=type.' },
    key: { type: 'string', description: 'Key or modifier chord for action=keypress, e.g. "Enter", "Control+A".' },
    deltaX: { type: 'integer', description: 'Horizontal wheel delta for action=scroll.' },
    deltaY: { type: 'integer', description: 'Vertical wheel delta for action=scroll.' },
    ms: { type: 'integer', description: 'Wait duration in milliseconds for action=wait. Defaults to 1000.' },
  },
  required: ['action'],
}

export const inject = ['tools', 'systemPrompt']

export function apply(ctx, config) {
  const logger = ctx.logger
  const sessions = new Map()

  function sessionFor(execution) {
    const key = execution.agent?.id ?? 'host'
    let session = sessions.get(key)
    if (session) return { key, session }
    const driver = config.driver === 'desktop'
      ? new DesktopDriver({ ...config.desktop, logger })
      : new BrowserDriver({ ...config.browser, logger, screenshotDir: config.screenshotDir })
    session = { driver, createdAt: Date.now() }
    sessions.set(key, session)
    return { key, session }
  }

  async function closeSession(key) {
    const session = sessions.get(key)
    if (!session) return
    sessions.delete(key)
    try {
      await session.driver.close()
    } catch (error) {
      logger.warn(`computer_use session close failed: ${String(error)}`)
    }
  }

  async function withDriver(execution, key, session, action, args) {
    if (action === 'close') {
      await closeSession(key)
      return { ok: true }
    }
    const driver = session.driver
    const signal = execution.signal
    switch (action) {
      case 'open': {
        if (typeof args.url !== 'string' || args.url.length === 0) throw new Error('action=open requires a `url` string')
        await driver.ensure()
        await driver.open(args.url, signal)
        return driver.describe()
      }
      case 'screenshot':
        return captureScreenshot(ctx, execution, driver)
      case 'get_state':
        await driver.ensure()
        return driver.getState()
      case 'click': {
        const x = Number(args.x); const y = Number(args.y)
        if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('action=click requires integer `x` and `y`')
        await driver.ensure()
        return driver.click(x, y, {
          button: args.button ?? 'left', clickCount: args.clickCount ?? 1, holdMs: args.holdMs,
        })
      }
      case 'type': {
        if (typeof args.text !== 'string') throw new Error('action=type requires a `text` string')
        await driver.ensure()
        return driver.type(args.text)
      }
      case 'keypress': {
        if (typeof args.key !== 'string' || args.key.length === 0) throw new Error('action=keypress requires a `key` string')
        await driver.ensure()
        return driver.keypress(args.key)
      }
      case 'scroll': {
        const x = Number(args.x); const y = Number(args.y)
        if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('action=scroll requires integer `x` and `y`')
        await driver.ensure()
        return driver.scroll(x, y, args.deltaX ?? 0, args.deltaY ?? 0)
      }
      case 'wait': {
        const ms = Number(args.ms ?? 1000)
        await driver.ensure()
        return driver.wait(ms)
      }
      default:
        throw new Error(`action '${action}' is not supported by the ${config.driver} driver`)
    }
  }

  const tool = {
    name: 'computer_use',
    description: [
      'Observe and operate the computer like a human user. Drives a live browser (or a desktop session when configured):',
      'take a screenshot of the current view, click at pixel coordinates, type text, press keys, scroll, and read interactive page state.',
      'Coordinate space: all x/y values are pixels of the image returned by the most recent action=screenshot call; that image is the ground truth.',
      'Workflow: screenshot → act → screenshot again to verify the result. Prefer get_state when locating elements precisely.',
      'The session is a private, isolated browser; action=close ends it.',
    ].join(' '),
    parameters: TOOL_SCHEMA,
    output: {
      schema: {},
      render(args, value) {
        return renderComputerResult(args, value)
      },
    },
    timeoutMs: 60000,
    async execute(args, execution) {
      const action = typeof args?.action === 'string' ? args.action : undefined
      if (!action || !ACTIONS.includes(action)) {
        throw new Error(`computer_use requires an action field; expected one of: ${ACTIONS.join(', ')}`)
      }
      const { key, session } = sessionFor(execution)
      try {
        return await withDriver(execution, key, session, action, args ?? {})
      } finally {
        if (action === 'close') await closeSession(key)
      }
    },
  }

  ctx.tools.register(tool)

  let order = 2000
  try {
    order = ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE')
  } catch {
    // Section placement registry of this runtime has no computer-use name; use a late default.
  }
  ctx.systemPrompt.section({ name: 'computer-use:guidance', order, text: guidance })

  const computerUse = ctx.get('computerUse')
  const releaseComputerUse = computerUse ? computerUse.register('@local/dsh-computer-use') : undefined
  ctx.on('dispose', () => {
    if (releaseComputerUse) void releaseComputerUse()
    for (const key of [...sessions.keys()]) void closeSession(key)
  })

  logger.info('computer_use plugin active (driver=%s)', config.driver)
}
