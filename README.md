# dsh-computer-use-plugin

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Playwright](https://img.shields.io/badge/driver-Playwright-2f9e44)](drivers/browser.js)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.3%2B-4b6bfe)](https://github.com/deepseek-ai/deepseek-harness)

**Computer Use for DeepSeek Harness — let agents observe and operate a real browser like a human.**

A Cordis plugin that gives DeepSeek Harness agents a `computer_use` tool: take a screenshot of the current view, click at pixel coordinates, type text, press keys, scroll, and read the interactive page state. The agent drives the full **observe → reason → act → verify** loop on its own — no PyAutoGUI, no pre-scripted coordinates.

| Initial page | Expanded & typed | Saved result |
|---|---|---|
| ![initial](docs/screenshots/e2e-1-initial.png) | ![expanded](docs/screenshots/e2e-2-expanded.png) | ![saved](docs/screenshots/e2e-3-saved.png) |

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
- **Hybrid perception** (vision + structure, as the classic design suggests): `get_state` returns an accessibility-style snapshot of interactive elements with their on-screen boxes, so the model can locate targets precisely instead of guessing coordinates.
- **Attachment-pipeline screenshots.** When the calling model route declares image input, screenshots enter DSH's durable attachment store and are projected to the route's request size (same flow as the official `dsh-cua`). Text-only models get a graceful file fallback.
- **Isolated sessions.** One private Chromium session per agent, reusing the installed Google Chrome (no browser download).
- **Desktop extension point.** `drivers/desktop.js` defines the macOS driver contract (Accessibility + ScreenCaptureKit) as the next step — see [Roadmap](#roadmap).

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
    driver: browser
    browser:
      channel: chrome        # reuse system Chrome; or set executablePath / headless
      headless: false
      viewport: { width: 1280, height: 800 }
      blockExternal: false   # true = abort cross-origin requests
    screenshotDir: computer-use/screenshots
```

## Usage

Tell any agent something like:

> 打开 http://127.0.0.1:8734/test-page.html ，看看这个页面，点击"查看任务详情"，输入一条备注，然后保存。

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
├── test/driver.e2e.mjs   # standalone end-to-end test (plain Node, no harness needed)
└── test-page.html        # local demo page served for manual trials
```

## Verification

Honest status, verified on 2026-10-30 against DeepSeek Harness 0.2.1-rc.3:

- **Standalone e2e** (`test/driver.e2e.mjs`): open / screenshot (1280×800 PNG) / get_state (lossless JSON) / click-to-expand / type / click-to-save / status flip + input value readback / keypress / scroll — **all pass**.
- **In-harness loop**: the lead agent actually called `computer_use` end to end — opened the demo page, screenshot, `get_state` → element boxes, clicked *查看任务详情*, typed `hello computer use`, clicked *保存备注*, and verified via a second `get_state` that the status flipped to *任务状态：已经完成* and the input kept the typed text.
- **Known limitation**: with a text-only model route (e.g. `deepseek-v4-flash` without image input declared), screenshots fall back to file paths; switch to an image-capable model to receive inline image content blocks.

The demo server in the screenshots is a throwaway (`python3 -m http.server` serving `test-page.html`) — it is not part of the plugin.

## Roadmap

- **macOS desktop driver** — the interesting part of real Computer Use. Needs Accessibility API (`AXUIElement`) snapshots with element indices, ScreenCaptureKit/CGWindowList capture, and per-application event routing so agents operate apps without stealing global focus. The official DSH project is building this as `packages/experimental/cua` (native helper + permission UI) — not published to npm yet; when it ships, this plugin's browser driver composes alongside it.
- **Approval guards** for high-risk actions (delete / pay / send) via `ctx.tools.guard()`.
- **Multi-agent window concurrency** — one isolated browser per agent already; window-level isolation is the desktop-driver milestone.

## Related

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the harness this plugin extends
- [Computer Use API & Integration recipes](https://developers.openai.com/api/docs/guides/tools-computer-use) — the OpenAI computer-tool conventions this plugin follows
- Upstream CUA design: `packages/experimental/cua` in the deepseek-harness repository

## License

MIT © [Chengyunlai](https://github.com/Chengyunlai) — see [LICENSE](LICENSE).
