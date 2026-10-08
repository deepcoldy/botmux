import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')

describe('web terminal tmux attach sizing', () => {
  it('restores responsive tmux sizing before spawning the attach', () => {
    const attachBlockStart = workerSource.indexOf('const startAttach = (cols: number, rows: number)')
    const attachBlockEnd = workerSource.indexOf("cp = pty.spawn('tmux'", attachBlockStart)
    expect(attachBlockStart).toBeGreaterThan(-1)
    expect(attachBlockEnd).toBeGreaterThan(attachBlockStart)

    const beforeSpawn = workerSource.slice(attachBlockStart, attachBlockEnd)
    // `largest` restores the shared default so a prior manual web resize does
    // not strand the window in a fixed size — without letting a smaller/newer
    // viewer shrink every other attached client (which `latest` would do).
    expect(beforeSpawn).toContain("['set-option', '-t', tmuxTarget, 'window-size', 'largest']")
    // Bounded so a wedged tmux control socket cannot block the attach forever.
    expect(beforeSpawn).toContain('timeout: 3000')
  })

  it('keeps a read-only viewer from resizing an owned tmux pipe session', () => {
    const sharedRelayStart = workerSource.indexOf('// ── Shared relay (PtyBackend OR tmux pipe mode)')
    const sharedRelayEnd = workerSource.indexOf('// Bind + EADDRINUSE', sharedRelayStart)
    expect(sharedRelayStart).toBeGreaterThan(-1)
    expect(sharedRelayEnd).toBeGreaterThan(sharedRelayStart)

    const sharedRelay = workerSource.slice(sharedRelayStart, sharedRelayEnd)
    expect(sharedRelay).toContain("(effectiveBackendType === 'tmux' && isPipeMode && !lastInitConfig?.adoptMode)")
    expect(sharedRelay).toContain('if (readOnlyFollowsBackendGrid)')
    expect(sharedRelay).toContain('backend?.getPaneSize?.() ?? { cols: renderCols, rows: renderRows }')
    expect(sharedRelay).toContain('if (!result.backend && !readOnlyFollowsBackendGrid)')
    expect(sharedRelay).toContain('broadcastOwnedTmuxReadOnlyFollowerGrid()')
    expect(sharedRelay).not.toContain("hasWrite || effectiveBackendType !== 'remote-runner'")
  })
})
