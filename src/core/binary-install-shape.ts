/**
 * WHERE the running compiled binary lives — the pure, dependency-free half of the
 * self-update story.
 *
 * Split out of `binary-self-update.ts` so it can be imported from
 * `utils/global-install.ts` without closing an import cycle: the self-update
 * module needs `restart-report` (for the repo slug) which reaches
 * `utils/install-info.ts`, and `global-install.ts` is itself imported by
 * `install-diagnostics.ts`. This file imports nothing but `node:os`/`node:path`
 * plus the standalone check, so it is safe to depend on from anywhere.
 *
 * See `binary-self-update.ts` for the full rationale — in short: both installers
 * ship the SAME compiled binary, so the module graph cannot tell them apart (both
 * report an install root of `/`), and `process.execPath` can.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isStandaloneBinary } from './self-spawn.js';

/**
 * How the running compiled binary was installed, and therefore who owns updating it.
 *
 *  · `npm-binary`   — inside an npm/pnpm/Bun platform subpackage
 *                     (`botmux-<plat>-<arch>[-musl]`). The manager owns the file;
 *                     update by re-running it.
 *  · `curl-binary`  — the standalone location install.sh writes. We own the file;
 *                     update by replacing it.
 *  · `unknown`      — anywhere else (a hand-copied binary, a distro package, a dev
 *                     build run straight out of dist-bin/), or not a compiled
 *                     binary at all. Fail closed.
 */
export type BinaryInstallShape = 'npm-binary' | 'curl-binary' | 'unknown';

/** Default standalone install dir, matching install.sh's own default. */
function defaultInstallDir(home: string): string {
  return join(home, '.botmux', 'bin');
}

/**
 * Classify a binary path. Pure — the caller passes the path and the relevant
 * environment, so every shape is unit-testable without a real install.
 *
 * @param execPath  the running executable (`process.execPath`)
 * @param env       consulted for `BOTMUX_INSTALL_DIR` (install.sh honours it)
 * @param home      the home directory, for the default install dir
 */
export function classifyBinaryInstall(
  execPath: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): BinaryInstallShape {
  const path = execPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!path) return 'unknown';

  // Platform subpackage: <anything>/node_modules/botmux-<plat>-<arch>[-musl]/botmux
  // Anchored on `/node_modules/` so a user directory that merely happens to be
  // named `botmux-linux-x64` is not mistaken for a package-manager-owned tree.
  if (/\/node_modules\/botmux-(?:linux|darwin)-(?:x64|arm64)(?:-musl)?\/botmux$/.test(path)) {
    return 'npm-binary';
  }

  // The standalone install location. `BOTMUX_INSTALL_DIR` is what install.sh
  // honours, so an install that used it is recognised WHEN THAT VARIABLE IS STILL
  // EXPORTED at runtime. ⚠️ It usually is not: `BOTMUX_INSTALL_DIR=/opt/bm sh
  // install.sh` sets it for the installer only, so a later `botmux update` sees a
  // bare environment and this falls through to `unknown` — fail-closed, so nothing
  // is damaged, but self-update is unavailable for that install. Do not describe
  // custom dirs as unconditionally covered; making them work without the variable
  // would need a persisted install record, which is out of scope here.
  for (const raw of [env.BOTMUX_INSTALL_DIR, defaultInstallDir(home)]) {
    if (!raw) continue;
    const dir = raw.replace(/\\/g, '/').replace(/\/+$/, '');
    if (dir && path === `${dir}/botmux`) return 'curl-binary';
  }
  return 'unknown';
}

/** Classify the running process. `unknown` for a non-compiled (Node) run, whose
 *  updates go through the package-manager path instead. */
export function currentBinaryInstallShape(): BinaryInstallShape {
  if (!isStandaloneBinary()) return 'unknown';
  return classifyBinaryInstall(process.execPath);
}

/**
 * Map a platform-subpackage binary path to the MAIN `botmux` package root that
 * owns it. TWO layouts occur in the wild and both are load-bearing:
 *
 *   nested  (npm)  …/node_modules/botmux/node_modules/botmux-linux-x64/botmux
 *                  → …/node_modules/botmux          (the ENCLOSING package)
 *   sibling (Bun)  …/node_modules/botmux-linux-x64/botmux
 *                  → …/node_modules/botmux          (the package BESIDE it)
 *
 * ⚠️ ONLY THE SIBLING SHAPE USED TO BE HANDLED, and that was the whole of a real
 * bug: npm 10 does NOT hoist a package's own dependencies to the global root, so
 * `npm i -g botmux` puts the platform subpackage INSIDE the main package. The
 * sibling rule then produced `…/node_modules/botmux/node_modules/botmux`, a
 * directory that does not exist, so `detectGlobalInstallManager` said `unknown`,
 * no install plan resolved, and every npm user got "当前安装方式无法安全自动更新"
 * from `botmux update`, the dashboard button, and scheduled auto-update alike.
 * MEASURED on a real `npm i -g botmux` (npm 10.9.4): the binary lives at
 * `<prefix>/lib/node_modules/botmux/node_modules/botmux-linux-x64/botmux`, and
 * peer globals nest the same way (pm2: 112 nested deps, http-server: 47).
 *
 * The sibling rule is NOT obsolete and must not be replaced: MEASURED on the same
 * box, Bun's global tree HOISTS (a declared global package with dependencies has
 * 0 entries in its own `node_modules`), so a Bun-installed platform subpackage
 * really is a sibling. Hence both, distinguished purely and without touching the
 * filesystem: in the nested layout the directory CONTAINING that `node_modules`
 * is itself the main package (it is literally named `botmux`), so when that holds
 * it is the answer; otherwise the main package sits beside the subpackage. No
 * `existsSync` probe — this stays pure, and a guess that happens to be absent on
 * one box would otherwise silently change the answer.
 *
 * WHY GO THROUGH THE MAIN PACKAGE instead of computing an npm `--prefix` here:
 * `resolveGlobalInstallPlan` already classifies that path shape into the right
 * manager and builds the right command — including pnpm's `--global-dir`, Bun's
 * env pinning, and the POSIX-vs-Windows prefix difference — and all of it is
 * unit-tested. Re-deriving a prefix here would be a second, diverging
 * implementation of the same rules. It also means `pnpm i -g` / `bun add -g`
 * installs keep resolving to THEIR manager rather than being forced onto npm.
 *
 * Returns null when the shape does not match, so callers fail closed.
 */
export function mainPackageRootForSubpackageBinary(execPath: string): string | null {
  const path = execPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const m = /^(.*\/node_modules)\/botmux-(?:linux|darwin)-(?:x64|arm64)(?:-musl)?\/botmux$/.exec(path);
  if (!m) return null;
  const nodeModules = m[1];
  // Nested (npm): the directory holding this `node_modules` is the main package.
  // Anchored on `/botmux` so only the real main package matches — a subpackage
  // nested under some OTHER package would not be ours to hand to the manager.
  const enclosing = nodeModules.slice(0, -'/node_modules'.length);
  if (/\/node_modules\/botmux$/.test(enclosing)) return enclosing;
  // Sibling (Bun's hoisted global tree, and Windows npm).
  return `${nodeModules}/botmux`;
}

/**
 * How the running process should update itself.
 *
 *  · `package-manager` — hand off to npm/pnpm/Bun for `packageRoot`. Covers both a
 *    plain Node install AND a compiled binary living inside a package manager's
 *    tree (the manager owns that file).
 *  · `self-replace`    — download the release asset and swap the binary.
 *  · `unsupported`     — could not identify the install; callers keep their
 *                        existing "unsupported install" behaviour.
 */
export type UpdateStrategy =
  | { kind: 'package-manager'; packageRoot: string }
  | { kind: 'self-replace'; target: string }
  | { kind: 'unsupported'; reason: 'unknown-binary-location' };

/**
 * Decide the update strategy. Pure over its inputs so every branch is testable
 * without a compiled binary.
 *
 * The Node path is deliberately left EXACTLY as it was: when this is not a
 * standalone binary we return the running install root and callers resolve it
 * through `resolveGlobalInstallPlan` as before — no behaviour change for npm
 * `dist/cli.js` deployments or source checkouts.
 *
 * @param standalone   is this a compiled single-file executable?
 * @param execPath     the running executable
 * @param installRoot  `botmuxInstallRoot()` — only meaningful when NOT standalone
 */
export function resolveUpdateStrategy(
  standalone: boolean,
  execPath: string,
  installRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): UpdateStrategy {
  if (!standalone) return { kind: 'package-manager', packageRoot: installRoot };
  const shape = classifyBinaryInstall(execPath, env, home);
  if (shape === 'npm-binary') {
    const root = mainPackageRootForSubpackageBinary(execPath);
    // The regex that produced `npm-binary` is the same one used here, so `root`
    // cannot be null in practice; keep the guard so a future loosening of one
    // pattern degrades to "unsupported" instead of dereferencing null.
    if (root) return { kind: 'package-manager', packageRoot: root };
  }
  if (shape === 'curl-binary') return { kind: 'self-replace', target: execPath };
  return { kind: 'unsupported', reason: 'unknown-binary-location' };
}

/** Production wiring for {@link resolveUpdateStrategy}. */
export function currentUpdateStrategy(installRoot: string): UpdateStrategy {
  return resolveUpdateStrategy(isStandaloneBinary(), process.execPath, installRoot);
}
