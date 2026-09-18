import {
  WORKBENCH_SHELL_IMMERSIVE,
  WORKBENCH_SHELL_PARAM,
  type DashboardWorkbenchShell,
} from '../../core/workbench-shell.js';

export type DashboardClientShell = 'desktop' | 'mobile';

const CLIENT_SHELL_PARAM = 'botmuxClientShell';
const CLIENT_SHELLS = new Set<DashboardClientShell>(['desktop', 'mobile']);

function normalizeClientShell(value: string | null): DashboardClientShell | null {
  return value && CLIENT_SHELLS.has(value as DashboardClientShell)
    ? value as DashboardClientShell
    : null;
}

function normalizeWorkbenchShell(value: string | null): DashboardWorkbenchShell | null {
  return value === WORKBENCH_SHELL_IMMERSIVE ? value : null;
}

/**
 * Markers that must survive hash navigation. Both ride the hash on entry
 * (login redirects strip the query, browsers keep the fragment) and get
 * promoted into the durable URL query on boot by
 * {@link canonicalDashboardClientShellUrl}.
 */
const DURABLE_SHELL_MARKERS: ReadonlyArray<{
  param: string;
  normalize: (value: string | null) => string | null;
}> = [
  { param: CLIENT_SHELL_PARAM, normalize: normalizeClientShell },
  { param: WORKBENCH_SHELL_PARAM, normalize: normalizeWorkbenchShell },
];

/**
 * Upgrade hash-scoped shell markers (client shell, immersive workbench) into
 * the durable URL query. Returns the replacement URL, or null when no rewrite
 * is needed/possible. A marker already present in the query is left alone.
 */
export function canonicalDashboardClientShellUrl(href: string): string | null {
  try {
    const url = new URL(href);
    const queryIndex = url.hash.indexOf('?');
    if (queryIndex < 0) return null;
    const hashPath = url.hash.slice(0, queryIndex) || '#/';
    const hashParams = new URLSearchParams(url.hash.slice(queryIndex + 1));

    let moved = false;
    for (const { param, normalize } of DURABLE_SHELL_MARKERS) {
      if (normalize(url.searchParams.get(param))) continue;
      const value = normalize(hashParams.get(param));
      if (!value) continue;
      hashParams.delete(param);
      url.searchParams.set(param, value);
      moved = true;
    }
    if (!moved) return null;

    const remainingHashQuery = hashParams.toString();
    url.hash = remainingHashQuery ? `${hashPath}?${remainingHashQuery}` : hashPath;
    return url.toString();
  } catch {
    return null;
  }
}

/** Query-string form first (durable), hash form as the entry-time fallback. */
function readDurableShellMarker<T extends string>(
  param: string,
  normalize: (value: string | null) => T | null,
  search: string,
  hash: string,
): T | null {
  const fromSearch = normalize(
    new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get(param),
  );
  if (fromSearch) return fromSearch;

  const queryIndex = hash.indexOf('?');
  if (queryIndex < 0) return null;
  return normalize(new URLSearchParams(hash.slice(queryIndex + 1)).get(param));
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
  return readDurableShellMarker(CLIENT_SHELL_PARAM, normalizeClientShell, search, hash);
}

/**
 * Detect the immersive (chrome-less) Workbench entry — `/workbench`,
 * `/workbench-ticket/<ticket>` and the CLI / card links land here. Unlike the
 * client shell it only decides the Workbench surface: navigation filtering and
 * route redirects stay client-shell-only (see `core/workbench-shell.ts`).
 */
export function readDashboardWorkbenchShell(
  search = typeof location === 'undefined' ? '' : location.search,
  hash = typeof location === 'undefined' ? '' : location.hash,
): DashboardWorkbenchShell | null {
  return readDurableShellMarker(WORKBENCH_SHELL_PARAM, normalizeWorkbenchShell, search, hash);
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
