import { describe, expect, it, vi } from 'vitest'
import {
  allowsPlaintextBotmuxCloudSession,
  getBotmuxCloudAuthConfig,
  isBotmuxCloudDevAuthEnabled
} from './profile-cloud-auth-config'

vi.mock('electron', () => ({
  app: {
    isPackaged: false
  }
}))

const CONFIGURED_ENV = {
  BOTMUX_CLOUD_API_URL: 'https://botmux-cloud.example/',
  BOTMUX_CLOUD_CLIENT_ID: 'desktop-client',
  BOTMUX_RELAY_URL: 'https://relay.example'
} as const

describe('Botmux cloud auth config', () => {
  it('reports unconfigured without API URL, client ID, or relay URL', () => {
    expect(getBotmuxCloudAuthConfig({})).toEqual({
      configured: false,
      setupMessage:
        'Botmux Cloud sign-in is not configured. Set BOTMUX_CLOUD_API_URL, BOTMUX_CLOUD_CLIENT_ID (optional), and BOTMUX_RELAY_URL.'
    })
  })

  it('reports unconfigured when only API URL is set (relay required)', () => {
    expect(
      getBotmuxCloudAuthConfig({
        BOTMUX_CLOUD_API_URL: 'https://botmux-cloud.example',
        BOTMUX_CLOUD_CLIENT_ID: 'desktop-client'
      })
    ).toMatchObject({ configured: false })
  })

  it('builds default desktop auth endpoints from env hosts (no hardcoded production domains)', () => {
    const state = getBotmuxCloudAuthConfig(CONFIGURED_ENV)

    expect(state).toEqual({
      configured: true,
      config: {
        apiBaseUrl: 'https://botmux-cloud.example',
        authorizeEndpoint: 'https://botmux-cloud.example/v1/desktop/auth/authorize',
        sessionEndpoint: 'https://botmux-cloud.example/v1/desktop/auth/session',
        refreshEndpoint: 'https://botmux-cloud.example/v1/desktop/auth/refresh',
        capabilitiesEndpoint: 'https://botmux-cloud.example/v1/desktop/auth/capabilities',
        profileEndpoint: 'https://botmux-cloud.example/v1/desktop/auth/profile',
        orgEndpoint: 'https://botmux-cloud.example/v1/desktop/auth/org',
        logoutEndpoint: 'https://botmux-cloud.example/v1/desktop/auth/logout',
        relayTokenEndpoint: 'https://botmux-cloud.example/v1/desktop/auth/relay-token',
        relayDirectorUrl: 'https://relay.example',
        clientId: 'desktop-client',
        scope: 'openid profile email offline_access'
      }
    })
  })

  it('does not embed production hosts for packaged builds without env', () => {
    expect(getBotmuxCloudAuthConfig({}, true)).toMatchObject({ configured: false })
  })

  it('defaults client id when API URL is set', () => {
    const state = getBotmuxCloudAuthConfig({
      BOTMUX_CLOUD_API_URL: 'https://botmux-cloud.example',
      BOTMUX_RELAY_URL: 'https://relay.example'
    })
    expect(state).toMatchObject({
      configured: true,
      config: { clientId: 'botmux-desktop' }
    })
  })

  it('allows loopback HTTP endpoints for local desktop auth development', () => {
    const state = getBotmuxCloudAuthConfig({
      BOTMUX_CLOUD_API_URL: 'http://localhost:4100',
      BOTMUX_CLOUD_CLIENT_ID: 'desktop-client',
      BOTMUX_RELAY_URL: 'http://127.0.0.1:4200'
    })

    expect(state.configured).toBe(true)
  })

  it('rejects loopback HTTP endpoints in packaged builds', () => {
    expect(
      getBotmuxCloudAuthConfig(
        {
          BOTMUX_CLOUD_API_URL: 'http://localhost:4100',
          BOTMUX_CLOUD_CLIENT_ID: 'desktop-client',
          BOTMUX_RELAY_URL: 'http://127.0.0.1:4200'
        },
        true
      )
    ).toMatchObject({ configured: false })

    const httpsState = getBotmuxCloudAuthConfig(
      {
        BOTMUX_CLOUD_API_URL: 'https://botmux-cloud.example',
        BOTMUX_CLOUD_CLIENT_ID: 'desktop-client',
        BOTMUX_RELAY_URL: 'https://relay.example'
      },
      true
    )
    expect(httpsState.configured).toBe(true)
  })

  it('rejects non-HTTPS non-loopback API URLs', () => {
    expect(
      getBotmuxCloudAuthConfig({
        BOTMUX_CLOUD_API_URL: 'http://botmux-cloud.example',
        BOTMUX_CLOUD_CLIENT_ID: 'desktop-client',
        BOTMUX_RELAY_URL: 'https://relay.example'
      })
    ).toMatchObject({ configured: false })
  })

  it('allows dev plaintext sessions only outside production', () => {
    expect(
      allowsPlaintextBotmuxCloudSession({
        BOTMUX_CLOUD_ALLOW_PLAINTEXT_SESSION: '1',
        NODE_ENV: 'development'
      })
    ).toBe(true)
    expect(
      allowsPlaintextBotmuxCloudSession({
        BOTMUX_CLOUD_ALLOW_PLAINTEXT_SESSION: '1',
        NODE_ENV: 'production'
      })
    ).toBe(false)
  })

  it('ignores dev flags in packaged builds even without NODE_ENV', () => {
    // Why: packaged main bundles never define NODE_ENV, so packaged-ness must
    // gate the escape hatches on its own.
    expect(
      allowsPlaintextBotmuxCloudSession({ BOTMUX_CLOUD_ALLOW_PLAINTEXT_SESSION: '1' }, true)
    ).toBe(false)
    expect(isBotmuxCloudDevAuthEnabled({ BOTMUX_CLOUD_DEV_AUTH: '1' }, true)).toBe(false)
  })

  it('allows local dev auth only outside production', () => {
    expect(
      isBotmuxCloudDevAuthEnabled({
        BOTMUX_CLOUD_DEV_AUTH: '1',
        NODE_ENV: 'development'
      })
    ).toBe(true)
    expect(
      isBotmuxCloudDevAuthEnabled({
        BOTMUX_CLOUD_DEV_AUTH: '1',
        NODE_ENV: 'production'
      })
    ).toBe(false)
  })
})
