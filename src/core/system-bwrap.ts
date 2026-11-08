import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { locateExecutable } from '../utils/executable.js';
import { t, type Locale } from '../i18n/index.js';

/**
 * Which bubblewrap every Linux sandbox flavour (oncall, scratch,
 * credential-only, network, v3 distillation) executes.
 *
 * A bare `bwrap` resolved through PATH is not good enough: Codex installs its
 * own build at `~/.local/bin/bwrap` (`--version` mentions Codex), and that
 * directory usually precedes /usr/bin. MEASURED in a user report: with that
 * build first on PATH every sandboxed session exited at launch. So the distro
 * paths always win; PATH is only a fallback for hosts that installed bwrap
 * elsewhere, and that fallback is warned about (maintainer decision: warn, do
 * not refuse to start).
 */
export const SYSTEM_BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/bin/bwrap'] as const;

export interface BwrapResolution {
  /** Absolute, realpath'd executable to spawn. */
  path: string;
  /** True when it came from one of SYSTEM_BWRAP_CANDIDATES. */
  system: boolean;
  /** Set only for the PATH fallback. */
  warning?: string;
}

export interface BwrapResolveDeps {
  candidates?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** `<bwrap> --version` output; injected by tests. */
  readVersion?: (path: string) => string;
}

function executableFile(path: string): string | undefined {
  try {
    const resolved = realpathSync(path);
    if (statSync(resolved).isFile() && locateExecutable(resolved) !== null) return resolved;
  } catch { /* absent or unreadable — try the next candidate */ }
  return undefined;
}

/** First usable distro bubblewrap, or undefined. Never consults PATH. */
export function systemBwrapPath(candidates: readonly string[] = SYSTEM_BWRAP_CANDIDATES): string | undefined {
  for (const candidate of candidates) {
    const found = executableFile(candidate);
    if (found) return found;
  }
  return undefined;
}

function defaultReadVersion(path: string): string {
  const r = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 2_000 });
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
}

/** Pure-ish resolution (filesystem + injectable version probe). */
export function resolveBwrap(deps: BwrapResolveDeps = {}): BwrapResolution | undefined {
  const candidates = deps.candidates ?? SYSTEM_BWRAP_CANDIDATES;
  const system = systemBwrapPath(candidates);
  if (system) return { path: system, system: true };
  const located = locateExecutable('bwrap', deps.env ?? process.env);
  if (!located) return undefined;
  const path = executableFile(located);
  if (!path) return undefined;
  const version = (deps.readVersion ?? defaultReadVersion)(path).trim();
  const codexBuild = /codex/i.test(version);
  const versionLine = version.split('\n', 1)[0] || 'unknown version';
  const warning = `[sandbox] no system bubblewrap at ${candidates.join(' or ')}; using ${path} from PATH (${versionLine}).`
    + (codexBuild
      ? ' This is the Codex-bundled bubblewrap build, not the distro package; sandboxed sessions may exit right after launch.'
      : '')
    + ' Install the distro bubblewrap package (e.g. apt-get install bubblewrap) so botmux uses /usr/bin/bwrap.';
  return { path, system: false, warning };
}

const warnedPaths = new Set<string>();

/**
 * The bubblewrap to execute, or undefined when none is installed. Logs the
 * PATH-fallback warning once per executable per process.
 */
export function bwrapExecutable(deps?: BwrapResolveDeps): string | undefined {
  const resolved = resolveBwrap(deps);
  if (resolved?.warning && !warnedPaths.has(resolved.path)) {
    warnedPaths.add(resolved.path);
    console.error(resolved.warning);
  }
  return resolved?.path;
}

/** Test-only: forget which fallback paths were already warned about. */
export function __testOnly_resetBwrapWarnings(): void {
  warnedPaths.clear();
}

/**
 * A bwrap launch that died because the host refuses the namespaces every
 * Linux sandbox flavour needs. Typical in containers and nested sandboxes:
 *   - `pid`:  `Can't mount proc on /newroot/proc: Operation not permitted`
 *     (a fresh procfs inside a new PID namespace is denied);
 *   - `user`: `No permissions to creating new namespace, likely because the
 *     kernel does not allow non-privileged user namespaces` (older bwrap
 *     spells it `No permissions to create new namespace`), or the uid map
 *     cannot be written.
 * Diagnosis only: nothing here changes whether or how a sandbox degrades.
 */
export type BwrapNamespaceFailure = 'pid' | 'user';

export function classifyBwrapNamespaceFailure(text: string | undefined): BwrapNamespaceFailure | undefined {
  if (!text) return undefined;
  if (/No permissions to creat(?:e|ing) new namespace|Creating new namespace failed|setting up uid map/i.test(text)) {
    return 'user';
  }
  if (/Can't mount proc on \/newroot\/proc/i.test(text)) return 'pid';
  return undefined;
}

/**
 * Why a Linux bwrap launch failed, for the startup-failure notice. bwrap's own
 * message in `text` (terminal tail / error) wins; a tmux pane that died at
 * once leaves no output, so fall back to the cached host `probe`. A PID
 * refusal is not reported when this spawn already dropped --unshare-pid
 * (core-only degrade) — the launch did not need that namespace.
 */
export function diagnoseSandboxNamespaceFailure(input: {
  linuxBwrap: boolean;
  text: string | undefined;
  probe: () => BwrapNamespaceFailure | undefined;
  pidNamespaceDropped: () => boolean;
}): BwrapNamespaceFailure | undefined {
  if (!input.linuxBwrap) return undefined;
  const fromText = classifyBwrapNamespaceFailure(input.text);
  if (fromText) return fromText;
  const probed = input.probe();
  if (probed === 'pid' && input.pidNamespaceDropped()) return undefined;
  return probed;
}

/** Docs section the startup-failure hint links to (docs-site sandbox.md). */
export function bwrapNamespaceDocUrl(locale: 'zh' | 'en'): string {
  return `https://deepcoldy.github.io/botmux/${locale === 'en' ? 'en/' : ''}sandbox#linux-namespace`;
}

/** Startup-failure line for a host whose bwrap cannot create a namespace. */
export function sandboxNamespaceNotice(kind: BwrapNamespaceFailure, locale: Locale): string {
  return t('worker.sandbox_namespace_unsupported', {
    kind: kind === 'pid' ? 'PID' : 'user',
    docUrl: bwrapNamespaceDocUrl(locale === 'en' ? 'en' : 'zh'),
  }, locale);
}
