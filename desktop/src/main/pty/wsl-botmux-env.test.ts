import { describe, expect, it } from 'vitest'
import { addBotmuxWslInteropEnv, addWorktreeSetupWslInteropEnv } from './wsl-botmux-env'

describe('addBotmuxWslInteropEnv', () => {
  it('marks the Botmux terminal handle for Windows to WSL env import', () => {
    const env: Record<string, string> = { BOTMUX_TERMINAL_HANDLE: 'term_wsl' }

    addBotmuxWslInteropEnv(env)

    expect(env.WSLENV).toBe('BOTMUX_TERMINAL_HANDLE/u')
  })

  it('preserves existing WSLENV entries and does not duplicate the handle entry', () => {
    const env: Record<string, string> = {
      WSLENV: 'FOO/u:BOTMUX_TERMINAL_HANDLE/u:BAR/p'
    }

    addBotmuxWslInteropEnv(env)

    expect(env.WSLENV).toBe('FOO/u:BOTMUX_TERMINAL_HANDLE/u:BAR/p')
  })

  it('marks OMP status and hook env for Windows to WSL import', () => {
    const env: Record<string, string> = {
      BOTMUX_TERMINAL_HANDLE: 'term_wsl',
      BOTMUX_USER_DATA_PATH: 'C:\\Users\\jin\\AppData\\Roaming\\Botmux',
      BOTMUX_CLI_COMMAND: 'botmux-ide',
      BOTMUX_OMP_STATUS_EXTENSION: 'C:\\Users\\jin\\.omp\\agent\\extensions\\botmux-agent-status.ts',
      BOTMUX_PANE_KEY: 'tab-1:leaf-1',
      BOTMUX_TAB_ID: 'tab-1',
      BOTMUX_WORKTREE_ID: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
      BOTMUX_AGENT_HOOK_PORT: '4567',
      BOTMUX_AGENT_HOOK_TOKEN: 'token',
      BOTMUX_AGENT_HOOK_ENV: 'dev',
      BOTMUX_AGENT_HOOK_VERSION: '1'
    }

    addBotmuxWslInteropEnv(env)

    expect(env.WSLENV).toContain('BOTMUX_TERMINAL_HANDLE/u')
    expect(env.WSLENV).toContain('BOTMUX_USER_DATA_PATH/p')
    expect(env.WSLENV).toContain('BOTMUX_CLI_COMMAND/u')
    expect(env.WSLENV).toContain('BOTMUX_OMP_STATUS_EXTENSION/p')
    expect(env.WSLENV).toContain('BOTMUX_PANE_KEY/u')
    expect(env.WSLENV).toContain('BOTMUX_TAB_ID/u')
    expect(env.WSLENV).toContain('BOTMUX_WORKTREE_ID/u')
    expect(env.WSLENV).toContain('BOTMUX_AGENT_HOOK_PORT/u')
    expect(env.WSLENV).toContain('BOTMUX_AGENT_HOOK_TOKEN/u')
    expect(env.WSLENV).toContain('BOTMUX_AGENT_HOOK_ENV/u')
    expect(env.WSLENV).toContain('BOTMUX_AGENT_HOOK_VERSION/u')
  })

  it('path-translates a Windows hook endpoint but passes a guest-side one untouched', () => {
    const windowsEnv: Record<string, string> = {
      BOTMUX_AGENT_HOOK_ENDPOINT: 'C:\\Users\\jin\\AppData\\Roaming\\Botmux\\agent-hooks\\endpoint.cmd'
    }
    addBotmuxWslInteropEnv(windowsEnv)
    expect(windowsEnv.WSLENV).toContain('BOTMUX_AGENT_HOOK_ENDPOINT/p')

    const guestEnv: Record<string, string> = {
      BOTMUX_AGENT_HOOK_ENDPOINT: '/home/jin/.botmux-wsl/agent-hooks/port-4567/endpoint.env'
    }
    addBotmuxWslInteropEnv(guestEnv)
    expect(guestEnv.WSLENV).toContain('BOTMUX_AGENT_HOOK_ENDPOINT/u')
    expect(guestEnv.WSLENV).not.toContain('BOTMUX_AGENT_HOOK_ENDPOINT/p')
  })

  it('tags pre-translated Linux setup paths /u so WSLENV does not translate them again (#9206)', () => {
    const env: Record<string, string> = {
      BOTMUX_ROOT_PATH: '/home/jin/repo',
      BOTMUX_WORKTREE_PATH: '/home/jin/repo-worktrees/fix-1',
      BOTMUX_WORKSPACE_NAME: 'fix-1',
      CONDUCTOR_ROOT_PATH: '/home/jin/repo',
      GHOSTX_ROOT_PATH: '/home/jin/repo'
    }

    addBotmuxWslInteropEnv(env)

    // /u (not /p): hooks.ts already converted these to Linux paths before
    // spawn, so a /p flag would make WSLENV double-translate them.
    expect(env.WSLENV).toContain('BOTMUX_ROOT_PATH/u')
    expect(env.WSLENV).toContain('BOTMUX_WORKTREE_PATH/u')
    expect(env.WSLENV).toContain('CONDUCTOR_ROOT_PATH/u')
    expect(env.WSLENV).toContain('GHOSTX_ROOT_PATH/u')
    expect(env.WSLENV).not.toContain('BOTMUX_ROOT_PATH/p')
    expect(env.WSLENV).not.toContain('BOTMUX_WORKTREE_PATH/p')
    // The value itself must stay the already-Linux path.
    expect(env.BOTMUX_ROOT_PATH).toBe('/home/jin/repo')
    expect(env.BOTMUX_WORKTREE_PATH).toBe('/home/jin/repo-worktrees/fix-1')
  })

  it('tags untranslated Windows setup paths /p so WSLENV translates them (wsl.exe shell over a Windows worktree)', () => {
    const env: Record<string, string> = {
      BOTMUX_ROOT_PATH: 'C:\\Users\\jin\\repo',
      BOTMUX_WORKTREE_PATH: 'C:\\Users\\jin\\repo-worktrees\\fix-1',
      CONDUCTOR_ROOT_PATH: 'C:\\Users\\jin\\repo',
      GHOSTX_ROOT_PATH: 'C:\\Users\\jin\\repo'
    }

    addBotmuxWslInteropEnv(env)

    expect(env.WSLENV).toContain('BOTMUX_ROOT_PATH/p')
    expect(env.WSLENV).toContain('BOTMUX_WORKTREE_PATH/p')
    expect(env.WSLENV).toContain('CONDUCTOR_ROOT_PATH/p')
    expect(env.WSLENV).toContain('GHOSTX_ROOT_PATH/p')
    expect(env.WSLENV).not.toContain('BOTMUX_ROOT_PATH/u')
    expect(env.WSLENV).not.toContain('BOTMUX_WORKTREE_PATH/u')
  })

  it('always tags BOTMUX_WORKSPACE_NAME /u because it is a name, not a path', () => {
    const env: Record<string, string> = { BOTMUX_WORKSPACE_NAME: 'fix-1' }

    addBotmuxWslInteropEnv(env)

    expect(env.WSLENV).toBe('BOTMUX_WORKSPACE_NAME/u')
  })

  it('does not register setup vars that are absent from the env', () => {
    const env: Record<string, string> = { BOTMUX_TERMINAL_HANDLE: 'term_wsl' }

    addBotmuxWslInteropEnv(env)

    expect(env.WSLENV).toBe('BOTMUX_TERMINAL_HANDLE/u')
  })

  it('marks the WSL hook relay version for import on relay spawn envs', () => {
    const env: Record<string, string> = { BOTMUX_WSL_HOOK_RELAY_VERSION: '0.1.0+abc' }
    addBotmuxWslInteropEnv(env)
    expect(env.WSLENV).toBe('BOTMUX_WSL_HOOK_RELAY_VERSION/u')
  })
})

describe('addWorktreeSetupWslInteropEnv', () => {
  it('registers only setup vars, sharing the /u-vs-/p flag logic with the PTY path (#9206)', () => {
    const env: Record<string, string | undefined> = {
      BOTMUX_ROOT_PATH: '/mnt/c/Users/jin/repo',
      BOTMUX_WORKTREE_PATH: 'C:\\Users\\jin\\repo-worktrees\\fix-1',
      BOTMUX_WORKSPACE_NAME: 'fix-1',
      // Terminal-only vars must not leak into runHook's WSLENV.
      BOTMUX_TERMINAL_HANDLE: 'term_wsl'
    }

    addWorktreeSetupWslInteropEnv(env)

    expect(env.WSLENV).toBe('BOTMUX_ROOT_PATH/u:BOTMUX_WORKTREE_PATH/p:BOTMUX_WORKSPACE_NAME/u')
  })
})
