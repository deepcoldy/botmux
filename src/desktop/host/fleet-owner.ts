import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FleetState } from '../../core/fleet-supervisor-policy.js';
import type { ExternalRuntimeCandidate } from '../main/runtime-service.js';

export interface FleetOwnerDeps {
  /** Absolute path of the binary the app runs the fleet from. */
  bundledExecPath: string;
  readState: () => FleetState | null;
  pidAlive: (pid: number) => boolean;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  readVersion?: (packageJsonPath: string) => string;
  /** `<binary> --version` for a compiled-binary owner; '' when unknown. */
  probeVersion?: (binary: string) => string;
}

/**
 * Who runs the live fleet. Three-way on purpose: "the app" must only ever mean a
 * supervisor whose entry IS the app runtime. A supervisor we cannot reconstruct a
 * launcher for (a checkout mid-`bun run build`, a deleted worktree) is still
 * SOMEONE ELSE'S fleet — treating it as the app's would let launch policy
 * restart it onto the app runtime and hand its updates to a daemon that is not
 * running the app runtime at all.
 */
export type FleetOwnership =
  | { kind: 'none' }
  | { kind: 'app' }
  | { kind: 'external'; runtime: ExternalRuntimeCandidate }
  | { kind: 'unknown-external'; entry: string | null };

/**
 * The supervisor records how it was launched (`supervisorEntry` +
 * `supervisorCommand` in fleet-state.json). A compiled binary records its own
 * executable; a Node/Bun install records `<root>/dist/index-supervisor.js` (or
 * `src/index-supervisor.ts` for the `supervisor:bun` dev chain) and the full
 * command line, whose prefix before the entry is the interpreter. Driving the
 * fleet through that same launcher keeps `botmux restart` from the app identical
 * to typing it in the owner's terminal.
 */
export function classifyFleetOwnership(deps: FleetOwnerDeps): FleetOwnership {
  const exists = deps.exists ?? existsSync;
  const realpath = deps.realpath ?? safeRealpath;
  const state = deps.readState();
  if (!state || !Number.isInteger(state.supervisorPid) || !deps.pidAlive(state.supervisorPid)) return { kind: 'none' };
  const entry = state.supervisorEntry;
  if (!entry) return { kind: 'unknown-external', entry: null };
  if (realpath(entry) === realpath(deps.bundledExecPath)) return { kind: 'app' };
  if (!exists(entry)) return { kind: 'unknown-external', entry };

  const script = /\.(?:[cm]?js|ts)$/.exec(entry);
  if (!script) {
    // Another compiled binary (install.sh / npm platform package).
    const probe = deps.probeVersion ?? probeVersionCached;
    return {
      kind: 'external',
      runtime: { kind: 'external', root: dirname(entry), cliPath: entry, binPath: entry, version: probe(entry), runtimeSource: 'global-cli' },
    };
  }

  // Same directory and extension as the entry: dist/cli.js, src/cli.ts.
  const cliPath = join(dirname(entry), `cli${script[0]}`);
  const interpreterPath = interpreterFromCommand(state.supervisorCommand, entry);
  if (!interpreterPath || !exists(interpreterPath) || !exists(cliPath)) return { kind: 'unknown-external', entry };
  const root = dirname(dirname(entry));
  const readVersion = deps.readVersion ?? readPackageVersion;
  return {
    kind: 'external',
    runtime: {
      kind: 'external',
      root,
      cliPath,
      binPath: cliPath,
      interpreterPath,
      version: readVersion(join(root, 'package.json')),
      runtimeSource: 'global-cli',
    },
  };
}

/** The external runtime to drive, when one can be driven; else null. */
export function resolveFleetOwner(deps: FleetOwnerDeps): ExternalRuntimeCandidate | null {
  const ownership = classifyFleetOwnership(deps);
  return ownership.kind === 'external' ? ownership.runtime : null;
}

const binaryVersionCache = new Map<string, string>();

function probeVersionCached(binary: string): string {
  let key = binary;
  try { key = `${binary}@${statSync(binary).mtimeMs}`; } catch { /* probe uncached */ }
  const cached = binaryVersionCache.get(key);
  if (cached !== undefined) return cached;
  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf-8',
    timeout: 15_000,
    env: { ...process.env, BOTMUX_INSTALL_PROBE: '1' },
  });
  const out = result.status === 0 ? result.stdout.trim() : '';
  const version = /^\d+\.\d+\.\d+/.test(out) ? out : '';
  binaryVersionCache.set(key, version);
  return version;
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
