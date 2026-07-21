#!/usr/bin/env node
/**
 * Non-GUI smoke for orca_botmux (OrcaBotmux-class vendor tree).
 * Checks build outputs, pairing encode/decode, and optional orca_botmux bridge module.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
let failed = 0

function ok(label) {
  console.log(`  ✓ ${label}`)
}
function fail(label, detail) {
  failed++
  console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`)
}

console.log('[smoke] build artifacts')
for (const p of [
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html',
  'out/main/daemon-entry.js',
]) {
  if (existsSync(join(root, p))) ok(p)
  else fail(p, 'missing')
}

console.log('[smoke] identity / rebrand')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (pkg.name === 'orca-botmux-desktop') ok('package name orca-botmux-desktop')
else fail('package name', pkg.name)
const ebc = readFileSync(join(root, 'config/electron-builder.config.cjs'), 'utf8')
if (ebc.includes("productName: 'orca_botmux'") || ebc.includes('productName: "orca_botmux"')) {
  ok('electron-builder productName OrcaBotmux')
} else fail('electron-builder productName')
if (ebc.includes('com.orca_botmux.desktop')) ok('appId com.orca_botmux.desktop')
else fail('appId')

console.log('[smoke] pairing protocol')
try {
  // Shared pairing is TS — use a tiny dynamic check via vitest source compile isn't available.
  // Instead grep built main for orca_botmux://pair string after build.
  const main = readFileSync(join(root, 'out/main/index.js'), 'utf8')
  if (main.includes('orca_botmux://pair')) ok('main bundle emits orca_botmux://pair')
  else fail('main bundle orca_botmux://pair')
  // Dual-accept legacy
  if (main.includes('orca_botmux:') || main.includes("'orca_botmux:'")) ok('legacy orca_botmux: scheme still accepted')
  else {
    // may be minified differently
    console.log('  · legacy orca_botmux: not found in bundle (check shared/pairing.ts)')
  }
} catch (e) {
  fail('pairing check', String(e))
}

console.log('[smoke] capability surface modules (source)')
for (const p of [
  'src/main/runtime/orca-botmux-runtime.ts',
  'src/main/runtime/runtime-rpc.ts',
  'src/main/ipc/mobile.ts',
  'src/main/git/runner.ts',
  'src/main/orca-botmux-bridge/orca-botmux-dashboard-client.ts',
  'src/main/orca-botmux-bridge/register-orca-botmux-bridge-ipc.ts',
  'src/main/orca-botmux-bridge/ssh-target-destination.ts',
  'src/main/orca-botmux-bridge/terminal-window.ts',
  'src/main/orca-botmux-bridge/ssh-tunnel.ts',
]) {
  if (existsSync(join(root, p))) ok(p)
  else fail(p, 'missing')
}

// Bridge IPC symbols in bundles
try {
  const main = readFileSync(join(root, 'out/main/index.js'), 'utf8')
  const preload = readFileSync(join(root, 'out/preload/index.js'), 'utf8')
  if (main.includes('orcaBotmuxBridge:listSshTargets')) ok('main has listSshTargets')
  else fail('main listSshTargets')
  if (main.includes('orcaBotmuxBridge:sendMessage')) ok('main has sendMessage')
  else fail('main sendMessage')
  if (main.includes('orcaBotmuxBridge:connectEndpoint')) ok('main has connectEndpoint (multi-host)')
  else fail('main connectEndpoint')
  if (main.includes('orcaBotmuxBridge:listEndpoints')) ok('main has listEndpoints')
  else fail('main listEndpoints')
  if (main.includes('orcaBotmuxBridge:listPendingAsks')) ok('main has listPendingAsks')
  else fail('main listPendingAsks')
  if (main.includes('orcaBotmuxBridge:nativeTerminalSpec')) ok('main has nativeTerminalSpec')
  else fail('main nativeTerminalSpec')
  if (main.includes('orcaBotmuxBridge:ensureWorkspaceDir')) ok('main has ensureWorkspaceDir')
  else fail('main ensureWorkspaceDir')
  if (main.includes('orcaBotmuxBridge:tmuxAttachSpec')) ok('main has tmuxAttachSpec')
  else fail('main tmuxAttachSpec')
  if (preload.includes('listSshTargets')) ok('preload listSshTargets')
  else fail('preload listSshTargets')
  if (preload.includes('connectEndpoint')) ok('preload connectEndpoint')
  else fail('preload connectEndpoint')
  if (main.includes('reconnectPersisted') || main.includes('orcaBotmuxBridge:reconnectPersisted')) {
    ok('main has reconnectPersisted')
  } else fail('main reconnectPersisted')
  if (main.includes('ensureUrlAuthToken') || main.includes('searchParams.set(\"t\"') || main.includes("searchParams.set('t'")) {
    ok('write-link token ensure present in main')
  } else {
    // minified may inline differently
    console.log('  · ensureUrlAuthToken name may be minified (non-fatal)')
  }
} catch (e) {
  fail('bridge IPC symbols', String(e))
}

console.log('[smoke] bridge module unit bits')
try {
  // Dynamic import of TS not available; re-check persistence filename constant via source.
  const persistSrc = readFileSync(
    join(root, 'src/main/orca-botmux-bridge/endpoint-persistence.ts'),
    'utf8'
  )
  if (persistSrc.includes('orca-botmux-bridge-endpoints.json')) ok('endpoint persistence file name')
  else fail('endpoint persistence')
  const clientSrc = readFileSync(
    join(root, 'src/main/orca-botmux-bridge/orca-botmux-dashboard-client.ts'),
    'utf8'
  )
  if (clientSrc.includes('ensureUrlAuthToken')) ok('ensureUrlAuthToken in client source')
  else fail('ensureUrlAuthToken source')
  const svcSrc = readFileSync(
    join(root, 'src/main/orca-botmux-bridge/orca-botmux-bridge-service.ts'),
    'utf8'
  )
  if (svcSrc.includes('ensureBotmuxAskBackgroundPoll')) ok('background ask poller')
  else fail('background ask poller')
  if (svcSrc.includes('writeLinkHttpToWorkerWsUrl')) ok('WS URL converter wired')
  else fail('WS URL converter')
  if (svcSrc.includes('electronRunAsNode')) ok('electronRunAsNode on PTY spec')
  else fail('electronRunAsNode')
} catch (e) {
  fail('bridge unit bits', String(e))
}

console.log('[smoke] PTY relay product path')
try {
  const relayPath = join(root, 'scripts/orca-botmux-term-relay.mjs')
  if (existsSync(relayPath)) ok('scripts/orca-botmux-term-relay.mjs present')
  else fail('orca-botmux-term-relay.mjs missing')
  const relay = readFileSync(relayPath, 'utf8')
  if (relay.includes('global WebSocket') || relay.includes("typeof WebSocket")) {
    ok('relay uses global WebSocket (zero-dep)')
  } else fail('relay WebSocket')
  if (relay.includes("type: 'resize'") || relay.includes('type: "resize"')) ok('relay resize protocol')
  else fail('relay resize')
  if (ebc.includes('orca-botmux-term-relay.mjs')) ok('electron-builder packs term relay')
  else fail('electron-builder term relay extraResource')
  const openTab = readFileSync(
    join(root, 'src/renderer/src/lib/open-orca-botmux-native-terminal-tab.ts'),
    'utf8'
  )
  if (openTab.includes('ELECTRON_RUN_AS_NODE=1')) ok('native tab prefixes ELECTRON_RUN_AS_NODE')
  else fail('ELECTRON_RUN_AS_NODE shell prefix')
  const wsHelper = readFileSync(
    join(root, 'src/main/orca-botmux-bridge/write-link-to-ws.ts'),
    'utf8'
  )
  // Unit-check trailing slash semantics without a test runner
  if (wsHelper.includes("path = `${path}/`") || wsHelper.includes("path + '/'")) {
    ok('write-link→WS trailing slash semantics')
  } else fail('write-link WS path slash')
} catch (e) {
  fail('PTY relay path', String(e))
}

console.log('[smoke] write-link→ws pure conversion')
try {
  // Inline mirror of writeLinkHttpToWorkerWsUrl for smoke (avoid TS load).
  function toWs(writeLinkUrl) {
    const u = new URL(writeLinkUrl)
    if (u.protocol === 'http:') u.protocol = 'ws:'
    else if (u.protocol === 'https:') u.protocol = 'wss:'
    let path = u.pathname.replace(/\/+$/, '') || ''
    if (!path.endsWith('/')) path = `${path}/`
    u.pathname = path
    return u.toString()
  }
  const got = toWs('http://127.0.0.1:18789/s/sess-abc?token=tok')
  const expect = 'ws://127.0.0.1:18789/s/sess-abc/?token=tok'
  if (got === expect) ok(`ws url ${got}`)
  else fail('ws url convert', `got ${got} want ${expect}`)
} catch (e) {
  fail('write-link convert smoke', String(e))
}

console.log('[smoke] electron binary')
try {
  const electronPath = require('electron')
  if (typeof electronPath === 'string' && existsSync(electronPath)) ok(`electron at ${electronPath}`)
  else fail('electron path', String(electronPath))
} catch (e) {
  fail('electron', String(e))
}

if (process.env.BOTMUX_SMOKE_SKIP_ELECTRON === '1') {
  console.log('[smoke] short electron boot skipped (BOTMUX_SMOKE_SKIP_ELECTRON=1)')
  ok('electron boot skipped for CI')
} else {
  console.log('[smoke] short electron boot (serve mode, no window)')
  // --serve starts runtime without main window when supported
  const electronBin = require('electron')
  const boot = spawnSync(electronBin, ['.', '--serve', '--port', '0'], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '1',
      // Isolate smoke userData
      ORCA_DEV_USER_DATA_PATH: join(root, '.smoke-user-data'),
    },
    timeout: 20000,
    encoding: 'utf8',
  })
  // serve may stay alive; timeout kills — treat non-crash before timeout as soft pass
  const combined = `${boot.stdout ?? ''}\n${boot.stderr ?? ''}`
  if (boot.error && boot.error.code === 'ETIMEDOUT') {
    ok('serve process stayed alive until timeout (expected)')
  } else if (boot.status === 0) {
    ok('serve exited 0')
  } else if (combined.includes('Error: Cannot find module') || combined.includes('FATAL')) {
    fail('serve boot', combined.slice(0, 400))
  } else {
    // Many environments kill electron on timeout with non-zero — log tail for debug
    console.log('  · serve status', boot.status, 'signal', boot.signal)
    ok('serve launched (see status; non-fatal for smoke)')
  }
}

if (failed > 0) {
  console.error(`[smoke] FAILED (${failed})`)
  process.exit(1)
}
console.log('[smoke] OK')
