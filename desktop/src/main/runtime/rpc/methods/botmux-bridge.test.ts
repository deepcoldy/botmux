import { describe, expect, it, vi, beforeEach } from 'vitest'
import { shapeBotmuxBridgeListSessionsResult } from './botmux-bridge'
import type { OrcaBotmuxBridgeListResult } from '../../../orca-botmux-bridge/types'

vi.mock('../../../orca-botmux-bridge/orca-botmux-bridge-service', () => ({
  getOrcaBotmuxBridgeStatus: vi.fn(),
  listOrcaBotmuxBridgeEndpoints: vi.fn(),
  listOrcaBotmuxBridgeSessions: vi.fn(),
  getOrcaBotmuxBridgeNativeTerminalSpec: vi.fn(),
  getOrcaBotmuxBridgeTmuxAttachSpec: vi.fn(),
  openOrcaBotmuxBridgeTerminal: vi.fn()
}))

import {
  getOrcaBotmuxBridgeNativeTerminalSpec,
  listOrcaBotmuxBridgeSessions
} from '../../../orca-botmux-bridge/orca-botmux-bridge-service'
import { BOTMUX_BRIDGE_METHODS } from './botmux-bridge'

function findHandler(name: string) {
  const method = BOTMUX_BRIDGE_METHODS.find((m) => m.name === name)
  if (!method) throw new Error(`missing method ${name}`)
  return method
}

describe('botmuxBridge RPC methods', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shapeBotmuxBridgeListSessionsResult filters by worktree path on real shape', () => {
    const list: OrcaBotmuxBridgeListResult = {
      ok: true,
      endpoints: [{ id: 'ssh:t1', label: 'd2', baseUrl: 'http://127.0.0.1:1', ok: true }],
      sessions: [
        {
          sessionId: 's-in',
          hostId: 'ssh:t1',
          hostLabel: 'd2',
          cwd: '/root/workspace/botmux/src',
          title: 'in'
        },
        {
          sessionId: 's-out',
          hostId: 'ssh:t1',
          hostLabel: 'd2',
          cwd: '/tmp/nope',
          title: 'out'
        }
      ]
    }
    const shaped = shapeBotmuxBridgeListSessionsResult(list, {
      worktreePath: '/root/workspace/botmux',
      orcaBotmuxHostId: 'ssh:t1'
    })
    expect(shaped.ok).toBe(true)
    if (!shaped.ok) return
    expect(shaped.sessions.map((s) => s.sessionId)).toEqual(['s-in'])
    expect(shaped.sessions[0]?.hostId).toBe('ssh:t1')
    expect(shaped.sessions[0]?.cwd).toBe('/root/workspace/botmux/src')
  })

  it('listSessions handler delegates to bridge service and applies scope', async () => {
    vi.mocked(listOrcaBotmuxBridgeSessions).mockResolvedValue({
      ok: true,
      endpoints: [{ id: 'local', label: 'Local', baseUrl: 'http://127.0.0.1:2', ok: true }],
      sessions: [
        {
          sessionId: 'keep',
          hostId: 'local',
          hostLabel: 'Local',
          cwd: '/Users/me/proj/a',
          title: 'keep'
        },
        {
          sessionId: 'drop',
          hostId: 'local',
          hostLabel: 'Local',
          cwd: '/Users/me/other',
          title: 'drop'
        }
      ]
    })
    const method = findHandler('botmuxBridge.listSessions')
    const params = method.params?.parse({
      worktreePath: '/Users/me/proj',
      orcaBotmuxHostId: 'local'
    })
    const result = (await method.handler(params, {
      runtime: {} as never
    })) as OrcaBotmuxBridgeListResult
    expect(listOrcaBotmuxBridgeSessions).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]?.sessionId).toBe('keep')
    expect(result.sessions[0]?.hostId).toBe('local')
    expect(result.sessions[0]?.cwd).toBe('/Users/me/proj/a')
  })

  it('nativeTerminalSpec handler returns attach payload from bridge service', async () => {
    vi.mocked(getOrcaBotmuxBridgeNativeTerminalSpec).mockResolvedValue({
      ok: true,
      command: 'node',
      args: ['relay.js'],
      title: 'OrcaBotmux · abc',
      writeLinkUrl: 'http://127.0.0.1/write',
      electronRunAsNode: true
    })
    const method = findHandler('botmuxBridge.nativeTerminalSpec')
    const params = method.params?.parse({ sessionId: 'sess-1', hostId: 'local' })
    const result = await method.handler(params, { runtime: {} as never })
    expect(getOrcaBotmuxBridgeNativeTerminalSpec).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      hostId: 'local'
    })
    expect(result).toMatchObject({
      ok: true,
      command: 'node',
      writeLinkUrl: 'http://127.0.0.1/write'
    })
  })

  it('registers expected method names for mobile', () => {
    const names = BOTMUX_BRIDGE_METHODS.map((m) => m.name).sort()
    expect(names).toEqual([
      'botmuxBridge.getStatus',
      'botmuxBridge.listEndpoints',
      'botmuxBridge.listSessions',
      'botmuxBridge.nativeTerminalSpec',
      'botmuxBridge.openTerminal',
      'botmuxBridge.tmuxAttachSpec'
    ])
  })
})
