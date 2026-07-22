#!/usr/bin/env node
/**
 * Launch Botmux desktop with CDP remote debugging, or attach to an existing port.
 *
 * Usage:
 *   node scripts/cdp-debug-desktop.mjs              # launch + print how to connect
 *   node scripts/cdp-debug-desktop.mjs --port 9540   # attach only, probe capabilities
 *   node scripts/cdp-debug-desktop.mjs --launch --port 9540
 *
 * Then:
 *   - Chrome: chrome://inspect → Discover network targets → 127.0.0.1:<port>
 *   - Playwright: chromium.connectOverCDP(`http://127.0.0.1:${port}`)
 *   - agent-browser: agent-browser --cdp <port> snapshot
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const portArg = process.argv.find((a, i, arr) => arr[i - 1] === '--port')
const port = Number(portArg || process.env.REMOTE_DEBUGGING_PORT || 9540)
const launch = args.has('--launch') || !args.has('--port')
const userData = process.env.BOTMUX_DEV_USER_DATA_PATH || path.join(root, '.cdp-debug-userdata')

function isPortOpen(p) {
  return fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(800) })
    .then((r) => r.ok)
    .catch(() => false)
}

async function pickFree(start = port) {
  for (let p = start; p < start + 50; p++) {
    const free = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.once('listening', () => s.close(() => resolve(true)))
      s.listen(p, '127.0.0.1')
    })
    if (free) return p
  }
  throw new Error('no free port')
}

async function probe(p) {
  const version = await fetch(`http://127.0.0.1:${p}/json/version`).then((r) => r.json())
  const targets = await fetch(`http://127.0.0.1:${p}/json`).then((r) => r.json())
  console.log(JSON.stringify({ version, targets: targets.map((t) => ({ type: t.type, title: t.title, url: t.url })) }, null, 2))
  try {
    const { chromium } = await import('@playwright/test')
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${p}`)
    const page =
      browser.contexts().flatMap((c) => c.pages()).find((pg) => /5173|index\.html/.test(pg.url())) ||
      browser.contexts()[0]?.pages()?.[0]
    if (page) {
      const caps = await page.evaluate(async () => {
        const api = window.api
        const runtime = api?.runtime?.getStatus ? await api.runtime.getStatus() : null
        const settings = api?.settings?.get ? await api.settings.get() : null
        return {
          title: document.title,
          apiTop: api ? Object.keys(api).length : 0,
          runtimeId: runtime?.runtimeId,
          graphStatus: runtime?.graphStatus,
          capabilities: runtime?.capabilities?.slice?.(0, 8),
          theme: settings?.theme,
          hasStore: Boolean(window.__store),
        }
      })
      console.log('renderer-probe:', JSON.stringify(caps, null, 2))
    }
    await browser.close().catch(() => {})
  } catch (e) {
    console.warn('playwright probe skipped:', e.message)
  }
}

if (await isPortOpen(port) && !args.has('--launch')) {
  console.log(`CDP already listening on ${port}`)
  await probe(port)
  process.exit(0)
}

if (!launch) {
  console.error(`No CDP on ${port}. Pass --launch to start desktop.`)
  process.exit(1)
}

mkdirSync(userData, { recursive: true })
const cdpPort = (await isPortOpen(port)) ? await pickFree(port + 1) : port
const env = {
  ...process.env,
  ELECTRON_ENABLE_LOGGING: '1',
  NODE_ENV: 'development',
  BOTMUX_DEV_USER_DATA_PATH: userData,
  BOTMUX_SKIP_DEV_WEB_PREPARE: '1',
  REMOTE_DEBUGGING_PORT: String(cdpPort),
  VITE_EXPOSE_STORE: 'true',
}
delete env.ELECTRON_RUN_AS_NODE

console.log(`Launching Botmux desktop with CDP on http://127.0.0.1:${cdpPort}`)
console.log(`userData: ${userData}`)
const child = spawn(process.execPath, [path.join(root, 'config/scripts/run-electron-vite-dev.mjs')], {
  cwd: root,
  env,
  stdio: 'inherit',
})
child.on('exit', (code) => process.exit(code ?? 0))

// Wait and print connection tips
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  if (await isPortOpen(cdpPort)) {
    console.log(`\n=== CDP ready: http://127.0.0.1:${cdpPort} ===`)
    console.log(`Chrome: chrome://inspect → 127.0.0.1:${cdpPort}`)
    console.log(`Playwright: await chromium.connectOverCDP('http://127.0.0.1:${cdpPort}')`)
    console.log(`agent-browser --cdp ${cdpPort} snapshot`)
    console.log(`Probe only: node scripts/cdp-debug-desktop.mjs --port ${cdpPort}`)
    await probe(cdpPort)
    break
  }
}
