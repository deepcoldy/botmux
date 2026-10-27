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
