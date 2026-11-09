/**
 * Content-addressed stable snapshots of a TRAE release.
 *
 * Why a snapshot at all: the CLI's shared `.system` cache is rebuilt from the
 * skills bundle of whatever executable actually runs. If BotMux spawns the
 * install entry (`current -> releases/...`), an upgrade between the last stat
 * and exec can make an "old" runtime start the new content (or the reverse).
 * Executing a private, verified copy removes that window: the snapshot inode
 * cannot change under a running process, and the gate keys overlap decisions
 * on the same content identity.
 *
 * Identity closure (round-4 review): capture the three expected SHA-256 values
 * ONCE, derive `comboKey` from those captured values, copy, then verify every
 * copy against the captured values AND recompute the key from the copies. If
 * the install switches between capture and copy, the copies disagree and the
 * temporary directory is discarded — content B is never published under A's
 * identity.
 *
 * Cost: one snapshot per content combination, shared by every bot/generation
 * with identical bytes. Never one 670 MB copy per generation.
 */
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  promises as fsp,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { withExclusiveFileLockAsync } from '../utils/file-flock.js';
import { resolveInstallIdentity, type ExecutableIdentity } from './cli-install-identity.js';

export const TRAEX_SNAPSHOT_MANIFEST = 'manifest.json';
export const TRAEX_SNAPSHOT_COMPLETE = '.complete';
const SNAPSHOT_VERSION = 1;
const MAX_MATERIALIZE_ATTEMPTS = 5;
const SNAPSHOT_LOCK_TIMEOUT_MS = 120_000;

export interface TraexReleaseIdentity {
  releaseDir: string;
  traex: string;
  helper?: string;
  installation?: string;
  hashes: { traex: string; helper?: string; installation?: string };
  comboKey: string;
  /** Stat signature of the source files at capture time. */
  sourceSignature?: string;
  /** Identity of the SOURCE install entry captured together with the content
   *  hashes above. It is the "install at spawn" fact: the worker must attest
   *  this value, never a later fresh stat of the mutable entry. */
  sourceInstallIdentity?: ExecutableIdentity;
}

export interface TraexSnapshotManifest {
  version: number;
  comboKey: string;
  sourceReleaseDir: string;
  /** Stat signature of the three source files at capture time. Lets a reader
   *  prove whether the mutable install entry still names the content this
   *  snapshot was built from without re-hashing the large binaries. */
  sourceSignature?: string;
  traex: { sha256: string; size: number; devIno: string };
  helper?: { sha256: string; size: number; devIno: string };
  installation?: { sha256: string; size: number; devIno: string };
  createdAt: string;
  verified: true;
}

export interface TraexSnapshotProvenance {
  snapshotDir: string;
  manifest: TraexSnapshotManifest;
  sourceReleaseDir: string;
  sourceSignature?: string;
}

/**
 * The executable content a gate may start.
 *
 * `snapshot: true` means the paths point into a verified private copy whose
 * inode cannot change under the process. `snapshot: false` is the operator's
 * pinned executable: it is hashed for identity and still occupies the domain,
 * but it is never copied (the operator chose that exact path deliberately).
 */
export interface TraexRuntimeContent {
  comboKey: string;
  dir: string;
  traexPath: string;
  helperPath?: string;
  installationPath?: string;
  manifest?: TraexSnapshotManifest;
  reused: boolean;
  snapshot: boolean;
  /** Identity of the configured install entry observed in the SAME capture
   *  that produced `comboKey`. Source observation and exec content are then
   *  atomically consistent: an entry switch after the lease cannot relabel
   *  which install this runtime was admitted from. */
  sourceInstallIdentity?: ExecutableIdentity;
}

export interface TraexSnapshot extends TraexRuntimeContent {
  manifest: TraexSnapshotManifest;
  snapshot: true;
}

export function defaultTraexSnapshotRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.BOTMUX_TRAEX_SNAPSHOT_DIR?.trim();
  return configured && configured.length > 0 ? configured : join(homedir(), '.botmux', 'traex-snapshots');
}

/** Release directory for a resolved CLI executable (diagnostic symlink already
 *  resolved by the caller). The paired helper and installation metadata are
 *  siblings of the main binary in every published release layout. */
export function releaseDirForExecutable(executablePath: string): string {
  return join(executablePath, '..');
}

/**
 * `comboKey` deliberately hashes only content, never path text: two byte-equal
 * copies of the same release (different bot homes, restore) share one snapshot.
 */
export function comboKeyFromHashes(hashes: { traex: string; helper?: string; installation?: string }): string {
  return createHash('sha256')
    .update(`traex ${hashes.traex}\nhelper ${hashes.helper ?? '-'}\ninstall ${hashes.installation ?? '-'}\n`)
    .digest('hex');
}

interface ReleaseFileStat {
  devIno: string;
  size: number;
  mtimeNs: string;
}

interface CachedReleaseIdentity {
  signature: string;
  identity: TraexReleaseIdentity;
}

const releaseIdentityCache = new Map<string, CachedReleaseIdentity>();

/** One release directory can be read through different leaves (the configured
 *  `traex` entry or an operator-pinned executable with another name), so the
 *  cache key must include the exact main-executable path. */
function releaseIdentityCacheKey(releaseDir: string, executablePath?: string): string {
  return `${releaseDir}\0${executablePath ?? 'traex'}`;
}

function statSignature(files: Array<string | undefined>): string | undefined {
  const parts: string[] = [];
  for (const file of files) {
    if (!file) { parts.push('-'); continue; }
    try {
      const st = statSync(file, { bigint: true });
      parts.push(`${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`);
    } catch {
      return undefined;
    }
  }
  return parts.join('|');
}

/**
 * Stat-only signature of the three files in a release directory. Missing
 * optional siblings are represented as `-`, so the value can be recomputed
 * after an upgrade and compared with a snapshot's recorded source signature.
 */
export function traexReleaseSignature(releaseDir: string): string | undefined {
  const traex = join(releaseDir, 'traex');
  if (!existsSync(traex)) return undefined;
  const helperCandidate = join(releaseDir, 'traex-code-mode-host');
  const installationCandidate = join(releaseDir, 'trae-installation.json');
  return statSignature([
    traex,
    existsSync(helperCandidate) ? helperCandidate : undefined,
    existsSync(installationCandidate) ? installationCandidate : undefined,
  ]);
}

/**
 * Read the provenance a published snapshot records about its source install.
 *
 * `executablePath` may be the snapshot's `traex` leaf (what an attestation
 * reports) or its directory. Returns `undefined` when the path is not inside a
 * verified snapshot.
 */
export function readTraexSnapshotProvenance(executablePath: string): TraexSnapshotProvenance | undefined {
  const snapshotDir = existsSync(join(executablePath, TRAEX_SNAPSHOT_MANIFEST))
    ? executablePath
    : releaseDirForExecutable(executablePath);
  if (!existsSync(join(snapshotDir, TRAEX_SNAPSHOT_COMPLETE))) return undefined;
  const manifest = readManifest(snapshotDir);
  if (!manifest) return undefined;
  if (typeof manifest.sourceReleaseDir !== 'string' || manifest.sourceReleaseDir.length === 0) return undefined;
  return {
    snapshotDir,
    manifest,
    sourceReleaseDir: manifest.sourceReleaseDir,
    ...(typeof manifest.sourceSignature === 'string' ? { sourceSignature: manifest.sourceSignature } : {}),
  };
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

/**
 * Capture one release identity. The returned hashes are the expectation the
 * copies are later verified against; they are never re-read from the source.
 */
export async function captureTraexReleaseIdentity(
  releaseDir: string,
  executablePath?: string,
): Promise<TraexReleaseIdentity> {
  // An operator-pinned executable may not be called `traex` (renamed or
  // installed under a custom name). It is still the main executable of the
  // snapshot; only the source leaf changes.
  const traex = executablePath ?? join(releaseDir, 'traex');
  if (!existsSync(traex)) throw new Error(`TRAE release is missing its main executable: ${traex}`);
  const helperCandidate = join(releaseDir, 'traex-code-mode-host');
  const installationCandidate = join(releaseDir, 'trae-installation.json');
  const helper = existsSync(helperCandidate) ? helperCandidate : undefined;
  const installation = existsSync(installationCandidate) ? installationCandidate : undefined;

  const signature = statSignature([traex, helper, installation]);
  // Captured in the SAME pass as the content hashes. The worker must attest
  // this value instead of statting the mutable entry again after the lease.
  const sourceInstallIdentity = resolveInstallIdentity(traex);
  const cacheKey = releaseIdentityCacheKey(releaseDir, executablePath);
  if (signature) {
    const cached = releaseIdentityCache.get(cacheKey);
    if (cached && cached.signature === signature) {
      // A stat signature can collide when two rewrites land in the same
      // timestamp tick (small files such as installation.json are the likely
      // case). Re-hash the cheap metadata file so a changed install can never
      // reuse the previous identity; the large binaries are covered by the
      // copy verification + retry below.
      const cachedInstallation = cached.identity.hashes.installation;
      if (installation === undefined || cachedInstallation === undefined) {
        return cached.identity;
      }
      if ((await sha256File(installation)) === cachedInstallation) return cached.identity;
      releaseIdentityCache.delete(cacheKey);
    }
  }

  const hashes = {
    traex: await sha256File(traex),
    ...(helper ? { helper: await sha256File(helper) } : {}),
    ...(installation ? { installation: await sha256File(installation) } : {}),
  };
  const identity: TraexReleaseIdentity = {
    releaseDir,
    traex,
    ...(helper ? { helper } : {}),
    ...(installation ? { installation } : {}),
    hashes,
    comboKey: comboKeyFromHashes(hashes),
    ...(signature ? { sourceSignature: signature } : {}),
    ...(sourceInstallIdentity ? { sourceInstallIdentity } : {}),
  };
  if (signature) releaseIdentityCache.set(cacheKey, { signature, identity });
  return identity;
}

/** Test seam: the cache is process-wide and must not leak fixtures. */
export function __testOnly_resetTraexSnapshotCache(): void {
  releaseIdentityCache.clear();
}

/**
 * Hash the executable an operator pinned, WITHOUT copying it.
 *
 * Fixed-path launches must still take part in the shared domain: they are the
 * exact bytes that will write the cache, so their content identity decides
 * whether another runtime may start. They are exempt only from automatic
 * switching, never from coordination. Siblings are optional because a pinned
 * binary need not sit in a full release layout.
 */
export async function captureTraexExecutableIdentity(executablePath: string): Promise<TraexRuntimeContent> {
  const dir = releaseDirForExecutable(executablePath);
  const helperCandidate = join(dir, 'traex-code-mode-host');
  const installationCandidate = join(dir, 'trae-installation.json');
  const helper = existsSync(helperCandidate) ? helperCandidate : undefined;
  const installation = existsSync(installationCandidate) ? installationCandidate : undefined;
  const hashes = {
    traex: await sha256File(executablePath),
    ...(helper ? { helper: await sha256File(helper) } : {}),
    ...(installation ? { installation: await sha256File(installation) } : {}),
  };
  const sourceInstallIdentity = resolveInstallIdentity(executablePath);
  return {
    comboKey: comboKeyFromHashes(hashes),
    dir,
    traexPath: executablePath,
    ...(sourceInstallIdentity ? { sourceInstallIdentity } : {}),
    ...(helper ? { helperPath: helper } : {}),
    ...(installation ? { installationPath: installation } : {}),
    reused: false,
    snapshot: false,
  };
}

function snapshotPaths(dir: string) {
  return {
    manifest: join(dir, TRAEX_SNAPSHOT_MANIFEST),
    complete: join(dir, TRAEX_SNAPSHOT_COMPLETE),
    traex: join(dir, 'traex'),
    helper: join(dir, 'traex-code-mode-host'),
    installation: join(dir, 'trae-installation.json'),
  };
}

function readManifest(dir: string): TraexSnapshotManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(snapshotPaths(dir).manifest, 'utf8')) as TraexSnapshotManifest;
    if (parsed.version !== SNAPSHOT_VERSION || parsed.verified !== true) return undefined;
    if (typeof parsed.comboKey !== 'string' || parsed.comboKey.length === 0) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function manifestMatches(manifest: TraexSnapshotManifest, identity: TraexReleaseIdentity): boolean {
  if (manifest.comboKey !== identity.comboKey) return false;
  if (manifest.traex.sha256 !== identity.hashes.traex) return false;
  if ((manifest.helper?.sha256 ?? undefined) !== identity.hashes.helper) return false;
  if ((manifest.installation?.sha256 ?? undefined) !== identity.hashes.installation) return false;
  return true;
}

function snapshotFromDir(
  dir: string,
  manifest: TraexSnapshotManifest,
  reused: boolean,
  sourceInstallIdentity?: ExecutableIdentity,
): TraexSnapshot {
  const paths = snapshotPaths(dir);
  return {
    comboKey: manifest.comboKey,
    dir,
    traexPath: paths.traex,
    ...(manifest.helper ? { helperPath: paths.helper } : {}),
    ...(manifest.installation ? { installationPath: paths.installation } : {}),
    manifest,
    reused,
    snapshot: true,
    ...(sourceInstallIdentity ? { sourceInstallIdentity } : {}),
  };
}

/** Reuse only when the published snapshot still carries the same verified
 *  identity. Size/ino drift means an external rewrite; re-materialise. */
function reusableSnapshot(dir: string, identity: TraexReleaseIdentity): TraexSnapshot | undefined {
  const paths = snapshotPaths(dir);
  if (!existsSync(paths.complete)) return undefined;
  const manifest = readManifest(dir);
  if (!manifest || !manifestMatches(manifest, identity)) return undefined;
  try {
    const st = statSync(paths.traex, { bigint: true });
    if (`${st.dev}:${st.ino}` !== manifest.traex.devIno) return undefined;
    if (Number(st.size) !== manifest.traex.size) return undefined;
    if (manifest.helper && !existsSync(paths.helper)) return undefined;
    if (manifest.installation && !existsSync(paths.installation)) return undefined;
  } catch {
    return undefined;
  }
  return snapshotFromDir(dir, manifest, true, identity.sourceInstallIdentity);
}

function fileStat(path: string): ReleaseFileStat {
  const st = statSync(path, { bigint: true });
  return { devIno: `${st.dev}:${st.ino}`, size: Number(st.size), mtimeNs: st.mtimeNs.toString() };
}

interface CopyResult {
  ok: boolean;
  mismatch?: string;
}

async function copyAndVerify(
  tmpDir: string,
  identity: TraexReleaseIdentity,
): Promise<CopyResult> {
  const target = snapshotPaths(tmpDir);
  const files: Array<{ src: string; dst: string; expected: string; mode: number }> = [
    { src: identity.traex, dst: target.traex, expected: identity.hashes.traex, mode: 0o755 },
  ];
  if (identity.helper && identity.hashes.helper) {
    files.push({ src: identity.helper, dst: target.helper, expected: identity.hashes.helper, mode: 0o755 });
  }
  if (identity.installation && identity.hashes.installation) {
    files.push({ src: identity.installation, dst: target.installation, expected: identity.hashes.installation, mode: 0o644 });
  }
  for (const file of files) {
    await fsp.copyFile(file.src, file.dst);
    await fsp.chmod(file.dst, file.mode);
  }
  const copied = {
    traex: await sha256File(target.traex),
    ...(identity.helper ? { helper: await sha256File(target.helper) } : {}),
    ...(identity.installation ? { installation: await sha256File(target.installation) } : {}),
  };
  if (copied.traex !== identity.hashes.traex) return { ok: false, mismatch: 'traex' };
  if (copied.helper !== identity.hashes.helper) return { ok: false, mismatch: 'helper' };
  if (copied.installation !== identity.hashes.installation) return { ok: false, mismatch: 'installation' };
  const copiedKey = comboKeyFromHashes(copied);
  if (copiedKey !== identity.comboKey) return { ok: false, mismatch: 'comboKey' };
  return { ok: true };
}

function buildManifest(
  identity: TraexReleaseIdentity,
  tmpDir: string,
  installation?: { sha256: string; size: number; devIno: string },
): TraexSnapshotManifest {
  const paths = snapshotPaths(tmpDir);
  return {
    version: SNAPSHOT_VERSION,
    comboKey: identity.comboKey,
    sourceReleaseDir: identity.releaseDir,
    ...(identity.sourceSignature ? { sourceSignature: identity.sourceSignature } : {}),
    traex: { sha256: identity.hashes.traex, ...fileStat(paths.traex) },
    ...(identity.helper && identity.hashes.helper
      ? { helper: { sha256: identity.hashes.helper, ...fileStat(paths.helper) } }
      : {}),
    ...(identity.installation && installation
      ? { installation }
      : {}),
    createdAt: new Date().toISOString(),
    verified: true,
  };
}

/**
 * Materialise (or reuse) the snapshot for the current content of `releaseDir`.
 *
 * Throws on unprovable identity, lock failure, copy failure or a source that
 * keeps changing. Callers must treat any throw as "do not start the CLI".
 */
export async function materializeTraexSnapshot(input: {
  releaseDir: string;
  /** Exact main executable to snapshot. Defaults to `<releaseDir>/traex`; an
   *  operator-pinned binary may live under another name. */
  executablePath?: string;
  snapshotsRoot?: string;
  /** Test seam: runs after the expected hashes are captured and before the
   *  copy starts, which is exactly the window an install switch can hit. */
  __testOnly_onCaptured?: (identity: TraexReleaseIdentity, attempt: number) => Promise<void> | void;
}): Promise<TraexSnapshot> {
  const root = input.snapshotsRoot ?? defaultTraexSnapshotRoot();
  await fsp.mkdir(root, { recursive: true });

  for (let attempt = 1; attempt <= MAX_MATERIALIZE_ATTEMPTS; attempt += 1) {
    const identity = await captureTraexReleaseIdentity(input.releaseDir, input.executablePath);
    await input.__testOnly_onCaptured?.(identity, attempt);
    const finalDir = join(root, identity.comboKey);
    const existing = reusableSnapshot(finalDir, identity);
    if (existing) return existing;

    const lock = await withExclusiveFileLockAsync(
      join(root, `.lock-${identity.comboKey}`),
      SNAPSHOT_LOCK_TIMEOUT_MS,
      async (): Promise<{ kind: 'snapshot'; snapshot: TraexSnapshot } | { kind: 'retry' }> => {
        const raced = reusableSnapshot(finalDir, identity);
        if (raced) return { kind: 'snapshot', snapshot: raced };

        const tmpDir = join(
          root,
          `.tmp-${identity.comboKey}-${process.pid}-${Date.now()}-${attempt}`,
        );
        try {
          await fsp.rm(tmpDir, { recursive: true, force: true });
          await fsp.mkdir(tmpDir, { recursive: true });
          const copied = await copyAndVerify(tmpDir, identity);
          if (!copied.ok) {
            await fsp.rm(tmpDir, { recursive: true, force: true });
            return { kind: 'retry' };
          }
          const installation = identity.installation
            ? { sha256: identity.hashes.installation!, ...fileStat(snapshotPaths(tmpDir).installation) }
            : undefined;
          const manifest = buildManifest(identity, tmpDir, installation);
          writeFileSync(snapshotPaths(tmpDir).manifest, JSON.stringify(manifest), 'utf8');
          writeFileSync(snapshotPaths(tmpDir).complete, `${identity.comboKey}\n`, 'utf8');
          try {
            renameSync(tmpDir, finalDir);
          } catch (err) {
            // Another process published the same combination first. That is
            // fine only if its manifest is the identity we verified.
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EISDIR') {
              await fsp.rm(tmpDir, { recursive: true, force: true });
              const winner = reusableSnapshot(finalDir, identity);
              if (winner) return { kind: 'snapshot', snapshot: winner };
              throw new Error(`snapshot publish collided with an unverified snapshot at ${finalDir}`);
            }
            throw err;
          }
          return { kind: 'snapshot', snapshot: snapshotFromDir(finalDir, manifest, false, identity.sourceInstallIdentity) };
        } catch (err) {
          try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
          throw err;
        }
      },
    );
    if (!lock.acquired) {
      throw new Error(
        `cannot coordinate TRAE snapshot materialisation for ${basename(identity.releaseDir)}: `
        + (lock.reason === 'error' ? lock.detail ?? 'lock error' : lock.reason),
      );
    }
    if (lock.value.kind === 'snapshot') return lock.value.snapshot;
    // The copies disagreed with the captured identity. Drop the stat-keyed
    // cache so the next attempt hashes the source again instead of repeating
    // the same stale expectation, then capture again.
    releaseIdentityCache.delete(releaseIdentityCacheKey(input.releaseDir, input.executablePath));
  }
  throw new Error(
    `TRAE install content kept changing while snapshotting ${input.releaseDir}; refusing to start`,
  );
}
