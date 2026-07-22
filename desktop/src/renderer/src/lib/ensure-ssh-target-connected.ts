import type { SshConnectionState, SshConnectionStatus } from '../../../shared/ssh-types'

const TRANSIENT_SSH_STATUSES: ReadonlySet<SshConnectionStatus> = new Set([
  'connecting',
  'deploying-relay',
  'reconnecting'
])

export function isTransientSshStatus(status: SshConnectionStatus | null | undefined): boolean {
  return status != null && TRANSIENT_SSH_STATUSES.has(status)
}

export type EnsureSshTargetConnectedDeps = {
  getState: (args: { targetId: string }) => Promise<SshConnectionState | null>
  connect: (args: { targetId: string }) => Promise<SshConnectionState | null>
  publishState: (targetId: string, state: SshConnectionState) => void
  sleep?: (ms: number) => Promise<void>
  /** Poll interval while main is still connecting/deploying-relay. Default 400ms. */
  pollIntervalMs?: number
  /** Max wait for a transient status to settle. Default 15s. */
  settleTimeoutMs?: number
}

/**
 * Make renderer SSH state match main for `targetId`, starting a connect when needed.
 *
 * Why: botmux/SSH workspaces can show a permanent "Connecting..." overlay when the
 * renderer misses the final `connected` push after `deploying-relay` (main already
 * live). Reconcile via getState, and call connect when truly disconnected.
 */
export async function ensureSshTargetConnected(
  targetId: string,
  deps: EnsureSshTargetConnectedDeps
): Promise<SshConnectionState | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const pollIntervalMs = deps.pollIntervalMs ?? 400
  const settleTimeoutMs = deps.settleTimeoutMs ?? 15_000

  let state = await deps.getState({ targetId })
  if (state) {
    deps.publishState(targetId, state)
  }

  if (state?.status === 'connected') {
    return state
  }

  // Transient (connecting / deploying-relay / reconnecting): poll until main
  // settles so a missed `connected` push cannot leave the overlay spinning.
  if (state && isTransientSshStatus(state.status)) {
    const started = Date.now()
    while (Date.now() - started < settleTimeoutMs) {
      await sleep(pollIntervalMs)
      state = await deps.getState({ targetId })
      if (!state) {
        continue
      }
      deps.publishState(targetId, state)
      if (!isTransientSshStatus(state.status)) {
        return state
      }
    }
    state = await deps.getState({ targetId })
    if (state) {
      deps.publishState(targetId, state)
    }
    if (state?.status === 'connected') {
      return state
    }
    // Still transient or failed after timeout — try a fresh connect below.
  }

  // disconnected / error / auth-failed / reconnection-failed / null / stuck transient
  try {
    const connected = await deps.connect({ targetId })
    if (connected) {
      deps.publishState(targetId, connected)
      return connected
    }
  } catch (err) {
    // Still re-read main so the overlay can show auth-failed/error, but rethrow
    // so callers (overlay) can toast and resync target metadata.
    state = await deps.getState({ targetId })
    if (state) {
      deps.publishState(targetId, state)
    }
    throw err
  }
  state = await deps.getState({ targetId })
  if (state) {
    deps.publishState(targetId, state)
  }
  return state
}
