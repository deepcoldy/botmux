#!/usr/bin/env node
/**
 * Product PTY relay: bridge Desktop native terminal ↔ orca_botmux worker web-terminal WS.
 *
 * Usage (prefer ELECTRON_RUN_AS_NODE=1 when command is Electron binary):
 *   ELECTRON_RUN_AS_NODE=1 electron orca-botmux-term-relay.mjs <wsUrl>
 *   node orca-botmux-term-relay.mjs <wsUrl>
 *
 * Zero external deps — uses global WebSocket (Node 22+ / Electron Node).
 *
 * Protocol (worker web terminal):
 *   → { type: 'input', data }
 *   → { type: 'resize', cols, rows }
 *   ← raw bytes or JSON { type:'output', data } / { data }
 */
const wsUrl = process.argv[2]
if (!wsUrl) {
  console.error('usage: orca-botmux-term-relay.mjs <wsUrl>')
  process.exit(2)
}

if (typeof WebSocket === 'undefined') {
  console.error(
    '[orca-botmux-term-relay] global WebSocket missing. Run with Node 22+ or ELECTRON_RUN_AS_NODE=1 Electron.'
  )
  process.exit(2)
}

const ws = new WebSocket(wsUrl)
ws.binaryType = 'arraybuffer'

let closed = false
let lastCols = process.stdout.columns || 80
let lastRows = process.stdout.rows || 24

function shutdown(code = 0) {
  if (closed) return
  closed = true
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
  } catch {
    /* ignore */
  }
  process.exit(code)
}

function sendResize() {
  if (ws.readyState !== WebSocket.OPEN) return
  const cols = process.stdout.columns || lastCols
  const rows = process.stdout.rows || lastRows
  if (cols === lastCols && rows === lastRows) return
  lastCols = cols
  lastRows = rows
  try {
    ws.send(JSON.stringify({ type: 'resize', cols, rows }))
  } catch {
    /* ignore */
  }
}

ws.addEventListener('open', () => {
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true)
    } catch {
      /* ignore */
    }
  }
  process.stdin.resume()
  try {
    ws.send(
      JSON.stringify({
        type: 'resize',
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24
      })
    )
  } catch {
    /* ignore */
  }

  process.stdin.on('data', (chunk) => {
    if (ws.readyState !== WebSocket.OPEN) return
    // Ctrl-\ exits relay without killing remote CLI
    if (chunk.length === 1 && chunk[0] === 0x1c) {
      shutdown(0)
      return
    }
    ws.send(JSON.stringify({ type: 'input', data: chunk.toString('utf8') }))
  })

  process.stdout.on('resize', sendResize)
  process.on('SIGWINCH', sendResize)
})

ws.addEventListener('message', (event) => {
  const data = event.data
  if (data instanceof ArrayBuffer) {
    process.stdout.write(Buffer.from(data))
    return
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(data)) {
    process.stdout.write(data)
    return
  }
  const text = typeof data === 'string' ? data : String(data)
  try {
    const msg = JSON.parse(text)
    if (msg && typeof msg === 'object') {
      if (typeof msg.data === 'string') {
        process.stdout.write(msg.data)
        return
      }
      if (msg.type === 'output' && typeof msg.data === 'string') {
        process.stdout.write(msg.data)
        return
      }
    }
  } catch {
    /* raw terminal bytes as text frame */
  }
  process.stdout.write(text)
})

ws.addEventListener('close', () => {
  process.stdout.write('\r\n[orca_botmux] terminal disconnected\r\n')
  shutdown(0)
})
ws.addEventListener('error', (err) => {
  const msg = err && typeof err === 'object' && 'message' in err ? err.message : String(err)
  console.error(`[orca-botmux-term-relay] ${msg}`)
  shutdown(1)
})

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
