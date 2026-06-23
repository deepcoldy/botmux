/**
 * Update check: query the published "latest" botmux version and the GitHub
 * release notes accumulated since the running version. Powers the Settings
 * "version & update" card (manual update flow) — see dashboard.ts /api/update/*.
 *
 * Every network call is best-effort: timeout-bounded and returns null / [] on
 * failure (offline, rate-limited, registry hiccup) so the card degrades to
 * "couldn't check" rather than erroring. The version math is pure (unit tested).
 */
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

const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/botmux/latest';

export interface FetchOpts {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * The npm `latest` dist-tag version — the authoritative target of
 * `npm install -g botmux@latest`. null on any failure (offline, non-200,
 * malformed body, or a version string we can't parse).
 */
export async function fetchLatestVersion(opts?: FetchOpts): Promise<string | null> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(REGISTRY_LATEST_URL, {
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
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'botmux' },
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
