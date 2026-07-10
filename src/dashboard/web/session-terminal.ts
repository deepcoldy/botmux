export interface SessionTerminalLocation {
  protocol: string;
  origin: string;
  hostname: string;
}

function currentLocation(): SessionTerminalLocation | null {
  return typeof window === 'undefined' ? null : window.location;
}

export function sessionTerminalHref(s: any, loc: SessionTerminalLocation | null = currentLocation()): string | null {
  if (!s?.webPort || !loc) return null;
  // On the central HTTPS machine domain, terminals must go through the same
  // origin `/s/<session>` reverse proxy. Exposing a raw port would produce a
  // dead link because the platform only proxies 443.
  if (loc.protocol === 'https:') {
    return s.proxyPort ? `${loc.origin}/s/${encodeURIComponent(s.sessionId)}` : null;
  }
  const port = s.proxyPort ?? s.webPort;
  const suffix = s.proxyPort ? `/s/${encodeURIComponent(s.sessionId)}` : '';
  return `http://${loc.hostname}:${port}${suffix}`;
}
