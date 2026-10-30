/**
 * Screenshot pipeline: capture bytes from the driver, persist a user-visible
 * PNG copy in the workspace, then — when the calling model route declares
 * image input — admit the screenshot into the durable attachment store and
 * project it to the route's request size (mirroring the official dsh-cua
 * flow). Text-only models fall back to the saved file path so the loop keeps
 * working through the agent's file/read tools.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

async function persistCopy(bytes, screenshotDir, agent, ctx) {
  const workingDirectory = ctx.get('workingDirectory')
  let base = process.cwd()
  if (agent && workingDirectory) {
    try {
      base = await workingDirectory.ensure(agent)
    } catch {
      // fall back to the harness working directory
    }
  }
  const absoluteDir = join(base, screenshotDir)
  await mkdir(absoluteDir, { recursive: true })
  const name = `computer-use-${Date.now()}.png`
  await writeFile(join(absoluteDir, name), bytes)
  return join(screenshotDir, name)
}

function routeOf(agent) {
  try {
    const routed = agent?.session?.requestHeader?.()?.config
    if (routed?.provider && routed?.model) return { provider: routed.provider, model: routed.model }
  } catch {
    // request header not available in this runtime; fall through to options
  }
  if (agent?.options?.provider && agent?.options?.model) {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  return undefined
}

export async function captureScreenshot(ctx, execution, driver, screenshotDir = 'computer-use/screenshots') {
  const shot = await driver.screenshot()
  execution.signal?.throwIfAborted()

  const metadata = {
    coordinateSpace: 'screenshot-pixels',
    mimeType: shot.mimeType,
    pixelWidth: shot.pixelWidth,
    pixelHeight: shot.pixelHeight,
    url: shot.url ?? null,
    title: shot.title ?? null,
  }
  const filePath = await persistCopy(shot.bytes, screenshotDir, execution.agent, ctx)

  const agent = execution.agent
  const attachments = ctx.get('attachments')
  const llm = ctx.get('llm')
  const route = agent ? routeOf(agent) : undefined
  if (attachments && llm && route) {
    try {
      const info = await llm.resolveModelInfo(route.provider, route.model, execution.signal)
      if (info?.inputModalities?.includes('image')) {
        const refs = await attachments.saveImages([
          { data: shot.bytes, mediaType: shot.mimeType, name: `computer-use-${Date.now()}.png` },
        ])
        const attachment = refs[0]
        const target = llm.imageRequestTarget(route.provider, route.model, attachment)
        await attachments.readImageRequest(attachment, target, execution.signal)
        return { ...metadata, mode: 'image', filePath, attachment }
      }
    } catch (error) {
      // admission failure is not fatal: the saved PNG path still serves the loop
      ctx.logger?.debug?.(`screenshot image admission skipped: ${String(error)}`)
    }
  }
  return { ...metadata, mode: 'file', filePath }
}

export function renderComputerResult(args, value) {
  if (args?.action !== 'screenshot') return [{ type: 'text', text: JSON.stringify(value) }]
  const { attachment, ...metadata } = value ?? {}
  const blocks = [{ type: 'text', text: JSON.stringify(metadata) }]
  if (attachment) blocks.push({ type: 'image', attachment })
  return blocks
}
