/**
 * Detect the package manager that owns the running global botmux install and
 * build an update command that targets that same install.
 *
 * Detection is deliberately conservative: writing with the wrong package
 * manager can create a second, inactive botmux copy. npm, pnpm, and Bun are
 * supported; known Yarn layouts are identified for diagnostics but rejected
 * until their global-dir/bin-dir semantics are handled explicitly.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { botmuxInstallRoot } from './install-info.js';

export type GlobalInstallManager = 'npm' | 'pnpm' | 'bun';
export type DetectedInstallManager = GlobalInstallManager | 'yarn' | 'unknown';

export interface GlobalInstallPlan {
  manager: GlobalInstallManager;
  command: GlobalInstallManager;
  args: string[];
  /** Package-manager-specific environment needed to keep the update in the
   *  install location that owns the running botmux process. */
  env?: Record<string, string>;
  /** Stable package root after the update. pnpm's runtime realpath is versioned,
   *  so this points at the global node_modules/botmux symlink instead. */
  activePackageRoot: string;
}

export class UnsupportedGlobalInstallError extends Error {
  constructor(
    public readonly manager: DetectedInstallManager,
    public readonly packageRoot: string,
  ) {
    super(`unsupported botmux global install (${manager}): ${packageRoot}`);
    this.name = 'UnsupportedGlobalInstallError';
  }
}

function normalized(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Node resolves pnpm 11's global botmux symlink to this store realpath. */
function pnpmV11StoreMatch(root: string): RegExpMatchArray | null {
  return root.match(
    /^(.*\/pnpm)\/store\/(v\d+)\/links\/@\/botmux\/[^/]+\/[^/]+\/node_modules\/botmux$/i,
  );
}

function pnpmGlobalDir(
  pathImpl: typeof posix,
  layout: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const command = platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(command, ['list', '-g', '--depth', '0', '--json'], {
    cwd: homedir(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    // .cmd shims are not directly executable: without cmd.exe the Windows
    // install path fails with ENOENT/EINVAL. Mirror the update execution
    // strategy (installLatestBotmuxSync / runGlobalInstall). Args are fixed
    // literals, so the shell cannot reinterpret anything.
    shell: platform === 'win32',
    // This probe runs on request-serving paths (dashboard settings, update
    // status, scheduled maintenance) with no plan cache before the first
    // successful update, so a hung pnpm or wedged disk must never freeze the
    // event loop. Any timeout/error keeps callers on the fail-closed path
    // (status !== 0 -> undefined). SIGKILL cannot be trapped by the child.
    timeout: 5_000,
    killSignal: 'SIGKILL',
    maxBuffer: 256 * 1024,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
  let globalRoot: string | undefined;
  try {
    const listing = JSON.parse(result.stdout);
    globalRoot = Array.isArray(listing) && typeof listing[0]?.path === 'string'
      ? normalized(listing[0].path)
      : undefined;
  } catch {
    return undefined;
  }
  if (!globalRoot) return undefined;
  return globalRoot.endsWith(`/${layout}`) ? pathImpl.dirname(globalRoot) : undefined;
}

/**
 * pnpm 11 installs a global project in a versioned directory and points a
 * stable content-addressed symlink at that directory:
 *
 *   <global-dir>/v11/<runtime-dir>/node_modules/botmux
 *   <global-dir>/v11/<stable-hash> -> <runtime-dir>
 *
 * Keep using the stable symlink for the post-update version check/restart. If
 * the install was copied, the symlink was removed, or the filesystem is not
 * readable, falling back to the running package root still preserves the
 * correct package-manager command and keeps this path detector conservative.
 */
function pnpmV11StablePackageRoot(
  packageRoot: string,
  globalDir: string,
  layout: string,
  pathImpl: typeof posix,
): string {
  const layoutRoot = pathImpl.join(globalDir, layout);
  try {
    const runtimeRoot = realpathSync(packageRoot);
    for (const entry of readdirSync(layoutRoot, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue;
      const candidate = pathImpl.join(layoutRoot, entry.name, 'node_modules', 'botmux');
      try {
        if (realpathSync(candidate) === runtimeRoot) return candidate;
      } catch {
        // Ignore stale content-addressed links and keep looking.
      }
    }
  } catch {
    // The path classifier must still work for diagnostics and dry-run callers.
  }
  return packageRoot;
}

/** Pure, path-only ownership classification used by both updates and diagnostics. */
export function detectGlobalInstallManager(
  packageRoot: string,
  platform: NodeJS.Platform = process.platform,
): DetectedInstallManager {
  const root = normalized(packageRoot).toLowerCase();
  if (!root.endsWith('/node_modules/botmux')) return 'unknown';

  // Node normally resolves pnpm's stable symlink to this versioned virtual-store
  // path. Match it before the generic node_modules layouts below.
  if (root.includes('/.pnpm/')) return 'pnpm';
  if (pnpmV11StoreMatch(root)) return 'pnpm';

  // Known non-npm managers must never fall through to npm, especially on
  // Windows where all three can end in <prefix>/node_modules/botmux.
  if (root.includes('/.bun/install/global/node_modules/botmux')
    || root.includes('/bun/install/global/node_modules/botmux')) return 'bun';
  if (root.includes('/.config/yarn/global/node_modules/botmux')
    || root.includes('/yarn/global/node_modules/botmux')) return 'yarn';

  // POSIX npm globals are unambiguous: <prefix>/lib/node_modules/botmux.
  if (root.endsWith('/lib/node_modules/botmux')) return 'npm';

  // A preserved pnpm symlink is normally only seen with --preserve-symlinks;
  // recognise the standard global-dir shape while keeping arbitrary POSIX
  // node_modules layouts unsupported.
  if (/\/pnpm\/global\/[^/]+\/node_modules\/botmux$/.test(root)
    || /\/pnpm\/global\/v\d+\/[^/]+\/node_modules\/botmux$/.test(root)) return 'pnpm';

  // npm on Windows uses <prefix>/node_modules/botmux (without POSIX's lib/).
  return platform === 'win32' ? 'npm' : 'unknown';
}

export function resolveGlobalInstallPlan(
  packageRoot: string = botmuxInstallRoot(),
  platform: NodeJS.Platform = process.platform,
  spec = 'botmux@latest',
): GlobalInstallPlan {
  const manager = detectGlobalInstallManager(packageRoot, platform);
  const path = platform === 'win32' ? win32 : posix;

  if (manager === 'npm') {
    const nodeModulesDir = path.dirname(packageRoot);
    const nodeModulesParent = path.dirname(nodeModulesDir);
    const prefix = path.basename(nodeModulesParent).toLowerCase() === 'lib'
      ? path.dirname(nodeModulesParent)
      : nodeModulesParent;
    return {
      manager,
      command: 'npm',
      args: ['install', '-g', '--prefix', prefix, spec],
      activePackageRoot: packageRoot,
    };
  }

  if (manager === 'pnpm') {
    const root = normalized(packageRoot);
    const marker = '/.pnpm/';
    const markerIndex = root.toLowerCase().indexOf(marker);
    const pnpmV11Match = root.match(/^(.*\/pnpm\/global)\/(v\d+)\/[^/]+\/node_modules\/botmux$/i);
    const pnpmV11Store = pnpmV11StoreMatch(root);
    // Use the capture from the normalized path. Besides avoiding a fragile
    // separator search, this preserves Windows drive letters while converting
    // backslashes to the separator expected by pnpm's command arguments.
    const globalDir = pnpmV11Match?.[1]
      ?? (pnpmV11Store ? pnpmGlobalDir(path, pnpmV11Store[2], platform) : undefined);
    if (pnpmV11Store && !globalDir) {
      throw new UnsupportedGlobalInstallError('pnpm', packageRoot);
    }
    const globalInstallDir = pnpmV11Match
      ? path.join(globalDir!, pnpmV11Match[2])
      : pnpmV11Store
        ? path.join(globalDir!, pnpmV11Store[2])
      : markerIndex >= 0
      ? root.slice(0, markerIndex)
      : path.dirname(path.dirname(packageRoot));
    // pnpm appends its global layout version (currently "5", or "v11") to
    // --global-dir. The pnpm 11 runtime adds another temporary directory below
    // the layout version, so pass the parent of that layout to pnpm.
    const resolvedGlobalDir = globalDir ?? path.dirname(globalInstallDir);
    const activePackageRoot = pnpmV11Match
      ? pnpmV11StablePackageRoot(packageRoot, resolvedGlobalDir, pnpmV11Match[2], path)
      : pnpmV11Store
        ? pnpmV11StablePackageRoot(packageRoot, resolvedGlobalDir, pnpmV11Store[2], path)
      : path.join(globalInstallDir, 'node_modules', 'botmux');
    if (pnpmV11Store && activePackageRoot === packageRoot) {
      throw new UnsupportedGlobalInstallError('pnpm', packageRoot);
    }
    return {
      manager,
      command: 'pnpm',
      args: ['add', '-g', '--global-dir', resolvedGlobalDir, spec],
      activePackageRoot,
    };
  }

  if (manager === 'bun') {
    // Bun supports explicit global package/bin locations through environment
    // variables. Pin both to the layout that owns the running package so a
    // different bunfig.toml or BUN_INSTALL value cannot create an inactive
    // second install during an update.
    const globalDir = path.dirname(path.dirname(packageRoot));
    const bunRoot = path.dirname(path.dirname(globalDir));
    return {
      manager,
      command: 'bun',
      args: ['add', '-g', spec],
      env: {
        BUN_INSTALL_GLOBAL_DIR: globalDir,
        BUN_INSTALL_BIN: path.join(bunRoot, 'bin'),
      },
      activePackageRoot: packageRoot,
    };
  }

  throw new UnsupportedGlobalInstallError(manager, packageRoot);
}

export function tryResolveGlobalInstallPlan(
  packageRoot: string = botmuxInstallRoot(),
  platform: NodeJS.Platform = process.platform,
  spec = 'botmux@latest',
): GlobalInstallPlan | null {
  try {
    return resolveGlobalInstallPlan(packageRoot, platform, spec);
  } catch (error) {
    if (error instanceof UnsupportedGlobalInstallError) return null;
    throw error;
  }
}

export function isAutoUpdateSupportedInstall(): boolean {
  return tryResolveGlobalInstallPlan() !== null;
}

/** Pin an install plan to one registry. Callers opt in explicitly (rollback only). */
export function withGlobalInstallRegistry(
  plan: GlobalInstallPlan,
  registry = 'https://registry.npmjs.org/',
): GlobalInstallPlan {
  return {
    ...plan,
    env: {
      ...plan.env,
      // npm accepts either casing; setting both also prevents an inherited
      // lowercase value from taking precedence. pnpm reads npm config env too.
      NPM_CONFIG_REGISTRY: registry,
      npm_config_registry: registry,
      BUN_CONFIG_REGISTRY: registry,
    },
  };
}

export function formatGlobalInstallCommand(plan: GlobalInstallPlan): string {
  const quote = (arg: string): string => /\s/.test(arg) ? JSON.stringify(arg) : arg;
  return [plan.command, ...plan.args].map(quote).join(' ');
}
