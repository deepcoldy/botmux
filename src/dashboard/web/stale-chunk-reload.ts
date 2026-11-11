export interface StaleChunkReloadEnv {
  href: string;
  hash: string;
  sessionStorage: Pick<Storage, 'getItem' | 'setItem'>;
  reload(): void;
}

export interface BrowserStaleChunkReloadEnv {
  href: string;
  hash: string;
  getSessionStorage(): Pick<Storage, 'getItem' | 'setItem'>;
  reload(): void;
}

const STALE_CHUNK_RELOAD_KEY_PREFIX = 'botmux.dashboard.stale-chunk-reload.v1:';
const DYNAMIC_IMPORT_ERROR_RE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|dynamically imported module/i;
const MISSING_EXPORT_ERROR_RE = /(?:does not|doesn't) provide an export named/i;
const MODULE_URL_RE = /(?:https?:\/\/|\/assets\/|\.{1,2}\/)[^\s"'<>]+?\.js\b/;
const DASHBOARD_CHUNK_URL_RE = /(?:\/chunks\/|\/chunk-)[^/?#]+\.js$/;

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export function isLikelyStaleRouteChunkError(err: unknown): boolean {
  const text = errorText(err);
  if (DYNAMIC_IMPORT_ERROR_RE.test(text)) return true;
  // An old successful shim response may still be in the browser's module map.
  // Recognize its linking error, without reloading for unrelated module bugs.
  const moduleUrl = text.match(MODULE_URL_RE)?.[0];
  return MISSING_EXPORT_ERROR_RE.test(text) && !!moduleUrl && DASHBOARD_CHUNK_URL_RE.test(moduleUrl);
}

function reloadKeyFor(err: unknown, env: StaleChunkReloadEnv): string {
  const text = errorText(err);
  const moduleUrl = text.match(MODULE_URL_RE)?.[0];
  const source = moduleUrl || `${env.href}|${env.hash}`;
  return `${STALE_CHUNK_RELOAD_KEY_PREFIX}${source.slice(-240)}`;
}

export function maybeReloadForStaleRouteChunk(err: unknown, env: StaleChunkReloadEnv): boolean {
  if (!isLikelyStaleRouteChunkError(err)) return false;

  const key = reloadKeyFor(err, env);
  try {
    // A loaded app.js can survive a dashboard upgrade and still point at
    // removed content-hashed chunks. Reload once to fetch the current shell,
    // but persist the guard so a real network/build failure does not loop.
    if (env.sessionStorage.getItem(key) === '1') return false;
    env.sessionStorage.setItem(key, '1');
  } catch {
    return false;
  }

  env.reload();
  return true;
}

export function maybeReloadBrowserForStaleRouteChunk(err: unknown, env: BrowserStaleChunkReloadEnv): boolean {
  if (!isLikelyStaleRouteChunkError(err)) return false;

  let sessionStorage: Pick<Storage, 'getItem' | 'setItem'>;
  try {
    // Some embedded/browser contexts can throw while reading the storage getter.
    // Keep the original route error path instead of replacing it with a
    // SecurityError when the reload guard cannot be persisted.
    sessionStorage = env.getSessionStorage();
  } catch {
    return false;
  }

  return maybeReloadForStaleRouteChunk(err, { ...env, sessionStorage });
}
