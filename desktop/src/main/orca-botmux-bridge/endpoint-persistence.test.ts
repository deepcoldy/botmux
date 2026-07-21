import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const userDataDir = mkdtempSync(join(tmpdir(), 'orca-botmux-bridge-ep-'))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userDataDir
      return userDataDir
    }
  }
}))

import {
  clearPersistedBridgeEndpoints,
  loadPersistedBridgeEndpoints,
  removePersistedBridgeEndpoint,
  upsertPersistedBridgeEndpoint
} from './endpoint-persistence'

describe('endpoint persistence (desired hosts)', () => {
  beforeEach(() => {
    clearPersistedBridgeEndpoints()
  })

  afterEach(() => {
    clearPersistedBridgeEndpoints()
  })

  it('upserts without dropping other hosts', () => {
    upsertPersistedBridgeEndpoint({ kind: 'local' })
    upsertPersistedBridgeEndpoint({ kind: 'ssh', sshTargetId: 'ssh-d2', label: 'd2' })
    const rows = loadPersistedBridgeEndpoints()
    expect(rows.map((r) => r.id).sort()).toEqual(['local', 'ssh:ssh-d2'])
  })

  it('remove only drops the disconnected id', () => {
    upsertPersistedBridgeEndpoint({ kind: 'local' })
    upsertPersistedBridgeEndpoint({ kind: 'ssh', sshTargetId: 'ssh-d2', label: 'd2' })
    removePersistedBridgeEndpoint('local')
    const rows = loadPersistedBridgeEndpoints()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('ssh:ssh-d2')
  })

  it('writes under userData', () => {
    upsertPersistedBridgeEndpoint({ kind: 'ssh', sshTargetId: 'ssh-x' })
    const raw = readFileSync(join(userDataDir, 'orca-botmux-bridge-endpoints.json'), 'utf8')
    expect(raw).toContain('ssh:ssh-x')
  })
})

// Cleanup temp dir after suite
afterEach(() => {
  // keep dir for other tests in file
})

// Note: process exit cleanup
import { afterAll } from 'vitest'
afterAll(() => {
  try {
    rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})
