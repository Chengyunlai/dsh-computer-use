/**
 * DesktopDriver — macOS desktop Computer Use driver, backed by the native
 * Swift helper (native/macos-helper). Gives the model REAL control of the
 * system: full-screen screenshots, real mouse/keyboard events (CGEvent),
 * app/window state via the Accessibility API, and app launching.
 *
 * Coordinate space: screenshots are physical pixels (Retina 2x on this
 * MacBook); CGEvent/AX coordinates are logical points. The driver converts
 * model-side screenshot pixels -> logical points using the scale factor of
 * the most recent screenshot, so the model can click exactly what it sees.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const DEFAULT_HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'macos-helper')

function runHelper(helperPath, command, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile(helperPath, [command, JSON.stringify(args ?? {})], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        // helper printed a JSON error on stdout before exiting nonzero in most cases
        let parsed
        try { parsed = JSON.parse(stdout) } catch { /* fall through */ }
        const message = parsed?.error ?? String(error?.message ?? error)
        const code = parsed?.code ?? 'HELPER_ERROR'
        reject(Object.assign(new Error(message), { code }))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(Object.assign(new Error(`helper returned invalid JSON for ${command}`), { code: 'HELPER_PROTOCOL' }))
      }
    })
  })
}

export class DesktopDriver {
  constructor(options = {}) {
    this.helperPath = options.helperPath ?? DEFAULT_HELPER
    this.logger = options.logger
    this.scale = 2 // refreshed on every screenshot; Retina default
    this.screenW = 0
    this.screenH = 0
    this.permissionsChecked = false
  }

  async #run(command, args) {
    return runHelper(this.helperPath, command, args)
  }

  async ensure() {
    if (this.permissionsChecked) return
    const perms = await this.#run('permissions')
    const missing = []
    if (perms.accessibility !== true) missing.push('辅助功能 (Accessibility)')
    if (perms.screenRecording !== true) missing.push('屏幕录制 (Screen Recording)')
    if (missing.length > 0) {
      throw Object.assign(
        new Error(
          `macOS 桌面驱动需要系统权限：请在 系统设置 → 隐私与安全性 → ${missing.join(' 和 ')} 中添加：\n${this.helperPath}\n\n` +
          '添加后重新打开 DeepSeek Harness（部分权限需要应用重启才生效）。',
        ),
        { code: 'DESKTOP_PERMISSION_REQUIRED' },
      )
    }
    this.permissionsChecked = true
  }

  async screenshot() {
    await this.ensure()
    const shot = await this.#run('screenshot')
    const bytes = await readFile(shot.path)
    this.scale = shot.scaleFactor ?? this.scale
    this.screenW = shot.screenBounds?.width ?? 0
    this.screenH = shot.screenBounds?.height ?? 0
    return {
      bytes,
      mimeType: 'image/png',
      pixelWidth: shot.width,
      pixelHeight: shot.height,
      scaleFactor: this.scale,
      url: null,
      title: null,
    }
  }

  async getState() {
    await this.ensure()
    const windows = await this.#run('listWindows')
    let ax = { app: null, window: null, elements: [] }
    try {
      ax = await this.#run('axstate')
    } catch (error) {
      if (error.code === 'ACCESSIBILITY_REQUIRED') throw error
      // frontmost app may expose no AX window; keep window list only
    }
    const scale = this.scale
    const elements = (ax.elements ?? []).map((el) => {
      const b = el.box ?? {}
      return {
        role: el.role,
        text: el.label ?? '',
        box: {
          x: Math.round((b.x ?? 0) * scale),
          y: Math.round((b.y ?? 0) * scale),
          width: Math.round((b.width ?? 0) * scale),
          height: Math.round((b.height ?? 0) * scale),
        },
      }
    }).filter((el) => el.box.width > 0 && el.box.height > 0)
    const window = ax.window ? {
      title: ax.window.title ?? '',
      box: {
        x: Math.round((ax.window.box?.x ?? 0) * scale),
        y: Math.round((ax.window.box?.y ?? 0) * scale),
        width: Math.round((ax.window.box?.width ?? 0) * scale),
        height: Math.round((ax.window.box?.height ?? 0) * scale),
      },
    } : null
    return {
      app: ax.app,
      window,
      elements,
      windows: (windows.windows ?? []).map((w) => ({
        ownerName: w.ownerName,
        title: w.title,
        pid: w.pid,
        bounds: w.bounds,
        isOnScreen: w.isOnScreen,
      })),
    }
  }

  /** Open a URL in the default browser, or launch an application by name/bundleId. */
  async open(target, signal) {
    await this.ensure()
    signal?.throwIfAborted()
    if (/^(https?|file):\/\//i.test(target)) {
      await new Promise((resolve, reject) => {
        execFile('/usr/bin/open', [target], { timeout: 15000 }, (error) => (error ? reject(error) : resolve()))
      })
      return this.describe()
    }
    const launched = await this.#run('openapp', { query: target })
    await new Promise((resolve) => setTimeout(resolve, 900))
    return { app: launched.name ?? target, pid: launched.pid ?? null, ready: true }
  }

  async describe() {
    const front = await this.#run('axstate').catch(() => null)
    return { app: front?.app?.name ?? null, ready: true }
  }

  async click(x, y, { button = 'left', clickCount = 1, holdMs } = {}) {
    await this.ensure()
    const sx = Math.round(x / this.scale)
    const sy = Math.round(y / this.scale)
    for (let i = 0; i < clickCount; i++) {
      await this.#run('click', { x: sx, y: sy, button })
      if (i < clickCount - 1) await new Promise((r) => setTimeout(r, 120))
    }
    return { ok: true, x, y, button, clickCount }
  }

  async type(text) {
    await this.ensure()
    await this.#run('type', { text })
    return { ok: true, length: text.length }
  }

  async keypress(key) {
    await this.ensure()
    await this.#run('keypress', { key })
    return { ok: true, key }
  }

  async scroll(x, y, deltaX, deltaY) {
    await this.ensure()
    await this.#run('scroll', { x: Math.round(x / this.scale), y: Math.round(y / this.scale), deltaX, deltaY })
    return { ok: true, x, y, deltaX, deltaY }
  }

  async wait(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return { ok: true, waitedMs: ms }
  }

  async close() {
    // The helper is stateless; nothing to release.
    return { ok: true }
  }
}
