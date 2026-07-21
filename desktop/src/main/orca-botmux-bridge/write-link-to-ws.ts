/**
 * Convert a orca_botmux web-terminal write-link (HTTP page URL) into the WebSocket
 * URL the in-page xterm client uses.
 *
 * Worker HTML:
 *   base = location.pathname (no trailing slash)
 *   ws   = proto + host + base + '/' + location.search
 * e.g. http://h:9/s/abc?token=x  →  ws://h:9/s/abc/?token=x
 */
export function writeLinkHttpToWorkerWsUrl(writeLinkUrl: string):
  | { ok: true; wsUrl: string }
  | { ok: false; reason: string; message: string } {
  let u: URL
  try {
    u = new URL(writeLinkUrl)
  } catch {
    return { ok: false, reason: 'bad_url', message: 'Invalid write-link URL' }
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    return {
      ok: false,
      reason: 'unsupported_scheme',
      message: `Cannot relay terminal for scheme ${u.protocol}`
    }
  }

  // Riff / external sandbox links are full product URLs, not worker pages.
  if (/riff|sandbox|codesandbox|gitpod/i.test(u.hostname + u.pathname) && !u.pathname.includes('/s/')) {
    return {
      ok: false,
      reason: 'external_terminal',
      message: 'This session uses an external operate link — open Web terminal instead of PTY.'
    }
  }

  if (u.protocol === 'http:') u.protocol = 'ws:'
  else if (u.protocol === 'https:') u.protocol = 'wss:'

  // Match worker page: pathname without trailing slash, then force one before '?'
  let path = u.pathname.replace(/\/+$/, '') || ''
  if (!path.endsWith('/')) path = `${path}/`
  u.pathname = path

  return { ok: true, wsUrl: u.toString() }
}
