/**
 * BaseComputerDriver — the uniform interface every driver implements.
 *
 * `open`/`describe` are browser-specific conveniences; desktop drivers
 * implement them as app-launch / window-list equivalents.
 */
export class BaseComputerDriver {
  /** Start the underlying session (browser launch / desktop connection). */
  async ensure() {}

  /** Capture the current viewport/app window. Returns { bytes, mimeType, pixelWidth, pixelHeight, url, title }. */
  async screenshot() { throw new Error('not implemented') }

  /** Structured, accessibility-like snapshot of the current surface. */
  async getState() { throw new Error('not implemented') }

  /** Navigate (browser) or open a document/app (desktop). */
  async open(target, signal) { throw new Error('not implemented') }

  /** Describe the current surface: { url, title, ready }. */
  async describe() { throw new Error('not implemented') }

  /** Click at screenshot pixels. options: { button, clickCount, holdMs }. */
  async click(x, y, options) { throw new Error('not implemented') }

  /** Type text into the focused element. */
  async type(text) { throw new Error('not implemented') }

  /** Press a key or chord, e.g. "Enter", "Control+A". */
  async keypress(key) { throw new Error('not implemented') }

  /** Move the pointer to (x, y) and wheel by (deltaX, deltaY). */
  async scroll(x, y, deltaX, deltaY) { throw new Error('not implemented') }

  /** Wait for the surface to settle. */
  async wait(ms) { throw new Error('not implemented') }

  /** End the session and release every resource. */
  async close() { throw new Error('not implemented') }
}
