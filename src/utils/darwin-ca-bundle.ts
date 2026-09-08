/**
 * CA bundle selection for a sandboxed Codex CLI on macOS.
 *
 * npm Codex talks TLS through a Rust stack that does not read the macOS
 * keychain. Outside the sandbox it still finds a usable trust store; inside
 * Seatbelt that discovery comes up empty and every request dies with
 * `UnknownIssuer` — which surfaces as a session that produces NOTHING at all
 * (the model API call itself is TLS), so it reads as "the bot is dead" rather
 * than as a certificate problem. Pointing `SSL_CERT_FILE` at a concrete bundle
 * fixes it.
 *
 * This only picks a default. An `SSL_CERT_FILE` already present in the daemon's
 * environment is an operator decision and is left untouched by the caller.
 *
 * Two properties of this module are load-bearing:
 *
 *   1. `realpath`. The Seatbelt baseline exposes `/private/etc`, NOT the `/etc`
 *      symlink, so `/etc/ssl/cert.pem` is only readable inside the sandbox once
 *      it is resolved to `/private/etc/ssl/cert.pem`. Dropping the realpath as
 *      "redundant" silently removes the system candidate.
 *   2. Trust ordering. `SSL_CERT_FILE` defines the complete set of trust
 *      anchors the sandboxed CLI will accept, so a bundle that the agent's own
 *      uid can write is a bundle the agent can add a rogue CA to. Candidates
 *      owned by root and not group/world-writable are therefore preferred over
 *      a Homebrew-managed one, independent of list order. A writable bundle is
 *      still used as a last resort (a machine with no usable trust store is
 *      worse) but the caller is told, so the choice is visible.
 */
import { existsSync as fsExistsSync, realpathSync as fsRealpathSync, statSync as fsStatSync } from 'node:fs';

/** Probed in order; a trustworthy candidate wins over an earlier writable one. */
export const DARWIN_CODEX_CA_BUNDLE_CANDIDATES = [
  '/etc/ssl/cert.pem',
  '/opt/homebrew/etc/ca-certificates/cert.pem',
  '/usr/local/etc/ca-certificates/cert.pem',
] as const;

/** Injected seam: the real implementations come from node:fs. */
export interface CaBundleProbe {
  platform: string;
  candidates: readonly string[];
  exists(path: string): boolean;
  realpath(path: string): string;
  /** uid/mode of the resolved bundle; only ownership and write bits are read. */
  stat(path: string): { uid: number; mode: number };
  warn(message: string): void;
}

const DEFAULT_PROBE: CaBundleProbe = {
  platform: process.platform,
  candidates: DARWIN_CODEX_CA_BUNDLE_CANDIDATES,
  exists: (p) => fsExistsSync(p),
  realpath: (p) => fsRealpathSync(p),
  stat: (p) => {
    const s = fsStatSync(p);
    return { uid: s.uid, mode: s.mode };
  },
  warn: () => { /* caller opts in */ },
};

/** Root-owned and not writable by group or others. */
function trustworthy(probe: CaBundleProbe, resolved: string): boolean {
  try {
    const { uid, mode } = probe.stat(resolved);
    return uid === 0 && (mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/**
 * Resolved path of the CA bundle to hand a sandboxed Codex, or undefined when
 * this is not macOS or no candidate exists.
 */
export function resolveDarwinCodexCaBundle(overrides: Partial<CaBundleProbe> = {}): string | undefined {
  const probe: CaBundleProbe = { ...DEFAULT_PROBE, ...overrides };
  if (probe.platform !== 'darwin') return undefined;
  let writableFallback: string | undefined;
  for (const candidate of probe.candidates) {
    let resolved: string;
    try {
      if (!probe.exists(candidate)) continue;
      resolved = probe.realpath(candidate);
    } catch {
      continue;
    }
    if (trustworthy(probe, resolved)) return resolved;
    writableFallback ??= resolved;
  }
  if (writableFallback) {
    probe.warn(
      `[sandbox] CA bundle ${writableFallback} is not root-owned/read-only; using it for sandboxed Codex `
      + 'anyway, but anything running as this user can add trust anchors to it',
    );
  }
  return writableFallback;
}
