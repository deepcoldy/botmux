/**
 * Install diagnostics for the manual-update preflight (Settings "version &
 * update" card): the running Node version, and whether more than one botmux
 * install is reachable on PATH.
 *
 * The multi-install check matters because an update only changes the copy
 * owned by the running install's package manager. If the active `botmux` is a
 * different install — the `~/.botmux/bin/botmux` source-checkout shim, or a
 * sibling Node version's global — the update silently doesn't take effect. We
 * surface every distinct install so the user can react before updating.
 *
 * The analysis core (analyzeInstalls / checkNode / parsing) is pure over
 * injected deps and unit tested; only the `which -a botmux` listing is wiring.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { isLocalDevInstallAt, botmuxVersion, botmuxInstallRoot } from './install-info.js';
import { detectGlobalInstallManager } from './global-install.js';
import { parseVersion } from '../core/update-check.js';

/** Minimum Node major (mirrors package.json `engines.node`). */
export const MIN_NODE_MAJOR = 22;

export interface NodeCheck {
  /** e.g. "v22.21.1" */
  version: string;
  major: number;
  required: number;
  ok: boolean;
}

/** Classify the running Node against the minimum major. Pure. */
export function checkNode(version: string = process.version, required = MIN_NODE_MAJOR): NodeCheck {
  const m = version.match(/v?(\d+)\./);
  const major = m ? Number(m[1]) : 0;
  return { version, major, required, ok: major >= required };
}

/**
 * The version to show in the update card. For an npm install this is the real
 * published version from package.json. A source checkout ships the unbuilt
 * `0.0.0` (CI injects the real version only at publish), so we derive a real
 * baseline from the latest git tag (`git describe --tags --abbrev=0` → the clean
 * tag, e.g. "v2.86.0", stripped of the leading v). That makes the version
 * display, "behind" comparison, and changelog range correct in dev mode too.
 * Falls back to the raw package.json version if git is unavailable.
 */
export function resolveCurrentVersion(): string {
  const raw = botmuxVersion();
  if (raw !== '0.0.0') return raw;
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
      cwd: botmuxInstallRoot(),
      encoding: 'utf-8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const ver = tag.replace(/^v/i, '');
    return parseVersion(ver) ? ver : raw;
  } catch {
    return raw; // no git / no tags / not a checkout
  }
}

export type InstallKind =
  | 'npm-global'
  | 'pnpm-global'
  | 'yarn-global'
  | 'bun-global'
  | 'source-checkout'
  | 'unknown';

export interface InstallEntry {
  /** The PATH entry that resolved to this install. */
  binPath: string;
  /** The install root we attribute it to (the dedup key). */
  root: string;
  kind: InstallKind;
}

export interface InstallDiagnostics {
  entries: InstallEntry[];
  /** true when more than one distinct install root is reachable on PATH. */
  multiple: boolean;
}

/** Filesystem deps, injectable for tests. */
export interface InstallProbeDeps {
  /** Read a bin file's text, or null (missing / binary / unreadable). */
  readFile: (path: string) => string | null;
  /** Resolve symlinks to a real path, or null on failure. */
  realpath: (path: string) => string | null;
  /** Does `root` look like a source checkout (has .git or src)? */
  isSourceCheckout: (root: string) => boolean;
}

/** A shim under 4 KiB is a tiny `exec node "<cli.js>"` wrapper; the real cli.js
 *  is hundreds of KiB, so a small file is the only one worth string-scanning. */
const MAX_SHIM_BYTES = 4096;

/** Resolve a `botmux` bin on PATH to the install root that runs it.
 *  - a `~/.botmux/bin/botmux` shim → the cli.js path it `exec`s
 *  - an npm-global symlink → the real `<pkg>/dist/cli.js` it points at
 *  Returns null when neither yields a cli.js path. */
function resolveBin(binPath: string, deps: InstallProbeDeps): { cliJs: string; root: string } | null {
  let cliJs: string | null = null;

  const content = deps.readFile(binPath);
  if (content && content.length < MAX_SHIM_BYTES) {
    // Require a path separator before cli.js so a bare "cli.js" literal inside
    // compiled code (if a binary slips through the size guard) can't match.
    const m = content.match(/"([^"]*[/\\]cli\.js)"/);
    if (m) cliJs = m[1];
  }
  if (!cliJs) {
    const real = deps.realpath(binPath);
    if (real && /cli\.js$/i.test(real)) cliJs = real;
  }
  if (!cliJs) return null;

  // <root>/dist/cli.js → <root>; otherwise the parent's parent.
  const root = /[/\\]dist[/\\]cli\.js$/i.test(cliJs)
    ? cliJs.replace(/[/\\]dist[/\\]cli\.js$/i, '')
    : dirname(dirname(cliJs));
  return { cliJs, root };
}

function classify(root: string, deps: InstallProbeDeps): InstallKind {
  if (deps.isSourceCheckout(root)) return 'source-checkout';
  const manager = detectGlobalInstallManager(root);
  if (manager !== 'unknown') return `${manager}-global`;
  return 'unknown';
}

/**
 * Pure: dedup the raw `which -a botmux` paths, resolve each to an install root,
 * and report whether more than one distinct install is present. Exported for
 * tests.
 */
export function analyzeInstalls(binPaths: string[], deps: InstallProbeDeps): InstallDiagnostics {
  const seenBin = new Set<string>();
  const seenRoot = new Set<string>();
  const entries: InstallEntry[] = [];
  for (const raw of binPaths) {
    const binPath = raw.trim();
    if (!binPath || seenBin.has(binPath)) continue;
    seenBin.add(binPath);
    const resolved = resolveBin(binPath, deps);
    const root = resolved?.root ?? binPath; // unresolvable → key by the bin path itself
    if (seenRoot.has(root)) continue;       // same install reached twice on PATH → one entry
    seenRoot.add(root);
    entries.push({ binPath, root, kind: resolved ? classify(root, deps) : 'unknown' });
  }
  return { entries, multiple: seenRoot.size > 1 };
}

const PROD_PROBE_DEPS: InstallProbeDeps = {
  readFile: (p) => {
    try {
      // Don't slurp a multi-hundred-KB cli.js just to scan for a shim path.
      if (statSync(p).size >= MAX_SHIM_BYTES) return null;
      return readFileSync(p, 'utf-8');
    } catch {
      return null;
    }
  },
  realpath: (p) => {
    try { return realpathSync(p); } catch { return null; }
  },
  isSourceCheckout: (root) => isLocalDevInstallAt(root),
};

/** List every `botmux` on PATH (best-effort; [] when the lookup tool fails). */
function listBotmuxBins(): string[] {
  try {
    const win = process.platform === 'win32';
    const out = execFileSync(win ? 'where' : 'which', win ? ['botmux'] : ['-a', 'botmux'], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return []; // `which` exits non-zero when nothing is found → no installs visible
  }
}

/** Production wiring: probe PATH for botmux installs. */
export function detectBotmuxInstalls(): InstallDiagnostics {
  return analyzeInstalls(listBotmuxBins(), PROD_PROBE_DEPS);
}
