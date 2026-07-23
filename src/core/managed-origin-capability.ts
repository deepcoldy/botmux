import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync,
  openSync, opendirSync, readSync, realpathSync, renameSync, rmSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const RELAY_ORIGIN_CAPABILITY_BASENAME = '.botmux-origin-capability.json';
export const MANAGED_ORIGIN_ISOLATION_MARKER_BASENAME = '.botmux-read-isolated-v1';
export const MANAGED_ORIGIN_ISOLATION_SENTINEL_BASENAME = '.botmux-read-isolation-sentinel-v1';
const MANAGED_ORIGIN_STALE_PROOF_MS = 60_000;

export interface ManagedOriginCapabilityClaim {
  sessionId: string;
  channelId?: string;
  capability: string;
  turnId?: string;
  dispatchAttempt?: number;
  /** Current daemon port, host-written on every capability rotation. */
  ipcPort?: number;
}

function assertManagedOriginChannelId(channelId: string): string {
  if (!/^[a-f0-9]{64}$/.test(channelId)) {
    throw new Error('invalid managed origin channel id');
  }
  return channelId;
}

function managedOriginChannelDigest(sessionId: string, channelId: string): string {
  return createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(assertManagedOriginChannelId(channelId))
    .digest('hex');
}

/**
 * Per-session path used by macOS read-isolated CLIs to read only their own
 * rotating daemon-IPC capability. Hashing keeps an untrusted session id out of
 * the path while still letting the worker and CLI derive the same filename.
 * The parent is denied wholesale by the Seatbelt profile; only this exact file
 * is carved back in for the owning session.
 */
export function managedOriginCapabilityPath(
  dataDir: string,
  sessionId: string,
  channelId: string,
): string {
  const digest = managedOriginChannelDigest(sessionId, channelId);
  return join(dataDir, 'read-isolation', `origin-${digest}.json`);
}

/** Host-written, child-read-only proof directory for live daemon attestation. */
export function managedOriginAttestationDirectory(
  dataDir: string,
  sessionId: string,
  channelId: string,
): string {
  const digest = managedOriginChannelDigest(sessionId, channelId);
  return join(dataDir, 'read-isolation', `attest-${digest}`);
}

export function managedOriginAttestationProofPath(
  dataDir: string,
  sessionId: string,
  channelId: string,
  nonce: string,
): string {
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error('invalid managed origin attestation nonce');
  return join(managedOriginAttestationDirectory(dataDir, sessionId, channelId), `${nonce}.json`);
}

export function managedOriginIsolationMarkerPath(
  dataDir: string,
  sessionId: string,
  channelId: string,
): string {
  return join(
    managedOriginAttestationDirectory(dataDir, sessionId, channelId),
    MANAGED_ORIGIN_ISOLATION_MARKER_BASENAME,
  );
}

export function managedOriginIsolationSentinelPath(homeDir: string): string {
  return join(homeDir, MANAGED_ORIGIN_ISOLATION_SENTINEL_BASENAME);
}

export function ensureManagedOriginIsolationSentinel(homeDir: string): string {
  const path = managedOriginIsolationSentinelPath(homeDir);
  replaceManagedOriginCapabilityFile(path, JSON.stringify({
    domain: 'botmux.read-isolation-sentinel.v1',
  }));
  chmodSync(path, 0o600);
  return path;
}

/** Fixed-OS-home locator whose basename is covered by the legacy
 * `.dashboard-secret(?:\.|$)` read/write deny. New profiles carve only the
 * exact current-session leaf back in for reads while the final write deny
 * remains in force. This gives cmdSend a data-root binding independent of
 * mutable HOME/SESSION_DATA_DIR. */
export function managedOriginRootLocatorPath(
  osUserHomeDir: string,
  sessionId: string,
): string {
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return join(
    osUserHomeDir,
    '.botmux',
    `.dashboard-secret.origin-root-${digest}.json`,
  );
}

export interface ManagedOriginRootLocator {
  sessionId: string;
  dataDir: string;
}

/** Probe placed inside the locator-selected data root's legacy-denied
 * `read-isolation/` namespace, but outside every current exact carve-out. The
 * exact directory location matters: a forged sibling dataDir must not inherit
 * a parent-level dashboard-secret deny and masquerade as the real root. */
export function managedOriginDataRootProbePath(
  dataDir: string,
  sessionId: string,
): string {
  if (!dataDir.startsWith('/')) throw new Error('managed origin data root must be absolute');
  const digest = createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(dataDir)
    .digest('hex');
  return join(dataDir, 'read-isolation', `.origin-root-probe-${digest}.json`);
}

export function ensureManagedOriginDataRootProbe(
  dataDir: string,
  sessionId: string,
): string {
  const canonicalDataDir = realpathSync(dataDir);
  const path = managedOriginDataRootProbePath(canonicalDataDir, sessionId);
  replaceManagedOriginCapabilityFile(path, JSON.stringify({
    domain: 'botmux.managed-origin-root-probe.v1',
    sessionId,
    dataDir: canonicalDataDir,
  }));
  chmodSync(path, 0o600);
  return path;
}

export function managedOriginDataRootProbeAccess(
  dataDir: string,
  sessionId: string,
): 'host_accessible' | 'sandbox_denied' | 'missing_or_unsafe' {
  const path = managedOriginDataRootProbePath(dataDir, sessionId);
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | fsConstants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    const expectedUid = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > 8 * 1024
      || (stat.mode & 0o777) !== 0o600
      || (expectedUid !== undefined && stat.uid !== expectedUid)) return 'missing_or_unsafe';
    const body = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < body.length) {
      const read = readSync(fd, body, offset, body.length - offset, null);
      if (read <= 0) return 'missing_or_unsafe';
      offset += read;
    }
    const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    return parsed.domain === 'botmux.managed-origin-root-probe.v1'
      && parsed.sessionId === sessionId
      && parsed.dataDir === dataDir
      ? 'host_accessible'
      : 'missing_or_unsafe';
  } catch (err: any) {
    // macOS Seatbelt returns EPERM for the profile deny. Do not accept EACCES:
    // a confined child can manufacture that with chmod(000) in a forged root.
    return err?.code === 'EPERM' ? 'sandbox_denied' : 'missing_or_unsafe';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

export function ensureManagedOriginRootLocator(
  osUserHomeDir: string,
  sessionId: string,
  dataDir: string,
): string {
  if (!dataDir.startsWith('/')) throw new Error('managed origin data root must be absolute');
  const canonicalDataDir = realpathSync(dataDir);
  const lexicalPath = managedOriginRootLocatorPath(osUserHomeDir, sessionId);
  const lexicalParent = dirname(lexicalPath);
  mkdirSync(lexicalParent, { recursive: true, mode: 0o700 });
  // Existing installations may symlink ~/.botmux. Resolve the trusted host
  // parent once, validate the target directory, and write the leaf there; the
  // CLI's lexical fixed-home path resolves to the same inode under Seatbelt.
  const parent = realpathSync(lexicalParent);
  const path = join(parent, basename(lexicalPath));
  const stat = lstatSync(parent);
  const expectedUid = process.getuid?.();
  if (!stat.isDirectory()
    || (expectedUid !== undefined && stat.uid !== expectedUid)) {
    throw new Error(`managed origin locator parent is unsafe: ${parent}`);
  }
  replaceManagedOriginCapabilityFile(path, JSON.stringify({
    domain: 'botmux.managed-origin-root.v1',
    sessionId,
    dataDir: canonicalDataDir,
  }));
  chmodSync(path, 0o600);
  return path;
}

export function readManagedOriginRootLocator(
  osUserHomeDir: string,
  sessionId: string,
): ManagedOriginRootLocator | null {
  const body = readManagedOriginAuthorityFile(
    managedOriginRootLocatorPath(osUserHomeDir, sessionId),
    8 * 1024,
  );
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed.domain !== 'botmux.managed-origin-root.v1'
      || parsed.sessionId !== sessionId
      || typeof parsed.dataDir !== 'string'
      || !parsed.dataDir.startsWith('/')
      || parsed.dataDir.length > 4096
      || parsed.dataDir.includes('\0')) return null;
    return { sessionId, dataDir: parsed.dataDir };
  } catch {
    return null;
  }
}

/** Kernel-observable macOS isolation classifier. The Seatbelt profile denies
 * this fixed, host-readable sentinel independent of env/argv/session ids. */
export function managedOriginIsolationSentinelAccess(
  homeDir: string,
): 'host_accessible' | 'sandbox_denied' | 'missing_or_unsafe' {
  const path = managedOriginIsolationSentinelPath(homeDir);
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | fsConstants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    const expectedUid = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > 1024
      || (stat.mode & 0o777) !== 0o600
      || (expectedUid !== undefined && stat.uid !== expectedUid)) return 'missing_or_unsafe';
    const body = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < body.length) {
      const read = readSync(fd, body, offset, body.length - offset, null);
      if (read <= 0) return 'missing_or_unsafe';
      offset += read;
    }
    try {
      const value = JSON.parse(body.toString('utf8')) as { domain?: unknown };
      return value.domain === 'botmux.read-isolation-sentinel.v1'
        ? 'host_accessible'
        : 'missing_or_unsafe';
    } catch {
      return 'missing_or_unsafe';
    }
  } catch (err: any) {
    return err?.code === 'EACCES' || err?.code === 'EPERM'
      ? 'sandbox_denied'
      : 'missing_or_unsafe';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/** Kernel probe backed by an inode that legacy read-isolation profiles already
 * denied: the dashboard HMAC secret. Only metadata is inspected; secret bytes
 * are never read or returned. This closes the upgrade race where a stale
 * pre-sentinel sandbox could replace a newly introduced probe path. */
export function managedOriginLegacyIsolationProbeAccess(
  osUserHomeDir: string,
): 'host_accessible' | 'sandbox_denied' | 'missing_or_unsafe' {
  const path = join(osUserHomeDir, '.botmux', '.dashboard-secret');
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | fsConstants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    const expectedUid = process.getuid?.();
    return stat.isFile() && stat.nlink === 1
      && (expectedUid === undefined || stat.uid === expectedUid)
      ? 'host_accessible'
      : 'missing_or_unsafe';
  } catch (err: any) {
    return err?.code === 'EACCES' || err?.code === 'EPERM'
      ? 'sandbox_denied'
      : 'missing_or_unsafe';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/** Strict bounded reader for host-owned authority metadata. It never follows a
 * leaf symlink and opens FIFOs/devices nonblocking before rejecting them by
 * inode type, ownership, link count, mode, and size. */
export function readManagedOriginAuthorityFile(
  filePath: string,
  maxBytes = 8 * 1024,
): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | fsConstants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    const expectedUid = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > maxBytes
      || (stat.mode & 0o777) !== 0o600
      || (expectedUid !== undefined && stat.uid !== expectedUid)) return null;
    const body = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < body.length) {
      const read = readSync(fd, body, offset, body.length - offset, null);
      if (read <= 0) return null;
      offset += read;
    }
    return body.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/** A durable, host-owned hint that this session was launched read-isolated.
 * It is deliberately separate from the rotating capability so missing,
 * corrupt, or revoked authority cannot silently downgrade `botmux send` to
 * the ordinary direct path. The marker is only a fail-closed classification
 * hint; the live daemon challenge remains the sole send authority. */
export function hasManagedOriginIsolationMarker(
  dataDir: string,
  sessionId: string,
  channelId: string,
): boolean {
  const body = readManagedOriginAuthorityFile(
    managedOriginIsolationMarkerPath(dataDir, sessionId, channelId),
    1024,
  );
  if (!body) return false;
  try {
    const parsed = JSON.parse(body) as {
      domain?: unknown;
      sessionId?: unknown;
      channelId?: unknown;
    };
    return parsed.domain === 'botmux.read-isolation-origin.v1'
      && parsed.sessionId === sessionId
      && parsed.channelId === channelId;
  } catch {
    return false;
  }
}

/** Prepare the proof directory before Seatbelt canonicalizes its read carve. */
export function ensureManagedOriginAttestationDirectory(
  dataDir: string,
  sessionId: string,
  channelId: string,
): string {
  const proofDir = managedOriginAttestationDirectory(dataDir, sessionId, channelId);
  const parent = dirname(proofDir);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const expectedUid = process.getuid?.();
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`managed origin attestation parent is not a real directory: ${parent}`);
  }
  if (expectedUid !== undefined && parentStat.uid !== expectedUid) {
    throw new Error(`managed origin attestation parent has the wrong owner: ${parent}`);
  }
  chmodSync(parent, 0o700);
  try {
    const existing = lstatSync(proofDir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      rmSync(proofDir, { recursive: true, force: true });
    } else if (expectedUid !== undefined && existing.uid !== expectedUid) {
      throw new Error(`managed origin attestation directory has the wrong owner: ${proofDir}`);
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
  mkdirSync(proofDir, { recursive: true, mode: 0o700 });
  chmodSync(proofDir, 0o700);
  const finalStat = lstatSync(proofDir);
  if (!finalStat.isDirectory() || finalStat.isSymbolicLink()
    || (expectedUid !== undefined && finalStat.uid !== expectedUid)
    || (finalStat.mode & 0o777) !== 0o700) {
    throw new Error(`managed origin attestation directory is unsafe: ${proofDir}`);
  }
  const markerPath = managedOriginIsolationMarkerPath(dataDir, sessionId, channelId);
  const markerBody = JSON.stringify({
    domain: 'botmux.read-isolation-origin.v1',
    sessionId,
    channelId,
  });
  if (!hasManagedOriginIsolationMarker(dataDir, sessionId, channelId)) {
    replaceManagedOriginCapabilityFile(markerPath, markerBody);
    chmodSync(markerPath, 0o600);
  }
  return proofDir;
}

/** Bounded owner-startup cleanup. Never call this from the unauthenticated
 * request path: a prefilled legacy directory must not turn every challenge
 * into an unbounded synchronous daemon scan. */
export function sweepManagedOriginAttestationProofs(
  dataDir: string,
  sessionId: string,
  channelId: string,
  maxEntries = 512,
): void {
  const proofDir = ensureManagedOriginAttestationDirectory(dataDir, sessionId, channelId);
  const expectedUid = process.getuid?.();
  const now = Date.now();
  const dir = opendirSync(proofDir);
  let seen = 0;
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      if (++seen > maxEntries) {
        throw new Error(`managed origin attestation directory exceeds ${maxEntries} entries`);
      }
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const candidate = join(proofDir, entry.name);
      try {
        const stat = lstatSync(candidate);
        if (stat.isDirectory()) continue;
        if (stat.isSymbolicLink() || !stat.isFile()
          || (expectedUid !== undefined && stat.uid !== expectedUid)
          || now - stat.mtimeMs > MANAGED_ORIGIN_STALE_PROOF_MS) {
          unlinkSync(candidate);
        }
      } catch { /* raced cleanup or inaccessible leaf: fail closed per nonce */ }
    }
  } finally {
    try { dir.closeSync(); } catch { /* best effort */ }
  }
}

/**
 * Atomically replace a capability file without following an attacker-planted
 * destination symlink. The generic atomic writer intentionally follows
 * symlinks for user-managed dotfiles; authority files need the opposite
 * contract so an isolated child cannot redirect the worker's next rotation.
 */
export function replaceManagedOriginCapabilityFile(filePath: string, body: string): void {
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`managed origin capability parent is not a real directory: ${parent}`);
  }
  const temp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    // rename replaces the destination directory entry itself; unlike opening
    // filePath, it does not dereference an existing destination symlink.
    renameSync(temp, filePath);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* temp may not have been created */ }
    throw error;
  }
}

/** Prepare a stable capability pathname without ever overwriting a successor
 * generation's regular file. Unsafe leaf types are removed by directory-entry
 * unlink (no follow); a regular leaf is left untouched for the daemon-owned
 * current-worker publication path. */
export function ensureManagedOriginCapabilityLeafSafe(filePath: string): void {
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`managed origin capability parent is not a real directory: ${parent}`);
  }
  try {
    const leaf = lstatSync(filePath);
    if (leaf.isSymbolicLink() || !leaf.isFile()) unlinkSync(filePath);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

/**
 * Read the current origin claim from the per-session sandbox relay (Linux) or
 * the exact Seatbelt carve-out (macOS). A file is only transport: the daemon
 * still compares the token with its live worker registry, so stale files and
 * forged tuple fields never confer authority.
 */
export function readManagedOriginCapability(
  dataDir: string,
  sessionId: string | undefined,
  relayDir?: string,
  channelId?: string,
): ManagedOriginCapabilityClaim | null {
  if (!sessionId) return null;
  const relay = !!relayDir;
  if (!relay && !channelId) return null;
  const path = relay
    ? join(relayDir!, RELAY_ORIGIN_CAPABILITY_BASENAME)
    : managedOriginCapabilityPath(dataDir, sessionId, channelId!);
  try {
    const body = readManagedOriginAuthorityFile(path, 8 * 1024);
    if (!body) return null;
    const parsed = JSON.parse(body) as {
      sessionId?: unknown;
      token?: unknown;
      capability?: unknown;
      turnId?: unknown;
      dispatchAttempt?: unknown;
      ipcPort?: unknown;
      channelId?: unknown;
    };
    if (!relay && parsed.sessionId !== sessionId) return null;
    if (!relay && parsed.channelId !== channelId) return null;
    const capability = typeof parsed.capability === 'string'
      ? parsed.capability
      : parsed.token;
    if (typeof capability !== 'string' || !/^[a-f0-9]{32,128}$/i.test(capability)) {
      return null;
    }
    const turnId = typeof parsed.turnId === 'string'
      && parsed.turnId.length > 0
      && parsed.turnId.length <= 256
      ? parsed.turnId
      : undefined;
    const dispatchAttempt = typeof parsed.dispatchAttempt === 'number'
      && Number.isSafeInteger(parsed.dispatchAttempt)
      && parsed.dispatchAttempt > 0
      ? parsed.dispatchAttempt
      : undefined;
    const ipcPort = typeof parsed.ipcPort === 'number'
      && Number.isSafeInteger(parsed.ipcPort)
      && parsed.ipcPort > 0 && parsed.ipcPort <= 65_535
      ? parsed.ipcPort
      : undefined;
    return {
      sessionId,
      ...(!relay && channelId ? { channelId } : {}),
      capability,
      ...(turnId ? { turnId } : {}),
      ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
      ...(ipcPort !== undefined ? { ipcPort } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Verify that the child-visible capability transport contains the exact token
 * currently authorized by the worker. Existence alone is insufficient: a
 * writable relay can contain a stale token, malformed JSON, or even a directory
 * at the reserved path after a prior sandbox generation.
 */
export function hasMatchingManagedOriginCapability(
  dataDir: string,
  sessionId: string | undefined,
  expectedCapability: string | undefined,
  relayDir?: string,
  channelId?: string,
): boolean {
  if (!expectedCapability) return false;
  return readManagedOriginCapability(dataDir, sessionId, relayDir, channelId)?.capability
    === expectedCapability;
}
