import { app } from 'electron'

export type BotmuxCloudAuthConfig = {
  apiBaseUrl: string
  authorizeEndpoint: string
  sessionEndpoint: string
  refreshEndpoint: string
  capabilitiesEndpoint: string
  profileEndpoint: string
  orgEndpoint: string
  logoutEndpoint: string
  relayTokenEndpoint: string
  relayDirectorUrl: string
  clientId: string
  scope: string
}

const DEFAULT_SCOPE = 'openid profile email offline_access'
// Why: public OAuth client id is not a secret and not an infrastructure host.
// Hosts (login API, relay) must come from env so open-source trees never embed
// internal domains.
const DEFAULT_CLIENT_ID = 'botmux-desktop'

// Why: packaged main bundles never define NODE_ENV, so packaged-ness is the
// only reliable production signal for gating dev-only auth escape hatches.
function isPackagedBotmuxBuild(): boolean {
  try {
    return app?.isPackaged === true
  } catch {
    return false
  }
}

function cleanUrl(value: string | undefined, allowLoopbackHttp: boolean): string | null {
  const trimmed = value?.trim()
  if (!trimmed) {
    return null
  }
  try {
    const parsed = new URL(trimmed)
    const loopbackHost =
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '[::1]'
    if (parsed.protocol !== 'https:' && !(loopbackHost && allowLoopbackHttp)) {
      return null
    }
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function endpoint(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl}/`).toString()
}

function cleanOrigin(value: string | undefined, allowLoopbackHttp: boolean): string | null {
  const cleaned = cleanUrl(value, allowLoopbackHttp)
  if (!cleaned) {
    return null
  }
  const parsed = new URL(cleaned)
  return parsed.pathname === '/' && !parsed.search && !parsed.hash ? parsed.origin : null
}

/**
 * Cloud login + relay are env-only (no hardcoded production hosts).
 *
 * Required:
 * - BOTMUX_CLOUD_API_URL
 * - BOTMUX_CLOUD_CLIENT_ID (defaults to `botmux-desktop` when API URL is set)
 * - BOTMUX_RELAY_URL (director origin for mobile remote pairing)
 *
 * Optional overrides: BOTMUX_CLOUD_AUTH_URL, BOTMUX_CLOUD_*_URL endpoint paths,
 * BOTMUX_CLOUD_AUTH_SCOPE.
 */
export function getBotmuxCloudAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = isPackagedBotmuxBuild()
): { configured: true; config: BotmuxCloudAuthConfig } | { configured: false; setupMessage: string } {
  // Why: loopback HTTP endpoints are a local-development convenience only;
  // packaged builds must not accept plain-HTTP token endpoints via env vars.
  const allowLoopbackHttp = !packaged
  const cleanEndpointUrl = (value: string | undefined): string | null =>
    cleanUrl(value, allowLoopbackHttp)

  const apiBaseUrl = cleanEndpointUrl(env.BOTMUX_CLOUD_API_URL)
  const clientId = env.BOTMUX_CLOUD_CLIENT_ID?.trim() || (apiBaseUrl ? DEFAULT_CLIENT_ID : undefined)
  const relayDirectorUrl = cleanOrigin(env.BOTMUX_RELAY_URL, allowLoopbackHttp)

  if (!apiBaseUrl || !clientId || !relayDirectorUrl) {
    return {
      configured: false,
      setupMessage:
        'Botmux Cloud sign-in is not configured. Set BOTMUX_CLOUD_API_URL, BOTMUX_CLOUD_CLIENT_ID (optional), and BOTMUX_RELAY_URL.'
    }
  }

  const authBaseUrl = cleanEndpointUrl(env.BOTMUX_CLOUD_AUTH_URL) ?? apiBaseUrl
  return {
    configured: true,
    config: {
      apiBaseUrl,
      authorizeEndpoint:
        cleanEndpointUrl(env.BOTMUX_CLOUD_AUTHORIZE_URL) ??
        endpoint(authBaseUrl, '/v1/desktop/auth/authorize'),
      sessionEndpoint:
        cleanEndpointUrl(env.BOTMUX_CLOUD_SESSION_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/session'),
      refreshEndpoint:
        cleanEndpointUrl(env.BOTMUX_CLOUD_REFRESH_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/refresh'),
      capabilitiesEndpoint:
        cleanEndpointUrl(env.BOTMUX_CLOUD_CAPABILITIES_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/capabilities'),
      profileEndpoint:
        cleanEndpointUrl(env.BOTMUX_CLOUD_PROFILE_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/profile'),
      orgEndpoint:
        cleanEndpointUrl(env.BOTMUX_CLOUD_ORG_URL) ?? endpoint(apiBaseUrl, '/v1/desktop/auth/org'),
      logoutEndpoint:
        cleanEndpointUrl(env.BOTMUX_CLOUD_LOGOUT_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/logout'),
      relayTokenEndpoint:
        cleanEndpointUrl(env.BOTMUX_CLOUD_RELAY_TOKEN_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/relay-token'),
      relayDirectorUrl,
      clientId,
      scope: env.BOTMUX_CLOUD_AUTH_SCOPE?.trim() || DEFAULT_SCOPE
    }
  }
}

export function allowsPlaintextBotmuxCloudSession(
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = isPackagedBotmuxBuild()
): boolean {
  return (
    env.BOTMUX_CLOUD_ALLOW_PLAINTEXT_SESSION === '1' && env.NODE_ENV !== 'production' && !packaged
  )
}

export function isBotmuxCloudDevAuthEnabled(
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = isPackagedBotmuxBuild()
): boolean {
  return env.BOTMUX_CLOUD_DEV_AUTH === '1' && env.NODE_ENV !== 'production' && !packaged
}
