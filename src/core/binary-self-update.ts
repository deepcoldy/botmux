/**
 * How the RUNNING compiled binary was installed, and how to update it.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
 * Every pre-existing update path (`botmux update`, the dashboard's
 * `/api/update/run`, the scheduled maintenance auto-update) asks
 * `resolveGlobalInstallPlan(botmuxInstallRoot())` which package manager owns the
 * install. That question is answered by looking at the install ROOT — the
 * directory holding `package.json` — and classifying its path shape
 * (`…/lib/node_modules/botmux` ⇒ npm, `…/.pnpm/…` ⇒ pnpm, …).
 *
 * A compiled single-file executable has NO package.json on disk: the module graph
 * lives in the virtual read-only `/$bunfs/`, so `packageRoot()` walks up to `/`
 * and stops. MEASURED on the real published v3.18.4 binary and on a locally
 * compiled probe — identical in both:
 *
 *     botmuxInstallRoot()            → "/"
 *     detectGlobalInstallManager("/") → "unknown"
 *     resolveGlobalInstallPlan("/")   → throws UnsupportedGlobalInstallError
 *     botmuxCliEntry()                → "/dist/cli.js"  (does not exist)
 *
 * So on the real shipped artifact `botmux update` printed
 * “无法安全识别当前安装方式（unknown）” and exited, the dashboard button greyed out
 * with “supports npm/pnpm/Bun global installs only”, and the scheduled
 * auto-update failed every single day (fail-safe — it never restarts onto a stale
 * version — but it marks the day done, so it does not even retry).
 *
 * ── THE KEY INSIGHT: BOTH INSTALLERS SHIP THE SAME BINARY ─────────────────────
 * It is tempting to think “npm users update with npm, curl users update with
 * curl”, i.e. that the two installers produce different artifacts. They do not.
 * `npm i -g botmux` downloads a platform subpackage; its `bin` is a sh launcher
 * that resolves and `exec`s that subpackage's compiled binary, and its postinstall
 * additionally writes `~/.botmux/bin/botmux` as a launcher onto the same binary. `install.sh` downloads
 * the very same compiled binary from the GitHub Release. Same bytes, different
 * location — which is exactly why classifying by MODULE GRAPH cannot work (both
 * report `/`) and classifying by LOCATION can.
 *
 * `process.execPath` is the location of the running executable, and it is the one
 * thing that still differs. MEASURED, compiled binaries invoked through each
 * installer's own launcher:
 *
 *   npm  → /usr/lib/node_modules/botmux-linux-x64/botmux       (subpackage dir)
 *   curl → ~/.botmux/bin/botmux                                (BOTMUX_INSTALL_DIR)
 *
 * Note it is the REAL binary path in both cases, not the launcher's: the launcher
 * `exec`s the binary, so the process's execPath is the target. Verified by
 * running a compiled probe through a launcher of exactly the shape postinstall
 * writes.
 *
 * ── WHAT EACH SHAPE DOES TO UPDATE ─────────────────────────────────────────────
 *  · npm  → hand back to npm (`npm i -g botmux@latest`). npm replaces the
 *           subpackage and re-runs postinstall, which re-points the launcher. We
 *           must NOT rewrite the binary ourselves: npm owns that tree, and a
 *           hand-written file there would be clobbered (or worse, left behind at
 *           a version npm's metadata disagrees with).
 *  · curl → replace the binary in place. Prefer the configured registry's exact
 *           platform package (compressed, typically much faster on a local
 *           mirror), verify its SHA-512 integrity and runtime version, then
 *           atomically rename. Any registry-path failure falls back to the
 *           matching GitHub asset + published SHA-256. Nothing else owns that
 *           path.
 *
 * Other binary locations require a manual release installation at the default
 * launcher path. The original binary is retained; scheduled updates are disabled
 * until the installed release is running.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readdirSync, renameSync, rmSync, statSync, chmodSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GITHUB_REPO } from './restart-report.js';
import { getReleaseStream, resolveHttpProxy } from './release-download.js';
import {
  fetchConfiguredPackageArtifact,
  parseUpdateTarget,
  shouldApplySelfUpdate,
  type ParsedUpdateTarget,
  type RegistryPackageArtifact,
} from './update-check.js';

/**
 * Where the running compiled binary lives, and therefore who owns updating it.
 * The pure location classifier lives in `binary-install-shape.ts` so
 * `utils/global-install.ts` can import it without closing an import cycle through
 * this module (which reaches install-info via restart-report). Re-exported here so
 * callers have one obvious import site for the whole self-update surface.
 */
export {
  classifyBinaryInstall,
  currentBinaryInstallShape,
  mainPackageRootForSubpackageBinary,
  resolveUpdateStrategy,
  currentUpdateStrategy,
  type BinaryInstallShape,
  type UpdateStrategy,
} from './binary-install-shape.js';

// ── Release asset selection ────────────────────────────────────────────────────

/**
 * Is this a musl libc host (Alpine and most slim Docker images)?
 *
 * WHY IT MATTERS: a glibc-linked binary does not run on musl at all — it dies in
 * the loader with a message naming no cause. Downloading the wrong one turns a
 * working install into a binary that cannot start, which is strictly worse than
 * refusing to update.
 *
 * Mirrors the probe order in `scripts/postinstall-bin.mjs` and install.sh, and is
 * deliberately conservative: only claim musl when positively observed, so a glibc
 * box is never pushed onto the musl asset. Node's `process.report` header is a
 * NEGATIVE signal only — measured on node:22-alpine it carries neither
 * `glibcVersionRuntime` nor any musl key, so it can confirm glibc but never musl.
 */
export function isMuslHost(
  platform: NodeJS.Platform = process.platform,
  probes: {
    glibcRuntime?: () => string | undefined;
    listDir?: (dir: string) => string[];
    exists?: (path: string) => boolean;
  } = {},
): boolean {
  if (platform !== 'linux') return false;
  const glibcRuntime = probes.glibcRuntime ?? (() => {
    try {
      return (process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } })
        ?.header?.glibcVersionRuntime;
    } catch { return undefined; }
  });
  const listDir = probes.listDir ?? ((dir: string) => {
    try { return readdirSync(dir); } catch { return []; }
  });
  const exists = probes.exists ?? ((p: string) => {
    try { return existsSync(p); } catch { return false; }
  });

  if (glibcRuntime()) return false; // a reported glibc runtime settles it
  for (const dir of ['/lib', '/usr/lib']) {
    if (listDir(dir).some(f => f.startsWith('ld-musl-'))) return true;
  }
  return exists('/etc/alpine-release');
}

/**
 * The release asset name for a platform, matching the names release.yml uploads
 * (`botmux-<os>-<arch>[-musl]`) and install.sh downloads. Returns null for a
 * platform/arch with no published build rather than inventing a name that 404s.
 */
export function releaseAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = isMuslHost(platform),
): string | null {
  const os = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'darwin' : null;
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (!os || !cpu) return null;
  // Only linux ships musl variants; darwin has no such split.
  return `botmux-${os}-${cpu}${os === 'linux' && musl ? '-musl' : ''}`;
}

/** Download base for a release tag, mirroring install.sh's URL construction. */
export function releaseAssetBaseUrl(version: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/v${version.replace(/^v/i, '')}`;
}

// ── The self-update itself ─────────────────────────────────────────────────────

const SELF_UPDATE_UA = 'botmux-self-update';

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function sha512FileBase64(path: string): Promise<string> {
  const hash = createHash('sha512');
  await pipeline(createReadStream(path), hash);
  return hash.digest('base64');
}

export interface BinarySelfUpdateResult {
  /** The asset that was installed. */
  asset: string;
  /** Absolute path that was replaced. */
  target: string;
  /** Bytes written. */
  bytes: number;
  /** Transport used for the candidate. Registry packages are compressed and
   *  usually faster on configured mirrors; GitHub remains the fail-safe. */
  source: 'registry-package' | 'github-release';
}

export type BinaryUpdatePhase = 'download' | 'checksum' | 'probe' | 'swap';

export interface BinaryUpdateProgress {
  /** Current stage. `download` events carry live byte counts; later stages
   *  report the fully-downloaded size so the UI stays busy past 100%. */
  phase: BinaryUpdatePhase;
  bytesReceived: number;
  /** Asset size from the response's Content-Length, or null when the
   *  (injected or chunked) stream does not announce one. */
  bytesTotal: number | null;
}

export interface BinarySelfUpdateDeps {
  /** Fetch a URL as a readable stream (injected for tests). */
  fetchStream?: (url: string) => Promise<NodeJS.ReadableStream>;
  /** Read the published checksum for `asset`, or null when none is published. */
  fetchChecksum?: (url: string) => Promise<string | null>;
  /** Resolve the exact platform package from the configured registry. Supplying
   *  `fetchStream` without this hook keeps legacy transport tests offline. */
  resolveRegistryArtifact?: (
    packageName: string,
    version: string,
  ) => Promise<RegistryPackageArtifact | null>;
  /** Fetch the configured-registry package tarball (injected for tests). */
  fetchRegistryStream?: (url: string) => Promise<NodeJS.ReadableStream>;
  /** Extract package/botmux from a verified npm tarball (injected for tests). */
  extractRegistryBinary?: (archive: string, destinationDir: string) => string;
  /** Execute the downloaded candidate before activation (injected for tests). */
  probeBinary?: (path: string) => { status: number | null; signal?: NodeJS.Signals | null; error?: Error; stdout?: string | Buffer | null; stderr?: string | Buffer | null };
  /** Observe download byte counts and stage transitions (dashboard progress). */
  onProgress?: (progress: BinaryUpdateProgress) => void;
}

function extractRegistryBinaryWithTar(archive: string, destinationDir: string): string {
  // SHA-512 pins the archive to the registry manifest. Intermediate archive
  // members rely on the host tar's path protections; check the final file below.
  const result = spawnSync('tar', [
    '-xzf', archive,
    '-C', destinationDir,
    'package/botmux',
  ], {
    encoding: 'utf-8',
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.error?.message || result.stderr || `exit ${result.status}`).trim();
    throw new Error(`registry package extraction failed: ${detail}`);
  }
  const candidate = join(destinationDir, 'package', 'botmux');
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('registry package candidate is not a regular file');
  }
  return candidate;
}

/** Shared direction guard for implicit latest updates, before any download or
 * filesystem mutation. Explicit versions may reinstall or roll back. */
export async function applyStandaloneUpdate(
  version: string,
  request: {
    currentVersion: string;
    target?: string;
    updateTarget?: ParsedUpdateTarget;
  },
  deps: BinarySelfUpdateDeps = {},
): Promise<({ skipped: false } & BinarySelfUpdateResult) | {
  skipped: true;
  reason: 'already_latest' | 'already_at_target';
}> {
  const updateTarget = request.updateTarget ?? parseUpdateTarget()!;
  const decision = shouldApplySelfUpdate(updateTarget, version, request.currentVersion);
  const reinstall = version === request.currentVersion
    && updateTarget.isExplicit && !updateTarget.isChannel;
  if (!decision.proceed && !reinstall) {
    return { skipped: true, reason: decision.reason! };
  }
  const result = await replaceStandaloneBinary(version, request.target, deps);
  return { skipped: false, ...result };
}

/**
 * Replace the running standalone binary with `version`'s published asset.
 *
 * ── WHY A RENAME AND NOT A WRITE (do not "simplify" this) ─────────────────────
 * MEASURED on Linux with a real ELF:
 *
 *   open(target,'r+b').write(…)  → OSError 26 ETXTBSY "Text file busy"
 *   rename(new, target)          → succeeds; the running process keeps executing
 *                                  the old inode and finishes normally
 *
 * So the update MUST land as a rename over the path, never an in-place write:
 * the kernel refuses to let us scribble on the executable of a live process, and
 * a rename is also what makes the swap atomic for anything about to `exec` it.
 * The temp file is created in the SAME directory as the target so the rename is
 * within one filesystem (a cross-device rename fails with EXDEV, and copying
 * would reintroduce the torn-file window this avoids).
 *
 * Checksum verification happens BEFORE the rename, so a truncated or tampered
 * download is discarded while the working binary is still in place. Registry
 * packages require their manifest's SHA-512 integrity; the GitHub fallback keeps
 * its existing `.sha256` verification (missing checksum remains a warning,
 * matching install.sh, with size + runtime probes still required).
 *
 * ── WHY NO `realpathSync(target)` ─────────────────────────────────────────────
 * Renaming over a SYMLINK replaces the link itself and orphans its target
 * (measured). That would matter if `target` could be a symlink — but the default
 * target is `process.execPath`, which the OS has already resolved: MEASURED with a
 * compiled binary invoked through a symlink, `process.execPath` reports the real
 * file, never the link. So the symlink case is unreachable on the production path,
 * and resolving again would only add a failure mode of its own (an unreadable
 * parent dir). install.sh's plain `mv` has the same semantics.
 */
export async function replaceStandaloneBinary(
  version: string,
  target: string = process.execPath,
  deps: BinarySelfUpdateDeps = {},
): Promise<BinarySelfUpdateResult> {
  const asset = releaseAssetName();
  if (!asset) {
    throw new Error(`当前平台没有发布二进制（${process.platform}-${process.arch}）`);
  }
  const base = releaseAssetBaseUrl(version);
  const proxy = resolveHttpProxy();
  const registryProxy = resolveHttpProxy({ includeConfig: false });
  const fetchStream = deps.fetchStream
    ?? (async (url: string) => await getReleaseStream(url, proxy, SELF_UPDATE_UA));
  const fetchRegistryStream = deps.fetchRegistryStream
    ?? (async (url: string) => await getReleaseStream(url, registryProxy, SELF_UPDATE_UA, 5, { respectNoProxy: true }));
  // Existing tests inject the GitHub stream. Treat that as a complete transport
  // override unless they explicitly opt into the registry-package path too.
  const resolveRegistryArtifact = deps.resolveRegistryArtifact
    ?? (deps.fetchStream ? async () => null : fetchConfiguredPackageArtifact);
  const extractRegistryBinary = deps.extractRegistryBinary ?? extractRegistryBinaryWithTar;
  const fetchChecksum = deps.fetchChecksum ?? (async (url: string) => {
    try {
      const res = await getReleaseStream(url, proxy, SELF_UPDATE_UA);
      const chunks: Buffer[] = [];
      for await (const chunk of res) chunks.push(Buffer.from(chunk as Buffer));
      // The file is "<sha256>  <filename>"; take the first field.
      const first = Buffer.concat(chunks).toString('utf-8').trim().split(/\s+/)[0] ?? '';
      return /^[0-9a-f]{64}$/i.test(first) ? first.toLowerCase() : null;
    } catch {
      return null; // no checksum published (or unreachable) → warn, don't fail
    }
  });
  const probeBinary = deps.probeBinary ?? ((path: string) => spawnSync(path, ['--version'], {
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, BOTMUX_INSTALL_PROBE: '1' },
  }));

  // Same directory as the target: keeps the rename intra-filesystem (EXDEV).
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const token = `${process.pid}.${randomBytes(4).toString('hex')}`;
  const tmp = join(dir, `.botmux-update.${token}.tmp`);
  let bytesReceived = 0;
  let bytesTotal: number | null = null;
  const emit = (phase: BinaryUpdatePhase): void => {
    deps.onProgress?.({ phase, bytesReceived, bytesTotal });
  };
  const downloadTo = async (res: NodeJS.ReadableStream, destination: string): Promise<void> => {
    const headers = (res as { headers?: Record<string, string | string[] | undefined> }).headers;
    const declared = headers
      ? Number(Array.isArray(headers['content-length']) ? headers['content-length'][0] : headers['content-length'])
      : NaN;
    bytesTotal = Number.isFinite(declared) && declared > 0 ? declared : null;
    bytesReceived = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesReceived += chunk.length;
        emit('download');
        callback(null, chunk);
      },
    });
    emit('download');
    await pipeline(res, counter, createWriteStream(destination));
  };

  try {
    let source: BinarySelfUpdateResult['source'] = 'github-release';
    let registryInstalled = false;
    const archive = join(dir, `.botmux-update.${token}.tgz`);
    let extractDir: string | null = null;
    try {
      const artifact = await resolveRegistryArtifact(asset, version);
      if (artifact) {
        const res = await fetchRegistryStream(artifact.tarball);
        await downloadTo(res, archive);
        emit('checksum');
        const expected = artifact.integrity.slice('sha512-'.length);
        const actual = await sha512FileBase64(archive);
        if (actual !== expected) {
          throw new Error(`${asset} registry SHA-512 integrity mismatch`);
        }
        extractDir = mkdtempSync(join(dir, '.botmux-registry-'));
        const candidate = extractRegistryBinary(archive, extractDir);
        renameSync(candidate, tmp);
        registryInstalled = true;
        source = 'registry-package';
      }
    } catch {
      // Registry transport is an optimization. Any manifest, download,
      // integrity, extraction or filesystem failure falls back to the existing
      // GitHub Release + SHA-256 path without touching the working binary.
      rmSync(tmp, { force: true });
    } finally {
      rmSync(archive, { force: true });
      if (extractDir) rmSync(extractDir, { recursive: true, force: true });
    }

    if (!registryInstalled) {
      const res = await fetchStream(`${base}/${asset}`);
      await downloadTo(res, tmp);
      emit('checksum');
      const expected = await fetchChecksum(`${base}/${asset}.sha256`);
      if (expected) {
        const actual = await sha256File(tmp);
        if (actual !== expected) {
          throw new Error(`${asset} SHA-256 校验不通过（期望 ${expected}，实际 ${actual}）`);
        }
      }
    }
    const bytes = statSync(tmp).size;
    // A truncated download that still passed (no checksum published) would leave
    // an unrunnable binary in place of a working one. The real assets are ~100MB+;
    // anything under a megabyte is a GitHub error page, not an executable.
    if (bytes < 1_000_000) {
      throw new Error(`${asset} 下载内容异常（仅 ${bytes} 字节，疑似错误页而非二进制）`);
    }
    chmodSync(tmp, 0o755);
    // Asset name + checksum prove identity, not runtime compatibility. In
    // particular, npm's `libc: glibc` cannot express a GLIBC symbol-version
    // floor; an embedded native built on a newer distro can still fail at dlopen.
    // Probe the complete module graph before the atomic rename so self-update has
    // the same fail-safe contract as npm postinstall and install.sh.
    emit('probe');
    const probe = probeBinary(tmp);
    if (probe.error || probe.status !== 0) {
      const raw = probe.error?.message || probe.stderr || `exit ${probe.status ?? probe.signal ?? 'unknown'}`;
      const detail = String(raw).trim().split('\n').slice(0, 8).join(' | ');
      throw new Error(`${asset} 与当前主机不兼容，保留现有版本：${detail || 'candidate probe failed'}`);
    }
    const candidateVersion = String(probe.stdout ?? '').trim();
    if (candidateVersion !== version) {
      throw new Error(`${asset} 版本校验失败（期望 ${version}，实际 ${candidateVersion || 'unknown'}），保留现有版本`);
    }
    // Atomic swap. NOT a write to `target` — that is ETXTBSY (see header).
    emit('swap');
    renameSync(tmp, target);
    return { asset, target, bytes, source };
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
