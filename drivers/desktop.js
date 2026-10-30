/**
 * DesktopDriver — macOS desktop extension point.
 *
 * NOT IMPLEMENTED in v0.1. This class defines the shape a native desktop
 * driver must fill, mirroring the article's drivers/macos.py direction:
 *
 *   - screenshot: ScreenCaptureKit (or CGWindowList) viewport capture.
 *   - getState:  Accessibility API (AXUIElement) tree snapshot with
 *                element indices + bounding boxes, so actions can target
 *                elements instead of guessing coordinates.
 *   - click/type/keypress/scroll: post synthetic events to the target
 *                application without stealing global focus (per-application
 *                event routing, e.g. AXUIElementPerformAction + CGEvent
 *                with explicit process targeting).
 *   - open/describe: NSWorkspace app launch and window enumeration.
 *
 * The official DSH project implements exactly this as `@deepseek-ai/dsh-cua`
 * + a native macOS helper (packages/experimental/cua in the deepseek-harness
 * repository); it is not published to npm yet, so v0.1 keeps this stub and
 * documents the extension contract instead of shipping a half-working native
 * bridge. Configure `driver: browser` for the working implementation.
 */
import { BaseComputerDriver } from './base.js'

export class DesktopDriver extends BaseComputerDriver {
  constructor(options = {}) {
    super()
    this.helperPath = options.helperPath
    this.logger = options.logger
  }

  #unsupported() {
    throw new Error(
      'The desktop driver is not implemented in @local/dsh-computer-use v0.1. ' +
      'Switch the plugin config to `driver: browser`, or implement DesktopDriver ' +
      '(see drivers/desktop.js for the macOS Accessibility/ScreenCaptureKit extension contract).',
    )
  }

  async ensure() { this.#unsupported() }
  async screenshot() { this.#unsupported() }
  async getState() { this.#unsupported() }
  async open() { this.#unsupported() }
  async describe() { this.#unsupported() }
  async click() { this.#unsupported() }
  async type() { this.#unsupported() }
  async keypress() { this.#unsupported() }
  async scroll() { this.#unsupported() }
  async wait() { this.#unsupported() }
  async close() { this.#unsupported() }
}
