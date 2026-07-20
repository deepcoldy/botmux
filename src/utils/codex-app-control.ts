import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, win32 } from 'node:path';
import type { BackendType } from '../adapters/backend/types.js';

/**
 * The launch boundary carries only a path to an owner-only, read-once file.
 * That file contains a fresh Ed25519 private key. The runner consumes and
 * unlinks it before app-server (and therefore model tools) can start. Only the
 * public key is persisted by the worker.
 */
export const CODEX_APP_CONTROL_BOOTSTRAP_ENV = 'BOTMUX_CODEX_APP_CONTROL_BOOTSTRAP';

export const CODEX_APP_CONTROL_LINE_MAX_BYTES = 4_096;
export const CODEX_APP_CONTROL_FINAL_MAX_BYTES = 1_048_576;
export const CODEX_APP_CONTROL_FINAL_CHUNK_BYTES = 1_536;
/** Keep control bootstrap/proof alive for the worker's existing cold-start cap. */
export const CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS = 90_000;
/** Absolute per-connection challenge/accept deadline; transport activity does not extend it. */
export const CODEX_APP_CONTROL_HANDSHAKE_TIMEOUT_MS = 5_000;

const CONTROL_STATE_VERSION = 3 as const;
const CONTROL_WIRE_VERSION = 2 as const;
const CONTROL_BOOTSTRAP_VERSION = 3 as const;
const CONTROL_LOCATOR_VERSION = 1 as const;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const BOOTSTRAP_MAX_BYTES = 8_192;
const LOCATOR_MAX_BYTES = 4_096;
const WINDOWS_SYSTEM_SID = 'S-1-5-18';
const WINDOWS_PIPE_PREFIX = '\\\\?\\pipe\\botmux-codex-app-';
const WINDOWS_OWNER_PIPE_PREFIX = '\\\\?\\pipe\\botmux-codex-app-owner-';
const POSIX_SOCKET_LEAF_RE = /^endpoint-[a-f0-9]{32}\.sock$/;
const POSIX_OWNER_RECORD_RE = /^owner-[a-f0-9]{64}\.json$/;
const POSIX_OWNER_PENDING_RE = /^owner-[a-f0-9]{64}\.pending$/;
const POSIX_REAPER_RECORD_RE = /^reap-[a-f0-9]{64}\.json$/;
const POSIX_REAPER_PENDING_RE = /^reap-[a-f0-9]{64}\.pending$/;
const POSIX_LEASE_RECORD_MAX_BYTES = 4_096;
const windowsHardenedDirectories = new Set<string>();

/**
 * Arm the shared Codex App startup deadline. Keeping the scheduling in one
 * helper prevents the runner auth gate, bootstrap cleanup, worker proof gate,
 * and first-prompt hard cap from silently drifting to different lifetimes.
 */
export function armCodexAppControlStartupTimeout(
  onTimeout: () => void,
  timeoutMs = CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS,
): ReturnType<typeof setTimeout> {
  return setTimeout(onTimeout, timeoutMs);
}

export function armCodexAppControlHandshakeTimeout(
  onTimeout: () => void,
  timeoutMs = CODEX_APP_CONTROL_HANDSHAKE_TIMEOUT_MS,
): ReturnType<typeof setTimeout> {
  return setTimeout(onTimeout, timeoutMs);
}

export type CodexAppSignedStateReadiness = 'invalid' | 'waiting' | 'ready';

/** Authentication and a signed busy/idle bit are not sufficient readiness.
 * The runner must explicitly assert that its initialized stdin/app-server path
 * accepts input. Missing/non-boolean values are protocol violations; `false`
 * is a valid not-ready state that leaves the absolute proof deadline armed. */
export function codexAppSignedStateReadiness(payload: unknown): CodexAppSignedStateReadiness {
  if (!payload || typeof payload !== 'object') return 'invalid';
  const acceptingInput = (payload as Record<string, unknown>).acceptingInput;
  if (typeof acceptingInput !== 'boolean') return 'invalid';
  return acceptingInput ? 'ready' : 'waiting';
}

/** Re-armable proof deadline shared by startup and authenticated disconnects. */
export class CodexAppControlProofDeadline {
  private timer: ReturnType<typeof setTimeout> | undefined;

  arm(onTimeout: () => void, timeoutMs = CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS): void {
    this.clear();
    this.timer = armCodexAppControlStartupTimeout(() => {
      this.timer = undefined;
      onTimeout();
    }, timeoutMs);
    this.timer.unref?.();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  get armed(): boolean {
    return this.timer !== undefined;
  }
}
const STATE_MAX_BYTES = 16_384;
const GENERATION_RE = /^[A-Za-z0-9_-]{43}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const KEY_RE = /^[A-Za-z0-9_-]{32,512}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;
const MAX_STATE_IDENTITIES = 4;

export interface CodexAppControlPathOptions {
  platform?: NodeJS.Platform;
  localAppData?: string;
  homeDirectory?: string;
}

export interface CodexAppControlFilesystemPolicy {
  useNoFollow: boolean;
  verifyUid: boolean;
  verifyExactMode: boolean;
  chmodAfterCreate: boolean;
  verifyPostUnlinkLinkCount: boolean;
  fsyncDirectory: boolean;
}

export function codexAppControlFilesystemPolicy(
  platform: NodeJS.Platform = process.platform,
): CodexAppControlFilesystemPolicy {
  if (platform === 'win32') {
    return {
      useNoFollow: false,
      verifyUid: false,
      verifyExactMode: false,
      chmodAfterCreate: false,
      verifyPostUnlinkLinkCount: false,
      fsyncDirectory: false,
    };
  }
  return {
    useNoFollow: true,
    verifyUid: true,
    verifyExactMode: true,
    chmodAfterCreate: true,
    verifyPostUnlinkLinkCount: true,
    fsyncDirectory: true,
  };
}

function ownerUid(): number | undefined {
  return process.geteuid?.() ?? process.getuid?.();
}

function noFollowFlag(platform: NodeJS.Platform): number {
  if (!codexAppControlFilesystemPolicy(platform).useNoFollow) return 0;
  const flag = (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW;
  if (typeof flag !== 'number') throw new Error('O_NOFOLLOW is required for Codex App control files');
  return flag;
}

function exactMode(mode: number): number {
  return mode & 0o777;
}

function assertOwned(stat: { uid: number }, label: string, platform: NodeJS.Platform): void {
  if (!codexAppControlFilesystemPolicy(platform).verifyUid) return;
  const uid = ownerUid();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${label} must be owned by the current uid`);
}

function isAbsoluteForPlatform(path: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? win32.isAbsolute(path) : isAbsolute(path);
}

function joinForPlatform(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === 'win32' ? win32.join(...parts) : join(...parts);
}

function dirnameForPlatform(platform: NodeJS.Platform, path: string): string {
  return platform === 'win32' ? win32.dirname(path) : dirname(path);
}

/**
 * Windows never places control material under SESSION_DATA_DIR: that setting
 * is bot/user supplied and may point at a shared tree.  The fixed root is
 * instead anchored in the current Windows profile and hardened before any
 * secret or locator is created beneath it.
 */
export function codexAppWindowsControlRoot(
  options: CodexAppControlPathOptions = {},
): string {
  const base = options.localAppData?.trim()
    || (options.platform === 'win32' || options.platform === undefined
      ? process.env.LOCALAPPDATA?.trim()
      : undefined)
    || options.homeDirectory?.trim()
    || homedir();
  // The locator protocol relies on local NTFS-style ACL and atomic-replace
  // semantics.  A UNC/redirected profile can have server-defined ACL and
  // rename behavior, so do not silently place capabilities on it.  The drive
  // root itself remains configurable through LOCALAPPDATA/home for normal
  // per-user profiles.
  if (!base || !/^[A-Za-z]:[\\/]/.test(base) || !win32.isAbsolute(base)) {
    throw new Error(
      'Windows Codex App control root requires a local drive-qualified LOCALAPPDATA or home directory',
    );
  }
  return win32.join(base, 'Botmux', 'codex-app-control');
}

function parseStrictCsvRow(row: string): string[] | undefined {
  const fields: string[] = [];
  let cursor = 0;
  while (cursor < row.length) {
    if (row[cursor] !== '"') return undefined;
    cursor++;
    let field = '';
    let closed = false;
    while (cursor < row.length) {
      const ch = row[cursor++]!;
      if (ch !== '"') {
        field += ch;
        continue;
      }
      if (row[cursor] === '"') {
        field += '"';
        cursor++;
        continue;
      }
      closed = true;
      break;
    }
    if (!closed) return undefined;
    fields.push(field);
    if (cursor === row.length) break;
    if (row[cursor] !== ',') return undefined;
    cursor++;
    if (cursor === row.length) return undefined;
  }
  return fields;
}

export function parseWindowsCurrentSid(output: string): string | undefined {
  const rows = output.replace(/^\uFEFF/, '').split(/\r?\n/).filter(row => row.length > 0);
  if (rows.length !== 1) return undefined;
  const fields = parseStrictCsvRow(rows[0]!);
  if (fields?.length !== 2) return undefined;
  const sid = fields[1]!;
  return /^S-\d-(?:\d+-)+\d+$/i.test(sid) ? sid.toUpperCase() : undefined;
}

interface WindowsAclAce {
  type: string;
  flags: string;
  rights: string;
  objectGuid: string;
  inheritObjectGuid: string;
  trustee: string;
}

export function decodeWindowsAclSnapshot(raw: Buffer): string {
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    return raw.subarray(2).toString('utf16le');
  }
  if (raw.length >= 4 && raw[1] === 0 && raw[3] === 0) return raw.toString('utf16le');
  return raw.toString('utf8');
}

function parseWindowsDaclSnapshot(snapshot: string): { flags: string; aces: WindowsAclAce[] } | undefined {
  // `/save` layout is not a documented API. Locate the SDDL token by grammar,
  // whether it follows the path on the same or next line. `D:\path` cannot
  // match because a DACL has only uppercase control flags before its first ACE.
  const daclMatch = snapshot.match(/D:[A-Z]*\([^\r\n]*/);
  if (!daclMatch) return undefined;
  let dacl = daclMatch[0].slice(2).trim();
  const saclStart = dacl.indexOf('S:');
  if (saclStart >= 0) dacl = dacl.slice(0, saclStart);
  const firstAce = dacl.indexOf('(');
  if (firstAce < 0) return undefined;
  const flags = dacl.slice(0, firstAce);
  const aceText = dacl.slice(firstAce);
  const aces: WindowsAclAce[] = [];
  let cursor = 0;
  while (cursor < aceText.length) {
    if (aceText[cursor] !== '(') return undefined;
    const end = aceText.indexOf(')', cursor + 1);
    if (end < 0) return undefined;
    const fields = aceText.slice(cursor + 1, end).split(';');
    if (fields.length !== 6) return undefined;
    aces.push({
      type: fields[0]!,
      flags: fields[1]!,
      rights: fields[2]!,
      objectGuid: fields[3]!,
      inheritObjectGuid: fields[4]!,
      trustee: fields[5]!,
    });
    cursor = end + 1;
  }
  return { flags, aces };
}

/** Locale-independent verification of the SDDL emitted by `icacls /save`. */
export function verifyWindowsCodexAppControlDacl(
  snapshot: string,
  currentSid: string,
  kind: 'directory' | 'file' = 'directory',
): boolean {
  const parsed = parseWindowsDaclSnapshot(snapshot);
  if (!parsed || !parsed.flags.includes('P')) return false;
  // P = protected DACL. AI/AR are canonical auto-inheritance metadata that
  // icacls may retain even after inherited ACEs are removed; reject anything
  // else and separately reject every inherited ACE below.
  if (parsed.flags.replace(/AI|AR|P/g, '')) return false;
  const expected = new Set(
    currentSid.toUpperCase() === WINDOWS_SYSTEM_SID
      ? [WINDOWS_SYSTEM_SID]
      : [currentSid.toUpperCase(), WINDOWS_SYSTEM_SID],
  );
  if (parsed.aces.length !== expected.size) return false;
  for (const ace of parsed.aces) {
    const trustee = ace.trustee.toUpperCase() === 'SY'
      ? WINDOWS_SYSTEM_SID
      : ace.trustee.toUpperCase();
    if (ace.type !== 'A' || ace.rights !== 'FA' || ace.objectGuid || ace.inheritObjectGuid
        || ace.flags.includes('ID') || !expected.delete(trustee)) return false;
    if (kind === 'directory') {
      if (!ace.flags.includes('OI') || !ace.flags.includes('CI')
          || ace.flags.replace(/OI|CI/g, '')) return false;
    } else if (ace.flags) return false;
  }
  return expected.size === 0;
}

export type WindowsControlCommandRunner = (
  command: string,
  args: string[],
) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>;

function defaultWindowsControlCommandRunner(
  command: string,
  args: string[],
): Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'> {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 10_000,
    maxBuffer: 1_048_576,
  });
}

function runWindowsControlCommand(
  runner: WindowsControlCommandRunner,
  command: string,
  args: string[],
  label: string,
): string {
  const result = runner(command, args);
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed closed (status=${String(result.status)})`);
  }
  return result.stdout ?? '';
}

/**
 * Remove inherited ACLs, grant only the current SID and SYSTEM full control,
 * then validate the resulting protected DACL via locale-independent SDDL.
 * Unknown explicit ACEs are never silently retained: verification fails.
 */
function hardenWindowsCodexAppControlAcl(
  path: string,
  kind: 'directory' | 'file',
  runner: WindowsControlCommandRunner = defaultWindowsControlCommandRunner,
): void {
  if (!path || !win32.isAbsolute(path)) {
    throw new Error(`Windows Codex App control ${kind} must be absolute`);
  }
  if (kind === 'directory') mkdirSync(path, { recursive: true });
  const stat = lstatSync(path);
  if ((kind === 'directory' ? !stat.isDirectory() : !stat.isFile())
      || stat.isSymbolicLink() || (kind === 'file' && stat.nlink !== 1)) {
    throw new Error(`Windows Codex App control ${kind} must be a real single-link ${kind}`);
  }
  const systemRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim();
  if (!systemRoot || !win32.isAbsolute(systemRoot)) {
    throw new Error('Windows SystemRoot is required for trusted ACL tools');
  }
  const whoamiCommand = win32.join(systemRoot, 'System32', 'whoami.exe');
  const icaclsCommand = win32.join(systemRoot, 'System32', 'icacls.exe');
  const whoami = runWindowsControlCommand(
    runner,
    whoamiCommand,
    ['/user', '/fo', 'csv', '/nh'],
    'Windows current SID lookup',
  );
  const sid = parseWindowsCurrentSid(whoami);
  if (!sid) throw new Error('Windows current SID lookup returned no SID');
  let lastVerificationError: Error | undefined;
  // Several workers can harden the shared per-user root concurrently. The
  // transaction is idempotent; bounded full retries avoid snapshotting another
  // worker's inheritance-removal→grant gap without ever accepting a loose ACL.
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshotPath = win32.join(
      kind === 'directory' ? path : win32.dirname(path),
      `.botmux-acl-${process.pid}-${randomBytes(16).toString('hex')}.txt`,
    );
    try {
      runWindowsControlCommand(
        runner,
        icaclsCommand,
        [path, '/setowner', `*${sid}`, '/q'],
        'Windows control owner assignment',
      );
      runWindowsControlCommand(
        runner,
        icaclsCommand,
        [path, '/inheritance:r', '/q'],
        'Windows control ACL inheritance removal',
      );
      runWindowsControlCommand(
        runner,
        icaclsCommand,
        [path, '/grant:r', `*${sid}:${kind === 'directory' ? '(OI)(CI)F' : 'F'}`,
          ...(sid === WINDOWS_SYSTEM_SID
            ? []
            : [`*${WINDOWS_SYSTEM_SID}:${kind === 'directory' ? '(OI)(CI)F' : 'F'}`]), '/q'],
        'Windows control ACL grant',
      );
      runWindowsControlCommand(
        runner,
        icaclsCommand,
        [path, '/verify', '/q'],
        'Windows control ACL canonical verification',
      );
      runWindowsControlCommand(
        runner,
        icaclsCommand,
        [path, '/save', snapshotPath, '/q'],
        'Windows control ACL snapshot',
      );
      const snapshot = decodeWindowsAclSnapshot(readFileSync(snapshotPath));
      if (verifyWindowsCodexAppControlDacl(snapshot, sid, kind)) return;
      lastVerificationError = new Error(
        `Windows Codex App control ${kind} ACL is not exactly current SID + SYSTEM`,
      );
    } catch (err) {
      lastVerificationError = err instanceof Error ? err : new Error(String(err));
    } finally {
      try { unlinkSync(snapshotPath); } catch { /* no snapshot on command failure */ }
    }
  }
  throw lastVerificationError ?? new Error(`Windows Codex App control ${kind} ACL verification failed`);
}

/**
 * Remove inherited ACLs, set the current SID as owner, grant only that SID and
 * SYSTEM full control, and verify the protected DACL. Unknown explicit ACEs
 * are retained by icacls but cause exact verification to fail closed.
 */
export function hardenWindowsCodexAppControlDirectory(
  directory: string,
  runner: WindowsControlCommandRunner = defaultWindowsControlCommandRunner,
): void {
  hardenWindowsCodexAppControlAcl(directory, 'directory', runner);
}

/** Validate/harden a pre-existing fixed-name state file before trusting it. */
export function hardenWindowsCodexAppControlFile(
  path: string,
  runner: WindowsControlCommandRunner = defaultWindowsControlCommandRunner,
): void {
  hardenWindowsCodexAppControlAcl(path, 'file', runner);
}

/** Create/validate a non-symlink owner-only directory. */
export function ensureCodexAppControlDirectory(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!directory || !isAbsoluteForPlatform(directory, platform)) {
    throw new Error('Codex App control directory must be absolute');
  }
  if (platform === 'win32') {
    const cacheKey = win32.normalize(directory).toLowerCase();
    if (windowsHardenedDirectories.has(cacheKey)) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        windowsHardenedDirectories.delete(cacheKey);
        throw new Error('Windows Codex App control directory changed after ACL hardening');
      }
      return;
    }
    hardenWindowsCodexAppControlDirectory(directory);
    // Re-running whoami/icacls for every atomic locator replacement would
    // block the worker event loop and amplify the named-pipe DoS boundary.
    // Once exact ACL verification succeeds, cross-user mutation is excluded;
    // same-SID compromise is outside this control plane's trust boundary.
    windowsHardenedDirectories.add(cacheKey);
    return;
  }
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Codex App control directory must be a real directory');
  }
  assertOwned(stat, 'Codex App control directory', platform);
  if (exactMode(stat.mode) !== PRIVATE_DIRECTORY_MODE) {
    chmodSync(directory, PRIVATE_DIRECTORY_MODE);
    const tightened = lstatSync(directory);
    assertOwned(tightened, 'Codex App control directory', platform);
    if (!tightened.isDirectory() || tightened.isSymbolicLink()
        || exactMode(tightened.mode) !== PRIVATE_DIRECTORY_MODE) {
      throw new Error('Codex App control directory could not be secured to 0700');
    }
  }
}

function sessionKey(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex');
}

export function codexAppControlStatePath(sessionDataDir: string, sessionId: string): string {
  if (process.platform === 'win32') {
    return win32.join(codexAppWindowsControlRoot(), 'state', `${sessionKey(sessionId)}.json`);
  }
  return join(sessionDataDir, 'codex-app-control', `${sessionKey(sessionId)}.json`);
}

export function codexAppControlStatePathForPlatform(
  sessionDataDir: string,
  sessionId: string,
  options: CodexAppControlPathOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    return win32.join(codexAppWindowsControlRoot(options), 'state', `${sessionKey(sessionId)}.json`);
  }
  return join(sessionDataDir, 'codex-app-control', `${sessionKey(sessionId)}.json`);
}

export function codexAppControlSocketPath(directory: string, sessionId: string): string {
  // Unix-domain paths are short on macOS. A fixed 32-hex leaf keeps the path
  // comfortably below the platform limit for normal BOT_HOME/tmp roots.
  return join(directory, `${sessionKey(sessionId).slice(0, 32)}.sock`);
}

export function codexAppPosixControlRoot(uid = process.getuid?.()): string {
  return join('/tmp', `botmux-codex-app-${uid ?? 'unknown'}`);
}

export function codexAppPosixOwnerLeaseDirectory(controlRoot: string, sessionId: string): string {
  return join(controlRoot, 'leases', `${sessionKey(sessionId).slice(0, 32)}.lease`);
}

export function generateCodexAppPosixSocketEndpoint(socketDirectory: string): string {
  return join(socketDirectory, `endpoint-${randomBytes(16).toString('hex')}.sock`);
}

export function codexAppControlLocatorPath(
  controlRoot: string,
  sessionId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return joinForPlatform(platform, controlRoot, 'locators', `${sessionKey(sessionId)}.json`);
}

export function generateCodexAppWindowsPipeEndpoint(): string {
  return `${WINDOWS_PIPE_PREFIX}${randomBytes(32).toString('hex')}`;
}

/**
 * A fixed coordination pipe is held for the lifetime of one Windows worker
 * process. It is not a control endpoint and is never put in a runner locator.
 * Its only purpose is to serialize locator publishers across the daemon's
 * kill-then-fork overlap window. The OS releases it if the old worker is
 * terminated, avoiding a crash-stale filesystem lock.
 */
export function codexAppWindowsOwnerPipeEndpoint(sessionId: string): string {
  return `${WINDOWS_OWNER_PIPE_PREFIX}${sessionKey(sessionId)}`;
}

export interface CodexAppControlOwnerLeaseOptions<T> {
  bind: () => Promise<T>;
  timeoutMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
}

/** Retry only a competing bind; every other owner-lease error fails closed. */
export async function acquireCodexAppControlOwnerLease<T>(
  options: CodexAppControlOwnerLeaseOptions<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryDelayMs = options.retryDelayMs ?? 50;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
  const deadline = now() + timeoutMs;
  let lastBusyError: unknown;
  while (true) {
    try {
      return await options.bind();
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw err;
      lastBusyError = err;
    }
    if (now() >= deadline) {
      throw lastBusyError instanceof Error
        ? lastBusyError
        : new Error('Windows Codex App control owner lease timed out');
    }
    await wait(Math.min(retryDelayMs, Math.max(0, deadline - now())));
  }
}

interface CodexAppPosixFileIdentity {
  dev: string;
  ino: string;
}

interface CodexAppPosixOwnerTarget {
  nonce: string;
  recordIdentity: CodexAppPosixFileIdentity;
  pid: number | null;
  processStartToken: string | null;
}

interface CodexAppPosixOwnerRecord {
  version: 2;
  role: 'owner' | 'reaper';
  sessionId: string;
  nonce: string;
  pid: number;
  processStartToken: string;
  createdAtMs: number;
  directoryIdentity: CodexAppPosixFileIdentity;
  targetOwner?: CodexAppPosixOwnerTarget;
}

export type CodexAppOwnerProcessStatus = 'alive' | 'dead' | 'unknown';

export interface CodexAppPosixOwnerLease {
  directory: string;
  ownerRecordPath: string;
  isOwned(): boolean;
  release(): void;
}

export interface CodexAppPosixOwnerLeaseOptions {
  controlRoot: string;
  sessionId: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  retryDelayMs?: number;
  initializationGraceMs?: number;
  pid?: number;
  processStartToken?: string;
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
  inspectOwner?: (pid: number, processStartToken: string) => CodexAppOwnerProcessStatus;
  /** Deterministic handoff-race seam: invoked after mkdir(EEXIST), before observation. */
  onContended?: () => void;
  /** Deterministic crash-resume seam: invoked after this creator pins the new directory inode. */
  onOwnerDirectoryCreated?: (directory: string) => void | Promise<void>;
  /** Deterministic crash-window seam: pauses after owner publication, before the directory CAS. */
  onOwnerRecordPublished?: (directory: string, ownerRecordPath: string) => void | Promise<void>;
  /** Deterministic replacement seam: pauses after a stale owner is pinned, before reaper publication. */
  onBeforeReaperRecordPublished?: (directory: string) => void | Promise<void>;
  /** Deterministic crash-window seam: pauses after reaper publication, before the directory CAS. */
  onReaperRecordPublished?: (directory: string, reaperRecordPath: string) => void | Promise<void>;
}

function linuxProcessStartToken(raw: string): string | undefined {
  const closeParen = raw.lastIndexOf(')');
  if (closeParen < 0) return undefined;
  const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
  return fields[19] || undefined;
}

export function codexAppPosixProcessProbeEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // `ps -o lstart` is formatted through locale and timezone. Pin both so the
  // same live process cannot acquire a different token after the worker's
  // ambient LC_*/TZ changes. Preserve PATH and the remaining launch context.
  return { ...base, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
}

export function readCodexAppProcessStartToken(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0 || platform === 'win32') return undefined;
  if (platform === 'linux') {
    try { return linuxProcessStartToken(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
    catch { return undefined; }
  }
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: codexAppPosixProcessProbeEnv(),
    shell: false,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) return undefined;
  const token = result.stdout.trim();
  return token || undefined;
}

function inspectCodexAppOwnerProcess(
  pid: number,
  expectedStartToken: string,
  platform: NodeJS.Platform,
): CodexAppOwnerProcessStatus {
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    // EPERM proves that a process occupies the pid. Any other probe failure is
    // also fail-closed: it must not authorize stale-owner deletion.
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
  const actualStartToken = readCodexAppProcessStartToken(pid, platform);
  if (!actualStartToken) return 'unknown';
  // lstart has one-second resolution on non-Linux POSIX. A same-second PID
  // reuse can therefore look alive and block stale recovery, but cannot grant
  // ownership or reap a live owner: the ambiguity remains fail-closed.
  return actualStartToken === expectedStartToken ? 'alive' : 'dead';
}

function validPosixFileIdentity(value: unknown): value is CodexAppPosixFileIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Record<string, unknown>;
  return typeof identity.dev === 'string' && /^(?:0|[1-9]\d*)$/.test(identity.dev)
    && typeof identity.ino === 'string' && /^(?:0|[1-9]\d*)$/.test(identity.ino);
}

function validPosixOwnerTarget(value: unknown): value is CodexAppPosixOwnerTarget {
  if (!value || typeof value !== 'object') return false;
  const target = value as Record<string, unknown>;
  const processIdentityValid = (target.pid === null && target.processStartToken === null)
    || (Number.isSafeInteger(target.pid) && (target.pid as number) > 0
      && typeof target.processStartToken === 'string'
      && target.processStartToken.length > 0 && target.processStartToken.length <= 256);
  return typeof target.nonce === 'string' && /^[a-f0-9]{64}$/.test(target.nonce)
    && validPosixFileIdentity(target.recordIdentity)
    && processIdentityValid;
}

function validPosixOwnerRecord(
  value: unknown,
  sessionId: string,
  expectedRole?: 'owner' | 'reaper',
): value is CodexAppPosixOwnerRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const roleValid = record.role === 'owner' || record.role === 'reaper';
  const targetValid = record.role === 'owner'
    ? record.targetOwner === undefined
    : validPosixOwnerTarget(record.targetOwner);
  return record.version === 2
    && roleValid
    && (expectedRole === undefined || record.role === expectedRole)
    && record.sessionId === sessionId
    && typeof record.nonce === 'string' && /^[a-f0-9]{64}$/.test(record.nonce)
    && Number.isSafeInteger(record.pid) && (record.pid as number) > 0
    && typeof record.processStartToken === 'string'
    && record.processStartToken.length > 0 && record.processStartToken.length <= 256
    && typeof record.createdAtMs === 'number' && Number.isFinite(record.createdAtMs)
    && validPosixFileIdentity(record.directoryIdentity)
    && targetValid;
}

function readPosixOwnerRecord(
  path: string,
  sessionId: string,
  platform: NodeJS.Platform,
  expectedRole: 'owner' | 'reaper' = 'owner',
): CodexAppPosixOwnerRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readOwnedRegularFile(
      path,
      4_096,
      'Codex App POSIX owner record',
      platform,
    ));
    return validPosixOwnerRecord(parsed, sessionId, expectedRole) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

interface ObservedPosixLeaseRecord {
  path: string;
  name: string;
  nonce: string;
  role: 'owner' | 'reaper';
  stat: BigIntStats;
  ageMs: number;
  record?: CodexAppPosixOwnerRecord;
}

interface ObservedPosixLeaseDirectory {
  stat: BigIntStats;
  identity: CodexAppPosixFileIdentity;
  names: string[];
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

function posixLeaseRaceError(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'EAGAIN' });
}

function posixFileIdentity(stat: BigIntStats): CodexAppPosixFileIdentity {
  return { dev: stat.dev.toString(10), ino: stat.ino.toString(10) };
}

function samePosixFileIdentity(
  left: CodexAppPosixFileIdentity,
  right: CodexAppPosixFileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function samePosixStatIdentity(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino;
}

function exactBigIntMode(mode: bigint): number {
  return Number(mode & 0o777n);
}

function assertPosixOwned(
  stat: { uid: bigint },
  label: string,
  platform: NodeJS.Platform,
): void {
  if (!codexAppControlFilesystemPolicy(platform).verifyUid) return;
  const uid = ownerUid();
  if (uid !== undefined && stat.uid !== BigInt(uid)) {
    throw new Error(`${label} must be owned by the current uid`);
  }
}

function assertPrivatePosixLeaseRecord(
  stat: BigIntStats,
  label: string,
  platform: NodeJS.Platform,
): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
      || exactBigIntMode(stat.mode) !== PRIVATE_FILE_MODE) {
    throw new Error(`${label} must be a single-link regular 0600 file`);
  }
  assertPosixOwned(stat, label, platform);
}

function posixLeaseRecordNonce(name: string): string | undefined {
  const match = name.match(/^(?:owner|reap)-([a-f0-9]{64})\.(?:json|pending)$/);
  return match?.[1];
}

function posixLeaseRecordRole(name: string): 'owner' | 'reaper' | undefined {
  if (POSIX_OWNER_RECORD_RE.test(name) || POSIX_OWNER_PENDING_RE.test(name)) return 'owner';
  if (POSIX_REAPER_RECORD_RE.test(name) || POSIX_REAPER_PENDING_RE.test(name)) return 'reaper';
  return undefined;
}

/**
 * Observe one lease actor record without treating a crash-partial payload as
 * insecure metadata. Wrong type/owner/mode/link count fails hard; a secure
 * empty/truncated/oversized file is returned as a grace-reclaimable record.
 */
function observePosixLeaseRecord(
  path: string,
  name: string,
  sessionId: string,
  platform: NodeJS.Platform,
  nowMs: number,
  label: string,
): ObservedPosixLeaseRecord | undefined {
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
  assertPrivatePosixLeaseRecord(before, label, platform);
  const nonce = posixLeaseRecordNonce(name);
  if (!nonce) throw new Error(`${label} has an invalid filename`);
  const role = posixLeaseRecordRole(name);
  if (!role) throw new Error(`${label} has an invalid role`);

  let record: CodexAppPosixOwnerRecord | undefined;
  if (before.size > 0n && before.size <= BigInt(POSIX_LEASE_RECORD_MAX_BYTES)) {
    try {
      const parsed: unknown = JSON.parse(readOwnedRegularFile(
        path,
        POSIX_LEASE_RECORD_MAX_BYTES,
        label,
        platform,
      ));
      if (validPosixOwnerRecord(parsed, sessionId, role) && parsed.nonce === nonce) {
        record = parsed;
      }
    } catch (err) {
      // JSON syntax failures are crash-partial data. A path race is handled by
      // the post-read identity check below and never reclassified as stale.
      if (errnoCode(err) === 'ENOENT') return undefined;
    }
  }

  let after: BigIntStats;
  try {
    after = lstatSync(path, { bigint: true });
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
  assertPrivatePosixLeaseRecord(after, label, platform);
  if (!samePosixStatIdentity(before, after)) return undefined;
  return {
    path,
    name,
    nonce,
    role,
    stat: after,
    ageMs: Math.max(0, nowMs - Number(after.mtimeMs)),
    ...(record ? { record } : {}),
  };
}

function observePosixLeaseDirectory(
  directory: string,
  platform: NodeJS.Platform,
): ObservedPosixLeaseDirectory | undefined {
  let before: BigIntStats;
  try {
    before = lstatSync(directory, { bigint: true });
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
  assertPosixLeaseDirectoryStat(before, platform);
  let names: string[];
  try {
    names = readdirSync(directory).sort();
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
  let after: BigIntStats;
  try {
    after = lstatSync(directory, { bigint: true });
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
  if (!samePosixStatIdentity(before, after)) return undefined;
  assertPosixLeaseDirectoryStat(after, platform);
  return { stat: after, identity: posixFileIdentity(after), names };
}

function createStagedPosixLeaseRecord(input: {
  directory: string;
  finalPath: string;
  pendingPath: string;
  record: CodexAppPosixOwnerRecord;
  sessionId: string;
  label: string;
  platform: NodeJS.Platform;
}): void {
  try {
    createExclusiveFile(
      input.pendingPath,
      JSON.stringify(input.record),
      `${input.label} pending file`,
      input.platform,
    );
    // A complete synced inode becomes authoritative in one namespace step.
    // SIGKILL during the write can therefore leave only a `.pending` file.
    renameSync(input.pendingPath, input.finalPath);
    fsyncDirectory(input.directory, input.platform);
    const persisted = readPosixOwnerRecord(
      input.finalPath,
      input.sessionId,
      input.platform,
      input.record.role,
    );
    if (!persisted || persisted.nonce !== input.record.nonce) {
      throw new Error(`${input.label} verification failed`);
    }
  } finally {
    try { unlinkSync(input.pendingPath); } catch { /* renamed or crash-partial cleanup */ }
  }
}

/**
 * Rename the exact observed random-name inode out of the lease directory.
 * Random actor filenames make this a compare-and-swap boundary: a concurrent
 * cleaner can only receive ENOENT and can never unlink a successor's record.
 */
function retireObservedPosixLeaseRecord(
  observed: ObservedPosixLeaseRecord,
  leasesRoot: string,
  sessionId: string,
  platform: NodeJS.Platform,
): boolean {
  let current: BigIntStats;
  try {
    current = lstatSync(observed.path, { bigint: true });
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return false;
    throw err;
  }
  assertPrivatePosixLeaseRecord(current, 'Codex App POSIX lease record', platform);
  if (!samePosixStatIdentity(observed.stat, current)) return false;
  const retired = join(
    leasesRoot,
    `.retired-${sessionKey(sessionId).slice(0, 16)}-${observed.nonce}-${randomBytes(16).toString('hex')}`,
  );
  try {
    renameSync(observed.path, retired);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return false;
    throw err;
  }
  try {
    const moved = lstatSync(retired, { bigint: true });
    assertPrivatePosixLeaseRecord(moved, 'Retired Codex App POSIX lease record', platform);
    if (!samePosixStatIdentity(observed.stat, moved)) {
      throw new Error('Codex App POSIX lease record changed during retirement');
    }
  } finally {
    try { unlinkSync(retired); } catch { /* crash residue is outside the authority directory */ }
  }
  return true;
}

function assertPosixLeaseDirectoryStat(stat: BigIntStats, platform: NodeJS.Platform): void {
  if (!stat.isDirectory() || stat.isSymbolicLink() || exactBigIntMode(stat.mode) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error('Codex App POSIX owner lease must be a real 0700 directory');
  }
  assertPosixOwned(stat, 'Codex App POSIX owner lease', platform);
}

function posixLeaseRecordMatchesDirectory(
  observed: ObservedPosixLeaseRecord,
  directory: ObservedPosixLeaseDirectory | CodexAppPosixFileIdentity,
): boolean {
  if (!observed.record) return false;
  const identity = 'identity' in directory ? directory.identity : directory;
  return samePosixFileIdentity(observed.record.directoryIdentity, identity);
}

function posixOwnerTarget(observed: ObservedPosixLeaseRecord): CodexAppPosixOwnerTarget {
  return {
    nonce: observed.nonce,
    recordIdentity: posixFileIdentity(observed.stat),
    pid: observed.record?.pid ?? null,
    processStartToken: observed.record?.processStartToken ?? null,
  };
}

function posixReaperTargetsOwner(
  reaper: ObservedPosixLeaseRecord,
  owner: ObservedPosixLeaseRecord,
): boolean {
  const target = reaper.record?.targetOwner;
  if (!target || target.nonce !== owner.nonce
      || !samePosixFileIdentity(target.recordIdentity, posixFileIdentity(owner.stat))) return false;
  if (!owner.record) return target.pid === null && target.processStartToken === null;
  return target.pid === owner.record.pid
    && target.processStartToken === owner.record.processStartToken;
}

/**
 * Process-lifetime publisher lease for POSIX.
 *
 * Both owners and stale cleaners publish complete, random-name actor records.
 * An actor record is written to `.pending`, synced, and atomically renamed to
 * `.json`, so SIGKILL cannot create a partial authoritative record. Existing
 * partial records remain recoverable after a grace interval. Every complete
 * actor is bound to the exact directory dev+ino it intended to mutate; reapers
 * additionally bind the exact owner-record inode/process tuple. A cleaner moves
 * the exact observed random-name inode out of the authority directory before
 * deleting it; that rename is the CAS boundary which prevents a delayed actor
 * from poisoning or deleting a successor's record after path replacement.
 */
export async function acquireCodexAppPosixOwnerLease(
  options: CodexAppPosixOwnerLeaseOptions,
): Promise<CodexAppPosixOwnerLease> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') throw new Error('POSIX owner lease is unavailable on Windows');
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryDelayMs = options.retryDelayMs ?? 50;
  const initializationGraceMs = options.initializationGraceMs ?? 1_000;
  const pid = options.pid ?? process.pid;
  const processStartToken = options.processStartToken
    ?? readCodexAppProcessStartToken(pid, platform);
  if (!processStartToken) {
    throw new Error('Cannot verify current process start token for Codex App POSIX owner lease');
  }
  const inspectOwner = options.inspectOwner
    ?? ((ownerPid: number, token: string) => inspectCodexAppOwnerProcess(ownerPid, token, platform));
  ensureCodexAppControlDirectory(options.controlRoot, platform);
  const leasesRoot = join(options.controlRoot, 'leases');
  ensureCodexAppControlDirectory(leasesRoot, platform);
  const directory = codexAppPosixOwnerLeaseDirectory(options.controlRoot, options.sessionId);
  const deadline = now() + timeoutMs;

  const retry = async (): Promise<void> => {
    if (now() >= deadline) throw new Error('Codex App POSIX owner lease timed out');
    await wait(Math.min(retryDelayMs, Math.max(0, deadline - now())));
  };

  acquireLoop: while (true) {
    const nonce = randomBytes(32).toString('hex');
    const ownerRecordPath = join(directory, `owner-${nonce}.json`);
    const ownerPendingPath = join(directory, `owner-${nonce}.pending`);
    let createdDirectory = false;
    try {
      mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
      createdDirectory = true;
      const ownedDirectoryStat = lstatSync(directory, { bigint: true });
      assertPosixLeaseDirectoryStat(ownedDirectoryStat, platform);
      const ownedDirectoryIdentity = posixFileIdentity(ownedDirectoryStat);
      if (options.onOwnerDirectoryCreated) {
        await options.onOwnerDirectoryCreated(directory);
      }
      const record: CodexAppPosixOwnerRecord = {
        version: 2,
        role: 'owner',
        sessionId: options.sessionId,
        nonce,
        pid,
        processStartToken,
        createdAtMs: now(),
        directoryIdentity: ownedDirectoryIdentity,
      };
      try {
        createStagedPosixLeaseRecord({
          directory,
          finalPath: ownerRecordPath,
          pendingPath: ownerPendingPath,
          record,
          sessionId: options.sessionId,
          label: 'Codex App POSIX owner record',
          platform,
        });
        const persisted = readPosixOwnerRecord(ownerRecordPath, options.sessionId, platform, 'owner');
        if (!persisted || persisted.nonce !== nonce) {
          throw new Error('Codex App POSIX owner record verification failed');
        }
        if (options.onOwnerRecordPublished) {
          await options.onOwnerRecordPublished(directory, ownerRecordPath);
        }
        const installed = observePosixLeaseDirectory(directory, platform);
        if (!installed || !samePosixStatIdentity(installed.stat, ownedDirectoryStat)
            || installed.names.length !== 1 || installed.names[0] !== basename(ownerRecordPath)) {
          throw posixLeaseRaceError(
            'Codex App POSIX owner directory changed during record publication',
          );
        }
      } catch (err) {
        try { unlinkSync(ownerPendingPath); } catch { /* not installed */ }
        try { unlinkSync(ownerRecordPath); } catch { /* not installed */ }
        try { rmdirSync(directory); } catch { /* competing reaper or residue */ }
        throw err;
      }
      let released = false;
      const isOwned = (): boolean => {
        if (released) return false;
        try {
          const currentDirectory = observePosixLeaseDirectory(directory, platform);
          if (!currentDirectory
              || !samePosixFileIdentity(currentDirectory.identity, ownedDirectoryIdentity)) return false;
          const currentOwner = observePosixLeaseRecord(
            ownerRecordPath,
            basename(ownerRecordPath),
            options.sessionId,
            platform,
            now(),
            'Codex App POSIX owner record',
          );
          if (!currentOwner || currentOwner.record?.nonce !== nonce
              || !posixLeaseRecordMatchesDirectory(currentOwner, ownedDirectoryIdentity)) return false;
          for (const name of currentDirectory.names.filter(candidate => (
            POSIX_REAPER_RECORD_RE.test(candidate) || POSIX_REAPER_PENDING_RE.test(candidate)
          ))) {
            const reaper = observePosixLeaseRecord(
              join(directory, name),
              name,
              options.sessionId,
              platform,
              now(),
              'Codex App POSIX reaper record',
            );
            if (!reaper) return false;
            // A delayed cleaner may publish into a replacement directory. Only
            // a complete actor bound to this inode and this exact owner tuple
            // can suspend authority. Partial/foreign actors never authorize a
            // takeover and are reclaimed by the acquisition loop.
            if (posixLeaseRecordMatchesDirectory(reaper, currentDirectory)
                && posixReaperTargetsOwner(reaper, currentOwner)) return false;
          }
          return true;
        } catch {
          return false;
        }
      };
      return {
        directory,
        ownerRecordPath,
        isOwned,
        release: () => {
          if (released) return;
          released = true;
          const persisted = readPosixOwnerRecord(ownerRecordPath, options.sessionId, platform, 'owner');
          if (persisted?.nonce === nonce
              && samePosixFileIdentity(persisted.directoryIdentity, ownedDirectoryIdentity)) {
            try { unlinkSync(ownerRecordPath); } catch { /* already reaped */ }
          }
          try { unlinkSync(ownerPendingPath); } catch { /* never published or already retired */ }
          try { rmdirSync(directory); } catch { /* another contender owns cleanup */ }
        },
      };
    } catch (err) {
      if (createdDirectory && (errnoCode(err) === 'EAGAIN' || errnoCode(err) === 'ENOENT')) {
        await retry();
        continue;
      }
      if (createdDirectory || errnoCode(err) !== 'EEXIST') throw err;
    }

    options.onContended?.();
    const snapshot = observePosixLeaseDirectory(directory, platform);
    if (!snapshot) {
      await retry();
      continue;
    }

    const knownNames = snapshot.names.filter(name => (
      POSIX_OWNER_RECORD_RE.test(name)
      || POSIX_OWNER_PENDING_RE.test(name)
      || POSIX_REAPER_RECORD_RE.test(name)
      || POSIX_REAPER_PENDING_RE.test(name)
    ));
    if (knownNames.length !== snapshot.names.length) {
      throw new Error('Codex App POSIX owner lease contains an unknown record');
    }

    // A live/unknown cleaner is authority and blocks fail-closed. A dead or
    // crash-partial cleaner has a unique filename, so retiring that exact inode
    // cannot clobber a successor cleaner.
    const reaperNames = snapshot.names.filter(name => (
      POSIX_REAPER_RECORD_RE.test(name) || POSIX_REAPER_PENDING_RE.test(name)
    ));
    if (reaperNames.length > 0) {
      let retiredAny = false;
      for (const name of reaperNames) {
        const observed = observePosixLeaseRecord(
          join(directory, name),
          name,
          options.sessionId,
          platform,
          now(),
          'Codex App POSIX reaper record',
        );
        if (!observed) {
          await retry();
          continue acquireLoop;
        }
        if (observed.record && !posixLeaseRecordMatchesDirectory(observed, snapshot)) {
          // The actor was published by a delayed cleaner that pinned an older
          // directory inode. It has no authority in this replacement directory,
          // regardless of whether that process is still alive.
        } else if (observed.record) {
          const status = inspectOwner(
            observed.record.pid,
            observed.record.processStartToken,
          );
          if (status !== 'dead') {
            await retry();
            continue acquireLoop;
          }
        } else if (observed.ageMs < initializationGraceMs) {
          await retry();
          continue acquireLoop;
        }
        if (!retireObservedPosixLeaseRecord(
          observed,
          leasesRoot,
          options.sessionId,
          platform,
        )) {
          await retry();
          continue acquireLoop;
        }
        retiredAny = true;
      }
      if (retiredAny) continue;
    }

    const ownerNames = snapshot.names.filter(name => (
      POSIX_OWNER_RECORD_RE.test(name) || POSIX_OWNER_PENDING_RE.test(name)
    ));
    const observedOwners: ObservedPosixLeaseRecord[] = [];
    let retiredForeignOwner = false;
    for (const name of ownerNames) {
      const observed = observePosixLeaseRecord(
        join(directory, name),
        name,
        options.sessionId,
        platform,
        now(),
        'Codex App POSIX owner record',
      );
      if (!observed) {
        await retry();
        continue acquireLoop;
      }
      if (observed.record && !posixLeaseRecordMatchesDirectory(observed, snapshot)) {
        // This can only be a creator that pinned an older directory and resumed
        // after the fixed path was replaced. Its process liveness is irrelevant:
        // the record never held authority over this inode.
        if (!retireObservedPosixLeaseRecord(
          observed,
          leasesRoot,
          options.sessionId,
          platform,
        )) {
          await retry();
          continue acquireLoop;
        }
        retiredForeignOwner = true;
        continue;
      }
      observedOwners.push(observed);
    }
    if (retiredForeignOwner) continue;
    if (observedOwners.length > 1) {
      let retiredNonAuthoritativeOwner = false;
      for (const observed of observedOwners) {
        const reclaimable = observed.record
          ? inspectOwner(observed.record.pid, observed.record.processStartToken) === 'dead'
          : observed.ageMs >= initializationGraceMs;
        if (!reclaimable) continue;
        // A creator can be paused after mkdir while another contender replaces
        // the empty inode, then resume and publish into that replacement before
        // noticing another owner. Exact actor-file CAS makes dead/partial losing
        // candidates independently reclaimable without touching a live/unknown
        // same-directory candidate.
        if (!retireObservedPosixLeaseRecord(
          observed,
          leasesRoot,
          options.sessionId,
          platform,
        )) {
          await retry();
          continue acquireLoop;
        }
        retiredNonAuthoritativeOwner = true;
      }
      if (retiredNonAuthoritativeOwner) continue;
      // Multiple live/unknown candidates are ambiguous. None can be newly
      // granted by this contender; wait for a creator to finish its directory
      // CAS or for liveness to become provable.
      await retry();
      continue;
    }

    if (observedOwners.length === 0) {
      const ageMs = Math.max(0, now() - Number(snapshot.stat.mtimeMs));
      if (ageMs < initializationGraceMs) {
        await retry();
        continue;
      }
      try {
        rmdirSync(directory);
      } catch (err) {
        if (errnoCode(err) !== 'ENOENT' && errnoCode(err) !== 'ENOTEMPTY') throw err;
        await retry();
      }
      continue;
    }

    const observedOwner = observedOwners[0]!;
    if (observedOwner.record) {
      const status = inspectOwner(
        observedOwner.record.pid,
        observedOwner.record.processStartToken,
      );
      if (status !== 'dead') {
        await retry();
        continue;
      }
    } else if (observedOwner.ageMs < initializationGraceMs) {
      await retry();
      continue;
    }

    const reaperNonce = randomBytes(32).toString('hex');
    const reaperPath = join(directory, `reap-${reaperNonce}.json`);
    const reaperPendingPath = join(directory, `reap-${reaperNonce}.pending`);
    const reaperRecord: CodexAppPosixOwnerRecord = {
      version: 2,
      role: 'reaper',
      sessionId: options.sessionId,
      nonce: reaperNonce,
      pid,
      processStartToken,
      createdAtMs: now(),
      directoryIdentity: snapshot.identity,
      targetOwner: posixOwnerTarget(observedOwner),
    };
    try {
      if (options.onBeforeReaperRecordPublished) {
        await options.onBeforeReaperRecordPublished(directory);
      }
      createStagedPosixLeaseRecord({
        directory,
        finalPath: reaperPath,
        pendingPath: reaperPendingPath,
        record: reaperRecord,
        sessionId: options.sessionId,
        label: 'Codex App POSIX reaper record',
        platform,
      });
      if (options.onReaperRecordPublished) {
        await options.onReaperRecordPublished(directory, reaperPath);
      }
      const reaperDirectory = observePosixLeaseDirectory(directory, platform);
      if (!reaperDirectory || !samePosixStatIdentity(reaperDirectory.stat, snapshot.stat)) {
        throw posixLeaseRaceError(
          'Codex App POSIX owner directory changed during reaper election',
        );
      }
    } catch (err) {
      try { unlinkSync(reaperPendingPath); } catch { /* never installed */ }
      try { unlinkSync(reaperPath); } catch { /* never installed */ }
      if (errnoCode(err) === 'EEXIST' || errnoCode(err) === 'ENOENT'
          || errnoCode(err) === 'EAGAIN') {
        await retry();
        continue;
      }
      throw err;
    }

    try {
      const electedSnapshot = observePosixLeaseDirectory(directory, platform);
      if (!electedSnapshot) continue;
      const electedReapers: ObservedPosixLeaseRecord[] = [];
      let electionMustRetry = false;
      for (const name of electedSnapshot.names.filter(candidate => (
        POSIX_REAPER_RECORD_RE.test(candidate) || POSIX_REAPER_PENDING_RE.test(candidate)
      ))) {
        const observed = observePosixLeaseRecord(
          join(directory, name),
          name,
          options.sessionId,
          platform,
          now(),
          'Codex App POSIX reaper record',
        );
        if (!observed || !observed.record) {
          electionMustRetry = true;
          break;
        }
        if (!posixLeaseRecordMatchesDirectory(observed, electedSnapshot)
            || !posixReaperTargetsOwner(observed, observedOwner)) {
          electionMustRetry = true;
          break;
        }
        if (observed.nonce !== reaperNonce) {
          const status = inspectOwner(
            observed.record.pid,
            observed.record.processStartToken,
          );
          if (status !== 'alive') {
            // Unknown actors block fail-closed; dead actors are reclaimed by
            // the outer observation loop before a new election.
            electionMustRetry = true;
            break;
          }
        }
        electedReapers.push(observed);
      }
      if (electionMustRetry) continue;
      electedReapers.sort((a, b) => (
        (a.record!.createdAtMs - b.record!.createdAtMs) || a.nonce.localeCompare(b.nonce)
      ));
      // Simultaneous contenders may both have published before observing each
      // other. The oldest deterministic actor proceeds; all others withdraw.
      if (electedReapers[0]?.nonce !== reaperNonce) continue;

      const currentOwner = observePosixLeaseRecord(
        observedOwner.path,
        observedOwner.name,
        options.sessionId,
        platform,
        now(),
        'Codex App POSIX owner record',
      );
      if (!currentOwner || !samePosixStatIdentity(currentOwner.stat, observedOwner.stat)
          || (currentOwner.record && !posixLeaseRecordMatchesDirectory(currentOwner, electedSnapshot))
          || !posixReaperTargetsOwner(
            electedReapers.find(candidate => candidate.nonce === reaperNonce)!,
            currentOwner,
          )) continue;
      if (currentOwner.record) {
        if (inspectOwner(
          currentOwner.record.pid,
          currentOwner.record.processStartToken,
        ) !== 'dead') continue;
      } else if (currentOwner.ageMs < initializationGraceMs) {
        continue;
      }
      if (!retireObservedPosixLeaseRecord(
        currentOwner,
        leasesRoot,
        options.sessionId,
        platform,
      )) {
        continue;
      }
    } finally {
      try { unlinkSync(reaperPendingPath); } catch { /* renamed or already retired */ }
      try { unlinkSync(reaperPath); } catch { /* another cleaner retired it */ }
    }
    try { rmdirSync(directory); } catch (err) {
      if (errnoCode(err) !== 'ENOENT' && errnoCode(err) !== 'ENOTEMPTY') throw err;
    }
  }
}

export function generateCodexAppControlEpoch(): string {
  return randomBytes(32).toString('base64url');
}

export interface CodexAppControlLocator {
  version: typeof CONTROL_LOCATOR_VERSION;
  sessionId: string;
  epoch: string;
  endpoint: string;
}

export function isValidCodexAppWindowsPipeEndpoint(endpoint: unknown): endpoint is string {
  return typeof endpoint === 'string'
    && /^\\\\\?\\pipe\\botmux-codex-app-[a-f0-9]{64}$/.test(endpoint);
}

function isValidCodexAppPosixSocketEndpoint(
  endpoint: unknown,
  locatorPath: string | undefined,
  expectedControlRoot: string | undefined,
  expectedSessionId: string,
  platform: NodeJS.Platform,
): endpoint is string {
  if (typeof endpoint !== 'string' || !locatorPath || !expectedControlRoot
      || !isAbsolute(endpoint) || !isAbsolute(locatorPath) || !isAbsolute(expectedControlRoot)) {
    return false;
  }
  // Do not infer trust from an attacker-selected locator path. The caller must
  // supply the already trusted control root and both paths must be the exact
  // canonical children for this session.
  if (locatorPath !== codexAppControlLocatorPath(
    expectedControlRoot,
    expectedSessionId,
    platform,
  )) return false;
  const endpointDirectory = join(expectedControlRoot, 'sockets');
  const leaf = basename(endpoint);
  return POSIX_SOCKET_LEAF_RE.test(leaf)
    && endpoint === join(endpointDirectory, leaf)
    // Darwin's sockaddr_un.sun_path is 104 bytes including the terminator.
    && Buffer.byteLength(endpoint, 'utf8') < 104;
}

export interface CodexAppControlLocatorValidationOptions {
  platform?: NodeJS.Platform;
  locatorPath?: string;
  /** Trusted, worker-owned root; never derive this authority from locatorPath. */
  expectedControlRoot?: string;
}

export function validateCodexAppControlLocator(
  value: unknown,
  expectedSessionId: string,
  options: CodexAppControlLocatorValidationOptions = {},
): CodexAppControlLocator | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const platform = options.platform ?? process.platform;
  const endpointValid = platform === 'win32'
    ? isValidCodexAppWindowsPipeEndpoint(record.endpoint)
    : isValidCodexAppPosixSocketEndpoint(
      record.endpoint,
      options.locatorPath,
      options.expectedControlRoot,
      expectedSessionId,
      platform,
    );
  if (record.version !== CONTROL_LOCATOR_VERSION
      || record.sessionId !== expectedSessionId
      || !isValidGeneration(record.epoch)
      || !endpointValid) return undefined;
  return record as unknown as CodexAppControlLocator;
}

export interface CodexAppControlIdentity {
  generation: string;
  publicKey: string;
  createdAtMs: number;
}

/**
 * pending may contain an old live identity plus a fresh spawn candidate. The
 * first identity that answers this worker's fresh socket challenge is atomically
 * collapsed to the sole active identity. No private material is persisted.
 */
export interface CodexAppControlState {
  version: typeof CONTROL_STATE_VERSION;
  status: 'pending' | 'active';
  identities: CodexAppControlIdentity[];
  updatedAtMs: number;
  activatedAtMs?: number;
}

function isValidGeneration(value: unknown): value is string {
  return typeof value === 'string' && GENERATION_RE.test(value);
}

function isValidChallenge(value: unknown): value is string {
  return typeof value === 'string' && CHALLENGE_RE.test(value);
}

function importPublicKey(encoded: string): KeyObject {
  return createPublicKey({ key: Buffer.from(encoded, 'base64url'), format: 'der', type: 'spki' });
}

function importPrivateKey(encoded: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(encoded, 'base64url'), format: 'der', type: 'pkcs8' });
}

function validIdentity(value: unknown): value is CodexAppControlIdentity {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (!isValidGeneration(record.generation)
      || typeof record.publicKey !== 'string' || !KEY_RE.test(record.publicKey)
      || typeof record.createdAtMs !== 'number' || !Number.isFinite(record.createdAtMs)) return false;
  try {
    return importPublicKey(record.publicKey).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

function validState(value: unknown): value is CodexAppControlState {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.version !== CONTROL_STATE_VERSION
      || (record.status !== 'pending' && record.status !== 'active')
      || !Array.isArray(record.identities)
      || record.identities.length < 1
      || record.identities.length > MAX_STATE_IDENTITIES
      || !record.identities.every(validIdentity)
      || new Set(record.identities.map(identity => identity.generation)).size !== record.identities.length
      || typeof record.updatedAtMs !== 'number' || !Number.isFinite(record.updatedAtMs)
      || (record.status === 'active' && record.identities.length !== 1)
      || (record.activatedAtMs !== undefined
        && (typeof record.activatedAtMs !== 'number' || !Number.isFinite(record.activatedAtMs)))) return false;
  return true;
}

function assertRegularSingleLinkWithinLimit(
  stat: Stats,
  maxBytes: number,
  label: string,
  platform: NodeJS.Platform,
): void {
  const policy = codexAppControlFilesystemPolicy(platform);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (policy.verifyExactMode && exactMode(stat.mode) !== PRIVATE_FILE_MODE)
      || stat.size <= 0 || stat.size > maxBytes) {
    const mode = policy.verifyExactMode ? ' 0600' : '';
    throw new Error(`${label} must be a single-link regular${mode} file within the size limit`);
  }
  assertOwned(stat, label, platform);
}

function sameFileIdentity(
  before: Stats,
  after: Stats,
): boolean {
  return Number.isFinite(before.dev) && Number.isFinite(before.ino)
    && before.dev === after.dev && before.ino === after.ino;
}

function readOwnedRegularFile(
  path: string,
  maxBytes: number,
  label: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const before = lstatSync(path);
  assertRegularSingleLinkWithinLimit(before, maxBytes, label, platform);
  const fd = openSync(path, fsConstants.O_RDONLY | noFollowFlag(platform));
  try {
    const stat = fstatSync(fd);
    assertRegularSingleLinkWithinLimit(stat, maxBytes, label, platform);
    if (!sameFileIdentity(before, stat)) throw new Error(`${label} changed between lstat and open`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

export function readCodexAppControlState(
  path: string,
  platform: NodeJS.Platform = process.platform,
): CodexAppControlState | undefined {
  try {
    const parsed: unknown = JSON.parse(readOwnedRegularFile(
      path,
      STATE_MAX_BYTES,
      'Codex App control state',
      platform,
    ));
    return validState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function createExclusiveFile(
  path: string,
  contents: string,
  label: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const policy = codexAppControlFilesystemPolicy(platform);
  const fd = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(platform),
    PRIVATE_FILE_MODE,
  );
  try {
    if (policy.chmodAfterCreate) fchmodSync(fd, PRIVATE_FILE_MODE);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1
        || (policy.verifyExactMode && exactMode(stat.mode) !== PRIVATE_FILE_MODE)) {
      throw new Error(`${label} was not created as a single-link regular private file`);
    }
    assertOwned(stat, label, platform);
    const data = Buffer.from(contents, 'utf8');
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(directory: string, platform: NodeJS.Platform): void {
  if (!codexAppControlFilesystemPolicy(platform).fsyncDirectory) return;
  const fd = openSync(directory, fsConstants.O_RDONLY | noFollowFlag(platform));
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) throw new Error('Codex App control state parent must be a directory');
    assertOwned(stat, 'Codex App control state parent', platform);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Symlink-safe atomic state replacement inside a private directory. */
export function writeCodexAppControlState(path: string, state: CodexAppControlState): void {
  writeCodexAppControlStateForPlatform(path, state, process.platform);
}

export function writeCodexAppControlStateForPlatform(
  path: string,
  state: CodexAppControlState,
  platform: NodeJS.Platform,
): void {
  if (!validState(state)) throw new Error('Codex App control state is invalid');
  const directory = dirnameForPlatform(platform, path);
  ensureCodexAppControlDirectory(directory, platform);
  const tmp = joinForPlatform(
    platform,
    directory,
    `.${sessionKey(path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    createExclusiveFile(tmp, JSON.stringify(state), 'Codex App control state temp file', platform);
    renameSync(tmp, path);
    // The file itself was synced before rename; sync the parent as well so a
    // proved generation does not silently roll back after a host crash.
    fsyncDirectory(directory, platform);
    const persisted = readCodexAppControlState(path, platform);
    if (!persisted || persisted.status !== state.status
        || persisted.identities.map(identity => identity.generation).join(',')
          !== state.identities.map(identity => identity.generation).join(',')) {
      throw new Error('Codex App control state verification failed after rename');
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed or never created */ }
  }
}

export function readCodexAppControlLocator(
  path: string,
  expectedSessionId: string,
  platform: NodeJS.Platform = process.platform,
  expectedControlRoot: string | undefined = platform === 'win32'
    ? undefined
    : codexAppPosixControlRoot(),
): CodexAppControlLocator | undefined {
  try {
    const value: unknown = JSON.parse(readOwnedRegularFile(
      path,
      LOCATOR_MAX_BYTES,
      'Codex App control locator',
      platform,
    ));
    return validateCodexAppControlLocator(value, expectedSessionId, {
      platform,
      locatorPath: path,
      expectedControlRoot,
    });
  } catch {
    return undefined;
  }
}

export function writeCodexAppControlLocator(
  path: string,
  locator: CodexAppControlLocator,
  platform: NodeJS.Platform = process.platform,
  expectedControlRoot: string | undefined = platform === 'win32'
    ? undefined
    : codexAppPosixControlRoot(),
): void {
  if (!validateCodexAppControlLocator(locator, locator.sessionId, {
    platform,
    locatorPath: path,
    expectedControlRoot,
  })) {
    throw new Error('Codex App control locator is invalid');
  }
  const directory = dirnameForPlatform(platform, path);
  ensureCodexAppControlDirectory(directory, platform);
  const tmp = joinForPlatform(
    platform,
    directory,
    `.${sessionKey(path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    createExclusiveFile(tmp, JSON.stringify(locator), 'Codex App control locator temp file', platform);
    renameSync(tmp, path);
    fsyncDirectory(directory, platform);
    const persisted = readCodexAppControlLocator(
      path,
      locator.sessionId,
      platform,
      expectedControlRoot,
    );
    if (!persisted || persisted.epoch !== locator.epoch || persisted.endpoint !== locator.endpoint) {
      throw new Error('Codex App control locator verification failed after rename');
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed or never created */ }
  }
}

/**
 * The ordering contract is security-sensitive on every platform: the random
 * pipe/socket must already be bound before its locator becomes visible.
 */
export async function bindThenPublishCodexAppControlLocator(input: {
  sessionId: string;
  epoch: string;
  endpoint: string;
  listen: (endpoint: string) => Promise<void>;
  publish: (locator: CodexAppControlLocator) => void;
  platform?: NodeJS.Platform;
  locatorPath?: string;
  expectedControlRoot?: string;
  isCurrent?: () => boolean;
  retire?: () => void;
}): Promise<CodexAppControlLocator | undefined> {
  const locator = validateCodexAppControlLocator({
    version: CONTROL_LOCATOR_VERSION,
    sessionId: input.sessionId,
    epoch: input.epoch,
    endpoint: input.endpoint,
  }, input.sessionId, {
    platform: input.platform,
    locatorPath: input.locatorPath,
    expectedControlRoot: input.expectedControlRoot,
  });
  if (!locator) throw new Error('Codex App control endpoint publication metadata is invalid');
  await input.listen(locator.endpoint);
  if (input.isCurrent && !input.isCurrent()) {
    input.retire?.();
    return undefined;
  }
  try {
    input.publish(locator);
  } catch (err) {
    input.retire?.();
    throw err;
  }
  return locator;
}

export function shouldFailCodexAppControlChannel(input: {
  channelId: number;
  currentChannelId: number;
  stopping: boolean;
}): boolean {
  return !input.stopping && input.channelId === input.currentChannelId;
}

/**
 * Runner-side endpoint policy for locator rotations. A never-accepted
 * locator may be retried (the independently random, protected epoch is still
 * required for acceptance) until the shared startup deadline. Once accepted,
 * the pipe name is permanently burned and only a newly published endpoint can
 * be used.
 */
export class CodexAppControlEndpointTracker {
  private readonly attemptsByEndpoint = new Map<string, number>();
  private readonly acceptedEndpoints = new Set<string>();

  take(locator: CodexAppControlLocator): string | undefined {
    if (this.acceptedEndpoints.has(locator.endpoint)) return undefined;
    const attempts = this.attemptsByEndpoint.get(locator.endpoint) ?? 0;
    this.attemptsByEndpoint.set(locator.endpoint, attempts + 1);
    return locator.endpoint;
  }

  noteAccepted(endpoint: string): void {
    if (!this.attemptsByEndpoint.has(endpoint)) {
      throw new Error('Cannot accept an unattempted Codex App control endpoint');
    }
    this.acceptedEndpoints.add(endpoint);
  }

  wasAttempted(endpoint: string): boolean {
    return this.attemptsByEndpoint.has(endpoint);
  }

  attemptCount(endpoint: string): number {
    return this.attemptsByEndpoint.get(endpoint) ?? 0;
  }

  wasAccepted(endpoint: string): boolean {
    return this.acceptedEndpoints.has(endpoint);
  }
}

/** Read and select one locator endpoint; missing/corrupt files are a poll miss. */
export function takeCodexAppControlLocatorEndpoint(input: {
  locatorPath: string;
  sessionId: string;
  tracker: CodexAppControlEndpointTracker;
  platform?: NodeJS.Platform;
  expectedControlRoot?: string;
}): { endpoint: string; epoch: string } | undefined {
  const platform = input.platform ?? process.platform;
  const locator = readCodexAppControlLocator(
    input.locatorPath,
    input.sessionId,
    platform,
    input.expectedControlRoot ?? (platform === 'win32' ? undefined : codexAppPosixControlRoot()),
  );
  if (!locator) return undefined;
  const endpoint = input.tracker.take(locator);
  return endpoint ? { endpoint, epoch: locator.epoch } : undefined;
}

const PERSISTENT_BACKEND_TYPES: ReadonlySet<BackendType> = new Set(['tmux', 'herdr', 'zellij']);

/** Missing/corrupt/legacy generations cannot prove a warm reattach. */
export function shouldColdStartCodexAppReattach(input: {
  cliId?: string;
  backendType: BackendType;
  isReattach: boolean;
  persistedState?: CodexAppControlState;
}): boolean {
  return input.cliId === 'codex-app'
    && input.isReattach
    && PERSISTENT_BACKEND_TYPES.has(input.backendType)
    && !input.persistedState;
}

export interface CodexAppControlBootstrap {
  path: string;
  identity: CodexAppControlIdentity;
}

export interface ConsumedCodexAppControlBootstrap {
  generation: string;
  privateKey: KeyObject;
  socketPath?: string;
  locatorPath?: string;
}

export type CodexAppControlBootstrapTarget =
  | { kind: 'endpoint'; socketPath: string }
  | { kind: 'locator'; locatorPath: string };

/** Create a fresh asymmetric candidate and one O_EXCL private bootstrap. */
export function createCodexAppControlBootstrap(
  directory: string,
  sessionId: string,
  target: string | CodexAppControlBootstrapTarget = codexAppControlSocketPath(directory, sessionId),
  platform: NodeJS.Platform = process.platform,
): CodexAppControlBootstrap {
  ensureCodexAppControlDirectory(directory, platform);
  const resolvedTarget: CodexAppControlBootstrapTarget = typeof target === 'string'
    ? { kind: 'endpoint', socketPath: target }
    : target;
  if (resolvedTarget.kind === 'endpoint'
      && !isAbsoluteForPlatform(resolvedTarget.socketPath, platform)) {
    throw new Error('Codex App control socket path must be absolute');
  }
  if (resolvedTarget.kind === 'locator'
      && !isAbsoluteForPlatform(resolvedTarget.locatorPath, platform)) {
    throw new Error('Codex App control locator path must be absolute');
  }
  const generation = randomBytes(32).toString('base64url');
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const identity: CodexAppControlIdentity = { generation, publicKey, createdAtMs: Date.now() };
  const key = sessionKey(sessionId).slice(0, 16);
  const path = joinForPlatform(platform, directory, `${key}.${randomBytes(16).toString('hex')}.bootstrap`);
  createExclusiveFile(
    path,
    JSON.stringify({
      version: CONTROL_BOOTSTRAP_VERSION,
      sessionId,
      generation,
      privateKey,
      ...(resolvedTarget.kind === 'endpoint'
        ? { socketPath: resolvedTarget.socketPath }
        : { locatorPath: resolvedTarget.locatorPath }),
    }),
    'Codex App control bootstrap',
    platform,
  );
  return { path, identity };
}

/** Remove crash-orphaned one-shot files for exactly one session generation. */
export function cleanupStaleCodexAppControlBootstraps(
  directory: string,
  sessionId: string,
  platform: NodeJS.Platform = process.platform,
): void {
  ensureCodexAppControlDirectory(directory, platform);
  const key = sessionKey(sessionId).slice(0, 16);
  const pattern = new RegExp(`^${key}\\.[a-f0-9]{32}\\.bootstrap$`);
  for (const name of readdirSync(directory)) {
    if (!pattern.test(name)) continue;
    try { unlinkSync(joinForPlatform(platform, directory, name)); } catch { /* raced with runner consume */ }
  }
}

/**
 * One-shot consume on one O_NOFOLLOW fd. The file is unlinked before its bytes
 * are read and the post-unlink link count must be zero. The private key is
 * imported here so callers do not retain or forward its encoded form.
 */
export function consumeCodexAppControlBootstrap(
  path: string,
  expectedSessionId?: string,
  platform: NodeJS.Platform = process.platform,
): ConsumedCodexAppControlBootstrap {
  if (!path || !isAbsoluteForPlatform(path, platform)) {
    throw new Error('Codex App control bootstrap path must be absolute');
  }
  let fd: number | undefined;
  try {
    const policy = codexAppControlFilesystemPolicy(platform);
    const beforePath = lstatSync(path);
    assertRegularSingleLinkWithinLimit(
      beforePath,
      BOOTSTRAP_MAX_BYTES,
      'Codex App control bootstrap',
      platform,
    );
    fd = openSync(path, fsConstants.O_RDONLY | noFollowFlag(platform));
    const before = fstatSync(fd);
    assertRegularSingleLinkWithinLimit(
      before,
      BOOTSTRAP_MAX_BYTES,
      'Codex App control bootstrap',
      platform,
    );
    if (!sameFileIdentity(beforePath, before)) {
      throw new Error('Codex App control bootstrap changed between lstat and open');
    }
    unlinkSync(path);
    const after = fstatSync(fd);
    if (policy.verifyPostUnlinkLinkCount && after.nlink !== 0) {
      throw new Error('Codex App control bootstrap was not consumed by unlink');
    }
    const decoded = JSON.parse(readFileSync(fd, 'utf8')) as Record<string, unknown>;
    const hasSocketPath = typeof decoded.socketPath === 'string'
      && isAbsoluteForPlatform(decoded.socketPath, platform);
    const hasLocatorPath = typeof decoded.locatorPath === 'string'
      && isAbsoluteForPlatform(decoded.locatorPath, platform);
    const posixLocatorPathValid = platform === 'win32' || !hasLocatorPath
      || decoded.locatorPath === codexAppControlLocatorPath(
        codexAppPosixControlRoot(),
        typeof decoded.sessionId === 'string' ? decoded.sessionId : '',
        platform,
      );
    if (decoded.version !== CONTROL_BOOTSTRAP_VERSION
        || typeof decoded.sessionId !== 'string'
        || (expectedSessionId !== undefined && decoded.sessionId !== expectedSessionId)
        || !isValidGeneration(decoded.generation)
        || typeof decoded.privateKey !== 'string' || !KEY_RE.test(decoded.privateKey)
        || hasSocketPath === hasLocatorPath
        // Windows always follows its protected locator. Current POSIX workers
        // also emit locators; a legacy direct socket bootstrap remains accepted
        // because the read-once bootstrap itself is the launch capability. Any
        // POSIX locator is nevertheless pinned to the fixed per-UID root here.
        || (platform === 'win32' && !hasLocatorPath)
        || !posixLocatorPathValid) {
      throw new Error('Codex App control bootstrap is invalid');
    }
    const privateKey = importPrivateKey(decoded.privateKey);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Codex App control private key is invalid');
    return {
      generation: decoded.generation,
      privateKey,
      ...(hasSocketPath ? { socketPath: decoded.socketPath as string } : {}),
      ...(hasLocatorPath ? { locatorPath: decoded.locatorPath as string } : {}),
    };
  } catch (err) {
    try { unlinkSync(path); } catch { /* remove a rejected bootstrap/symlink */ }
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function mergeCodexAppControlCandidate(
  existing: CodexAppControlState | undefined,
  candidate: CodexAppControlIdentity,
  nowMs = Date.now(),
): CodexAppControlState {
  if (!validIdentity(candidate)) {
    throw new Error('Codex App control candidate is invalid');
  }
  const identities = [candidate, ...(existing?.identities ?? [])]
    .filter((identity, index, all) => all.findIndex(item => item.generation === identity.generation) === index)
    .slice(0, MAX_STATE_IDENTITIES);
  return {
    version: CONTROL_STATE_VERSION,
    status: 'pending',
    identities,
    updatedAtMs: nowMs,
  };
}

export function activateCodexAppControlIdentity(
  state: CodexAppControlState,
  generation: string,
  nowMs = Date.now(),
): CodexAppControlState {
  const identity = state.identities.find(candidate => candidate.generation === generation);
  if (!identity) throw new Error('Codex App control generation is not a persisted candidate');
  return {
    version: CONTROL_STATE_VERSION,
    status: 'active',
    identities: [identity],
    updatedAtMs: nowMs,
    activatedAtMs: nowMs,
  };
}

export function generateCodexAppControlChallenge(): string {
  return randomBytes(32).toString('base64url');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite control payload number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(',')}}`;
  }
  throw new Error('unsupported control payload value');
}

function signingBytes(domain: 'auth' | 'marker', value: Record<string, unknown>): Buffer {
  return Buffer.from(`botmux/codex-app/control/${domain}/v2\0${canonicalJson(value)}`, 'utf8');
}

function signature(privateKey: KeyObject, domain: 'auth' | 'marker', value: Record<string, unknown>): string {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Codex App control signer must be an Ed25519 private key');
  }
  return sign(null, signingBytes(domain, value), privateKey).toString('base64url');
}

function signatureValid(
  publicKey: string,
  signatureValue: string,
  domain: 'auth' | 'marker',
  value: Record<string, unknown>,
): boolean {
  if (!KEY_RE.test(publicKey) || !SIGNATURE_RE.test(signatureValue)) return false;
  try {
    return verify(
      null,
      signingBytes(domain, value),
      importPublicKey(publicKey),
      Buffer.from(signatureValue, 'base64url'),
    );
  } catch {
    return false;
  }
}

export interface CodexAppControlChallenge {
  version: typeof CONTROL_WIRE_VERSION;
  type: 'challenge';
  sessionId: string;
  challenge: string;
}

export interface CodexAppControlAuth {
  version: typeof CONTROL_WIRE_VERSION;
  type: 'auth';
  sessionId: string;
  generation: string;
  challenge: string;
  signature: string;
}

export interface CodexAppControlAccepted {
  version: typeof CONTROL_WIRE_VERSION;
  type: 'accepted';
  sessionId: string;
  generation: string;
  challenge: string;
  endpointEpoch?: string;
}

export interface CodexAppControlAck {
  version: typeof CONTROL_WIRE_VERSION;
  type: 'ack';
  sessionId: string;
  generation: string;
  challenge: string;
  seq: number;
}

export interface CodexAppSignedControlMarker {
  version: typeof CONTROL_WIRE_VERSION;
  type: 'marker';
  sessionId: string;
  generation: string;
  challenge: string;
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  signature: string;
}

export type CodexAppControlWireRecord =
  | CodexAppControlChallenge
  | CodexAppControlAuth
  | CodexAppControlAccepted
  | CodexAppControlAck
  | CodexAppSignedControlMarker;

export function encodeCodexAppControlChallenge(sessionId: string, challenge: string): string {
  if (!sessionId || !isValidChallenge(challenge)) throw new Error('Codex App control challenge is invalid');
  return JSON.stringify({ version: CONTROL_WIRE_VERSION, type: 'challenge', sessionId, challenge });
}

export function encodeCodexAppControlAccepted(
  sessionId: string,
  generation: string,
  challenge: string,
  endpointEpoch?: string,
): string {
  if (!sessionId || !isValidGeneration(generation) || !isValidChallenge(challenge)) {
    throw new Error('Codex App control acceptance metadata is invalid');
  }
  if (endpointEpoch !== undefined && !isValidGeneration(endpointEpoch)) {
    throw new Error('Codex App control endpoint epoch is invalid');
  }
  return JSON.stringify({
    version: CONTROL_WIRE_VERSION,
    type: 'accepted',
    sessionId,
    generation,
    challenge,
    ...(endpointEpoch ? { endpointEpoch } : {}),
  });
}

export function encodeCodexAppControlAck(
  sessionId: string,
  generation: string,
  challenge: string,
  seq: number,
): string {
  if (!sessionId || !isValidGeneration(generation) || !isValidChallenge(challenge)
      || !Number.isSafeInteger(seq) || seq <= 0) {
    throw new Error('Codex App control acknowledgement metadata is invalid');
  }
  return JSON.stringify({
    version: CONTROL_WIRE_VERSION,
    type: 'ack',
    sessionId,
    generation,
    challenge,
    seq,
  });
}

function authUnsigned(sessionId: string, generation: string, challenge: string): Record<string, unknown> {
  return { sessionId, generation, challenge };
}

export function encodeCodexAppControlAuth(
  privateKey: KeyObject,
  sessionId: string,
  generation: string,
  challenge: string,
): string {
  if (!sessionId || !isValidGeneration(generation) || !isValidChallenge(challenge)) {
    throw new Error('Codex App control authentication metadata is invalid');
  }
  const unsigned = authUnsigned(sessionId, generation, challenge);
  return JSON.stringify({
    version: CONTROL_WIRE_VERSION,
    type: 'auth',
    ...unsigned,
    signature: signature(privateKey, 'auth', unsigned),
  });
}

function markerUnsigned(
  sessionId: string,
  generation: string,
  challenge: string,
  seq: number,
  kind: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return { sessionId, generation, challenge, seq, kind, payload };
}

export function encodeCodexAppSignedControlMarker(
  privateKey: KeyObject,
  sessionId: string,
  generation: string,
  challenge: string,
  seq: number,
  kind: string,
  payload: Record<string, unknown>,
): string {
  if (!sessionId || !isValidGeneration(generation) || !isValidChallenge(challenge)
      || !Number.isSafeInteger(seq) || seq <= 0 || !kind) {
    throw new Error('Codex App control marker metadata is invalid');
  }
  const unsigned = markerUnsigned(sessionId, generation, challenge, seq, kind, payload);
  return JSON.stringify({
    version: CONTROL_WIRE_VERSION,
    type: 'marker',
    ...unsigned,
    signature: signature(privateKey, 'marker', unsigned),
  });
}

export function parseCodexAppControlWireRecord(line: string): CodexAppControlWireRecord | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.version !== CONTROL_WIRE_VERSION || typeof value.sessionId !== 'string' || !value.sessionId) return undefined;
    if (value.type === 'challenge' && isValidChallenge(value.challenge)) {
      return value as unknown as CodexAppControlChallenge;
    }
    if (value.type === 'auth' && isValidGeneration(value.generation)
        && isValidChallenge(value.challenge)
        && typeof value.signature === 'string' && SIGNATURE_RE.test(value.signature)) {
      return value as unknown as CodexAppControlAuth;
    }
    if (value.type === 'accepted' && isValidGeneration(value.generation)
        && isValidChallenge(value.challenge)
        && (value.endpointEpoch === undefined || isValidGeneration(value.endpointEpoch))) {
      return value as unknown as CodexAppControlAccepted;
    }
    if (value.type === 'ack' && isValidGeneration(value.generation)
        && isValidChallenge(value.challenge)
        && Number.isSafeInteger(value.seq) && Number(value.seq) > 0) {
      return value as unknown as CodexAppControlAck;
    }
    if (value.type === 'marker' && isValidGeneration(value.generation)
        && isValidChallenge(value.challenge)
        && Number.isSafeInteger(value.seq) && Number(value.seq) > 0
        && typeof value.kind === 'string' && value.kind.length > 0
        && value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)
        && typeof value.signature === 'string' && SIGNATURE_RE.test(value.signature)) {
      return value as unknown as CodexAppSignedControlMarker;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export type CodexAppControlRunnerHandshakeAction =
  | { type: 'authenticate'; challenge: string }
  | { type: 'accepted'; challenge: string }
  | { type: 'ack'; seq: number }
  | { type: 'reject' };

/**
 * Pure runner-side handshake state machine. Keeping the phase checks here
 * makes repeated challenges, wrong locator epochs, and out-of-order ACKs
 * executable in unit tests instead of relying on source-string assertions.
 */
export class CodexAppControlRunnerHandshake {
  private phase: 'challenge' | 'accepted' | 'active' = 'challenge';
  private challengeValue: string | undefined;

  constructor(
    private readonly expectedSessionId: string,
    private readonly expectedGeneration: string,
    private readonly expectedEndpointEpoch?: string,
  ) {}

  handle(
    record: CodexAppControlWireRecord | undefined,
    sentThrough: number,
  ): CodexAppControlRunnerHandshakeAction {
    if (!record || record.sessionId !== this.expectedSessionId) return { type: 'reject' };
    if (this.phase === 'challenge' && record.type === 'challenge') {
      this.challengeValue = record.challenge;
      this.phase = 'accepted';
      return { type: 'authenticate', challenge: record.challenge };
    }
    if (this.phase === 'accepted'
        && record.type === 'accepted'
        && record.generation === this.expectedGeneration
        && record.challenge === this.challengeValue
        && (this.expectedEndpointEpoch === undefined
          || record.endpointEpoch === this.expectedEndpointEpoch)) {
      this.phase = 'active';
      return { type: 'accepted', challenge: record.challenge };
    }
    if (this.phase === 'active'
        && record.type === 'ack'
        && record.generation === this.expectedGeneration
        && record.challenge === this.challengeValue
        && record.seq > 0
        && record.seq <= sentThrough) {
      return { type: 'ack', seq: record.seq };
    }
    return { type: 'reject' };
  }

  get active(): boolean {
    return this.phase === 'active';
  }
}

export function verifyCodexAppControlAuth(auth: CodexAppControlAuth, publicKey: string): boolean {
  return signatureValid(
    publicKey,
    auth.signature,
    'auth',
    authUnsigned(auth.sessionId, auth.generation, auth.challenge),
  );
}

export function authenticateCodexAppControlCandidate(input: {
  state: CodexAppControlState | undefined;
  auth: CodexAppControlAuth;
  sessionId: string;
  challenge: string;
}): CodexAppControlIdentity | undefined {
  if (!input.state
      || input.auth.sessionId !== input.sessionId
      || input.auth.challenge !== input.challenge) return undefined;
  const identity = input.state.identities.find(
    candidate => candidate.generation === input.auth.generation,
  );
  return identity && verifyCodexAppControlAuth(input.auth, identity.publicKey)
    ? identity
    : undefined;
}

export function verifyCodexAppSignedControlMarker(
  marker: CodexAppSignedControlMarker,
  publicKey: string,
): boolean {
  return signatureValid(
    publicKey,
    marker.signature,
    'marker',
    markerUnsigned(
      marker.sessionId,
      marker.generation,
      marker.challenge,
      marker.seq,
      marker.kind,
      marker.payload,
    ),
  );
}

/**
 * Marker sequences may begin above one after a worker replacement, but every
 * record on one authenticated connection must then be contiguous. This keeps
 * a skipped final fragment from being hidden by a later cumulative ACK.
 */
export class CodexAppControlSequenceFence {
  private previous: number | undefined;

  accept(seq: number): boolean {
    if (!Number.isSafeInteger(seq) || seq <= 0) return false;
    if (this.previous !== undefined && seq !== this.previous + 1) return false;
    this.previous = seq;
    return true;
  }
}

export type CodexAppFinalAssemblyResult =
  | { status: 'not-final' }
  | { status: 'accepted' }
  | { status: 'complete'; payload: Record<string, unknown> }
  | { status: 'reject'; reason: string };

interface CodexAppFinalAssemblyState {
  id: string;
  total: number;
  metadata: Record<string, unknown>;
  chunks: Buffer[];
  bytes: number;
}

const FINAL_ID_MAX_BYTES = 512;
const STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Per-connection final transaction assembler. Start and chunks deliberately
 * remain unacknowledged; only a valid, complete end record is eligible for the
 * cumulative ACK. Any gap or interleaving rejects the connection, so the
 * runner must re-sign and replay the complete transaction under a new
 * challenge.
 */
export class CodexAppControlFinalAssembler {
  private active: CodexAppFinalAssemblyState | undefined;

  accept(kind: string, payload: Record<string, unknown>): CodexAppFinalAssemblyResult {
    const isTransactionKind = kind === 'final-start' || kind === 'final-chunk' || kind === 'final-end';
    if (!isTransactionKind) {
      if (kind === 'final' || kind.startsWith('final-')) {
        return this.reject(`unsupported final record ${kind}`);
      }
      return this.active
        ? this.reject(`interleaved ${kind} record inside final transaction`)
        : { status: 'not-final' };
    }

    const id = typeof payload.id === 'string' ? payload.id : '';
    if (!id || Buffer.byteLength(id, 'utf8') > FINAL_ID_MAX_BYTES) {
      return this.reject('invalid final transaction id');
    }

    if (kind === 'final-start') {
      const total = typeof payload.total === 'number' && Number.isSafeInteger(payload.total)
        ? payload.total
        : -1;
      if (this.active || total < 0 || total > 2_048) {
        return this.reject('invalid or overlapping final-start');
      }
      const { id: _id, total: _total, ...metadata } = payload;
      this.active = { id, total, metadata, chunks: [], bytes: 0 };
      return { status: 'accepted' };
    }

    const assembly = this.active;
    if (!assembly || id !== assembly.id) {
      return this.reject('final fragment has no matching start');
    }

    if (kind === 'final-chunk') {
      const index = typeof payload.index === 'number' && Number.isSafeInteger(payload.index)
        ? payload.index
        : -1;
      if (index !== assembly.chunks.length || index >= assembly.total
          || typeof payload.data !== 'string' || !STRICT_BASE64_RE.test(payload.data)) {
        return this.reject('invalid, duplicate, or out-of-order final chunk');
      }
      const chunk = Buffer.from(payload.data, 'base64');
      if (chunk.length === 0 || chunk.length > CODEX_APP_CONTROL_FINAL_CHUNK_BYTES) {
        return this.reject('final chunk size is invalid');
      }
      assembly.bytes += chunk.length;
      if (assembly.bytes > CODEX_APP_CONTROL_FINAL_MAX_BYTES) {
        return this.reject('final transaction exceeds the byte limit');
      }
      assembly.chunks.push(chunk);
      return { status: 'accepted' };
    }

    const endTotal = typeof payload.total === 'number' && Number.isSafeInteger(payload.total)
      ? payload.total
      : -1;
    if (endTotal !== assembly.total || assembly.chunks.length !== assembly.total) {
      return this.reject('incomplete or inconsistent final-end');
    }
    this.active = undefined;
    return {
      status: 'complete',
      payload: {
        ...assembly.metadata,
        content: Buffer.concat(assembly.chunks, assembly.bytes).toString('utf8'),
      },
    };
  }

  clear(): void {
    this.active = undefined;
  }

  private reject(reason: string): CodexAppFinalAssemblyResult {
    this.active = undefined;
    return { status: 'reject', reason };
  }
}

/**
 * Per-worker replay window for authenticated runner generations. A runner may
 * reconnect after losing an ACK and legitimately re-sign the same sequence
 * under the new connection challenge; the worker ACKs that retry without
 * applying its lifecycle/final side effects twice.
 */
export class CodexAppControlReplayWindow {
  private readonly highWaterByGeneration = new Map<string, number>();

  highWater(generation: string): number {
    return this.highWaterByGeneration.get(generation) ?? 0;
  }

  hasSeen(generation: string, seq: number): boolean {
    return seq <= this.highWater(generation);
  }

  commit(generation: string, seq: number): void {
    if (!isValidGeneration(generation) || !Number.isSafeInteger(seq) || seq <= 0) {
      throw new Error('Codex App control replay sequence is invalid');
    }
    if (seq > this.highWater(generation)) this.highWaterByGeneration.set(generation, seq);
  }

  retainOnly(generation: string): void {
    const retained = this.highWaterByGeneration.get(generation);
    this.highWaterByGeneration.clear();
    if (retained !== undefined) this.highWaterByGeneration.set(generation, retained);
  }
}

/** Bounded newline decoder; oversized attacker input is discarded until resync. */
export class CodexAppControlLineDecoder {
  private pending = Buffer.alloc(0);
  private droppingOversized = false;

  push(chunk: Buffer): { lines: string[]; droppedMalformed: boolean } {
    const lines: string[] = [];
    let droppedMalformed = false;
    let cursor = 0;
    while (cursor < chunk.length) {
      const nl = chunk.indexOf(0x0a, cursor);
      const end = nl >= 0 ? nl : chunk.length;
      const piece = chunk.subarray(cursor, end);
      cursor = nl >= 0 ? nl + 1 : chunk.length;

      if (this.droppingOversized) {
        droppedMalformed = true;
        if (nl >= 0) this.droppingOversized = false;
        continue;
      }
      if (this.pending.length + piece.length > CODEX_APP_CONTROL_LINE_MAX_BYTES) {
        this.pending = Buffer.alloc(0);
        droppedMalformed = true;
        if (nl < 0) this.droppingOversized = true;
        continue;
      }
      this.pending = Buffer.concat([this.pending, piece]);
      if (nl >= 0) {
        const line = this.pending.toString('utf8').trim();
        this.pending = Buffer.alloc(0);
        if (line) lines.push(line);
      }
    }
    return { lines, droppedMalformed };
  }

  clear(): void {
    this.pending = Buffer.alloc(0);
    this.droppingOversized = false;
  }
}
