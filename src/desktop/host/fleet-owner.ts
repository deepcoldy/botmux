import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FleetState } from '../../core/fleet-supervisor-policy.js';
import type { ExternalRuntimeCandidate } from '../main/runtime-service.js';

export interface FleetOwnerDeps {
  /** Absolute path of the binary bundled in Botmux.app. */
  bundledExecPath: string;
  readState: () => FleetState | null;
  pidAlive: (pid: number) => boolean;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  readVersion?: (packageJsonPath: string) => string;
}

/**
 * Who owns the live fleet, when it is NOT the app's bundled binary.
 *
 * The supervisor records how it was launched (`supervisorEntry` +
 * `supervisorCommand` in fleet-state.json). A compiled binary records its own
 * executable; a Node/Bun install records `<root>/dist/index-supervisor.js` and the
 * full command line, whose prefix before the entry is the interpreter. Driving
 * the fleet through that same launcher is what keeps `botmux restart` from the
 * app identical to typing it in the owner's terminal.
 *
 * Returns null when no supervisor is alive, when the owner IS the bundled binary,
 * or when the launcher cannot be reconstructed (missing files); callers then fall
 * back to the bundled runtime.
 */
export function resolveFleetOwner(deps: FleetOwnerDeps): ExternalRuntimeCandidate | null {
  const exists = deps.exists ?? existsSync;
  const realpath = deps.realpath ?? safeRealpath;
  const state = deps.readState();
  if (!state || !Number.isInteger(state.supervisorPid) || !deps.pidAlive(state.supervisorPid)) return null;
  const entry = state.supervisorEntry;
  if (!entry || !exists(entry)) return null;
  if (realpath(entry) === realpath(deps.bundledExecPath)) return null;

  if (!entry.endsWith('.js')) {
    // Another compiled binary (install.sh / npm platform package).
    return {
      kind: 'external',
      root: dirname(entry),
      cliPath: entry,
      binPath: entry,
      version: '',
      runtimeSource: 'global-cli',
    };
  }

  const cliPath = join(dirname(entry), 'cli.js');
  const interpreterPath = interpreterFromCommand(state.supervisorCommand, entry);
  if (!interpreterPath || !exists(interpreterPath) || !exists(cliPath)) return null;
  const root = dirname(dirname(entry));
  const readVersion = deps.readVersion ?? readPackageVersion;
  return {
    kind: 'external',
    root,
    cliPath,
    binPath: cliPath,
    interpreterPath,
    version: readVersion(join(root, 'package.json')),
    runtimeSource: 'global-cli',
  };
}

/**
 * `/a b/bun --enable-source-maps /x/dist/index-supervisor.js` → `/a b/bun`.
 * Everything before the entry, minus trailing flag tokens, so interpreter paths
 * containing spaces survive.
 */
export function interpreterFromCommand(command: string | undefined, entry: string): string | null {
  if (!command) return null;
  const at = command.indexOf(entry);
  if (at <= 0) return null;
  const tokens = command.slice(0, at).trim().split(' ');
  while (tokens.length > 1 && tokens[tokens.length - 1]?.startsWith('-')) tokens.pop();
  const interpreter = tokens.join(' ').trim();
  return interpreter.startsWith('/') ? interpreter : null;
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const tagVersionCache = new Map<string, string>();

function readPackageVersion(packageJsonPath: string): string {
  try {
    const version = (JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: unknown }).version;
    if (typeof version === 'string' && version !== '0.0.0') return version;
  } catch { /* fall through to the checkout's tag */ }
  // Source checkouts keep package.json at 0.0.0; their nearest tag is what the
  // CLI itself reports. Cached per root: state is polled every few seconds.
  const root = dirname(packageJsonPath);
  const cached = tagVersionCache.get(root);
  if (cached !== undefined) return cached;
  const tag = spawnSync('git', ['-C', root, 'describe', '--tags', '--abbrev=0'], { encoding: 'utf-8', timeout: 3_000 });
  const version = tag.status === 0 ? tag.stdout.trim().replace(/^v/, '') : '';
  tagVersionCache.set(root, version);
  return version;
}
