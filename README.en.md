# dsh-computer-use-plugin

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Playwright](https://img.shields.io/badge/driver-Playwright-2f9e44)](drivers/browser.js)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.3%2B-4b6bfe)](https://github.com/deepseek-ai/deepseek-harness)

**Computer Use for DeepSeek Harness — let agents observe and operate a real browser like a human.**

A Cordis plugin that gives DeepSeek Harness agents a `computer_use` tool: capture the current view, click at pixel coordinates, type text, press keys, scroll, and read interactive page state. The agent drives the full **observe → reason → act → verify** loop on its own — no PyAutoGUI, no pre-scripted coordinates.

## Live demos

GIFs of three real-world scenarios, all recorded by the plugin's own driver (the same `BrowserDriver` behind `computer_use`). Reproduce them with `scripts/record-demo.mjs`.

| Scenario | Demo | Actions used |
|---|---|---|
| **Browse & interact** · figma.com | ![figma.com demo](docs/demos/figma.gif) | `open` → `screenshot` → `get_state` to locate → `click` to dismiss the cookie banner → `scroll` |
| **Search & type** · Wikipedia | ![Wikipedia demo](docs/demos/wikipedia.gif) | `click` the search box → `type` "Playwright" → `keypress` Enter → straight to the article |
| **Multi-step repo browsing** · deepseek-harness | ![GitHub demo](docs/demos/github.gif) | `click` into the `packages` folder → `click` to open `README.md` → `scroll` |

## macOS desktop driver (real mouse · system understanding)

Besides the browser, `computer_use` can drive the macOS desktop in **desktop** mode: full-screen captures, app/window/element state via the Accessibility API, and launching/activating apps. **Background mode by default**: the target app is operated through AX actions — your real mouse never moves and keyboard focus is not stolen (switch with `inputMode: global` to real CGEvent input).

**Desktop demo**: operating the Calculator in the background (`7 + 3 =`) with the real mouse untouched and focus never stolen — verified end to end by `test/driver.desktop.e2e.mjs` (ALL PASS). Note: desktop operation captures the full screen, so for privacy this repo intentionally ships **no desktop demo GIF**; record your own with `scripts/record-demo-desktop.mjs` on a clean screen.

Implementation: a native Swift helper (`native/macos-helper.swift`); build with:

```bash
./native/build.sh   # requires Xcode Command Line Tools
```

### System permissions (one-time)

The helper needs two permissions in **System Settings → Privacy & Security**:

| Permission | Purpose | Grant to |
|---|---|---|
| Accessibility | mouse/keyboard events, AX element reads | tick **DeepSeek Harness**, or add the helper path |
| Screen Recording | ScreenCaptureKit captures | same |

To add the helper path: click **"+"** in the list, press `Cmd+Shift+G` in the file picker, enter `<repo>/native/macos-helper`, open. Reopen DeepSeek Harness afterwards (some permissions need an app restart).

### Config & action semantics

```yaml
- id: computer-use
  config:
    mode: auto               # default: URL -> browser driver, app name -> desktop driver; actions follow the active surface
    desktop:
      helperPath: null       # defaults to native/macos-helper in the repo
      inputMode: background  # background (default; no real mouse movement, no focus steal) | global (real CGEvent mouse)
```

In desktop mode the `computer_use` actions are:

- `open`: `http(s)://` opens in the default browser; otherwise launches and **activates** an app by name / bundleId (e.g. `Calculator`)
- `screenshot`: full-screen capture (physical pixels); coordinates are screenshot pixels, Retina scaling is handled by the driver
- `get_state`: frontmost app, window, interactive elements (role / label / box) plus the system window list
- `click` / `type` / `keypress` / `scroll`: real system events

## What it does

The model does **not** control the mouse directly. It emits structured actions (`click`, `type`, `keypress`, `scroll`, …); the plugin's **Computer Driver** turns them into real browser events, then returns a fresh screenshot so the model can verify and continue.

This maps onto the classic Computer Use architecture — and the plugin is deliberately only the bottom half:

| Layer | Who provides it |
|---|---|
| L1 Agent / LLM (planning, error recovery) | **DeepSeek Harness agent loop** |
| L2 Computer Use Tool (`computer_use`, actions, permission) | **this plugin** |
| L3 Computer Driver (screenshot, mouse, keyboard, state) | **this plugin** (`drivers/`) |
| L4 OS / Application | Chromium via Playwright |

## Features

- **One `computer_use` tool** with OpenAI-computer-call-style actions: `open`, `screenshot`, `get_state`, `click`, `type`, `keypress`, `scroll`, `wait`, `close`.
- **Screenshot-first observation.** Coordinates are pixels of the last screenshot image (top-left origin) — the image is the ground truth.
- **Hybrid perception** (vision + structure): `get_state` returns an accessibility-style snapshot of interactive elements with their on-screen boxes, so the model can locate targets precisely instead of guessing coordinates.
- **Attachment-pipeline screenshots.** When the calling model route declares image input, screenshots enter DSH's durable attachment store and are projected to the route's request size (same flow as the official `dsh-cua`). Text-only models get a graceful file fallback.
- **Isolated sessions.** One private Chromium session per agent, reusing the installed Google Chrome (no browser download).
- **Desktop extension point.** `drivers/desktop.js` defines the macOS driver contract (Accessibility + ScreenCaptureKit) — native desktop apps (e.g. the Figma desktop app) are operated through that driver, while the Figma **web** app already works today.

## Install

Prerequisites: DeepSeek Harness desktop **0.2.1-rc.3+**, Google Chrome installed, Node.js 20+.

```bash
# 1. install the runtime dependencies (linked bundles do not install transitive deps into the profile)
npm install

# 2. install the bundle into your profile via the Plugin Manager (or the plugin_manager tool)
#    target: the absolute path of this repository directory
```

The plugin row `computer-use` activates with `driver: browser` by default. Example profile patch:

```yaml
- id: computer-use
  name: '@local/dsh-computer-use'
  config:
    mode: auto               # auto (default; URL -> browser, app name -> desktop, switch freely) | browser | desktop
    browser:
      channel: chrome        # reuse system Chrome; or set executablePath / headless
      headless: false
      viewport: { width: 1280, height: 800 }
      blockExternal: false   # true = abort cross-origin requests
    desktop:
      inputMode: background  # background (default; no real mouse movement, no focus steal) | global
    screenshotDir: computer-use/screenshots
```

## Usage

Tell any agent something like:

> 打开 https://www.figma.com ，关掉 Cookie 横幅，往下滚动看看这个页面。

The agent will open the browser, screenshot, locate elements, act, and verify — a Chrome window appears on your screen while it works.

### Actions

| Action | Purpose | Key parameters |
|---|---|---|
| `open` | open the browser and navigate | `url` (http/https/file/data) |
| `screenshot` | capture the viewport; returns image + metadata | — |
| `get_state` | url/title + interactive elements with boxes | — |
| `click` | click at screenshot pixels | `x`, `y`, `button`, `clickCount`, `holdMs` |
| `type` | type into the focused element | `text` |
| `keypress` | key or chord | `key` (e.g. `Control+A`) |
| `scroll` | wheel at a position | `x`, `y`, `deltaX`, `deltaY` |
| `wait` | let the page settle | `ms` |
| `close` | end the session | — |

**Working rules** (also injected as a prompt section): after `open` or any action, take a fresh screenshot before the next action; prefer `get_state` when locating a target precisely; verify every action with a new screenshot; handle dialogs by clicking their buttons or pressing Escape.

## How it works

```
screenshot ──► image content block / saved PNG + metadata
      │
      ▼
 model reasons ──► computer_use({ action: 'click', x, y }) ──► driver.click()
      ▲                                                                │
      └──────────── fresh screenshot ◄── driver returns state ◄────────┘
```

The screenshot pipeline mirrors the official `dsh-cua` implementation: `attachments.saveImages()` → `llm.imageRequestTarget()` → `attachments.readImageRequest()` → `{ type: 'image', attachment }` content block. If the model route does not declare image input, the PNG is saved to the workspace and its path returned instead, so the loop works on text-only models too.

```
computer-use/
├── index.js              # Host plugin: Config, tool registration, per-agent sessions, action dispatch
├── drivers/
│   ├── base.js           # BaseComputerDriver interface
│   ├── browser.js        # Playwright driver (isolated Chromium session)
│   └── desktop.js        # macOS desktop extension point (roadmap)
├── lib/
│   ├── screenshot.js     # attachment admission + route projection + file fallback
│   └── guidance.js       # model-facing usage rules (prompt section)
├── scripts/record-demo.mjs  # script that recorded the GIFs above
├── test/driver.e2e.mjs   # standalone end-to-end test (plain Node, no harness needed)
└── test-page.html        # local demo page (used by the e2e test)
```

## Verification

Honest status, verified on 2026-10-30 against DeepSeek Harness 0.2.1-rc.3:

- **Standalone e2e** (`test/driver.e2e.mjs`): open / screenshot (1280×800 PNG) / get_state (lossless JSON) / click-to-expand / type / click-to-save / status flip + input value readback / keypress / scroll — **all pass** on the local demo page (`test-page.html`).
- **In-harness loop**: the lead agent actually called `computer_use` end to end — opened the demo page, screenshot, `get_state` → element boxes, clicked *查看任务详情*, typed `hello computer use`, clicked *保存备注*, and verified via a second `get_state` that the status flipped to *任务状态：已经完成* and the input kept the typed text.
- **Real-world operation**: the same tool drove figma.com (open, click *Allow all cookies* to dismiss the banner, scroll) plus multi-step Wikipedia / GitHub runs — the GIFs above are those recordings.
- **Desktop driver e2e (background mode)** (`test/driver.desktop.e2e.mjs`): launch Calculator and hand focus back → read buttons via background AX → **AX press clicks** on `7 / + / 3 / =` → Calculator shows `10` — **all passed**; **focus is never stolen** (the user's frontmost app stays frontmost) and the **real mouse never moves** (verified before/after every click).
- **Known limitation**: with a text-only model route (e.g. `deepseek-v4-flash` without image input declared), screenshots fall back to file paths; switch to an image-capable model to receive inline image content blocks. Desktop captures additionally require the Screen Recording permission.

## Roadmap

- **Desktop driver deepening** — the macOS MVP is done (real mouse/keyboard + AX system understanding). Remaining: **per-application event routing without stealing global focus**, **multi-agent window concurrency** (one window context per agent), and Windows support. The official DSH `packages/experimental/cua` (native helper + permission UI) can compose with this plugin once it ships.
- **Approval guards** for high-risk actions (delete / pay / send) via `ctx.tools.guard()`.

## Related

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the harness this plugin extends
- [Computer Use API & Integration recipes](https://developers.openai.com/api/docs/guides/tools-computer-use) — the OpenAI computer-tool conventions this plugin follows
- Upstream CUA design: `packages/experimental/cua` in the deepseek-harness repository

## License

MIT © [Chengyunlai](https://github.com/Chengyunlai) — see [LICENSE](LICENSE).
