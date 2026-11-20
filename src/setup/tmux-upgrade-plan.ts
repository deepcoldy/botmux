/**
 * Decide HOW the tmux that botmux actually runs can be upgraded, and run it.
 *
 * Rule: upgrade the binary botmux resolves (same PATH as every tmux call, see
 * tmuxEnv) with the package manager that OWNS it. Installing a second copy
 * somewhere else would not help — e.g. `brew install tmux` while /usr/bin/tmux
 * stays first on the daemon's PATH changes nothing — so ownership is proven
 * first and anything unproven (a hand-placed ~/.local/bin/tmux, a source build
 * in /usr/local) is left alone with manual instructions.
 *
 * Every argv is built here from fixed strings plus values read from the
 * package manager itself (an apt version, a conda prefix); nothing comes from
 * the card or the user. The installers themselves are ensure-tmux.ts's
 * (buildTmuxUpgradeArgv / nonInteractivePrivilegedArgv), so sudo handling stays
 * identical to first-time installs, minus the interactive branch: the daemon
 * has no TTY to type a password into.
 */
import { execFile, spawn } from 'node:child_process';
import {
  accessSync, closeSync, constants as fsConstants, existsSync, openSync, readSync, readdirSync, realpathSync, statSync, unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { PackageManager, PlatformInfo } from './detect-platform.js';
import {
  buildTmuxUpgradeArgv,
  nonInteractivePrivilegedArgv,
  tmuxEnv,
} from './ensure-tmux.js';
import {
  TMUX_RECOMMENDED_MIN,
  compareTmuxRelease,
  isTmuxBelowRecommended,
  parseTmuxRelease,
  type TmuxRecommendation,
} from './tmux-recommended.js';
import {
  defaultPrebuiltSupportIo,
  inspectManagedTmux,
  probePrebuiltSupport,
  type ManagedTmuxState,
  type PrebuiltInstallFailure,
  type PrebuiltInstallResult,
  type PrebuiltSupport,
} from './tmux-prebuilt.js';
import { managedTmuxRoot } from './tmux-managed-path.js';

export type SystemPackageManager = Exclude<PackageManager, 'brew' | 'conda' | 'unknown'>;

export type TmuxInstallOwner =
  | { kind: 'brew'; brewBin: string }
  | { kind: 'conda'; condaBin: string; prefix: string }
  | { kind: 'system'; pm: SystemPackageManager }
  /** botmux's own prebuilt copy under `root` (fresh install or replacement). */
  | { kind: 'botmux'; root: string };

/** Why there is no button, and what the owner can do instead. */
export type TmuxManualReason =
  | 'tmux_missing'
  | 'unmanaged_binary'
  | 'needs_sudo'
  | 'no_candidate'
  | 'unsupported_platform'
  /** botmux's own tmux directory exists but is not provably what botmux put there. */
  | 'managed_modified';

export type TmuxUpgradePlan =
  | {
      auto: true;
      owner: TmuxInstallOwner;
      tmuxPath: string;
      /** Human-readable command shown on the card (no secrets, no shell). */
      display: string;
      /** Best release the package source offers right now, when known. */
      candidate?: string;
      /** owner=botmux: what gets installed where, and which binary stays as is. */
      prebuilt?: { release: string; root: string; keepPath?: string };
    }
  | {
      auto: false;
      reason: TmuxManualReason;
      tmuxPath?: string;
      /** Best release the package source offers, for the no_candidate reason. */
      candidate?: string;
      /** A copy-pasteable command, when one exists. */
      manualCommand?: string;
      /** Platform-specific way out (backports, Homebrew, …); plain text. */
      hint?: string;
      /** Why botmux's own prebuilt tmux is not an option here either. */
      prebuiltUnavailable?: { reason: string; detail?: string; missingLibraries?: string[] };
    };

/** apt / dnf report versions like `3.5a-2~bpo12+1`; keep the exact string for
 *  the install pin, the parsed release for comparisons. */
export interface PackageCandidate {
  packageVersion: string;
  release: string;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Injectable probes: production reads the host, tests feed fixtures. The ones
 * that spawn a process are async so the primary daemon's event loop is never
 * blocked by a slow package manager (dnf/brew can take seconds).
 */
export interface TmuxUpgradeProbe {
  platform: PlatformInfo;
  /** `tmux` as every botmux tmux call resolves it (tmuxEnv PATH), realpath'd. */
  resolveTmux(): { path: string; realPath: string } | null;
  which(cmd: string): string | null;
  /** `brew --prefix`, realpath'd; null when unknown. */
  brewPrefix(brewBin: string): MaybePromise<string | null>;
  exists(path: string): boolean;
  /** conda-meta/<name>-*.json present under prefix. */
  condaOwnsTmux(prefix: string): boolean;
  /** Is tmux recorded as installed by this system package manager? */
  systemPackageInstalled(pm: SystemPackageManager): MaybePromise<boolean>;
  /** Versions the package source currently offers (no network). null = unknown. */
  packageCandidates(pm: SystemPackageManager): MaybePromise<PackageCandidate[] | null>;
  /** botmux's own tmux directory; absent → the prebuilt route is not considered. */
  managedRoot?: string;
  /** Canonical path (production: realpathSync); undefined when it does not exist. */
  realpath?(path: string): string | undefined;
  /** Ownership of what is in `managedRoot` right now. */
  managedState?(): ManagedTmuxState;
  /** Can botmux install its own prebuilt tmux on this host? */
  prebuiltSupport?(): Promise<PrebuiltSupport>;
}

const ALWAYS_FRESH_SYSTEM_MANAGERS: ReadonlySet<SystemPackageManager> = new Set(['pacman', 'apk', 'zypper']);

/** Highest candidate at or above the recommendation; madison/repoquery order
 *  breaks ties (apt lists the pinned-preferred source first). */
export function pickCandidate(
  candidates: readonly PackageCandidate[],
  recommendation: TmuxRecommendation = TMUX_RECOMMENDED_MIN,
): PackageCandidate | undefined {
  let best: PackageCandidate | undefined;
  for (const c of candidates) {
    const parsed = parseTmuxRelease(c.release);
    if (!parsed || isTmuxBelowRecommended(c.release, recommendation)) continue;
    const bestParsed = best ? parseTmuxRelease(best.release) : null;
    if (!bestParsed || compareTmuxRelease(parsed, bestParsed) > 0) best = c;
  }
  return best;
}

/** Highest candidate overall (for "the source only has X" messages). */
function highestCandidate(candidates: readonly PackageCandidate[]): PackageCandidate | undefined {
  let best: PackageCandidate | undefined;
  for (const c of candidates) {
    const parsed = parseTmuxRelease(c.release);
    if (!parsed) continue;
    const bestParsed = best ? parseTmuxRelease(best.release) : null;
    if (!bestParsed || compareTmuxRelease(parsed, bestParsed) > 0) best = c;
  }
  return best;
}

/** `apt-cache madison tmux` → candidates. Lines look like
 *  `      tmux | 3.5a-2~bpo12+1 | http://deb.debian.org/debian bookworm-backports/main amd64 Packages`. */
export function parseAptMadison(text: string): PackageCandidate[] {
  const out: PackageCandidate[] = [];
  const seen = new Set<string>();
  for (const line of String(text ?? '').split('\n')) {
    const cols = line.split('|').map(s => s.trim());
    if (cols.length < 3 || cols[0] !== 'tmux') continue;
    const packageVersion = cols[1]!;
    if (!isSafePackageVersion(packageVersion) || seen.has(packageVersion)) continue;
    // Strip the epoch and Debian revision: `1:3.5a-2~bpo12+1` → `3.5a`.
    const upstream = packageVersion.replace(/^\d+:/, '').replace(/-[^-]*$/, '');
    if (!parseTmuxRelease(upstream)) continue;
    seen.add(packageVersion);
    out.push({ packageVersion, release: upstream });
  }
  return out;
}

/** `dnf repoquery --qf '%{version}'` → candidates (one version per line). */
export function parseRepoqueryVersions(text: string): PackageCandidate[] {
  const out: PackageCandidate[] = [];
  for (const raw of String(text ?? '').split('\n')) {
    const v = raw.trim();
    if (!v || !isSafePackageVersion(v) || !parseTmuxRelease(v)) continue;
    out.push({ packageVersion: v, release: v });
  }
  return out;
}

/** The only characters a Debian/RPM version may contain. Anything else read
 *  back from a package tool is refused rather than passed on as an argv pin. */
export function isSafePackageVersion(v: string): boolean {
  return /^[0-9][0-9A-Za-z.+~:_-]{0,63}$/.test(v);
}

function manualInstallCommand(pm: PackageManager): string {
  switch (pm) {
    case 'apt': return 'sudo apt-get update && sudo apt-get install -y tmux';
    case 'dnf': return 'sudo dnf upgrade -y tmux';
    case 'yum': return 'sudo yum update -y tmux';
    case 'pacman': return 'sudo pacman -S --needed tmux';
    case 'apk': return 'sudo apk add --upgrade tmux';
    case 'zypper': return 'sudo zypper update tmux';
    case 'brew': return 'brew upgrade tmux';
    case 'conda': return `conda install -c conda-forge "tmux>=${TMUX_RECOMMENDED_MIN.version}"`;
    default: return '';
  }
}

/** A way out when the distro's own repositories stop below the recommendation. */
function noCandidateHint(platform: PlatformInfo, codename: string | undefined, locale: 'zh' | 'en'): string {
  const brew = locale === 'en'
    ? 'install a newer tmux with Homebrew (`brew install tmux`) or conda-forge (`conda install -c conda-forge tmux`) and make sure it comes first on PATH'
    : '用 Homebrew（`brew install tmux`）或 conda-forge（`conda install -c conda-forge tmux`）装一份新版，并确保它在 PATH 里排在前面';
  if (platform.distro === 'debian' && codename && /^[a-z]+$/.test(codename)) {
    return locale === 'en'
      ? `Enable ${codename}-backports in your apt sources, then run \`sudo apt-get update && sudo apt-get install -y -t ${codename}-backports tmux\`; or ${brew}.`
      : `可以在 apt 源里启用 ${codename}-backports，然后执行 \`sudo apt-get update && sudo apt-get install -y -t ${codename}-backports tmux\`；或者${brew}。`;
  }
  return locale === 'en'
    ? `Your distribution's repositories stop below it. You can ${brew}, or upgrade the OS.`
    : `当前系统的软件源里没有更新的版本。可以${brew}，或者升级操作系统。`;
}

/**
 * Work out what the one-click upgrade would do on this host. Pure over the
 * injected probe (no installs, no network): the card shows the result before
 * anyone clicks.
 */
export async function planTmuxUpgrade(
  probe: TmuxUpgradeProbe,
  opts: { locale?: 'zh' | 'en'; recommendation?: TmuxRecommendation; debianCodename?: string } = {},
): Promise<TmuxUpgradePlan> {
  const root = probe.managedRoot;
  const tmux = probe.resolveTmux();
  // Compare canonical paths: a symlinked HOME/.botmux must not make botmux's
  // own copy look like the user's (and get offered as "left untouched").
  const realRoot = root ? (probe.realpath?.(root) ?? root) : undefined;
  // botmux's own copy is what runs: replace it (only if provably ours).
  if (root && realRoot && tmux && (tmux.realPath.startsWith(realRoot + '/') || tmux.realPath.startsWith(root + '/'))) {
    const state = probe.managedState?.() ?? { state: 'foreign', reason: 'unknown' } as ManagedTmuxState;
    if (state.state === 'foreign') return { auto: false, reason: 'managed_modified', tmuxPath: root };
    const support = await probe.prebuiltSupport?.();
    if (support?.ok) {
      return {
        auto: true,
        owner: { kind: 'botmux', root },
        tmuxPath: tmux.path,
        display: support.candidates[0]!.fileName,
        prebuilt: { release: support.candidates[0]!.release, root },
      };
    }
    return {
      auto: false,
      reason: 'unsupported_platform',
      tmuxPath: tmux.path,
      ...(support && !support.ok ? { prebuiltUnavailable: unavailable(support) } : {}),
    };
  }
  const viaPackages = await planPackageManagerUpgrade(probe, opts);
  if (viaPackages.auto || !root || !probe.prebuiltSupport) return viaPackages;
  // No package manager can deliver it: botmux's own prebuilt copy, if this
  // host can run one. The binary the user put there stays exactly as it is.
  if (viaPackages.reason !== 'unmanaged_binary' && viaPackages.reason !== 'needs_sudo'
    && viaPackages.reason !== 'no_candidate') return viaPackages;
  const state = probe.managedState?.() ?? { state: 'absent' } as ManagedTmuxState;
  if (state.state === 'foreign') {
    return { ...viaPackages, prebuiltUnavailable: { reason: 'managed_modified', detail: root } };
  }
  const support = await probe.prebuiltSupport();
  if (!support.ok) return { ...viaPackages, prebuiltUnavailable: unavailable(support) };
  return {
    auto: true,
    owner: { kind: 'botmux', root },
    tmuxPath: viaPackages.tmuxPath ?? tmux?.path ?? 'tmux',
    display: support.candidates[0]!.fileName,
    prebuilt: { release: support.candidates[0]!.release, root, ...(viaPackages.tmuxPath ? { keepPath: viaPackages.tmuxPath } : {}) },
  };
}

function unavailable(support: Extract<PrebuiltSupport, { ok: false }>): NonNullable<Extract<TmuxUpgradePlan, { auto: false }>['prebuiltUnavailable']> {
  return {
    reason: support.reason,
    ...(support.detail ? { detail: support.detail } : {}),
    ...(support.missingLibraries?.length ? { missingLibraries: support.missingLibraries } : {}),
  };
}

/** The package-manager route only (brew / conda / distro manager). */
async function planPackageManagerUpgrade(
  probe: TmuxUpgradeProbe,
  opts: { locale?: 'zh' | 'en'; recommendation?: TmuxRecommendation; debianCodename?: string },
): Promise<TmuxUpgradePlan> {
  const locale = opts.locale ?? 'zh';
  const recommendation = opts.recommendation ?? TMUX_RECOMMENDED_MIN;
  const { platform } = probe;
  if (platform.os === 'other') return { auto: false, reason: 'unsupported_platform' };
  const tmux = probe.resolveTmux();
  if (!tmux) return { auto: false, reason: 'tmux_missing' };
  const tmuxPath = tmux.path;
  const real = tmux.realPath;

  // Homebrew: the binary must live in Homebrew's own tmux keg, not merely
  // under its prefix (an Intel Mac's /usr/local also hosts source builds).
  const brewBin = probe.which('brew');
  if (brewBin) {
    const prefix = await probe.brewPrefix(brewBin);
    if (prefix && real.startsWith(join(prefix, 'Cellar', 'tmux') + '/')) {
      return { auto: true, owner: { kind: 'brew', brewBin }, tmuxPath, display: 'brew upgrade tmux' };
    }
  }

  // conda: <prefix>/bin/tmux with a conda-meta record for tmux in <prefix>.
  if (real.endsWith('/bin/tmux')) {
    const prefix = dirname(dirname(real));
    if (probe.exists(join(prefix, 'conda-meta')) && probe.condaOwnsTmux(prefix)) {
      const condaBin = probe.which('conda') ?? probe.which('mamba')
        ?? (probe.exists(join(prefix, 'bin', 'conda')) ? join(prefix, 'bin', 'conda') : null);
      if (!condaBin) {
        return { auto: false, reason: 'unmanaged_binary', tmuxPath, manualCommand: manualInstallCommand('conda') };
      }
      const argv = buildTmuxUpgradeArgv('conda', platform, { condaBin, condaPrefix: prefix, minVersion: recommendation.version })!;
      return { auto: true, owner: { kind: 'conda', condaBin, prefix }, tmuxPath, display: argv.join(' ') };
    }
  }

  // System package: /usr/bin/tmux (or /bin with usrmerge) recorded as installed
  // by the distro manager.
  const systemPm = platform.packageManagers.find((pm): pm is SystemPackageManager =>
    pm !== 'brew' && pm !== 'conda' && pm !== 'unknown');
  const inSystemDir = real === '/usr/bin/tmux' || real === '/bin/tmux';
  if (!systemPm || !inSystemDir || !(await probe.systemPackageInstalled(systemPm))) {
    // Not provably package-managed (a hand-placed ~/.local/bin/tmux, a source
    // build in /usr/local, an extracted .deb): botmux never overwrites it.
    return { auto: false, reason: 'unmanaged_binary', tmuxPath };
  }

  // Does the package source offer ≥ the recommendation at all? apt/dnf are
  // checked from their local metadata; the rolling managers always track the
  // newest release, and an unknown answer still offers the button (the result
  // is verified with `tmux -V` afterwards either way).
  let candidate: string | undefined;
  if (!ALWAYS_FRESH_SYSTEM_MANAGERS.has(systemPm)) {
    const candidates = await probe.packageCandidates(systemPm);
    if (candidates) {
      const picked = pickCandidate(candidates, recommendation);
      if (!picked) {
        const best = highestCandidate(candidates);
        return {
          auto: false,
          reason: 'no_candidate',
          tmuxPath,
          ...(best ? { candidate: best.release } : {}),
          hint: noCandidateHint(platform, opts.debianCodename, locale),
        };
      }
      candidate = picked.release;
    }
  }

  const argv = buildTmuxUpgradeArgv(systemPm, platform);
  if (!argv) {
    return { auto: false, reason: 'needs_sudo', tmuxPath, manualCommand: manualInstallCommand(systemPm) };
  }
  // apt pins the exact version it picks after refreshing its lists; show the
  // shape of that command (the pin itself is only known at run time).
  const update = systemPm === 'apt' ? nonInteractivePrivilegedArgv(['apt-get', 'update'], platform) : undefined;
  const display = update ? `${update.join(' ')} && ${argv.join(' ')}` : argv.join(' ');
  return { auto: true, owner: { kind: 'system', pm: systemPm }, tmuxPath, display, ...(candidate ? { candidate } : {}) };
}

// ─── Running a plan ─────────────────────────────────────────────────────────

export interface UpgradeStepResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error?: string;
}

/** Runs one argv and streams its output lines. Injected in tests. */
export type UpgradeCommandRunner = (
  argv: string[],
  opts: {
    timeoutMs: number;
    /** SIGTERM → SIGKILL grace for the detached process group. */
    killGraceMs?: number;
    env: NodeJS.ProcessEnv;
    onLine: (line: string) => void;
    /** The installer process started (its pid leads its own process group). */
    onSpawn?: (pid: number) => void;
  },
) => Promise<UpgradeStepResult>;

export interface TmuxUpgradeExecution {
  ok: boolean;
  /** Commands actually executed, in order (display form). */
  ran: string[];
  /** Release the package source delivered, when it was selected up front. */
  selected?: string;
  /** Failure reason in plain words (no stack traces). */
  error?: string;
  /** Machine-readable failure kind. */
  failure?: 'command_failed' | 'timed_out' | 'no_candidate' | 'refused' | PrebuiltInstallFailure;
  /** Prebuilt route: libraries this host lacks for every candidate. */
  missingLibraries?: string[];
}

const STEP_TIMEOUT_MS = 10 * 60_000;
const APT_UPDATE_TIMEOUT_MS = 3 * 60_000;

/**
 * Execute an auto plan. Only the package manager runs here; whether the result
 * actually reached the recommendation is the caller's `tmux -V` re-check.
 * apt is two-phase: refresh the lists, then pin the best version ≥ the
 * recommendation from the REFRESHED lists (it may be a backports build that
 * apt would never pick by itself).
 */
export async function executeTmuxUpgrade(
  plan: Extract<TmuxUpgradePlan, { auto: true }>,
  deps: {
    platform: PlatformInfo;
    run: UpgradeCommandRunner;
    onLine: (line: string) => void;
    onSpawn?: (pid: number) => void;
    aptCandidates?: () => MaybePromise<PackageCandidate[] | null>;
    /** Prebuilt route (owner=botmux): install botmux's own copy. */
    installPrebuilt?: (onLine: (line: string) => void) => Promise<PrebuiltInstallResult>;
    recommendation?: TmuxRecommendation;
    env?: NodeJS.ProcessEnv;
  },
): Promise<TmuxUpgradeExecution> {
  const recommendation = deps.recommendation ?? TMUX_RECOMMENDED_MIN;
  const env: NodeJS.ProcessEnv = {
    ...(deps.env ?? tmuxEnv()),
    DEBIAN_FRONTEND: 'noninteractive',
    HOMEBREW_NO_ENV_HINTS: '1',
  };
  const ran: string[] = [];
  const runStep = async (argv: string[], timeoutMs: number): Promise<UpgradeStepResult> => {
    ran.push(argv.join(' '));
    deps.onLine(`$ ${argv.join(' ')}`);
    return deps.run(argv, { timeoutMs, env, onLine: deps.onLine, ...(deps.onSpawn ? { onSpawn: deps.onSpawn } : {}) });
  };
  const failed = (r: UpgradeStepResult, argv: string[]): TmuxUpgradeExecution => ({
    ok: false,
    ran,
    failure: r.timedOut ? 'timed_out' : 'command_failed',
    error: r.timedOut
      ? `${argv[0]} timed out`
      : r.error ?? `${argv.join(' ')} exited with ${r.code ?? r.signal ?? 'unknown'}`,
  });

  const { owner } = plan;
  if (owner.kind === 'botmux') {
    if (!deps.installPrebuilt) return { ok: false, ran, failure: 'unsupported', error: 'prebuilt install unavailable' };
    const r = await deps.installPrebuilt(deps.onLine);
    if (r.ok) {
      ran.push(r.source);
      return { ok: true, ran, selected: r.release };
    }
    return {
      ok: false,
      ran,
      failure: r.failure,
      error: r.error,
      ...(r.missingLibraries?.length ? { missingLibraries: r.missingLibraries } : {}),
    };
  }
  if (owner.kind === 'brew' || owner.kind === 'conda') {
    const argv = owner.kind === 'brew'
      ? [owner.brewBin, 'upgrade', 'tmux']
      : buildTmuxUpgradeArgv('conda', deps.platform, {
          condaBin: owner.condaBin, condaPrefix: owner.prefix, minVersion: recommendation.version,
        })!;
    const r = await runStep(argv, STEP_TIMEOUT_MS);
    return r.code === 0 ? { ok: true, ran } : failed(r, argv);
  }

  let aptVersion: string | undefined;
  let selected: string | undefined;
  if (owner.pm === 'apt') {
    const update = nonInteractivePrivilegedArgv(['apt-get', 'update'], deps.platform);
    if (!update) return { ok: false, ran, failure: 'refused', error: 'needs sudo' };
    // A failed refresh is not fatal: the current lists may already carry it.
    await runStep(update, APT_UPDATE_TIMEOUT_MS);
    const candidates = (await deps.aptCandidates?.()) ?? null;
    if (candidates) {
      const picked = pickCandidate(candidates, recommendation);
      if (!picked) {
        const best = highestCandidate(candidates);
        return {
          ok: false,
          ran,
          failure: 'no_candidate',
          error: best ? `apt only offers tmux ${best.release}` : 'apt offers no tmux package',
        };
      }
      aptVersion = picked.packageVersion;
      selected = picked.release;
    }
  }
  const argv = buildTmuxUpgradeArgv(owner.pm, deps.platform, aptVersion ? { aptVersion } : {});
  if (!argv) return { ok: false, ran, failure: 'refused', error: 'needs sudo' };
  const r = await runStep(argv, STEP_TIMEOUT_MS);
  return r.code === 0 ? { ok: true, ran, ...(selected ? { selected } : {}) } : failed(r, argv);
}

// ─── Production probes ──────────────────────────────────────────────────────

function isExecutable(path: string): boolean {
  try { accessSync(path, fsConstants.X_OK); return true; } catch { return false; }
}

/** First executable `name` on PATH, like `command -v`. */
export function whichOnPath(name: string, pathValue: string | undefined): string | null {
  for (const dir of String(pathValue ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** stdout of a successful run, null on any failure. Async: never blocks the
 *  daemon's event loop while a package manager thinks. */
function quietExec(bin: string, args: string[], timeoutMs = 10_000): Promise<string | null> {
  return new Promise(resolve => {
    try {
      execFile(bin, args, { encoding: 'utf-8', timeout: timeoutMs, env: tmuxEnv(), maxBuffer: 1 << 20 }, (error, stdout) => {
        resolve(error ? null : String(stdout ?? ''));
      });
    } catch {
      resolve(null);
    }
  });
}

export function defaultTmuxUpgradeProbe(platform: PlatformInfo): TmuxUpgradeProbe {
  const pathValue = tmuxEnv().PATH;
  const managedRoot = managedTmuxRoot();
  return {
    platform,
    managedRoot,
    realpath: path => { try { return realpathSync(path); } catch { return undefined; } },
    managedState: () => inspectManagedTmux(managedRoot),
    prebuiltSupport: () => probePrebuiltSupport(defaultPrebuiltSupportIo()),
    resolveTmux() {
      const path = whichOnPath('tmux', pathValue);
      if (!path) return null;
      try { return { path, realPath: realpathSync(path) }; } catch { return { path, realPath: path }; }
    },
    which: name => whichOnPath(name, pathValue),
    async brewPrefix(brewBin) {
      const out = (await quietExec(brewBin, ['--prefix']))?.trim();
      if (!out) return null;
      try { return realpathSync(out); } catch { return out; }
    },
    exists: existsSync,
    condaOwnsTmux(prefix) {
      try { return readdirSync(join(prefix, 'conda-meta')).some(f => /^tmux-\d.*\.json$/.test(f)); }
      catch { return false; }
    },
    async systemPackageInstalled(pm) {
      switch (pm) {
        case 'apt': return /install ok installed/.test((await quietExec('dpkg-query', ['-W', '-f=${Status}', 'tmux'])) ?? '');
        case 'dnf': case 'yum': case 'zypper': return (await quietExec('rpm', ['-q', 'tmux'])) !== null;
        case 'pacman': return (await quietExec('pacman', ['-Q', 'tmux'])) !== null;
        case 'apk': return (await quietExec('apk', ['info', '-e', 'tmux'])) !== null;
      }
    },
    async packageCandidates(pm) {
      if (pm === 'apt') {
        const out = await quietExec('apt-cache', ['madison', 'tmux']);
        return out === null ? null : parseAptMadison(out);
      }
      if (pm === 'dnf') {
        // -C: cache only, never refresh metadata over the network here.
        const out = await quietExec('dnf', ['-q', '-C', 'repoquery', '--qf', '%{version}\n', 'tmux'], 20_000);
        return out === null ? null : parseRepoqueryVersions(out);
      }
      return null;
    },
  };
}

/** `VERSION_CODENAME` from /etc/os-release (Debian backports hint). */
export function readDebianCodename(read: () => string): string | undefined {
  try {
    const match = /^VERSION_CODENAME=("?)([a-z]+)\1$/m.exec(read());
    return match?.[2];
  } catch {
    return undefined;
  }
}

/**
 * Spawn an installer without a shell and stream its merged stdout/stderr.
 *
 * Output goes to a temp FILE that is tailed, not to a pipe: if the daemon is
 * restarted mid-install, a pipe would close under apt/dpkg and SIGPIPE could
 * kill the package manager half-way (dpkg "was interrupted" state). With a
 * file the installer runs to completion on its own (own process group, so a
 * fleet stop does not signal it either); the restarted daemon simply re-reads
 * `tmux -V`. A timeout sends SIGTERM to the group, then SIGKILL after a grace.
 */
export const spawnUpgradeCommand: UpgradeCommandRunner = (argv, opts) => new Promise(resolve => {
  const logPath = join(tmpdir(), `botmux-tmux-upgrade-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  let fd: number;
  try {
    fd = openSync(logPath, 'a', 0o600);
  } catch (err) {
    resolve({ code: null, signal: null, timedOut: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  let offset = 0;
  let partial = '';
  const drain = (final: boolean) => {
    let chunk = '';
    try {
      const size = statSync(logPath).size;
      if (size > offset) {
        const buf = Buffer.alloc(Math.min(size - offset, 1 << 20));
        const rfd = openSync(logPath, 'r');
        try { readSync(rfd, buf, 0, buf.length, offset); } finally { closeSync(rfd); }
        offset += buf.length;
        chunk = buf.toString('utf8');
      }
    } catch { /* best effort */ }
    const parts = (partial + chunk).split(/\r\n|\n|\r/);
    partial = parts.pop() ?? '';
    for (const line of parts) opts.onLine(line);
    if (partial.length > 8_192 || (final && partial)) { opts.onLine(partial); partial = ''; }
  };
  let settled = false;
  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  let groupWatch: NodeJS.Timeout | undefined;
  let childPid: number | undefined;
  const groupAlive = (): boolean => {
    if (childPid === undefined) return false;
    try { process.kill(-childPid, 0); return true; } catch { return false; }
  };
  const signalGroup = (sig: NodeJS.Signals) => {
    try { if (childPid !== undefined) process.kill(-childPid, sig); } catch { /* already gone */ }
  };
  const stopGroupWatch = () => {
    if (groupWatch) clearInterval(groupWatch);
    groupWatch = undefined;
  };
  const poll = setInterval(() => drain(false), 300);
  poll.unref?.();
  const finish = (r: UpgradeStepResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // A leader exiting after TERM does not prove its descendants exited. Keep
    // escalation only while the original group is actually non-empty, and stop
    // it as soon as that group disappears so a later PGID reuse is not killed.
    if (killTimer && groupAlive()) {
      if (!groupWatch) {
        groupWatch = setInterval(() => {
          if (groupAlive()) return;
          if (killTimer) clearTimeout(killTimer);
          killTimer = undefined;
          stopGroupWatch();
        }, 50);
        groupWatch.unref?.();
      }
    } else {
      if (killTimer) clearTimeout(killTimer);
      killTimer = undefined;
      stopGroupWatch();
    }
    clearInterval(poll);
    drain(true);
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(logPath); } catch { /* best effort */ }
    resolve(r);
  };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(argv[0]!, argv.slice(1), {
      stdio: ['ignore', fd, fd],
      env: opts.env,
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    finish({ code: null, signal: null, timedOut: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  childPid = child.pid;
  if (child.pid !== undefined) opts.onSpawn?.(child.pid);
  const timer = setTimeout(() => {
    timedOut = true;
    signalGroup('SIGTERM');
    killTimer = setTimeout(() => {
      killTimer = undefined;
      stopGroupWatch();
      signalGroup('SIGKILL');
    }, opts.killGraceMs ?? 10_000);
    killTimer.unref?.();
  }, opts.timeoutMs);
  timer.unref?.();
  child.on('error', err => finish({ code: null, signal: null, timedOut, error: err.message }));
  child.on('exit', (code, signal) => finish({ code, signal, timedOut }));
});
