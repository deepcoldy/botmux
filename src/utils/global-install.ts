/**
 * Detect the package manager that owns the running global botmux install and
 * build an update command that targets that same install.
 *
 * Detection is deliberately conservative: writing with the wrong package
 * manager can create a second, inactive botmux copy. npm and pnpm are
 * supported; known Yarn/Bun layouts are identified for diagnostics but are
 * rejected until their global-dir/bin-dir semantics are handled explicitly.
 */
import { posix, win32 } from 'node:path';
import { botmuxInstallRoot } from './install-info.js';

export type GlobalInstallManager = 'npm' | 'pnpm';
export type DetectedInstallManager = GlobalInstallManager | 'yarn' | 'bun' | 'unknown';

export interface GlobalInstallPlan {
  manager: GlobalInstallManager;
  command: GlobalInstallManager;
  args: string[];
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

  // Known unsupported managers must never fall through to npm, especially on
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
  if (/\/pnpm\/global\/[^/]+\/node_modules\/botmux$/.test(root)) return 'pnpm';

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
    const globalInstallDir = markerIndex >= 0
      ? root.slice(0, markerIndex)
      : path.dirname(path.dirname(packageRoot));
    // pnpm appends its global layout version (currently "5") to --global-dir.
    // The runtime package lives under <global-dir>/<layout>/node_modules, so
    // pass the parent while keeping the versioned directory as the stable root.
    const globalDir = path.dirname(globalInstallDir);
    return {
      manager,
      command: 'pnpm',
      args: ['add', '-g', '--global-dir', globalDir, spec],
      activePackageRoot: path.join(globalInstallDir, 'node_modules', 'botmux'),
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

export function formatGlobalInstallCommand(plan: GlobalInstallPlan): string {
  const quote = (arg: string): string => /\s/.test(arg) ? JSON.stringify(arg) : arg;
  return [plan.command, ...plan.args].map(quote).join(' ');
}
