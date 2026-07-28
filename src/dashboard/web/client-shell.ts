export type DashboardClientShell = 'desktop' | 'mobile';

const CLIENT_SHELL_PARAM = 'botmuxClientShell';
const CLIENT_SHELLS = new Set<DashboardClientShell>(['desktop', 'mobile']);

function normalizeClientShell(value: string | null): DashboardClientShell | null {
  return value && CLIENT_SHELLS.has(value as DashboardClientShell)
    ? value as DashboardClientShell
    : null;
}

/**
 * Upgrade a legacy hash-scoped shell marker into the durable URL query.
 * Returns the replacement URL, or null when no rewrite is needed/possible.
 */
export function canonicalDashboardClientShellUrl(href: string): string | null {
  try {
    const url = new URL(href);
    if (normalizeClientShell(url.searchParams.get(CLIENT_SHELL_PARAM))) return null;

    const queryIndex = url.hash.indexOf('?');
    if (queryIndex < 0) return null;
    const hashParams = new URLSearchParams(url.hash.slice(queryIndex + 1));
    const shell = normalizeClientShell(hashParams.get(CLIENT_SHELL_PARAM));
    if (!shell) return null;

    const hashPath = url.hash.slice(0, queryIndex) || '#/';
    hashParams.delete(CLIENT_SHELL_PARAM);
    const remainingHashQuery = hashParams.toString();
    url.searchParams.set(CLIENT_SHELL_PARAM, shell);
    url.hash = remainingHashQuery ? `${hashPath}?${remainingHashQuery}` : hashPath;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Detect the restricted Desktop/Mobile dashboard shell.
 *
 * The query-string form is canonical because hash navigation must not clear
 * the shell boundary. Reading the hash form as a compatibility fallback lets
 * old one-time open links reach the shell long enough to be redirected.
 */
export function readDashboardClientShell(
  search = typeof location === 'undefined' ? '' : location.search,
  hash = typeof location === 'undefined' ? '' : location.hash,
): DashboardClientShell | null {
  const fromSearch = normalizeClientShell(
    new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
      .get(CLIENT_SHELL_PARAM),
  );
  if (fromSearch) return fromSearch;

  const queryIndex = hash.indexOf('?');
  if (queryIndex < 0) return null;
  return normalizeClientShell(
    new URLSearchParams(hash.slice(queryIndex + 1)).get(CLIENT_SHELL_PARAM),
  );
}

/** Workflow is deliberately outside the Botmux Desktop/Mobile integration. */
export function isWorkflowDashboardHash(hash: string): boolean {
  const path = (hash.split('?')[0] || '#/').toLowerCase();
  return (
    path === '#/workflows' ||
    path.startsWith('#/workflows/') ||
    path.startsWith('#/workflows-') ||
    path === '#/v3' ||
    path.startsWith('#/v3/') ||
    path.startsWith('#/v3?') ||
    path === '#/legacy-workflow' ||
    path.startsWith('#/legacy-workflow/')
  );
}

/** Monitor Room is a web-terminal surface and is owned by the native client. */
export function isWebTerminalDashboardHash(hash: string): boolean {
  const path = (hash.split('?')[0] || '#/').toLowerCase();
  return path === '#/monitor-room' || path.startsWith('#/monitor-room/');
}

/**
 * Embedded Desktop/Mobile dashboards must never offer web terminal actions.
 *
 * The native Botmux Sessions surface owns terminal attachment in those clients;
 * keeping this decision beside the shell parser prevents a future UI control
 * from accidentally minting a write link that the Electron boundary rejects.
 */
export function dashboardShellAllowsWebTerminal(
  search = typeof location === 'undefined' ? '' : location.search,
  hash = typeof location === 'undefined' ? '' : location.hash,
): boolean {
  return readDashboardClientShell(search, hash) === null;
}

/** Resolve unsupported embedded routes before the lazy page module is loaded. */
export function dashboardClientShellRedirect(
  hash: string,
  search = typeof location === 'undefined' ? '' : location.search,
): '#/' | '#/sessions' | null {
  if (!readDashboardClientShell(search, hash)) return null;
  if (isWorkflowDashboardHash(hash)) return '#/';
  if (isWebTerminalDashboardHash(hash)) return '#/sessions';
  return null;
}
