/**
 * OpenSSH local-forward tunnel for reaching a remote botmux dashboard.
 * Uses system `ssh` so ~/.ssh/config Host aliases work without reimplementing auth.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { connect, createServer } from 'node:net'
import { homedir } from 'node:os'

export type SshTunnelHandle = {
  localPort: number
  baseUrl: string
  remotePort: number
  target: string
  close: () => void
}

// Why: spawn uses stdio ['ignore','pipe','pipe'], so stdin is null — not WithoutNullStreams.
type SshTunnelChild = ChildProcessByStdio<null, Readable, Readable>

type ActiveTunnel = {
  key: string
  handle: SshTunnelHandle
  child: SshTunnelChild
  refs: number
}

const tunnels = new Map<string, ActiveTunnel>()

function tunnelKey(target: string, remotePort: number): string {
  return `${target}::${remotePort}`
}

async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('failed to allocate free port'))
        return
      }
      const port = addr.port
      server.close((err) => (err ? reject(err) : resolve(port)))
    })
    server.on('error', reject)
  })
}

/** Run a short remote command over SSH (login shell, Capture stdout). */
export async function sshExec(
  target: string,
  remoteCommand: string,
  timeoutMs = 15_000,
  extraArgs: string[] = []
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(
      'ssh',
      [
        ...extraArgs,
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'StrictHostKeyChecking=accept-new',
        target,
        remoteCommand
      ],
      { env: process.env }
    )
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: 124, stdout, stderr: stderr || 'ssh exec timed out' })
    }, timeoutMs)
    child.stdout.on('data', (c) => {
      stdout += String(c)
    })
    child.stderr.on('data', (c) => {
      stderr += String(c)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: 1, stdout, stderr: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

/**
 * Discover remote dashboard port + token via SSH, then open -L tunnel.
 * remoteBotmuxHome defaults to probing `$HOME/.botmux` then legacy `$HOME/.botmux`.
 */
export type RemoteBotmuxProbe = {
  remotePort: number
  token: string | null
}

/** Probe remote botmux home for dashboard port + token (no tunnel). */
export async function probeRemoteBotmuxDashboard(opts: {
  target: string
  remoteBotmuxHome?: string
  remoteDashboardPort?: number
  extraArgs?: string[]
}): Promise<
  { ok: true; probe: RemoteBotmuxProbe } | { ok: false; reason: string; message: string }
> {
  const target = opts.target.trim()
  if (!target) {
    return { ok: false, reason: 'bad_target', message: 'SSH target is empty' }
  }
  const extraArgs = opts.extraArgs ?? []
  // Why: botmux CLI persists under ~/.botmux; older bridge code probed
  // ~/.botmux only, so write-link auth failed with empty/missing tokens
  // while public-read session lists still worked.
  const homeProbe = opts.remoteBotmuxHome
    ? `CANDIDATES=${JSON.stringify(opts.remoteBotmuxHome)}; BH=""; for C in $CANDIDATES; do if [ -f "$C/.dashboard-port" ] || [ -f "$C/.dashboard-token" ]; then BH="$C"; break; fi; done; if [ -z "$BH" ]; then BH=${JSON.stringify(opts.remoteBotmuxHome)}; fi`
    : 'BH=""; for C in "$HOME/.botmux" "$HOME/.botmux"; do if [ -f "$C/.dashboard-port" ] || [ -f "$C/.dashboard-token" ]; then BH="$C"; break; fi; done; if [ -z "$BH" ]; then BH="$HOME/.botmux"; fi'
  const probe = await sshExec(
    target,
    [
      'set -e',
      homeProbe,
      'PORT_FILE="$BH/.dashboard-port"',
      'TOKEN_FILE="$BH/.dashboard-token"',
      'if [ -f "$PORT_FILE" ]; then PORT=$(cat "$PORT_FILE" | tr -d "[:space:]"); else PORT=""; fi',
      `if [ -z "$PORT" ]; then PORT=${opts.remoteDashboardPort ?? 7891}; fi`,
      'TOKEN=""',
      'if [ -f "$TOKEN_FILE" ]; then TOKEN=$(cat "$TOKEN_FILE" | tr -d "\\r\\n"); fi',
      'echo "HOME=$BH"',
      'echo "PORT=$PORT"',
      'echo "TOKEN=$TOKEN"'
    ].join('; '),
    15_000,
    extraArgs
  )
  if (probe.code !== 0) {
    return {
      ok: false,
      reason: 'ssh_failed',
      message: probe.stderr.trim() || probe.stdout.trim() || `ssh exit ${probe.code}`
    }
  }
  const portMatch = probe.stdout.match(/^PORT=(\d+)\s*$/m)
  const tokenMatch = probe.stdout.match(/^TOKEN=(.*)$/m)
  const remotePort = portMatch ? Number(portMatch[1]) : opts.remoteDashboardPort ?? 7891
  if (!Number.isFinite(remotePort) || remotePort <= 0) {
    return {
      ok: false,
      reason: 'no_remote_port',
      message:
        'Could not resolve remote dashboard port (~/.botmux/.dashboard-port or ~/.botmux/.dashboard-port)'
    }
  }
  return {
    ok: true,
    probe: {
      remotePort,
      token: tokenMatch?.[1]?.trim() || null
    }
  }
}

export async function openRemoteBotmuxTunnel(opts: {
  target: string
  remoteBotmuxHome?: string
  remoteDashboardPort?: number
  extraArgs?: string[]
  /**
   * When set, try Botmux's connected SSH port-forward first (same TCP tunnel
   * manager as Settings → Ports). Falls back to system `ssh -L`.
   */
  preferBotmuxSshTargetId?: string
}): Promise<
  | { ok: true; endpoint: { baseUrl: string; token: string | null }; tunnel: SshTunnelHandle }
  | { ok: false; reason: string; message: string }
> {
  const target = opts.target.trim()
  if (!target) {
    return { ok: false, reason: 'bad_target', message: 'SSH target is empty' }
  }
  const extraArgs = opts.extraArgs ?? []

  const probed = await probeRemoteBotmuxDashboard({
    target,
    remoteBotmuxHome: opts.remoteBotmuxHome,
    remoteDashboardPort: opts.remoteDashboardPort,
    extraArgs
  })
  if (!probed.ok) return probed
  const { remotePort, token } = probed.probe

  const key = tunnelKey(
    opts.preferBotmuxSshTargetId ? `botmux:${opts.preferBotmuxSshTargetId}` : target,
    remotePort
  )
  const existing = tunnels.get(key)
  if (existing) {
    existing.refs += 1
    return {
      ok: true,
      endpoint: { baseUrl: existing.handle.baseUrl, token },
      tunnel: existing.handle
    }
  }

  // Prefer Botmux SSH port-forward when the target is already connected.
  if (opts.preferBotmuxSshTargetId) {
    try {
      const { openBotmuxDashboardPortForwardOnConnectedSsh } = await import('../ipc/ssh')
      const localPort = await pickFreePort()
      const pf = await openBotmuxDashboardPortForwardOnConnectedSsh({
        targetId: opts.preferBotmuxSshTargetId,
        remotePort,
        localPort,
        label: 'Botmux dashboard'
      })
      if (pf.ok) {
        const handle: SshTunnelHandle = {
          localPort: pf.localPort,
          baseUrl: `http://127.0.0.1:${pf.localPort}`,
          remotePort: pf.remotePort,
          target: opts.preferBotmuxSshTargetId,
          close: () => {
            // Port forwards are owned by the SSH connection lifecycle; just drop our ref.
            const t = tunnels.get(key)
            if (!t) return
            t.refs -= 1
            if (t.refs <= 0) tunnels.delete(key)
          }
        }
        // Synthetic "child" not used — store a no-op process placeholder via refs only.
        tunnels.set(key, {
          key,
          handle,
          child: { kill: () => undefined } as unknown as SshTunnelChild,
          refs: 1
        })
        return {
          ok: true,
          endpoint: { baseUrl: handle.baseUrl, token },
          tunnel: handle
        }
      }
    } catch {
      // Fall through to system ssh -L
    }
  }

  const localPort = await pickFreePort()
  const child = spawn(
    'ssh',
    [
      ...extraArgs,
      '-N',
      '-L',
      `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'StrictHostKeyChecking=accept-new',
      target
    ],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
  )

  const ready = await waitForTunnelReady(child, localPort, 12_000)
  if (!ready.ok) {
    child.kill('SIGKILL')
    return ready
  }

  const handle: SshTunnelHandle = {
    localPort,
    baseUrl: `http://127.0.0.1:${localPort}`,
    remotePort,
    target,
    close: () => {
      const t = tunnels.get(key)
      if (!t) return
      t.refs -= 1
      if (t.refs <= 0) {
        tunnels.delete(key)
        try {
          t.child.kill('SIGTERM')
        } catch {
          /* ignore */
        }
      }
    }
  }

  child.on('exit', () => {
    tunnels.delete(key)
  })

  tunnels.set(key, { key, handle, child, refs: 1 })
  return { ok: true, endpoint: { baseUrl: handle.baseUrl, token }, tunnel: handle }
}

async function waitForTunnelReady(
  child: SshTunnelChild,
  localPort: number,
  timeoutMs: number
): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
  const started = Date.now()
  let stderr = ''
  child.stderr.on('data', (c) => {
    stderr += String(c)
  })

  return await new Promise((resolve) => {
    const check = (): void => {
      if (child.exitCode !== null) {
        resolve({
          ok: false,
          reason: 'ssh_tunnel_exit',
          message: stderr.trim() || `ssh tunnel exited with ${child.exitCode}`
        })
        return
      }
      const c = connect({ host: '127.0.0.1', port: localPort }, () => {
        c.end()
        resolve({ ok: true })
      })
      c.on('error', () => {
        if (Date.now() - started > timeoutMs) {
          resolve({
            ok: false,
            reason: 'ssh_tunnel_timeout',
            message: stderr.trim() || `tunnel to local port ${localPort} not ready`
          })
          return
        }
        setTimeout(check, 150)
      })
    }
    setTimeout(check, 200)
  })
}

/** Test helper / diagnostics — home for docs only. */
export function localHome(): string {
  return homedir()
}
