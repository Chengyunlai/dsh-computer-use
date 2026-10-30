# dsh-computer-use · Computer Use for DeepSeek Harness

[中文](README.md) · [MIT](LICENSE)

A Cordis plugin for browser and macOS desktop interaction in DeepSeek Harness. The agent observes, clicks, types and verifies through one `computer_use` tool. URLs select an isolated browser; application names select the desktop driver.

## Demos

These GIFs are scripted runs of the plugin’s own BrowserDriver in an isolated browser on public websites; no model round ran:

| Scenario | Demo |
|---|---|
| Figma website | ![Figma](docs/demos/figma.gif) |
| Wikipedia: search for the Playwright software article | ![Wikipedia](docs/demos/wikipedia-search.gif) |
| GitHub browsing | ![GitHub](docs/demos/github.gif) |

The Wikipedia GIF shows four verified states: the homepage, focused search field, entered `Playwright (software)` query, and destination article. Holds are 1, 0.5, 2 and 4 seconds for presentation, not response-latency measurements. Reproduce with `node scripts/record-demo.mjs wikipedia` after installing dependencies in the plugin directory; frames are saved under `.playwright-mcp/`.

Run `node test/driver.desktop.e2e.mjs` locally to exercise Calculator through Accessibility (`7 + 3 = 10`), verify focus and pointer position, and capture the target window. Desktop recordings are ignored by Git.

## Install

Requires DeepSeek Harness 0.2.1-rc.3 or later, Node.js and Google Chrome. Desktop support requires macOS 14 or later and Xcode Command Line Tools.

1. Run `npm install` in this plugin directory.
2. For desktop use, run `bash native/build.sh` and grant Harness/helper Accessibility and Screen Recording permissions in System Settings.
3. Install this directory through the Harness plugin manager. Dependencies of external link packages must be installed in the plugin directory.

```yaml
- id: computer-use
  name: '@local/dsh-computer-use'
  config:
    mode: auto
    browser:
      channel: chrome
      headless: false
      viewport: { width: 1280, height: 800 }
    desktop:
      inputMode: background
    screenshotDir: computer-use/screenshots
```

## Actions and limits

- `open`: URLs select the browser, application names such as `Calculator` select desktop. Use `mode: browser` or `desktop` to pin the driver.
- `screenshot`: browser viewport or selected application's largest ordinary window. Missing windows and denied permissions fail without capturing the full display.
- `get_state`: page elements or target application AX elements, plus system window information. After a desktop screenshot, coordinates are relative to that window and translated to screen coordinates by the driver.
- `click` / `type` / `keypress` / `scroll`: supported in browsers. Default desktop `background` input relies on AX controls supplied by the application; arbitrary application support is not guaranteed.
- Desktop background mode does not support general keyboard chords or scrolling. Applications without AX controls fail explicitly. `inputMode: global` uses the foreground mouse and keyboard and affects user input.
- `wait` waits; `close` closes browser and helper resources and awaits helper exit.

Launching an app can briefly activate it before restoring the previous app's focus. Background input uses Accessibility and process-targeted events. It does not inject code, create an independent desktop, or provide a universal virtual mouse.

Screenshots use Harness attachments when the model route declares image support, otherwise a local path is returned. Target windows can contain private information; treat screenshots and attachments as private data.

## Validation

```sh
node --test test/privacy.test.mjs
node test/driver.desktop.e2e.mjs
```

The first command checks missing targets, vanished windows without display fallback, and helper exit/restart. The desktop scenario requires system permissions; user pointer movement can fail the stationary-pointer assertions. The browser scenario `test/driver.e2e.mjs` needs the local fixture at `http://127.0.0.1:8734/test-page.html`.

## Data removal

Desktop screenshots and recordings are not uploaded automatically. Deleting the current file and rewriting history do not guarantee removal of cached objects. Contact GitHub Support using [GitHub's sensitive-data removal procedure](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository). Public repository visibility does not establish that historical objects or caches have been purged.

## License

MIT © Chengyunlai. See [LICENSE](LICENSE).
