/**
 * DesktopDriver — macOS desktop Computer Use driver, backed by the native
 * Swift helper (native/macos-helper).
 *
 * Background input uses AX presses on supported controls or the exact window
 * from the last screenshot. Window-routed dispatch never uses global input;
 * callers must observe the application to verify its effect. Application
 * selection requests a background launch without restoring another app.
 * Global input uses the real pointer and foreground keyboard recipient.
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
    this.capture = null
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
    if (this.inputMode === 'background' && perms.backgroundProtocol !== 2) {
      throw Object.assign(new Error('原生 helper 版本不匹配，请在插件目录运行 bash native/build.sh 后重试'), { code: 'HELPER_REBUILD_REQUIRED' })
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
    this.capture = { pid: this.targetPid, windowId: shot.windowId, bounds: shot.screenBounds }
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
    const launched = await this.#run('openapp', { query: target, background: this.inputMode === 'background' })
    this.capture = null
    this.lastElements = []
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
      if (holdMs !== undefined || button !== 'left' || ![1, 2].includes(clickCount)) {
        throw Object.assign(new Error('后台点击仅支持左键单击或双击，不支持长按'), { code: 'BACKGROUND_UNSUPPORTED' })
      }
      const target = this.#nearestElement(x, y)
      if (target && target.source !== 'ocr' && this.targetPid) {
        for (let i = 0; i < clickCount; i++) await this.#run('axpress', { pid: this.targetPid, label: target.text })
        return { ok: true, dispatched: true, verified: false, x, y, via: 'axpress', element: target.text }
      }
      if (!this.capture?.windowId || this.capture.pid !== this.targetPid) {
        throw Object.assign(new Error('后台坐标点击需要先截取目标窗口'), { code: 'WINDOW_CAPTURE_REQUIRED' })
      }
      const result = await this.#run('click', {
        pid: this.targetPid, windowId: this.capture.windowId, bounds: this.capture.bounds,
        x: x / this.scale + this.origin.x, y: y / this.scale + this.origin.y, button, clickCount,
      })
      return { ...result, x, y }
    }

    const sx = Math.round(x / this.scale + this.origin.x)
    const sy = Math.round(y / this.scale + this.origin.y)
    for (let i = 0; i < clickCount; i++) {
      await this.#run('click', { x: sx, y: sy, button })
      if (i < clickCount - 1) await new Promise((r) => setTimeout(r, 120))
    }
    return { ok: true, x, y, via: 'cgevent', button, clickCount }
  }

  #backgroundWindow() {
    if (!this.capture?.windowId || this.capture.pid !== this.targetPid) {
      throw Object.assign(new Error('后台键盘输入需要先截取目标窗口，再点击输入框并观察'), { code: 'WINDOW_CAPTURE_REQUIRED' })
    }
    return { pid: this.targetPid, windowId: this.capture.windowId, bounds: this.capture.bounds }
  }

  #nearestElement(x, y) {
    let best = null
    let bestDist = 120 * this.scale // elements farther than this radius are ignored
    for (const el of this.lastElements) {
      if (!el.text || !['AXButton', 'AXCheckBox', 'AXRadioButton', 'AXLink', 'AXMenuItem'].includes(el.role)) continue
      if (x < el.box.x || y < el.box.y || x >= el.box.x + el.box.width || y >= el.box.y + el.box.height) continue
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
      // Prefer AX insertion; custom views use exact-window keyboard delivery
      // and remain unverified until the caller observes the result.
      const state = await this.getState()
      const focused = state.elements.find((el) => el.role === 'AXTextField' || el.role === 'AXTextArea' || el.role === 'AXSearchField')
      if (focused && this.targetPid) {
        await this.#run('axsetvalue', { pid: this.targetPid, label: focused.text, value: text }).catch(() => {
          throw Object.assign(new Error('后台模式文本输入需要目标文本框（AX setValue）；坐标键入请配置 inputMode: global'), { code: 'AX_SETVALUE_FAILED' })
        })
        return { ok: true, via: 'axsetvalue', length: text.length }
      }
      return this.#run('type', { ...this.#backgroundWindow(), text })
    }
    await this.#run('type', { text })
    return { ok: true, via: 'cgevent', length: text.length }
  }

  async keypress(key) {
    await this.ensure()
    if (this.inputMode === 'background') {
      return this.#run('keypress', { ...this.#backgroundWindow(), key })
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
