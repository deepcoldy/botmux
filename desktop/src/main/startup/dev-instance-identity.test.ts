import { describe, expect, it } from 'vitest'
import { getDevInstanceIdentity } from './dev-instance-identity'

describe('dev-instance-identity', () => {
  it('keeps packaged identity stable', () => {
    expect(getDevInstanceIdentity(false, {})).toMatchObject({
      name: 'botmux',
      appName: 'botmux',
      isDev: false,
      devLabel: null,
      dockBadgeLabel: null,
      appUserModelId: 'com.botmux.desktop'
    })
  })

  it('pins a stable dev appName across branches so the safeStorage key does not churn', () => {
    const a = getDevInstanceIdentity(true, { BOTMUX_DEV_BRANCH: 'feature/a' })
    const b = getDevInstanceIdentity(true, { BOTMUX_DEV_BRANCH: 'feature/b' })

    // Per-branch label differs (window title / app menu)...
    expect(a.name).not.toBe(b.name)
    // ...but the Keychain-driving appName is identical and distinct from prod.
    expect(a.appName).toBe('Botmux Dev')
    expect(b.appName).toBe('Botmux Dev')
    expect(a.appName).not.toBe('botmux')
  })

  it('derives a readable dev label from worktree and branch env', () => {
    const identity = getDevInstanceIdentity(true, {
      BOTMUX_DEV_REPO_ROOT: '/repo/worktrees/dev-indicator',
      BOTMUX_DEV_WORKTREE_NAME: 'dev-indicator',
      BOTMUX_DEV_BRANCH: 'nwparker/dev-indicator'
    })

    expect(identity).toMatchObject({
      isDev: true,
      devLabel: 'dev-indicator',
      devBranch: 'nwparker/dev-indicator',
      devWorktreeName: 'dev-indicator',
      devRepoRoot: '/repo/worktrees/dev-indicator'
    })
    expect(identity.name).toBe('Botmux: nwparker/dev-indicator')
    expect(identity.dockBadgeLabel).toBeNull()
    expect(identity.appUserModelId).toMatch(/^com\.stablyai\.botmux\.dev\.[a-f0-9]{10}$/)
  })

  it('includes the branch when it differs from the worktree basename', () => {
    const identity = getDevInstanceIdentity(true, {
      BOTMUX_DEV_REPO_ROOT: '/repo/worktrees/payment-ui',
      BOTMUX_DEV_WORKTREE_NAME: 'payment-ui',
      BOTMUX_DEV_BRANCH: 'feature/billing-shell'
    })

    expect(identity.devLabel).toBe('payment-ui @ feature/billing-shell')
    expect(identity.name).toBe('Botmux: feature/billing-shell')
    expect(identity.dockBadgeLabel).toBeNull()
  })

  it('allows an explicit label override', () => {
    const identity = getDevInstanceIdentity(true, {
      BOTMUX_DEV_INSTANCE_LABEL: 'manual label',
      BOTMUX_DEV_WORKTREE_NAME: 'dev-indicator',
      BOTMUX_DEV_BRANCH: 'feature/other'
    })

    expect(identity.devLabel).toBe('manual label')
    expect(identity.name).toBe('Botmux: feature/other')
    expect(identity.dockBadgeLabel).toBeNull()
  })
})
