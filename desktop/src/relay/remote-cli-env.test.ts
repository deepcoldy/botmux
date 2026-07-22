import { describe, expect, it } from 'vitest'
import { pickRemoteCliEnv } from './remote-cli-env'

describe('pickRemoteCliEnv', () => {
  it('forwards SSH Botmux terminal and worktree context for remote CLI calls', () => {
    expect(
      pickRemoteCliEnv({
        BOTMUX_TERMINAL_HANDLE: 'term_ssh',
        BOTMUX_WORKTREE_ID: 'repo::remote',
        BOTMUX_PANE_KEY: 'pane-1',
        BOTMUX_WORKSPACE_ID: 'workspace-1',
        BOTMUX_USER_DATA_PATH: '/tmp/botmux',
        PATH: '/usr/bin',
        SECRET_TOKEN: 'nope'
      })
    ).toEqual({
      BOTMUX_TERMINAL_HANDLE: 'term_ssh',
      BOTMUX_WORKTREE_ID: 'repo::remote',
      BOTMUX_PANE_KEY: 'pane-1',
      BOTMUX_WORKSPACE_ID: 'workspace-1',
      BOTMUX_USER_DATA_PATH: '/tmp/botmux',
      PATH: '/usr/bin'
    })
  })
})
