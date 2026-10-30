/**
 * DesktopDriver — macOS desktop Computer Use driver, backed by the native
 * Swift helper (native/macos-helper).
 *
 * Two input modes:
 *  - background (default): operates apps WITHOUT moving the user's real
 *    mouse or stealing keyboard focus. Reading uses the Accessibility API on
 *    the target pid; clicks use AX press actions on located elements (the
 *    helper's CGEventPostToPid also avoids the HID layer); the launched app
 *    is brought up briefly, then focus is returned to the user's app.
 *  - global: classic CGEvent injection — the real pointer moves and events go
 *    to whatever is frontmost.
 *
 * Coordinate space: screenshots are physical pixels (Retina 2x); AX boxes are
 * logical points. The driver converts model-side screenshot pixels to
 * logical points using the scale factor of the most recent screenshot.
 */
import { execFile, spawn } from 'node:child_process'
import { readFile, unlink, rmdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const DEFAULT_HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'macos-helper')

// One resident helper daemon per driver: JSON commands on stdin, JSON results
// on stdout (one line each, serial). A crashed daemon is respawned lazily;
// a timed-out call rejects and resets the pipe.
export class DaemonClient {
  constructor(helperPath, logger) {
    this.helperPath = helperPath
    this.logger = logger
    this.proc = null
    this.buffer = ''
    this.pending = []
  }

  ensure() {
    if (this.proc && !this.proc.killed) return
    const proc = spawn(this.helperPath, ['daemon'])
    this.proc = proc
    this.buffer = ''
    proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString()
      let idx
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim()
        this.buffer = this.buffer.slice(idx + 1)
        if (line) this.#resolveOne(line)
      }
    })
    proc.stderr.on('data', (chunk) => this.logger?.debug?.(`helper stderr: ${String(chunk).trim()}`))
    proc.on('exit', (code) => {
      if (this.proc !== proc) return
      this.proc = null
      const error = Object.assign(new Error(`helper daemon exited (${code})`), { code: 'HELPER_DAEMON_EXITED' })
      for (const { reject, timer } of this.pending.splice(0)) {
        clearTimeout(timer)
        reject(error)
      }
    })
    proc.on('error', (error) => {
      if (this.proc !== proc) return
      this.proc = null
      for (const { reject, timer } of this.pending.splice(0)) {
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  #resolveOne(line) {
    let parsed
    try { parsed = JSON.parse(line) } catch { parsed = null }
    const entry = this.pending.shift()
    if (!entry) return
    clearTimeout(entry.timer)
    if (parsed?.ok === false || parsed === null) {
      entry.reject(Object.assign(new Error(parsed?.error ?? 'helper returned an invalid response'), { code: parsed?.code ?? 'HELPER_PROTOCOL' }))
    } else {
      entry.resolve(parsed)
    }
  }

  call(command, args, timeoutMs = 20000) {
    this.ensure()
    const started = Date.now()
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        process.stderr.write(`[daemon] ${command} ${Date.now() - started}ms\n`)
        fn(value)
      }
      const timer = setTimeout(() => {
        const error = Object.assign(new Error(`helper daemon timed out for ${command}`), { code: 'HELPER_TIMEOUT' })
        for (const entry of this.pending.splice(0)) {
          clearTimeout(entry.timer)
          entry.reject(error)
        }
        this.close()
      }, timeoutMs)
      this.pending.push({ resolve: (v) => finish(resolve, v), reject: (e) => finish(reject, e), timer })
      this.proc.stdin.write(JSON.stringify({ cmd: command, args: args ?? {} }) + '\n')
    })
  }

  async close() {
    const proc = this.proc
    const exited = proc && proc.exitCode === null && proc.signalCode === null
      ? new Promise((resolve) => proc.once('exit', resolve)) : Promise.resolve()
    if (this.proc && !this.proc.killed) {
      try { this.proc.stdin.end() } catch { /* already closed */ }
      this.proc.kill()
    }
    this.proc = null
    for (const { reject, timer } of this.pending.splice(0)) {
      clearTimeout(timer)
      reject(Object.assign(new Error('helper daemon closed'), { code: 'HELPER_CLOSED' }))
    }
    await exited
  }
}

export class DesktopDriver {
  constructor(options = {}) {
    this.helperPath = options.helperPath ?? DEFAULT_HELPER
    this.inputMode = options.inputMode ?? 'background'
    this.logger = options.logger
    this.daemon = new DaemonClient(this.helperPath, options.logger)
    this.origin = { x: 0, y: 0 }
    this.scale = 2
    this.screenW = 0
    this.screenH = 0
    this.permissionsChecked = false
    this.targetPid = null
    this.targetName = null
    this.lastElements = []
  }

  async #run(command, args, timeoutMs) {
    return this.daemon.call(command, args, timeoutMs)
  }

  // Single-shot call. CGWindowListCopyWindowInfo hangs inside daemon child
  // processes in this remote/virtual display environment, so the window list
  // uses a direct call instead (fast and reliable).
  #runOnce(command, args, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      execFile(this.helperPath, [command, JSON.stringify(args ?? {})], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
        if (error) {
          let parsed
          try { parsed = JSON.parse(stdout) } catch { /* fall through */ }
          reject(Object.assign(new Error(parsed?.error ?? String(error?.message ?? error)), { code: parsed?.code ?? 'HELPER_ERROR' }))
          return
        }
        try {
          const value = JSON.parse(stdout)
          if (value.ok !== true) {
            reject(Object.assign(new Error(value.error ?? 'Invalid helper response'), { code: value.code ?? 'HELPER_PROTOCOL' }))
          } else {
            resolve(value)
          }
        } catch {
          reject(Object.assign(new Error(`helper returned invalid JSON for ${command}`), { code: 'HELPER_PROTOCOL' }))
        }
      })
    })
  }

  async ensure() {
    if (this.permissionsChecked) return
    const perms = await this.#run('permissions')
    if (perms.accessibility !== true) {
      throw Object.assign(
        new Error(
          `macOS 桌面驱动需要辅助功能权限：请在 系统设置 → 隐私与安全性 → 辅助功能 中添加：\n${this.helperPath}\n\n` +
          '添加后重新打开 DeepSeek Harness（部分权限需要应用重启才生效）。',
        ),
        { code: 'DESKTOP_PERMISSION_REQUIRED' },
      )
    }
    this.permissionsChecked = true
  }

  async screenshot() {
    await this.ensure()
    // Screen Recording is only required for captures; the helper reports a
    // SCREEN_RECORDING_REQUIRED error here when it is missing.
    if (!this.targetPid) throw Object.assign(new Error('先打开目标应用再截图'), { code: 'TARGET_REQUIRED' })
    const shot = await this.#runOnce('screenshot', { pid: this.targetPid })
    let bytes
    try { bytes = await readFile(shot.path) } finally {
      await unlink(shot.path)
      await rmdir(dirname(shot.path))
    }
    this.origin = shot.origin
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
      title: this.targetName,
      scope: 'window',
    }
  }

  async getState() {
    await this.ensure()
    const windows = await this.#runOnce('listWindows')
    const pid = this.targetPid ?? (await this.#run('axstate')).app?.pid
    let ax = { app: null, window: null, elements: [] }
    if (pid) {
      try {
        ax = await this.#run('axstate', { pid })
      } catch (error) {
        if (error.code === 'ACCESSIBILITY_REQUIRED') throw error
      }
    }
    const scale = this.scale
    let elements = (ax.elements ?? []).map((el) => {
      const b = el.box ?? {}
      return {
        role: el.role,
        text: el.label ?? '',
        index: el.index,
        box: {
          x: Math.round(((b.x ?? 0) - this.origin.x) * scale),
          y: Math.round(((b.y ?? 0) - this.origin.y) * scale),
          width: Math.round((b.width ?? 0) * scale),
          height: Math.round((b.height ?? 0) * scale),
        },
      }
    }).filter((el) => el.box.width > 0 && el.box.height > 0)

    this.lastElements = elements
    const window = ax.window ? {
      title: ax.window.title ?? '',
      box: {
        x: Math.round(((ax.window.box?.x ?? 0) - this.origin.x) * scale),
        y: Math.round(((ax.window.box?.y ?? 0) - this.origin.y) * scale),
        width: Math.round((ax.window.box?.width ?? 0) * scale),
        height: Math.round((ax.window.box?.height ?? 0) * scale),
      },
    } : null
    return {
      app: ax.app ?? { name: this.targetName, pid: this.targetPid },
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

  /** Open a URL in the default browser, or launch an app by name/bundleId. */
  async open(target, signal) {
    await this.ensure()
    signal?.throwIfAborted()
    if (/^(https?|file):\/\//i.test(target)) {
      await new Promise((resolve, reject) => {
        execFile('/usr/bin/open', [target], { timeout: 15000 }, (error) => (error ? reject(error) : resolve()))
      })
      return this.describe()
    }
    // Remember what the user had frontmost so background mode can hand focus back.
    const frontmost = await this.#run('axstate').catch(() => null)
    const launched = await this.#run('openapp', { query: target })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (this.inputMode === 'background' && frontmost?.app?.pid && frontmost.app.pid !== launched.pid) {
      // Hand focus back: the launched app keeps running, but the user's app
      // stays frontmost. The launched app is operated in the background via AX.
      await this.#run('activate', { pid: frontmost.app.pid })
    }
    this.targetPid = launched.pid ?? null
    this.targetName = launched.name ?? target
    return { app: this.targetName, pid: this.targetPid, ready: true }
  }

  async describe() {
    if (this.targetPid) {
      const ax = await this.#run('axstate', { pid: this.targetPid }).catch(() => null)
      return { app: ax?.app?.name ?? this.targetName, ready: true }
    }
    return { app: null, ready: true }
  }

  async click(x, y, { button = 'left', clickCount = 1, holdMs } = {}) {
    await this.ensure()
    if (this.inputMode === 'background') {
      // Prefer an AX press on the element nearest to the requested point:
      // works while the app is in the background, without moving the pointer.
      const target = this.#nearestElement(x, y)
      if (target && this.targetPid) {
        if (target.source === 'ocr') {
          // OCR-recognized text has no AX press target; click by coordinates
          // via postToPid (virtual, does not move the real pointer). Targeted
          // events reach Electron apps only while they are frontmost.
          const sx = Math.round(x / this.scale + this.origin.x)
          const sy = Math.round(y / this.scale + this.origin.y)
          await this.#run('click', { x: sx, y: sy, pid: this.targetPid })
          return { ok: true, x, y, via: 'postToPid', element: target.text, button, clickCount }
        }
        for (let i = 0; i < clickCount; i++) {
          await this.#run('axpress', { pid: this.targetPid, label: target.text })
          if (i < clickCount - 1) await new Promise((r) => setTimeout(r, 150))
        }
        return { ok: true, x, y, via: 'axpress', element: target.text, button, clickCount }
      }
      throw Object.assign(
        new Error('background 模式点击需要先 get_state 定位元素（AX press 不依赖坐标）。若必须按坐标点击，请配置 inputMode: global。'),
        { code: 'AX_TARGET_REQUIRED' },
      )
    }
    const sx = Math.round(x / this.scale + this.origin.x)
    const sy = Math.round(y / this.scale + this.origin.y)
    for (let i = 0; i < clickCount; i++) {
      await this.#run('click', { x: sx, y: sy, button })
      if (i < clickCount - 1) await new Promise((r) => setTimeout(r, 120))
    }
    return { ok: true, x, y, via: 'cgevent', button, clickCount }
  }

  #nearestElement(x, y) {
    let best = null
    let bestDist = 120 * this.scale // elements farther than this radius are ignored
    for (const el of this.lastElements) {
      const cx = el.box.x + el.box.width / 2
      const cy = el.box.y + el.box.height / 2
      const dist = Math.hypot(x - cx, y - cy)
      if (dist < bestDist) {
        bestDist = dist
        best = el
      }
    }
    return best
  }

  async type(text) {
    await this.ensure()
    if (this.inputMode === 'background') {
      // Text input to a background app is not reliable via events; use AX
      // value setting on the focused text element when available.
      const state = await this.getState()
      const focused = state.elements.find((el) => el.role === 'AXTextField' || el.role === 'AXTextArea' || el.role === 'AXSearchField')
      if (focused && this.targetPid) {
        await this.#run('axsetvalue', { pid: this.targetPid, label: focused.text, value: text }).catch(() => {
          throw Object.assign(new Error('后台模式文本输入需要目标文本框（AX setValue）；坐标键入请配置 inputMode: global'), { code: 'AX_SETVALUE_FAILED' })
        })
        return { ok: true, via: 'axsetvalue', length: text.length }
      }
      throw Object.assign(new Error('后台模式未找到可输入文本框；键入类操作请配置 inputMode: global'), { code: 'AX_TARGET_REQUIRED' })
    }
    await this.#run('type', { text })
    return { ok: true, via: 'cgevent', length: text.length }
  }

  async keypress(key) {
    await this.ensure()
    if (this.inputMode === 'background') {
      throw Object.assign(
        new Error('后台模式不支持按键组合（键盘事件需要目标在前台）；请配置 inputMode: global 或让目标应用前台'),
        { code: 'AX_KEYPRESS_UNSUPPORTED' },
      )
    }
    await this.#run('keypress', { key })
    return { ok: true, via: 'cgevent', key }
  }

  async scroll(x, y, deltaX, deltaY) {
    await this.ensure()
    if (this.inputMode === 'background') {
      throw Object.assign(
        new Error('后台模式不支持滚轮（需要目标在前台）；请配置 inputMode: global'),
        { code: 'AX_SCROLL_UNSUPPORTED' },
      )
    }
    await this.#run('scroll', { x: Math.round(x / this.scale + this.origin.x), y: Math.round(y / this.scale + this.origin.y), deltaX, deltaY })
    return { ok: true, x, y, deltaX, deltaY }
  }

  async wait(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return { ok: true, waitedMs: ms }
  }

  /** Raise the target app's window above other windows WITHOUT activating it
   *  (used by GIF demos so a background-operated window stays visible). */
  async raise() {
    if (this.targetPid) await this.#run('axraise', { pid: this.targetPid })
    return { ok: true }
  }

  async activate(pid) {
    await this.ensure()
    await this.#run('activate', { pid })
    return { ok: true }
  }

  async close() {
    await this.daemon.close()
    return { ok: true }
  }
}
