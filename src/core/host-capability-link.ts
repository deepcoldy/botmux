/**
 * Shapes of the capability links the host builds for its own Web terminal,
 * Dashboard, workflow entry, decision-board item and plugin result pages.
 * Without a public external host these point at this machine's own interface
 * (getLocalIp fallback), and the Lark local-address policy lets a card link
 * field through only when it has one of these shapes. The judgment reads the
 * URL and configuration only, so the daemon, a `botmux send` process and a
 * restarted daemon all agree on the same body, as long as they see the same
 * Dashboard port: a sandbox with its own HOME cannot read the recorded one
 * and only knows the configured port.
 *
 * A model can still spell a link of the same shape; the page behind it checks
 * its own session, capability or login, so a guessed one opens nothing.
 * Anything else on these hosts, including other paths, routes and query
 * parameters on the Dashboard port, is not a host link.
 *
 * Kept import-free so the Lark client can depend on it without pulling in the
 * URL builders' module graph.
 */
export interface HostLinkScope {
  /** Hosts the URL builders put in links (Web terminal and Dashboard external host). */
  hosts: readonly string[];
  /** Ports the Dashboard answers on; a bare root is only a host page there.
   *  The terminal root is refused only on listed ports: an empty list refuses none. */
  dashboardPorts: readonly string[];
}

const ID = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}';
const CAPABILITY = /^[A-Za-z0-9_-]{20,512}$/;
const TERMINAL_PATH = new RegExp(`^/s/${ID}$`);
const DASHBOARD_PATH = new RegExp(`^/(?:workbench|plugin-result-access/[A-Za-z0-9_-]{20,256}|board/[A-Za-z0-9_-]{1,64}/\\d{1,9}|workflow/[A-Za-z0-9_-]{1,64}/${ID})$`);
const DASHBOARD_ROUTE = new RegExp(`^#/(?:(?:v3|workflows)/${ID}|sessions\\?session=${ID}|agent-workbench(?:-dock)?(?:\\?botmuxWorkbenchShell=immersive)?)$`);

function normalizedHost(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** No query, or a single parameter from `names` carrying an opaque capability. */
function capabilityQuery(url: URL, names: readonly string[]): 'none' | 'one' | 'other' {
  if (!url.search) return 'none';
  const entries = [...url.searchParams];
  if (entries.length !== 1) return 'other';
  const [name, value] = entries[0]!;
  return names.includes(name) && CAPABILITY.test(value) ? 'one' : 'other';
}

export function isHostCapabilityLink(value: string, scope: HostLinkScope): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'http:' || url.username || url.password) return false;
  if (!scope.hosts.some(host => host && normalizedHost(host) === normalizedHost(url.hostname))) return false;
  const port = url.port || '80';
  const terminal = capabilityQuery(url, ['token', 'viewToken']);
  if (!url.hash && terminal !== 'other') {
    if (TERMINAL_PATH.test(url.pathname)) return true;
    if (url.pathname === '/' && terminal === 'one' && !scope.dashboardPorts.includes(port)) return true;
  }
  if (!scope.dashboardPorts.includes(port)) return false;
  const dashboard = capabilityQuery(url, ['t']);
  if (dashboard === 'other') return false;
  if (url.pathname === '/') return !url.hash || DASHBOARD_ROUTE.test(url.hash);
  if (url.hash || !DASHBOARD_PATH.test(url.pathname)) return false;
  return url.pathname === '/workbench' || dashboard === 'none';
}
