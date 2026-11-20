/**
 * One-click tmux upgrade for hosts whose tmux NO package manager owns (a
 * hand-placed ~/.local/bin/tmux, no sudo, a distro whose repositories stop
 * below the recommendation): botmux installs its OWN copy of an official
 * Debian build and prefers it from then on (see tmux-managed-path.ts and
 * tmuxEnv). The user's tmux is never touched.
 *
 * Rules (all enforced here, all covered by tests):
 *  - Sources are fixed in code: every candidate names its exact .deb, its size,
 *    its SHA256 (cross-checked against the Debian Packages index it shipped
 *    in) and two URLs serving the same bytes — deb.debian.org (fast, but a
 *    superseded backport leaves the pool) and snapshot.debian.org (permanent).
 *    Bytes whose size or SHA256 differ are discarded, never executed.
 *  - Only botmux's own directory is ever written, and an existing install is
 *    only replaced when it is PROVABLY botmux's: `current` is a symlink into
 *    `releases/`, the release has a manifest botmux wrote, and the executable
 *    still hashes to what that manifest recorded. Anything else is "foreign"
 *    and left alone.
 *  - Nothing is promoted until the staged binary has answered `tmux -V` with
 *    the expected release AND started a throwaway server on a private socket.
 *    Promotion is one atomic symlink rename, so a crash at any point leaves
 *    either the old install or the new one, never half of each.
 *  - The binary runs as is against the host's own libraries (no LD_LIBRARY_PATH,
 *    no loader wrapper): the tmux server's /proc/<pid>/exe must stay a file
 *    named `tmux` (current-actor.ts relies on it). Candidates are tried in
 *    order and the first one whose libraries the host has wins; both are
 *    ≥ TMUX_RECOMMENDED_MIN.
 *  - Switching the running server onto it is NOT done here: that is the
 *    owner-chosen switch on the card (tmux-upgrade.ts).
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync, chmodSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join, relative } from 'node:path';
import { withFileLock } from '../utils/file-lock.js';
import { getReleaseStream, resolveHttpProxy } from '../core/release-download.js';
import { tmuxEnv } from './ensure-tmux.js';
import { managedTmuxRoot } from './tmux-managed-path.js';
import {
  TMUX_RECOMMENDED_MIN,
  isTmuxBelowRecommended,
  tmuxReleaseLabel,
  type TmuxRecommendation,
} from './tmux-recommended.js';

export type PrebuiltArch = 'x64' | 'arm64';

export interface TmuxPrebuiltCandidate {
  /** Release as `tmux -V` reports it. */
  release: string;
  /** Exact Debian package version. */
  debVersion: string;
  arch: PrebuiltArch;
  fileName: string;
  size: number;
  sha256: string;
  /** SHA256 of the `usr/bin/tmux` inside it: what an installed copy must hash to. */
  binSha256: string;
  /** Same bytes, tried in order. */
  urls: readonly string[];
  /** Shared libraries the executable loads from the host (besides glibc). */
  hostLibraries: readonly string[];
  /** Highest GLIBC_x.y symbol version the executable references. */
  minGlibc: string;
}

const DEB_POOL = 'https://deb.debian.org/debian/pool/main/t/tmux/';
const snapshotPool = (stamp: string) => `https://snapshot.debian.org/archive/debian/${stamp}/pool/main/t/tmux/`;

const TMUX_35A_LIBS = ['libevent_core-2.1.so.7', 'libjemalloc.so.2', 'libsystemd.so.0', 'libtinfo.so.6', 'libstdc++.so.6', 'libgcc_s.so.1'] as const;
const TMUX_34_LIBS = ['libevent_core-2.1.so.7', 'libutempter.so.0', 'libsystemd.so.0', 'libtinfo.so.6'] as const;

/**
 * APPEND-ONLY: an installed copy is recognised as botmux's by matching an entry
 * here, so removing an entry would turn existing installs "foreign".
 *
 * Official Debian bookworm-backports builds (checked 2026-11-19): SHA256 and
 * size from the bookworm-backports Packages index (3.5a: live index; 3.4: the
 * snapshot index of 2024-08-29), library lists from each executable's
 * DT_NEEDED, glibc floor from its GLIBC_ symbol versions. 3.5a needs
 * libjemalloc2, 3.4 needs libutempter0 instead — offering both covers hosts
 * that have either (a host that ever had a distro tmux has libutempter0).
 */
export const TMUX_PREBUILT_CANDIDATES: readonly TmuxPrebuiltCandidate[] = [
  {
    release: '3.5a', debVersion: '3.5a-2~bpo12+1', arch: 'x64',
    fileName: 'tmux_3.5a-2~bpo12+1_amd64.deb', size: 487_280,
    sha256: '8aedf15af88f47dd726e163d314ca1fa026de98359643b4e63ba22a826d33882',
    binSha256: '2d934abcbb7561dd36b12cda3d0d0eb8a90dc8f111b6d3bbf78119a4f717f383',
    urls: [`${DEB_POOL}tmux_3.5a-2~bpo12+1_amd64.deb`, `${snapshotPool('20241019T023215Z')}tmux_3.5a-2~bpo12+1_amd64.deb`],
    hostLibraries: TMUX_35A_LIBS, minGlibc: '2.34',
  },
  {
    release: '3.5a', debVersion: '3.5a-2~bpo12+1', arch: 'arm64',
    fileName: 'tmux_3.5a-2~bpo12+1_arm64.deb', size: 450_768,
    sha256: 'bdbb9fc634fadd7b9dde2366826033e09d03381a578e3b47d4fd9a18a327e80c',
    binSha256: '39de92fa68e576958c7dcc12e29998dcf7792088e1c0245e32da9b9d23729bf9',
    urls: [`${DEB_POOL}tmux_3.5a-2~bpo12+1_arm64.deb`, `${snapshotPool('20241019T023215Z')}tmux_3.5a-2~bpo12+1_arm64.deb`],
    hostLibraries: TMUX_35A_LIBS, minGlibc: '2.34',
  },
  {
    release: '3.4', debVersion: '3.4-8~bpo12+1', arch: 'x64',
    fileName: 'tmux_3.4-8~bpo12+1_amd64.deb', size: 480_660,
    sha256: 'd2b99d7c773dcad5aafd2aca367edab8eae935e090b7efc63636f29a9b4e3eaf',
    binSha256: 'ee200c0b5679884282f4d2dc28b8681707c6108ff489d155561cfa9d3b433441',
    urls: [`${snapshotPool('20240829T084346Z')}tmux_3.4-8~bpo12+1_amd64.deb`],
    hostLibraries: TMUX_34_LIBS, minGlibc: '2.34',
  },
  {
    release: '3.4', debVersion: '3.4-8~bpo12+1', arch: 'arm64',
    fileName: 'tmux_3.4-8~bpo12+1_arm64.deb', size: 443_436,
    sha256: '3f57cd1fdea7fee8f9baa70d8522732e3e28c786bbc61f21d06265ef8cc7967b',
    binSha256: '1c6a22eefd78bab34fbbd9fe96f994bcbe3438893d065c3a5ba0edb588272571',
    urls: [`${snapshotPool('20240829T084346Z')}tmux_3.4-8~bpo12+1_arm64.deb`],
    hostLibraries: TMUX_34_LIBS, minGlibc: '2.34',
  },
];

/** `tmux_3.5a-2~bpo12+1_amd64.deb` → `tmux_3.5a-2_bpo12_1_amd64` (a plain dir name). */
export function releaseIdFor(candidate: TmuxPrebuiltCandidate): string {
  return candidate.fileName.replace(/\.deb$/, '').replace(/[^A-Za-z0-9._-]/g, '_');
}

export function prebuiltArch(nodeArch: string = process.arch): PrebuiltArch | undefined {
  return nodeArch === 'x64' || nodeArch === 'arm64' ? nodeArch : undefined;
}

/** Candidates for `arch` that meet the recommendation, in preference order. */
export function prebuiltCandidatesFor(
  arch: PrebuiltArch,
  recommendation: TmuxRecommendation = TMUX_RECOMMENDED_MIN,
  table: readonly TmuxPrebuiltCandidate[] = TMUX_PREBUILT_CANDIDATES,
): TmuxPrebuiltCandidate[] {
  return table.filter(c => c.arch === arch && !isTmuxBelowRecommended(c.release, recommendation));
}

// ─── Small pure helpers ─────────────────────────────────────────────────────

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareDotted(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** `glibc 2.36` (getconf GNU_LIBC_VERSION) → `2.36`. */
export function parseGlibcVersion(text: string): string | undefined {
  return /glibc\s+(\d+\.\d+(?:\.\d+)?)/i.exec(text)?.[1];
}

export function glibcAtLeast(version: string, floor: string): boolean {
  return compareDotted(version, floor) >= 0;
}

/** Library names `ldconfig -p` knows for this architecture. */
export function parseLdconfigLibraries(text: string, arch: PrebuiltArch): Set<string> {
  const tag = arch === 'x64' ? /x86-64/ : /AArch64/i;
  const out = new Set<string>();
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*(\S+)\s+\(([^)]*)\)\s+=>/.exec(line);
    if (m && tag.test(m[2]!)) out.add(m[1]!);
  }
  return out;
}

/** Libraries the dynamic loader could not find, from its error text. */
export function missingLibrariesFromLoaderError(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text ?? '').matchAll(/error while loading shared libraries: ([^:\s]+): cannot open shared object file/g)) {
    out.add(m[1]!);
  }
  return [...out];
}

/** Split a .deb (ar archive) and return its `data.tar.*` member. */
export function debDataMember(deb: Buffer): { name: string; data: Buffer } {
  if (deb.subarray(0, 8).toString('latin1') !== '!<arch>\n') throw new Error('not a Debian package (bad ar magic)');
  let off = 8;
  while (off + 60 <= deb.length) {
    const header = deb.subarray(off, off + 60).toString('latin1');
    const name = header.slice(0, 16).trim().replace(/\/$/, '');
    const size = Number(header.slice(48, 58).trim());
    if (!Number.isSafeInteger(size) || size < 0 || off + 60 + size > deb.length) throw new Error('truncated Debian package');
    if (/^data\.tar(\.(xz|gz|zst))?$/.test(name)) return { name, data: deb.subarray(off + 60, off + 60 + size) };
    off += 60 + size + (size & 1);
  }
  throw new Error('Debian package has no data.tar member');
}

// ─── Ownership ──────────────────────────────────────────────────────────────

export interface ManagedTmuxManifest {
  schema: 1;
  release: string;
  debVersion: string;
  arch: PrebuiltArch;
  fileName: string;
  debSha256: string;
  binSha256: string;
  /** URL the verified bytes came from. */
  source: string;
  installedAt: string;
}

export type ManagedTmuxState =
  | { state: 'absent' }
  | { state: 'valid'; releaseDir: string; binPath: string; manifest: ManagedTmuxManifest }
  | { state: 'foreign'; reason: string };

const STAGING_PREFIX = '.staging-';
const LINK_TMP_PREFIX = 'current.tmp-';
/** The only release directory names botmux creates (see releaseIdFor). */
const RELEASE_NAME_RE = /^tmux_[A-Za-z0-9._-]+_(?:amd64|arm64)$/;

/** A real directory (not a symlink to one). */
function isRealDir(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function isHex64(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

export function parseManifest(raw: string): ManagedTmuxManifest | undefined {
  try {
    const m = JSON.parse(raw);
    if (!m || m.schema !== 1) return undefined;
    if (typeof m.release !== 'string' || !tmuxReleaseLabel(m.release)) return undefined;
    if (typeof m.debVersion !== 'string' || typeof m.fileName !== 'string' || typeof m.source !== 'string') return undefined;
    if (m.arch !== 'x64' && m.arch !== 'arm64') return undefined;
    if (!isHex64(m.debSha256) || !isHex64(m.binSha256)) return undefined;
    if (typeof m.installedAt !== 'string') return undefined;
    return m as ManagedTmuxManifest;
  } catch {
    return undefined;
  }
}

/**
 * Is there a botmux-installed tmux under `root`, and is it provably ours and
 * unmodified? "Ours" means: botmux's exact layout (real directories, no
 * symlinked `releases/`, only names botmux creates), `current` pointing into
 * `releases/`, and an executable whose hash is one of the pinned builds AND
 * matches its manifest. Anything else is foreign and is never written to.
 */
export function inspectManagedTmux(
  root: string = managedTmuxRoot(),
  table: readonly TmuxPrebuiltCandidate[] = TMUX_PREBUILT_CANDIDATES,
): ManagedTmuxState {
  let rootStat;
  try { rootStat = lstatSync(root); } catch { return { state: 'absent' }; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { state: 'foreign', reason: 'not a plain directory' };
  let entries: string[];
  try { entries = readdirSync(root); } catch (err) { return { state: 'foreign', reason: `unreadable: ${(err as Error).message}` }; }
  const unexpected = entries.filter(e => e !== 'current' && e !== 'releases' && !e.startsWith(LINK_TMP_PREFIX));
  if (unexpected.length) return { state: 'foreign', reason: `unexpected entries: ${unexpected.join(', ')}` };
  const releases = join(root, 'releases');
  if (entries.includes('releases')) {
    if (!isRealDir(releases)) return { state: 'foreign', reason: 'releases is not a plain directory' };
    let inside: string[];
    try { inside = readdirSync(releases); } catch (err) { return { state: 'foreign', reason: `unreadable: ${(err as Error).message}` }; }
    const strangers = inside.filter(e => !RELEASE_NAME_RE.test(e) && !e.startsWith(STAGING_PREFIX));
    if (strangers.length) return { state: 'foreign', reason: `unexpected entries in releases/: ${strangers.join(', ')}` };
  }
  const link = join(root, 'current');
  let linkStat;
  try { linkStat = lstatSync(link); } catch { return { state: 'absent' }; }
  if (!linkStat.isSymbolicLink()) return { state: 'foreign', reason: 'current is not a symlink' };
  const target = readlinkSync(link);
  const name = target.split('/')[1] ?? '';
  if (!/^releases\/[A-Za-z0-9._-]+$/.test(target) || !RELEASE_NAME_RE.test(name)) {
    return { state: 'foreign', reason: `current points outside botmux's releases: ${target}` };
  }
  const releaseDir = join(root, target);
  if (!isRealDir(releaseDir) || !isRealDir(join(releaseDir, 'bin'))) return { state: 'foreign', reason: 'release is not a plain directory' };
  let manifest: ManagedTmuxManifest | undefined;
  try {
    const manifestPath = join(releaseDir, 'manifest.json');
    if (!lstatSync(manifestPath).isFile()) throw new Error('not a file');
    manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
  } catch { manifest = undefined; }
  if (!manifest) return { state: 'foreign', reason: 'missing or invalid manifest' };
  const known = table.find(c => c.fileName === manifest!.fileName && c.sha256 === manifest!.debSha256
    && c.binSha256 === manifest!.binSha256);
  if (!known) return { state: 'foreign', reason: 'manifest does not name a build botmux ships' };
  const binPath = join(releaseDir, 'bin', 'tmux');
  let binSha: string;
  try {
    if (!lstatSync(binPath).isFile()) throw new Error('not a regular file');
    binSha = sha256Hex(readFileSync(binPath));
  } catch { return { state: 'foreign', reason: 'executable missing or not a regular file' }; }
  if (binSha !== known.binSha256) return { state: 'foreign', reason: 'executable does not match the pinned build' };
  return { state: 'valid', releaseDir, binPath, manifest };
}

// ─── Install ────────────────────────────────────────────────────────────────

export interface PrebuiltInstallIo {
  /** Fetch a URL, refusing bodies larger than `maxBytes`. */
  download(url: string, maxBytes: number): Promise<Buffer>;
  /** Extract `usr/bin/tmux` from a verified .deb into `workDir`; returns its path. */
  extractTmux(deb: Buffer, workDir: string): Promise<string>;
  /** `<bin> -V` → combined output; ok=false when it did not run. */
  runVersion(bin: string): Promise<{ ok: boolean; output: string }>;
  /** Start and stop a throwaway server with `<bin>` on a private socket. */
  functionalProbe(bin: string): Promise<{ ok: boolean; output: string }>;
  now(): Date;
}

export type PrebuiltInstallFailure =
  | 'foreign' | 'unsupported' | 'download_failed' | 'checksum_mismatch' | 'libs_missing' | 'verify_failed' | 'io';

export type PrebuiltInstallResult =
  | { ok: true; release: string; binPath: string; source: string; alreadyInstalled?: boolean }
  | { ok: false; failure: PrebuiltInstallFailure; error: string; missingLibraries?: string[] };

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function rmQuiet(path: string): void {
  try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Install (or replace) botmux's own tmux under `root` from the first candidate
 * that verifies on this host. `onLine` receives human-readable progress.
 */
export async function installManagedTmux(opts: {
  root?: string;
  candidates: readonly TmuxPrebuiltCandidate[];
  io: PrebuiltInstallIo;
  onLine: (line: string) => void;
  /** Ownership table (tests); production uses TMUX_PREBUILT_CANDIDATES. */
  table?: readonly TmuxPrebuiltCandidate[];
}): Promise<PrebuiltInstallResult> {
  const root = opts.root ?? managedTmuxRoot();
  if (!opts.candidates.length) return { ok: false, failure: 'unsupported', error: 'no prebuilt tmux for this platform' };
  try {
    mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  } catch (err) {
    return { ok: false, failure: 'io', error: (err as Error).message };
  }
  // One installer at a time per directory (two fleets can share a HOME).
  return withFileLock(root, () => installManagedTmuxLocked(root, opts), { maxWaitMs: 30_000 })
    .catch(err => ({ ok: false as const, failure: 'io' as const, error: (err as Error).message }));
}

async function installManagedTmuxLocked(root: string, opts: {
  candidates: readonly TmuxPrebuiltCandidate[];
  io: PrebuiltInstallIo;
  onLine: (line: string) => void;
  table?: readonly TmuxPrebuiltCandidate[];
}): Promise<PrebuiltInstallResult> {
  const { io, onLine } = opts;
  const table = opts.table ?? TMUX_PREBUILT_CANDIDATES;
  const before = inspectManagedTmux(root, table);
  if (before.state === 'foreign') {
    return { ok: false, failure: 'foreign', error: `${root}: ${before.reason}` };
  }
  const releases = join(root, 'releases');
  try {
    mkdirSync(releases, { recursive: true, mode: 0o700 });
    // Never delete through a symlinked root/releases (inspect also refuses it;
    // re-checked here because it is the last line before rmSync).
    if (!isRealDir(root) || !isRealDir(releases)) {
      return { ok: false, failure: 'foreign', error: `${root}: not plain directories` };
    }
    // Leftovers of an interrupted run (botmux owns these names exclusively).
    for (const e of readdirSync(releases)) if (e.startsWith(STAGING_PREFIX)) rmQuiet(join(releases, e));
    for (const e of readdirSync(root)) if (e.startsWith(LINK_TMP_PREFIX)) rmQuiet(join(root, e));
  } catch (err) {
    return { ok: false, failure: 'io', error: (err as Error).message };
  }

  let firstFailure: Extract<PrebuiltInstallResult, { ok: false }> | undefined;
  const missing = new Set<string>();
  const note = (f: Extract<PrebuiltInstallResult, { ok: false }>) => {
    if (f.failure === 'libs_missing') for (const l of f.missingLibraries ?? []) missing.add(l);
    if (!firstFailure || (firstFailure.failure !== 'libs_missing' && f.failure === 'libs_missing')) firstFailure = f;
  };

  for (const candidate of opts.candidates) {
    const id = releaseIdFor(candidate);
    if (before.state === 'valid' && before.manifest.fileName === candidate.fileName) {
      // Same build already installed — but only "done" if it still runs here
      // (a library may have been removed since); otherwise reinstall/fall back.
      const still = await io.runVersion(before.binPath);
      if (still.ok && tmuxReleaseLabel(still.output) === candidate.release) {
        onLine(`already installed: tmux ${candidate.release} (${before.binPath})`);
        return { ok: true, release: candidate.release, binPath: before.binPath, source: before.manifest.source, alreadyInstalled: true };
      }
      onLine(`installed tmux ${candidate.release} no longer runs here: ${still.output.trim().slice(0, 160)}`);
    }

    // 1. Download from the fixed URLs; only exact size + SHA256 is accepted.
    let deb: Buffer | undefined;
    let source = '';
    for (const url of candidate.urls) {
      onLine(`download ${url}`);
      let bytes: Buffer;
      try {
        bytes = await io.download(url, candidate.size + 1);
      } catch (err) {
        onLine(`  download failed: ${(err as Error).message}`);
        note({ ok: false, failure: 'download_failed', error: `${candidate.fileName}: ${(err as Error).message}` });
        continue;
      }
      const sha = sha256Hex(bytes);
      if (bytes.length !== candidate.size || sha !== candidate.sha256) {
        onLine(`  rejected: ${bytes.length} bytes, sha256 ${sha.slice(0, 16)}… (expected ${candidate.size} bytes, ${candidate.sha256.slice(0, 16)}…)`);
        note({ ok: false, failure: 'checksum_mismatch', error: `${candidate.fileName}: size/SHA256 mismatch from ${new URL(url).host}` });
        continue;
      }
      onLine(`  sha256 ok (${candidate.sha256.slice(0, 16)}…)`);
      deb = bytes;
      source = url;
      break;
    }
    if (!deb) continue;

    // 2. Stage: extract, place, verify — nothing is visible to botmux yet.
    const staging = join(releases, `${STAGING_PREFIX}${id}-${randomBytes(4).toString('hex')}`);
    try {
      mkdirSync(join(staging, 'bin'), { recursive: true, mode: 0o700 });
      const extracted = await io.extractTmux(deb, join(staging, 'work'));
      if (!lstatSync(extracted).isFile()) throw new Error('usr/bin/tmux in the package is not a regular file');
      const bin = join(staging, 'bin', 'tmux');
      copyFileSync(extracted, bin);
      chmodSync(bin, 0o755);
      rmQuiet(join(staging, 'work'));
      const binSha = sha256Hex(readFileSync(bin));
      if (binSha !== candidate.binSha256) {
        onLine(`  rejected: usr/bin/tmux sha256 ${binSha.slice(0, 16)}… (expected ${candidate.binSha256.slice(0, 16)}…)`);
        note({ ok: false, failure: 'checksum_mismatch', error: `${candidate.fileName}: unexpected usr/bin/tmux` });
        rmQuiet(staging);
        continue;
      }

      const version = await io.runVersion(bin);
      const libs = missingLibrariesFromLoaderError(version.output);
      if (libs.length) {
        onLine(`  tmux ${candidate.release} needs ${libs.join(', ')} — not on this host`);
        note({ ok: false, failure: 'libs_missing', error: `missing ${libs.join(', ')}`, missingLibraries: libs });
        rmQuiet(staging);
        continue;
      }
      if (!version.ok || tmuxReleaseLabel(version.output) !== candidate.release) {
        onLine(`  tmux -V: ${version.output.trim().slice(0, 200)}`);
        note({ ok: false, failure: 'verify_failed', error: `${candidate.fileName}: tmux -V answered ${JSON.stringify(version.output.trim().slice(0, 120))}` });
        rmQuiet(staging);
        continue;
      }
      onLine(`  tmux -V: ${version.output.trim()}`);
      const probe = await io.functionalProbe(bin);
      if (!probe.ok) {
        onLine(`  server probe failed: ${probe.output.trim().slice(0, 200)}`);
        note({ ok: false, failure: 'verify_failed', error: `${candidate.fileName}: a test server did not start (${probe.output.trim().slice(0, 120)})` });
        rmQuiet(staging);
        continue;
      }
      onLine('  test server started and stopped');

      const manifest: ManagedTmuxManifest = {
        schema: 1,
        release: candidate.release,
        debVersion: candidate.debVersion,
        arch: candidate.arch,
        fileName: candidate.fileName,
        debSha256: candidate.sha256,
        binSha256: binSha,
        source,
        installedAt: io.now().toISOString(),
      };
      writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

      // 3. Promote: release dir rename, then ONE atomic symlink swap.
      const finalDir = join(releases, id);
      if (existsSync(finalDir) || isSymlink(finalDir)) {
        // Not current (that case returned above) and inside botmux's own
        // releases/ — a leftover of an earlier install; replace it.
        rmQuiet(finalDir);
      }
      renameSync(staging, finalDir);
      const tmpLink = join(root, `${LINK_TMP_PREFIX}${randomBytes(4).toString('hex')}`);
      symlinkSync(relative(root, finalDir), tmpLink);
      renameSync(tmpLink, join(root, 'current'));

      // 4. Old releases: a running server keeps its mapped binary; the files
      //    are only botmux's own (names it created under releases/).
      for (const e of readdirSync(releases)) {
        if (e !== id && RELEASE_NAME_RE.test(e)) rmQuiet(join(releases, e));
      }
      onLine(`installed tmux ${candidate.release} → ${join(root, 'current', 'bin', 'tmux')}`);
      return { ok: true, release: candidate.release, binPath: join(finalDir, 'bin', 'tmux'), source };
    } catch (err) {
      rmQuiet(staging);
      onLine(`  install failed: ${(err as Error).message}`);
      note({ ok: false, failure: 'io', error: (err as Error).message });
    }
  }
  if (firstFailure?.failure === 'libs_missing') {
    return { ...firstFailure, missingLibraries: [...missing], error: `missing ${[...missing].join(', ')}` };
  }
  return firstFailure ?? { ok: false, failure: 'unsupported', error: 'no candidate could be installed' };
}

// ─── Host support ───────────────────────────────────────────────────────────

export type PrebuiltSupport =
  | { ok: true; arch: PrebuiltArch; glibc: string; candidates: TmuxPrebuiltCandidate[] }
  | { ok: false; reason: 'platform' | 'arch' | 'glibc' | 'extractor' | 'libraries' | 'outdated'; detail?: string; missingLibraries?: string[] };

export interface PrebuiltSupportIo {
  platform: NodeJS.Platform;
  arch: string;
  /** `getconf GNU_LIBC_VERSION` output, null when it could not run (musl, …). */
  glibcVersion(): Promise<string | null>;
  /** Is this tool on botmux's PATH? */
  has(tool: string): boolean;
  /** `ldconfig -p` output, null when unavailable. */
  ldconfig(): Promise<string | null>;
}

/**
 * Can botmux install its own tmux here, and which candidates fit? Read-only
 * and network-free; the actual install still verifies everything on disk.
 */
export async function probePrebuiltSupport(
  io: PrebuiltSupportIo,
  recommendation: TmuxRecommendation = TMUX_RECOMMENDED_MIN,
  table: readonly TmuxPrebuiltCandidate[] = TMUX_PREBUILT_CANDIDATES,
): Promise<PrebuiltSupport> {
  if (io.platform !== 'linux') return { ok: false, reason: 'platform' };
  const arch = prebuiltArch(io.arch);
  if (!arch) return { ok: false, reason: 'arch', detail: io.arch };
  const forArch = table.filter(c => c.arch === arch);
  const usable = prebuiltCandidatesFor(arch, recommendation, table);
  if (!usable.length) return { ok: false, reason: forArch.length ? 'outdated' : 'arch', detail: io.arch };
  const glibcText = await io.glibcVersion();
  const glibc = glibcText ? parseGlibcVersion(glibcText) : undefined;
  if (!glibc) return { ok: false, reason: 'glibc', detail: 'not a glibc system' };
  const fitsGlibc = usable.filter(c => glibcAtLeast(glibc, c.minGlibc));
  if (!fitsGlibc.length) return { ok: false, reason: 'glibc', detail: glibc };
  if (!io.has('dpkg-deb') && !(io.has('tar') && io.has('xz'))) return { ok: false, reason: 'extractor' };
  const ld = await io.ldconfig();
  if (ld === null) return { ok: true, arch, glibc, candidates: fitsGlibc };
  const present = parseLdconfigLibraries(ld, arch);
  const fitsLibs = fitsGlibc.filter(c => c.hostLibraries.every(l => present.has(l)));
  if (fitsLibs.length) return { ok: true, arch, glibc, candidates: fitsLibs };
  // Report what the closest candidate lacks.
  const closest = [...fitsGlibc].sort((a, b) =>
    a.hostLibraries.filter(l => !present.has(l)).length - b.hostLibraries.filter(l => !present.has(l)).length)[0]!;
  return { ok: false, reason: 'libraries', missingLibraries: closest.hostLibraries.filter(l => !present.has(l)) };
}

// ─── Production I/O ─────────────────────────────────────────────────────────

const TOOL_TIMEOUT_MS = 60_000;

/** Minimal environment for the fixed helper tools (and the throwaway probe
 *  server): botmux's tmux PATH, the user's TMUX_TMPDIR, nothing else. */
function toolEnv(): NodeJS.ProcessEnv {
  const env = tmuxEnv();
  return {
    PATH: env.PATH, LANG: 'C', LC_ALL: 'C', HOME: env.HOME, TMPDIR: env.TMPDIR,
    ...(env.TMUX_TMPDIR ? { TMUX_TMPDIR: env.TMUX_TMPDIR } : {}),
  };
}

function whichOnPath(name: string, pathValue: string | undefined): string | null {
  for (const dir of String(pathValue ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try { accessSync(candidate, fsConstants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

function run(bin: string, args: string[], timeoutMs = TOOL_TIMEOUT_MS): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    try {
      execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, env: toolEnv(), maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
        resolve({ ok: !error, output: `${stdout ?? ''}${stderr ?? ''}` });
      });
    } catch (err) {
      resolve({ ok: false, output: (err as Error).message });
    }
  });
}

export function defaultPrebuiltSupportIo(): PrebuiltSupportIo {
  const pathValue = toolEnv().PATH;
  return {
    platform: process.platform,
    arch: process.arch,
    async glibcVersion() {
      const r = await run('getconf', ['GNU_LIBC_VERSION'], 10_000);
      return r.ok ? r.output : null;
    },
    has: tool => whichOnPath(tool, pathValue) !== null,
    async ldconfig() {
      const bin = whichOnPath('ldconfig', pathValue);
      if (!bin) return null;
      const r = await run(bin, ['-p'], 10_000);
      return r.ok ? r.output : null;
    },
  };
}

async function downloadWithCap(url: string, maxBytes: number): Promise<Buffer> {
  const signal = AbortSignal.timeout(120_000);
  const res = await getReleaseStream(url, resolveHttpProxy(), 'botmux-tmux-prebuilt', 5, { signal, respectNoProxy: true });
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res) {
    const b = Buffer.from(chunk);
    total += b.length;
    if (total > maxBytes) {
      res.destroy();
      throw new Error(`response larger than ${maxBytes} bytes`);
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/** dpkg-deb when present (it decompresses on its own); otherwise split the ar
 *  archive here and let tar + xz unpack exactly one member. */
export async function extractTmuxFromDeb(
  deb: Buffer,
  workDir: string,
  tools: { dpkgDeb?: string | null; tar?: string | null } = {},
): Promise<string> {
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const out = join(workDir, 'root');
  mkdirSync(out, { recursive: true });
  const pathValue = toolEnv().PATH;
  const dpkgDeb = tools.dpkgDeb === undefined ? whichOnPath('dpkg-deb', pathValue) : tools.dpkgDeb;
  if (dpkgDeb) {
    const pkg = join(workDir, 'pkg.deb');
    writeFileSync(pkg, deb, { mode: 0o600 });
    const r = await run(dpkgDeb, ['-x', pkg, out]);
    if (!r.ok) throw new Error(`dpkg-deb -x failed: ${r.output.trim().slice(0, 200)}`);
  } else {
    const tar = tools.tar === undefined ? whichOnPath('tar', pathValue) : tools.tar;
    if (!tar) throw new Error('neither dpkg-deb nor tar is available');
    const member = debDataMember(deb);
    const flag = member.name.endsWith('.xz') ? '-J' : member.name.endsWith('.gz') ? '-z' : member.name.endsWith('.zst') ? '--zstd' : '';
    const archive = join(workDir, member.name);
    writeFileSync(archive, member.data, { mode: 0o600 });
    const r = await run(tar, ['-x', ...(flag ? [flag] : []), '-f', archive, '-C', out, './usr/bin/tmux']);
    if (!r.ok) throw new Error(`tar failed: ${r.output.trim().slice(0, 200)}`);
  }
  const bin = join(out, 'usr', 'bin', 'tmux');
  // lstat: a symlink in the package must not pull a host file in.
  if (!lstatSync(bin).isFile()) throw new Error('usr/bin/tmux in the package is not a regular file');
  return bin;
}

async function functionalProbeFor(bin: string): Promise<{ ok: boolean; output: string }> {
  // Same throwaway-server check ensureTmux uses, on a unique socket name so no
  // existing server (the user's or botmux's) is ever involved.
  const sock = `bmx-prebuilt-probe-${process.pid}-${Date.now()}`;
  const started = await run(bin, ['-f', '/dev/null', '-L', sock, 'new-session', '-d', '-s', 'probe', 'true'], 15_000);
  await run(bin, ['-L', sock, 'kill-server'], 5_000);
  return started;
}

export function defaultPrebuiltInstallIo(): PrebuiltInstallIo {
  return {
    download: downloadWithCap,
    extractTmux: extractTmuxFromDeb,
    runVersion: bin => run(bin, ['-V'], 15_000),
    functionalProbe: functionalProbeFor,
    now: () => new Date(),
  };
}

/** The daemon's entry point: re-check this host, then install from the
 *  candidates that fit it (preference order). */
export async function installManagedTmuxForHost(
  onLine: (line: string) => void,
  opts: { root?: string; supportIo?: PrebuiltSupportIo; io?: PrebuiltInstallIo; recommendation?: TmuxRecommendation } = {},
): Promise<PrebuiltInstallResult> {
  const support = await probePrebuiltSupport(opts.supportIo ?? defaultPrebuiltSupportIo(), opts.recommendation);
  if (!support.ok) {
    return support.reason === 'libraries'
      ? { ok: false, failure: 'libs_missing', error: `missing ${support.missingLibraries?.join(', ')}`, missingLibraries: support.missingLibraries ?? [] }
      : { ok: false, failure: 'unsupported', error: `${support.reason}${support.detail ? ` (${support.detail})` : ''}` };
  }
  return installManagedTmux({
    ...(opts.root ? { root: opts.root } : {}),
    candidates: support.candidates,
    io: opts.io ?? defaultPrebuiltInstallIo(),
    onLine,
  });
}
