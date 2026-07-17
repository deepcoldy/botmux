export interface DesktopShellRouteOptions {
  locale: string;
  runtimeVersion?: string | null;
}

export function routeDashboardUrl(
  url: string,
  route: string | null,
  options: DesktopShellRouteOptions,
): string {
  const desktopUrl = withDesktopShell(url, options);
  return route ? withDashboardRoute(desktopUrl, route, options) : desktopUrl;
}

export function currentDashboardUrlFromSrc(src: string | null): string | null {
  if (!src || src === 'about:blank') return null;
  try {
    const parsed = new URL(src);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // Keep origin/path/query such as auth tokens, then let routeDashboardUrl
    // apply the newly selected hash route and desktop shell parameters.
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

export function withDesktopShell(url: string, options: DesktopShellRouteOptions): string {
  try {
    const parsed = new URL(url);
    // Store desktop shell mode in the hash route because the dashboard token
    // redirect intentionally strips query params after setting the auth cookie.
    parsed.hash = withDesktopShellRoute(parsed.hash || '#/', options);
    return parsed.toString();
  } catch {
    const hashIndex = url.indexOf('#');
    const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
    const hash = hashIndex >= 0 ? url.slice(hashIndex) : '#/';
    return `${base}${withDesktopShellRoute(hash, options)}`;
  }
}

export function withDashboardRoute(
  url: string,
  route: string,
  options: DesktopShellRouteOptions,
): string {
  try {
    const parsed = new URL(url);
    parsed.hash = withDesktopShellRoute(route, options);
    return parsed.toString();
  } catch {
    return `${url.replace(/#.*/, '')}${withDesktopShellRoute(route, options)}`;
  }
}

export function dashboardRouteFromUrl(url: string): string {
  try {
    return normalizeDashboardRoute(new URL(url).hash || '#/');
  } catch {
    const hashIndex = url.indexOf('#');
    return normalizeDashboardRoute(hashIndex >= 0 ? url.slice(hashIndex) : '#/');
  }
}

export function normalizeDashboardRoute(route: string): string {
  const normalized = !route || route === '#'
    ? '#/'
    : route.startsWith('#') ? route : `#${route}`;
  return withoutDesktopShellRouteParam(normalized);
}

export function withDesktopShellRoute(route: string, options: DesktopShellRouteOptions): string {
  const normalized = normalizeDashboardRoute(route);
  const queryStart = normalized.indexOf('?');
  const path = queryStart >= 0 ? normalized.slice(0, queryStart) : normalized;
  const query = queryStart >= 0 ? normalized.slice(queryStart + 1) : '';
  const params = new URLSearchParams(query);
  params.set('shell', 'desktop');
  params.set('locale', options.locale);
  if (options.runtimeVersion) {
    // The embedded dashboard process can be older than the effective runtime
    // selected by the native shell; pass the shell's runtime version so Settings
    // shows the same version as the desktop footer.
    params.set('runtimeVersion', options.runtimeVersion);
  } else {
    params.delete('runtimeVersion');
  }
  return `${path}?${params.toString()}`;
}

export function dashboardRouteMatches(route: string, hash: string): boolean {
  const current = normalizeDashboardRoute(hash);
  if (route === '#/') return current === '#/';
  return current === route || current.startsWith(`${route}/`);
}

function withoutDesktopShellRouteParam(route: string): string {
  const queryStart = route.indexOf('?');
  if (queryStart < 0) return route;
  const path = route.slice(0, queryStart);
  const params = new URLSearchParams(route.slice(queryStart + 1));
  params.delete('shell');
  params.delete('locale');
  params.delete('runtimeVersion');
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
