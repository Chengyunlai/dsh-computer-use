# dsh-computer-use-plugin

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Playwright](https://img.shields.io/badge/driver-Playwright-2f9e44)](drivers/browser.js)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.3%2B-4b6bfe)](https://github.com/deepseek-ai/deepseek-harness)
**为 DeepSeek Harness 打造的 Computer Use 插件——让 Agent 像人一样观察并操作真实浏览器。**

一个 Cordis 插件，为 DeepSeek Harness 的 Agent 提供 `computer_use` 工具：截取当前视图、按像素坐标点击、输入文本、按键、滚动、读取可交互页面状态。Agent 自主完成 **观察 → 决策 → 操作 → 验证** 的完整闭环——不需要 PyAutoGUI，也不需要预先写死的坐标。

## 现场演示

三个真实场景的 GIF，全部由插件自身的驱动（`computer_use` 背后的同一套 `BrowserDriver`）录制，可复现：`scripts/record-demo.mjs`。

| 场景 | 演示 | 用到的动作 |
|---|---|---|
| **浏览官网并交互** · figma.com | ![figma.com 演示](docs/demos/figma.gif) | `open` → `screenshot` → `get_state` 定位 → `click` 关闭 Cookie 横幅 → `scroll` |
| **搜索并输入** · Wikipedia | ![Wikipedia 演示](docs/demos/wikipedia.gif) | `click` 搜索框 → `type` "Playwright" → `keypress` Enter → 直达词条 |
| **仓库多步浏览** · deepseek-harness | ![GitHub 演示](docs/demos/github.gif) | `click` 进入 `packages` 目录 → `click` 打开 `README.md` → `scroll` |

## macOS 桌面驱动（真实鼠标 · 系统理解）

除了浏览器，`computer_use` 还能以 **desktop** 模式驱动 macOS 桌面：整屏截图、通过辅助功能 API 读取**应用/窗口/元素状态**、启动并激活应用。**默认后台模式**：用 AX 动作操作目标应用，**不移动你的真实鼠标、不抢键盘焦点**（可选 `inputMode: global` 切换为真实 CGEvent 鼠标）。演示（后台操作计算器，`7 + 3 =`，全程真实鼠标不动）：

![桌面演示](docs/demos/desktop-calculator.gif)

实现：原生 Swift helper（`native/macos-helper.swift`），编译：

```bash
./native/build.sh   # 需要 Xcode Command Line Tools
```

### 系统权限（一次性）

helper 需要两项系统权限，在 **系统设置 → 隐私与安全性** 中授予：

| 权限 | 作用 | 授予对象 |
|---|---|---|
| 辅助功能 (Accessibility) | 鼠标/键盘事件、AX 元素读取 | 勾选 **DeepSeek Harness**，或添加 helper 路径 |
| 屏幕录制 (Screen Recording) | ScreenCaptureKit 截图 | 同上 |

添加 helper 路径：列表左下角 **"+"** → 文件选择器按 `Cmd+Shift+G` → 输入 `<仓库>/native/macos-helper` → 打开。授权后重新打开 DeepSeek Harness（部分权限需应用重启生效）。

### 配置与动作语义

```yaml
- id: computer-use
  config:
    mode: auto               # 默认：URL→浏览器驱动，应用名→桌面驱动，观察/操作跟随当前面
    desktop:
      helperPath: null       # 默认用仓库内 native/macos-helper
      inputMode: background  # background（默认，不移动真实鼠标/不抢焦点）| global（真实 CGEvent 鼠标）
```

desktop 模式下 `computer_use` 的动作：

- `open`：`http(s)://` 用默认浏览器打开；否则按名称 / bundleId 启动并**激活**应用（如 `Calculator`）
- `screenshot`：整屏截图（物理像素）；坐标空间 = 截图像素，Retina 缩放由驱动自动换算
- `get_state`：前台应用、窗口、可交互元素（role / label / 框坐标）+ 系统窗口列表
- `click` / `type` / `keypress` / `scroll`：真实系统事件

## 它做什么

模型**不直接控制鼠标**。它输出结构化动作（`click`、`type`、`keypress`、`scroll`…），由插件的 **Computer Driver** 转成真实浏览器事件，再返回新截图供模型验证并继续。

对应经典的 Computer Use 四层架构，本插件刻意只做下半部分：

| 层级 | 由谁提供 |
|---|---|
| L1 Agent / LLM（规划、错误恢复） | **DeepSeek Harness 的 Agent 循环** |
| L2 Computer Use Tool（`computer_use`、动作、权限） | **本插件** |
| L3 Computer Driver（截图、鼠标、键盘、状态） | **本插件**（`drivers/`） |
| L4 OS / 应用 | 经 Playwright 驱动的 Chromium |

## 特性

- **单一 `computer_use` 工具**，OpenAI computer-call 风格动作：`open`、`screenshot`、`get_state`、`click`、`type`、`keypress`、`scroll`、`wait`、`close`。
- **截图优先的观察**。坐标为最近一次截图图像的像素（左上角原点）——图像即事实。
- **混合感知**（视觉 + 结构）：`get_state` 返回可交互元素的辅助功能风格快照及屏幕框坐标，模型可以精确定位目标，而不是猜坐标。
- **附件管线截图**：当调用模型路由声明 image 输入时，截图进入 DSH 持久化附件库并按路由尺寸投影（与官方 `dsh-cua` 同一流程）；文本模型自动回退为文件路径。
- **会话隔离**：每个 Agent 一个私有 Chromium 会话，复用已安装的 Google Chrome（无需下载浏览器）。
- **桌面扩展点**：`drivers/desktop.js` 定义了 macOS 驱动契约（Accessibility + ScreenCaptureKit）——本地桌面应用（如 Figma 桌面版）将通过该驱动操作，而 Figma **网页版**现在就能用。

## 安装

前置条件：DeepSeek Harness 桌面版 **0.2.1-rc.3+**、已安装 Google Chrome、Node.js 20+。

```bash
# 1. 安装运行时依赖（profile 对外部 link 包不装传递依赖，需在仓库根目录安装）
npm install

# 2. 通过插件管理器（或 plugin_manager 工具）把本仓库目录作为 bundle 安装进 profile
```

插件行 `computer-use` 默认以 `driver: browser` 激活。示例 profile 配置：

```yaml
- id: computer-use
  name: '@local/dsh-computer-use'
  config:
    mode: auto               # auto（默认，URL→浏览器、应用名→桌面，自由切换）| browser | desktop
    browser:
      channel: chrome        # 复用系统 Chrome；也可指定 executablePath / headless
      headless: false
      viewport: { width: 1280, height: 800 }
      blockExternal: false   # true = 中断跨源请求
    desktop:
      inputMode: background  # background（默认，不移动真实鼠标/不抢焦点）| global
    screenshotDir: computer-use/screenshots
```

## 使用

对任意 Agent 说类似的话：

> 打开 https://www.figma.com ，关掉 Cookie 横幅，往下滚动看看这个页面。

Agent 会自己打开浏览器、截图、定位元素、操作并验证——操作时你屏幕上会弹出一个 Chrome 窗口。

### 动作表

| 动作 | 作用 | 关键参数 |
|---|---|---|
| `open` | 打开浏览器并导航 | `url`（http/https/file/data） |
| `screenshot` | 截取视口，返回图像 + 元数据 | — |
| `get_state` | url/标题 + 带框坐标的可交互元素 | — |
| `click` | 按截图像素点击 | `x`、`y`、`button`、`clickCount`、`holdMs` |
| `type` | 向焦点元素输入 | `text` |
| `keypress` | 按键或组合键 | `key`（如 `Control+A`） |
| `scroll` | 在指定位置滚轮 | `x`、`y`、`deltaX`、`deltaY` |
| `wait` | 等待页面稳定 | `ms` |
| `close` | 结束会话 | — |

**使用规则**（同时以 prompt section 注入）：`open` 或任何操作后先重新截图再行动；精确定位优先用 `get_state`；每个动作都要用新截图验证；弹窗用点击按钮或按 Escape 处理。

## 工作原理

```
screenshot ──► 图像内容块 / 保存的 PNG + 元数据
      │
      ▼
 模型决策 ──► computer_use({ action: 'click', x, y }) ──► driver.click()
      ▲                                                          │
      └──────────── 新截图 ◄── driver 返回状态 ◄─────────────────┘
```

截图管线复刻官方 `dsh-cua` 实现：`attachments.saveImages()` → `llm.imageRequestTarget()` → `attachments.readImageRequest()` → `{ type: 'image', attachment }` 内容块。若模型路由未声明 image 输入，则把 PNG 存到工作区并返回路径，保证文本模型也能跑通闭环。

```
computer-use/
├── index.js              # Host 插件：Config、工具注册、按 Agent 会话管理、动作分发
├── drivers/
│   ├── base.js           # BaseComputerDriver 接口
│   ├── browser.js        # Playwright 驱动（隔离 Chromium 会话）
│   └── desktop.js        # macOS 桌面扩展点（Roadmap）
├── lib/
│   ├── screenshot.js     # 附件接入 + 路由投影 + 文件回退
│   └── guidance.js       # 模型侧使用规则（prompt section）
├── scripts/record-demo.mjs  # 录制上方 GIF 的复现脚本
├── test/driver.e2e.mjs   # 独立端到端测试（纯 Node，无需 Harness）
└── test-page.html        # 本地演示页（e2e 使用）
```

## 验证

如实说明，2026-10-30 在 DeepSeek Harness 0.2.1-rc.3 上验证：

- **独立 e2e**（`test/driver.e2e.mjs`）：open / screenshot（1280×800 PNG）/ get_state（无损 JSON）/ 点击展开 / 输入 / 点击保存 / 状态翻转 + 输入值回读 / keypress / scroll —— 在本地演示页（`test-page.html`）上**全部通过**。
- **Harness 内闭环**：lead agent 实际调用 `computer_use` 全流程——打开演示页、截图、`get_state` 拿元素框坐标、点击"查看任务详情"、输入 `hello computer use`、点击"保存备注"，再用第二次 `get_state` 确认状态翻转为"任务状态：已经完成"且输入框保留文本。
- **真实站点操作**：同一套工具驱动了 figma.com（打开、点击 *Allow all cookies* 关横幅、滚动）与 Wikipedia / GitHub 的多步操作，上方 GIF 即来自这些录制。
- **桌面驱动 e2e（后台模式）**（`test/driver.desktop.e2e.mjs`）：启动计算器并归还焦点 → 后台 AX 读取按钮 → **AX press 点击** `7 / 加 / 3 / 等于` → 计算器显示 `10` —— **全部通过**；全程**焦点不被抢**（用户前台应用不变）、**真实鼠标不动**（逐次点击前后对比）。
- **已知限制**：文本模型路由（如未声明 image 输入的 `deepseek-v4-flash`）下截图回退为文件路径；换成图像模型即可收到内联图像内容块。桌面截图需要屏幕录制权限。

## Roadmap

- **桌面驱动深化** —— macOS MVP 已完成（真实鼠标/键盘 + AX 系统理解）。剩余：**不抢占全局焦点的按应用事件路由**、**多 Agent 窗口并发**（每个 Agent 一个独立窗口上下文）、Windows 支持。官方 DSH 的 `packages/experimental/cua`（原生 helper + 权限 UI）发布后可与本插件组合。
- **高风险操作审批**（删除/付款/发送）—— 通过 `ctx.tools.guard()` 接入。

## 相关

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 本插件所扩展的 Harness
- [Computer Use API & Integration recipes](https://developers.openai.com/api/docs/guides/tools-computer-use) —— 本插件遵循的 OpenAI computer-tool 约定
- 上游 CUA 设计：deepseek-harness 仓库中的 `packages/experimental/cua`

## License

MIT © [Chengyunlai](https://github.com/Chengyunlai) —— 见 [LICENSE](LICENSE)。
