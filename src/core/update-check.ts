/**
 * Update check: query the published "latest" botmux version and the GitHub
 * release notes accumulated since the running version. Powers the Settings
 * "version & update" card (manual update flow) — see dashboard.ts /api/update/*.
 *
 * The `latest` lookup MUST go through the registry npm is actually configured
 * to use (`npm config get registry`): the update button installs with the
 * owning package manager, which resolves through that same .npmrc family.
 * Checking the public registry while installing through a lagging mirror made
 * the card advertise upgrades that could never install. The public registry is
 * only a fallback for when the npm config can't be read (npm missing/unusual
 * PATH). The ROLLBACK packument lookup, by contrast, deliberately stays
 * public: the rollback install pins the registry to public too
 * (`withGlobalInstallRegistry` in global-install.ts, rollback-only opt-in),
 * and the allow-list validated against this packument must match the source
 * that pin installs from.
 *
 * Every network call is best-effort: timeout-bounded and returns null / [] on
 * failure (offline, rate-limited, registry hiccup) so the card degrades to
 * "couldn't check" rather than erroring. The version math is pure (unit tested).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { githubAuthHeaders, type GithubAuthResolveOptions } from './github-auth.js';
import { GITHUB_REPO } from './restart-report.js';

export interface ReleaseNote {
  /** Semver without leading 'v' (e.g. "2.85.1"). */
  version: string;
  /** Release display name / title (GitHub `name`), falls back to the tag. */
  name: string;
  /** Markdown release body (the CI-published changelog). */
  body: string;
  /** Canonical release URL. */
  url: string;
  /** ISO publish timestamp, or null. */
  publishedAt: string | null;
}

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers ([] for a stable release). */
  pre: string[];
}

/** Parse "X.Y.Z" / "vX.Y.Z" / "X.Y.Z-canary.1". null on anything else. */
export function parseVersion(raw: string): ParsedVersion | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  };
}

/** A stable (non-prerelease) semver string. */
export function isStableVersion(raw: string): boolean {
  const v = parseVersion(raw);
  return !!v && v.pre.length === 0;
}

/** Canonical stable package version accepted from a privileged API body. */
export function isCanonicalStableVersion(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length > 32) return false;
  const match = raw.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  return !!match && match.slice(1).every(part => Number.isSafeInteger(Number(part)));
}

/**
 * Semver precedence: -1 if a<b, 0 if equal, 1 if a>b. An unparseable version
 * sorts smallest (so garbage never masquerades as "newer"). A stable release
 * outranks a pre-release of the same X.Y.Z, and pre-release identifiers compare
 * per semver §11 (numeric < numeric numerically, alphanumeric lexically,
 * numeric < alphanumeric, a longer set of identifiers > a shorter prefix).
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  // Equal core. A release with no pre-release ranks above one that has it.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // shorter identifier set is smaller
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1; // numeric identifiers rank below alphanumeric
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Is `latest` strictly newer than `current`? */
export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

function vtag(v: string): string {
  return v.startsWith('v') ? v : `v${v}`;
}

/** Fallback registry when the npm config can't be read (npm missing, odd PATH). */
const PUBLIC_REGISTRY = 'https://registry.npmjs.org/';

/**
 * Normalize a raw registry value (`npm config get registry` output or a
 * caller-supplied string) to a base URL with a trailing slash. npm prints the
 * value as the last stdout line, but wrapper shims (nvm, corp-managed npm) may
 * print banners first — so scan from the end and take the first line that
 * parses as an http(s) URL. null when nothing does — garbage is never
 * interpolated into a fetch target.
 */
export function normalizeRegistryBase(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = lines[i].trim().replace(/^["']|["']$/g, '');
    if (/^https?:\/\/\S+$/.test(v)) return v.endsWith('/') ? v : `${v}/`;
  }
  return null;
}

/** `GET {registry}botmux/{tag}` — the dist-tag or version manifest. */
export function registryDistTagUrl(base: string, tag: string = 'latest'): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}botmux/${encodeURIComponent(tag.trim().replace(/^@/, ''))}`;
}

/** `GET {registry}botmux/latest` — the dist-tag manifest `@latest` installs. */
export function registryLatestUrl(base: string): string {
  return registryDistTagUrl(base, 'latest');
}

/** `GET {registry}botmux` — the packument behind the rollback picker. */
export function registryPackumentUrl(base: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}botmux`;
}

/**
 * Read `npm config get registry` (honors user/global/project .npmrc and
 * NPM_CONFIG_REGISTRY). Async spawn — the dashboard must not block on npm CLI
 * startup (~0.5-1s). Exported for tests only.
 *
 * Hang-hardened for wrapper shims (nvm, corp-managed npm): a shim may spawn a
 * long-lived grandchild that inherits the stdout pipe. Killing only the shim
 * then leaves the grandchild holding the pipe, 'close' never fires, and the
 * promise would hang forever — pinning the module's in-flight guard and
 * killing every later version check in the process. Two bounds instead:
 * (1) shim exited but the pipe is still held → the output is already ours,
 *     settle after a grace period WITHOUT killing the grandchild (it may be a
 *     legitimate resident process the shim started for unrelated reasons);
 * (2) npm itself hung → kill the whole process group (taskkill /T on Windows).
 */
export function spawnNpmConfigRegistry(): Promise<string> {
  return new Promise(resolve => {
    // Explicit type: settle() below references `child` from a closure created
    // before the assignment, so `let child;`'s evolving-any can't be inferred.
    let child: ChildProcess;
    let killTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (value: string): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      // Release our read end and drop the data listener: a pipe-holding
      // grandchild would otherwise keep the fd open AND keep `out` growing
      // (unbounded memory) for as long as it writes to the dead pipe.
      try { child.stdout?.destroy(); } catch { /* already closed */ }
      resolve(value);
    };
    try {
      child = spawn('npm', ['config', 'get', 'registry'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: process.platform === 'win32', // resolve npm.cmd on Windows
        // Own process group (POSIX): a timeout kill then reaches the shim's
        // descendants too, not just the shim itself.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch {
      resolve('');
      return;
    }
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', () => settle(''));
    // (2) The child itself is hung. Kill the group; 'exit' follows, and (1)
    // below settles even if a setsid-style escapee still holds the pipe.
    killTimer = setTimeout(() => {
      try {
        if (child.pid === undefined) return;
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch { /* already gone */ }
    }, 5_000).unref();
    // (1) npm exited but 'close' hasn't fired → a grandchild holds the pipe.
    // We already have the output; stop waiting instead of hanging forever.
    child.on('exit', () => {
      graceTimer = setTimeout(() => settle(out), 1_000).unref();
    });
    // Normal path: all stdio closed right after exit — settle immediately.
    child.on('close', () => settle(out));
  });
}

let npmRegistryBase: string | null = null;   // successful reads only
let npmRegistryInFlight: Promise<string> | null = null;

/**
 * The registry base package-manager installs resolve through. A successful
 * read is cached for the process lifetime (registry config rarely changes,
 * and the update flow restarts the process anyway when it matters). A failed
 * read is NOT cached — a transient spawn failure at startup would otherwise
 * pin the fallback (public registry) forever, re-introducing the very
 * check/install mismatch this module exists to prevent. Retrying is naturally
 * rate-limited by the caller's version cache. The reader is injectable so
 * tests can cover the cache policy itself (exported for tests only).
 */
export function resolveNpmRegistryBase(read: () => Promise<string> = spawnNpmConfigRegistry): Promise<string> {
  if (npmRegistryBase) return Promise.resolve(npmRegistryBase);
  npmRegistryInFlight ??= read()
    .then(raw => {
      const base = normalizeRegistryBase(raw);
      if (base) npmRegistryBase = base;
      return base ?? PUBLIC_REGISTRY;
    })
    .finally(() => { npmRegistryInFlight = null; });
  return npmRegistryInFlight;
}

/** Resolve the fetch base for a registry lookup: the opts override (tests)
 *  when given, else the npm-configured registry with public fallback. */
async function effectiveRegistryBase(registry?: string): Promise<string> {
  return registry !== undefined
    ? (normalizeRegistryBase(registry) ?? PUBLIC_REGISTRY)
    : resolveNpmRegistryBase();
}

export interface FetchOpts {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  auth?: GithubAuthResolveOptions;
  /** Registry base override (tests / callers that already know it). Invalid
   *  values fall back to the public registry, mirroring runtime behavior. */
  registry?: string;
}

export interface ParsedUpdateTarget {
  raw: string;
  tag: string;
  spec: string;
  isChannel: boolean;
  isExplicit: boolean;
}

export const KNOWN_CHANNELS = new Set(['latest', 'canary', 'beta', 'rc', 'next']);

/**
 * Parse a user-supplied update target into a normalized channel or version spec.
 * Returns null if the target is invalid, malformed, an unallowed package source,
 * or a semver range/wildcard (e.g. `x`, `X`, `vx`, `v3`, `3.x`, `*`).
 *
 * Per npm dist-tag rules (https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/#caveats),
 * tags must not parse as semver ranges or versions. To ensure safety across all install
 * methods, botmux only accepts explicitly known release channels or exact semver versions.
 *
 * Supports:
 * - empty / undefined -> latest (botmux@latest, isExplicit: false)
 * - 'latest', '@latest', '--latest', 'botmux@latest' -> latest (botmux@latest, isExplicit: true)
 * - 'canary', '@canary', '--canary', 'botmux@canary' -> canary (botmux@canary, isExplicit: true)
 * - 'beta', '@beta', '--beta' -> beta (botmux@beta, isExplicit: true)
 * - 'rc', '@rc', '--rc' -> rc (botmux@rc, isExplicit: true)
 * - 'next', '@next', '--next' -> next (botmux@next, isExplicit: true)
 * - '3.28.0', 'v3.28.0', '@3.28.0', 'botmux@3.28.0' -> 3.28.0 (botmux@3.28.0, isExplicit: true)
 */
export function parseUpdateTarget(rawInput?: string): ParsedUpdateTarget | null {
  const raw = (rawInput ?? '').trim();
  if (!raw) {
    return { raw: '', tag: 'latest', spec: 'botmux@latest', isChannel: true, isExplicit: false };
  }
  let cleaned = raw;
  if (cleaned.toLowerCase().startsWith('botmux@')) {
    cleaned = cleaned.slice(7).trim();
  } else if (cleaned.startsWith('@')) {
    cleaned = cleaned.slice(1).trim();
  } else if (cleaned.startsWith('--')) {
    cleaned = cleaned.slice(2).trim();
  }

  // Reject empty cleaned token or tokens containing forbidden characters
  // (e.g. URLs, npm: aliases, git references, file paths, ranges)
  if (!cleaned || /[:/\\?#%^~@]/.test(cleaned)) {
    return null;
  }

  const lower = cleaned.toLowerCase();
  if (KNOWN_CHANNELS.has(lower)) {
    return { raw, tag: lower, spec: `botmux@${lower}`, isChannel: true, isExplicit: true };
  }
  const v = cleaned.replace(/^v/i, '');
  if (parseVersion(v)) {
    return { raw, tag: v, spec: `botmux@${v}`, isChannel: false, isExplicit: true };
  }
  return null;
}

/**
 * The dist-tag version (e.g. `latest`, `canary`, `beta`, `rc`, `next`) or specific
 * manifest version on the registry npm is configured to use.
 * null on any failure.
 */
export async function fetchDistTagVersion(tag: string = 'latest', opts?: FetchOpts): Promise<string | null> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const cleanTag = tag.trim().replace(/^@/, '');
  try {
    const base = await effectiveRegistryBase(opts?.registry);
    const res = await fetchImpl(registryDistTagUrl(base, cleanTag), {
      headers: { Accept: 'application/json', 'User-Agent': 'botmux' },
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 8_000),
    });
    if (!res.ok) return null;
    const body = await res.json() as { version?: unknown };
    return typeof body?.version === 'string' && parseVersion(body.version) ? body.version : null;
  } catch {
    return null;
  }
}

/**
 * The `latest` dist-tag version on the registry npm is configured to use —
 * the authoritative target of a `@latest` update. null on any failure
 * (offline, non-200, malformed body, or a version string we can't parse).
 */
export async function fetchLatestVersion(opts?: FetchOpts): Promise<string | null> {
  return fetchDistTagVersion('latest', opts);
}

/**
 * Decision helper for standalone binary self-update:
 * - When target is implicit (default `botmux update`), only update if resolvedVersion is strictly newer than current.
 * - When target is explicit (e.g. `botmux update latest` or `botmux update canary`), allow switching or aligning to
 *   the target version whenever resolvedVersion !== currentVersion (e.g. returning to stable latest from canary).
 */
export function shouldApplySelfUpdate(
  target: ParsedUpdateTarget,
  resolvedVersion: string,
  currentVersion: string,
): { proceed: boolean; reason?: 'already_latest' | 'already_at_target' } {
  if (!target.isExplicit && !isNewerVersion(resolvedVersion, currentVersion)) {
    return { proceed: false, reason: 'already_latest' };
  }
  if (resolvedVersion === currentVersion) {
    return { proceed: false, reason: 'already_at_target' };
  }
  return { proceed: true };
}

export interface RollbackVersion {
  version: string;
  publishedAt: string | null;
}

export interface RollbackVersionsResult {
  ok: boolean;
  versions: RollbackVersion[];
}

/** Stable published versions older than `current`, newest first. */
export function selectRollbackVersions(raw: unknown, current: string, max = 3): RollbackVersion[] {
  if (!raw || typeof raw !== 'object') return [];
  const packument = raw as Record<string, unknown>;
  if (!packument.versions || typeof packument.versions !== 'object') return [];
  const time = packument.time && typeof packument.time === 'object'
    ? packument.time as Record<string, unknown>
    : {};
  return Object.entries(packument.versions as Record<string, unknown>)
    .filter(([version, manifest]) => isCanonicalStableVersion(version)
      && !!manifest
      && typeof manifest === 'object'
      && (manifest as Record<string, unknown>).version === version
      && compareVersions(version, current) < 0)
    .map(([version]) => version)
    .sort((a, b) => compareVersions(b, a))
    .slice(0, max)
    .map(version => ({
      version,
      publishedAt: typeof time[version] === 'string' ? time[version] : null,
    }));
}

/**
 * Fetch the packument used to offer an allow-listed rollback target.
 * Deliberately PUBLIC, not the npm-configured registry: the rollback install
 * pins its registry to public too (`withGlobalInstallRegistry`, rollback-only
 * opt-in in global-install.ts), and the allow-list validated against this
 * packument must match the source that pin installs from. Following the
 * configured registry here would break rollback for whitelists that don't
 * proxy botmux (lookup 503 → versions_unavailable) even though the pinned
 * public install would have worked. (`opts.registry` does not apply here.)
 */
export async function fetchRollbackVersions(
  current: string,
  opts?: FetchOpts & { max?: number },
): Promise<RollbackVersionsResult> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(registryPackumentUrl(PUBLIC_REGISTRY), {
      headers: { Accept: 'application/json', 'User-Agent': 'botmux' },
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 8_000),
    });
    if (!res.ok) return { ok: false, versions: [] };
    const raw = await res.json();
    if (!raw || typeof raw !== 'object' || !(raw as Record<string, unknown>).versions) {
      return { ok: false, versions: [] };
    }
    return { ok: true, versions: selectRollbackVersions(raw, current, opts?.max ?? 3) };
  } catch {
    return { ok: false, versions: [] };
  }
}

export interface ChangelogResult {
  /** false when the GitHub fetch failed (offline / rate-limited / malformed) —
   *  the caller shows a "view on GitHub" fallback instead of "no releases". */
  ok: boolean;
  /** true on HTTP 403 — GitHub's unauthenticated API is 60 req/h per IP, easily
   *  exhausted behind shared NAT. Lets the UI explain the failure precisely. */
  rateLimited?: boolean;
  releases: ReleaseNote[];
}

/**
 * Stable GitHub releases strictly newer than `current`, newest first, capped at
 * `max`. Pre-releases (canary/beta/rc) are excluded — the card mirrors exactly
 * what `@latest` would install. Returns `{ ok:false }` on any failure so the UI
 * distinguishes "couldn't load" from a genuinely empty (already-latest) list.
 */
export async function fetchReleasesSince(
  current: string,
  opts?: FetchOpts & { max?: number },
): Promise<ChangelogResult> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'botmux',
        ...githubAuthHeaders(opts?.auth),
      },
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 8_000),
    });
    if (!res.ok) return { ok: false, rateLimited: res.status === 403, releases: [] };
    const raw = await res.json();
    if (!Array.isArray(raw)) return { ok: false, releases: [] };
    return { ok: true, releases: selectReleasesSince(raw, current, opts?.max ?? 30) };
  } catch {
    return { ok: false, releases: [] };
  }
}

/**
 * Pure: filter the raw GitHub releases array to published, stable notes strictly
 * newer than `current`, newest first, capped at `max`. Exported for tests.
 */
export function selectReleasesSince(raw: unknown[], current: string, max = 30): ReleaseNote[] {
  const notes: ReleaseNote[] = [];
  for (const item of raw) {
    const r = item as Record<string, unknown>;
    if (!r || typeof r !== 'object') continue;
    if (r.draft === true || r.prerelease === true) continue;
    const tag = typeof r.tag_name === 'string' ? r.tag_name : '';
    const version = tag.replace(/^v/i, '');
    if (!isStableVersion(version)) continue;
    if (compareVersions(version, current) <= 0) continue;
    notes.push({
      version,
      name: typeof r.name === 'string' && r.name.trim() ? r.name : tag,
      body: typeof r.body === 'string' ? r.body : '',
      url: typeof r.html_url === 'string' ? r.html_url : `https://github.com/${GITHUB_REPO}/releases/tag/${vtag(version)}`,
      publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
    });
  }
  notes.sort((a, b) => compareVersions(b.version, a.version));
  return notes.slice(0, max);
}
