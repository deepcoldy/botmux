/**
 * Physical identity of the TRAE CLI skills cache shared by every managed
 * runtime.
 *
 * Why the skills directory and not the CLI install path: TRAE's `.system`
 * skills cache lives at `<TRAE_HOME>/skills/.system`. Different installs,
 * different bots and different `TRAE_HOME` layouts can all resolve to the SAME
 * physical cache (a symlinked skills dir, a bind alias, a sandbox mapping).
 * A registry keyed by install path or bot id would therefore split one real
 * shared domain into several independent locks and allow mixed versions to
 * write the same cache again.
 *
 * The key is `sha256(dev:ino(realpath(<TRAE_HOME>/skills)))`. The skills root
 * exists before `.system` is created and is NOT deleted when TRAE rebuilds the
 * cache, so the key is stable across marker rebuilds. Registry metadata must
 * never live inside `.system` for the same reason.
 */
import { createHash } from 'node:crypto';
import { accessSync, constants, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TRAEX_RUNTIME_LOCK_NAME = '.botmux-traex-runtime.lock';
export const TRAEX_RUNTIME_REGISTRY_NAME = '.botmux-traex-runtime.json';
export const TRAEX_RUNTIME_LOCK_TIMEOUT_MS = 5_000;

export interface TraexRuntimeDomain {
  /** Canonical physical path of `<TRAE_HOME>/skills`. */
  skillsDir: string;
  /** Stable across `.system` rebuilds and independent of path text. */
  domainKey: string;
  /** `<skillsDir>/.botmux-traex-runtime.lock` — one real file for one cache. */
  lockPath: string;
  registryPath: string;
}

export type TraexDomainResolution =
  | { kind: 'ready'; domain: TraexRuntimeDomain }
  | {
      kind: 'uncoordinated';
      reason:
        | 'trae-home-unavailable'
        | 'skills-dir-unavailable'
        | 'skills-dir-not-writable'
        | 'identity-unprovable';
      detail?: string;
    };

/** `<TRAE_HOME>/skills` for this process, honouring the worker's per-bot home. */
export function traexHomeForDomain(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TRAE_HOME?.trim();
  return configured && configured.length > 0 ? configured : join(homedir(), '.trae');
}

/**
 * Resolve the one physical coordination root for a TRAE skills cache.
 *
 * The skills directory is pre-created when missing: creating it here (instead
 * of letting the CLI create it later) is what keeps the domain key stable
 * between "cache not yet created" and "cache created", a round-3 review gap.
 *
 * A non-writable directory is NOT downgraded to a per-bot lock. Two bots would
 * then hold different locks over the same cache and the gate would silently
 * stop working, so this returns `uncoordinated` and the caller must refuse to
 * start (fail closed).
 */
export function resolveTraexRuntimeDomain(
  traeHome: string = traexHomeForDomain(),
): TraexDomainResolution {
  if (!traeHome) return { kind: 'uncoordinated', reason: 'trae-home-unavailable' };
  const skillsDir = join(traeHome, 'skills');
  let physical: string;
  try {
    mkdirSync(skillsDir, { recursive: true });
    physical = realpathSync(skillsDir);
  } catch (err) {
    return {
      kind: 'uncoordinated',
      reason: 'skills-dir-unavailable',
      detail: errorText(err),
    };
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(physical, { bigint: true });
    if (!stat.isDirectory()) {
      return { kind: 'uncoordinated', reason: 'identity-unprovable', detail: `${physical} is not a directory` };
    }
  } catch (err) {
    return { kind: 'uncoordinated', reason: 'identity-unprovable', detail: errorText(err) };
  }
  try {
    accessSync(physical, constants.W_OK);
  } catch (err) {
    return { kind: 'uncoordinated', reason: 'skills-dir-not-writable', detail: errorText(err) };
  }
  const domainKey = createHash('sha256')
    .update(`${stat.dev}:${stat.ino}`)
    .digest('hex');
  return {
    kind: 'ready',
    domain: {
      skillsDir: physical,
      domainKey,
      lockPath: join(physical, TRAEX_RUNTIME_LOCK_NAME),
      registryPath: join(physical, TRAEX_RUNTIME_REGISTRY_NAME),
    },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
