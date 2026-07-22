import {
  PAIRING_OFFER_VERSION,
  PairingOfferSchema,
  type PairingOffer
} from './mobile-relay-pairing-offer'

export { PAIRING_OFFER_VERSION, PairingOfferSchema }
export type { PairingOffer }

// Canonical pairing scheme for Botmux Desktop ↔ Mobile.
const PAIRING_SCHEMES = new Set(['botmux:'])

export function encodePairingOffer(offer: PairingOffer): string {
  const json = JSON.stringify(offer)
  const base64url = Buffer.from(json, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  // Why: Android camera intents and Expo Router preserve query params more
  // reliably than URL fragments when launching a custom-scheme app.
  return `botmux://pair?code=${base64url}`
}

export function decodePairingOffer(url: string): PairingOffer {
  const code = extractPairingCodeFromUrl(url)
  if (!code) {
    throw new Error(
      'Invalid pairing URL: must start with botmux://pair and include a pairing code'
    )
  }
  return decodePairingBase64(code)
}

function extractPairingCodeFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  // Why: only hostname `pair` may carry runtime auth material.
  if (!PAIRING_SCHEMES.has(parsed.protocol) || parsed.hostname !== 'pair') {
    return null
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    return null
  }
  const code = parsed.searchParams.get('code')
  if (code) {
    return code
  }
  return parsed.hash ? parsed.hash.slice(1) || null : null
}

// Why: accept either an `botmux://pair?...` URL or the bare base64
// string so the mobile paste-pair flow can take whichever the user
// actually copied from desktop.
export function parsePairingCode(input: string): PairingOffer | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  try {
    if (trimmed.toLowerCase().startsWith('botmux://')) {
      return decodePairingOffer(trimmed)
    }
    return decodePairingBase64(trimmed)
  } catch {
    return null
  }
}

function decodePairingBase64(base64url: string): PairingOffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const json = Buffer.from(base64, 'base64').toString('utf-8')
  return PairingOfferSchema.parse(JSON.parse(json))
}
