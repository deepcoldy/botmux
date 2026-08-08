import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createConnection, createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_APP_CONTROL_LINE_MAX_BYTES,
  CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS,
  CodexAppControlFinalAssembler,
  CodexAppControlLineDecoder,
  CodexAppControlEndpointTracker,
  CodexAppControlReplayWindow,
  CodexAppControlProofDeadline,
  CodexAppControlRunnerHandshake,
  CodexAppControlSequenceFence,
  activateCodexAppControlIdentity,
  acquireCodexAppControlOwnerLease,
  acquireCodexAppPosixOwnerLease,
  armCodexAppControlHandshakeTimeout,
  armCodexAppControlStartupTimeout,
  authenticateCodexAppControlCandidate,
  bindThenPublishCodexAppControlLocator,
  cleanupStaleCodexAppControlBootstraps,
  codexAppControlFilesystemPolicy,
  codexAppControlLocatorPath,
  codexAppPosixControlRoot,
  codexAppPosixOwnerLeaseDirectory,
  codexAppPosixProcessProbeEnv,
  codexAppControlStatePathForPlatform,
  codexAppWindowsOwnerPipeEndpoint,
  codexAppWindowsControlRoot,
  consumeCodexAppControlBootstrap,
  createCodexAppControlBootstrap,
  decodeWindowsAclSnapshot,
  encodeCodexAppControlAccepted,
  encodeCodexAppControlAck,
  encodeCodexAppControlAuth,
  encodeCodexAppControlChallenge,
  encodeCodexAppSignedControlMarker,
  generateCodexAppControlChallenge,
  generateCodexAppControlEpoch,
  generateCodexAppPosixSocketEndpoint,
  generateCodexAppWindowsPipeEndpoint,
  mergeCodexAppControlCandidate,
  parseCodexAppControlWireRecord,
  parseWindowsCurrentSid,
  readCodexAppControlState,
  readCodexAppControlLocator,
  shouldColdStartCodexAppReattach,
  shouldFailCodexAppControlChannel,
  takeCodexAppControlLocatorEndpoint,
  validateCodexAppControlLocator,
  verifyCodexAppControlAuth,
  verifyCodexAppSignedControlMarker,
  verifyWindowsCodexAppControlDacl,
  writeCodexAppControlLocator,
  writeCodexAppControlState,
} from '../src/utils/codex-app-control.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-control-'));
  tempDirs.push(dir);
  return dir;
}

function shortPosixControlRoot(): string {
  const dir = mkdtempSync('/tmp/bca-');
  tempDirs.push(dir);
  return dir;
}

function writePosixLeaseActorRecord(input: {
  path: string;
  sessionId: string;
  nonce: string;
  pid: number;
  processStartToken: string;
  createdAtMs?: number;
  intendedDirectory?: string;
  targetOwnerPath?: string;
  version?: 2 | 3;
}): void {
  const role = basename(input.path).startsWith('reap-') ? 'reaper' : 'owner';
  const intendedDirectory = input.intendedDirectory ?? dirname(input.path);
  const directoryStat = statSync(intendedDirectory, { bigint: true });
  const generationNames = readdirSync(intendedDirectory)
    .filter(name => /^generation-[a-f0-9]{64}\.json$/.test(name));
  const directoryGeneration = generationNames.length === 1
    ? generationNames[0]!.slice('generation-'.length, -'.json'.length)
    : undefined;
  const version = input.version ?? (directoryGeneration ? 3 : 2);
  let targetOwner: Record<string, unknown> | undefined;
  if (role === 'reaper') {
    const targetPath = input.targetOwnerPath ?? readdirSync(dirname(input.path))
      .find(name => /^owner-[a-f0-9]{64}\.json$/.test(name));
    const resolvedTargetPath = targetPath
      ? (targetPath.includes('/') ? targetPath : join(dirname(input.path), targetPath))
      : undefined;
    if (resolvedTargetPath && existsSync(resolvedTargetPath)) {
      const targetRecord = JSON.parse(readFileSync(resolvedTargetPath, 'utf8')) as {
        nonce: string;
        pid: number;
        processStartToken: string;
      };
      const targetStat = statSync(resolvedTargetPath, { bigint: true });
      targetOwner = {
        nonce: targetRecord.nonce,
        recordIdentity: { dev: targetStat.dev.toString(10), ino: targetStat.ino.toString(10) },
        pid: targetRecord.pid,
        processStartToken: targetRecord.processStartToken,
      };
    } else {
      targetOwner = {
        nonce: '0'.repeat(64),
        recordIdentity: { dev: '0', ino: '0' },
        pid: null,
        processStartToken: null,
      };
    }
  }
  writeFileSync(input.path, JSON.stringify({
    version,
    role,
    sessionId: input.sessionId,
    nonce: input.nonce,
    pid: input.pid,
    processStartToken: input.processStartToken,
    createdAtMs: input.createdAtMs ?? Date.now(),
    directoryIdentity: {
      dev: directoryStat.dev.toString(10),
      ino: directoryStat.ino.toString(10),
      ...(version === 3 ? { generation: directoryGeneration } : {}),
    },
    ...(targetOwner ? { targetOwner } : {}),
  }), { mode: 0o600 });
  chmodSync(input.path, 0o600);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Codex App asymmetric control bootstrap and state', () => {
  it('keeps a delayed runner alive beyond 30 seconds and expires at the shared 90-second hard cap', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const timer = armCodexAppControlStartupTimeout(onTimeout);
    try {
      expect(CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS).toBe(90_000);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(onTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(59_998);
      expect(onTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeout(timer);
      vi.useRealTimers();
    }
  });

  it('returns only a public identity, consumes the 0600 private bootstrap once, and binds session', () => {
    const dir = tempDir();
    const bootstrap = createCodexAppControlBootstrap(dir, 'session-one');
    const raw = readFileSync(bootstrap.path, 'utf8');
    const serialized = JSON.parse(raw);

    expect(Object.keys(bootstrap).sort()).toEqual(['identity', 'path']);
    expect(bootstrap.identity.publicKey).toEqual(expect.any(String));
    expect(JSON.stringify(bootstrap)).not.toContain(serialized.privateKey);
    expect(serialized).toMatchObject({
      version: 3,
      sessionId: 'session-one',
      generation: bootstrap.identity.generation,
      privateKey: expect.any(String),
      socketPath: expect.stringMatching(/\.sock$/),
    });
    expect(statSync(bootstrap.path).mode & 0o777).toBe(0o600);

    const consumed = consumeCodexAppControlBootstrap(bootstrap.path, 'session-one');
    expect(consumed.generation).toBe(bootstrap.identity.generation);
    expect(consumed.privateKey.type).toBe('private');
    expect(consumed.privateKey.asymmetricKeyType).toBe('ed25519');
    expect(existsSync(bootstrap.path)).toBe(false);
    expect(() => consumeCodexAppControlBootstrap(bootstrap.path, 'session-one')).toThrow();

    const wrongSession = createCodexAppControlBootstrap(dir, 'session-two');
    expect(() => consumeCodexAppControlBootstrap(wrongSession.path, 'session-other')).toThrow(/invalid/);
    expect(existsSync(wrongSession.path)).toBe(false);
  });

  it('fails closed on broad mode, symlink, and hard-linked bootstraps', () => {
    const dir = tempDir();
    const loose = createCodexAppControlBootstrap(dir, 'loose');
    chmodSync(loose.path, 0o644);
    expect(() => consumeCodexAppControlBootstrap(loose.path, 'loose')).toThrow(/regular 0600 file/);
    expect(existsSync(loose.path)).toBe(false);

    const target = join(dir, 'target');
    const symlink = join(dir, 'symlink.bootstrap');
    writeFileSync(target, '{}', { mode: 0o600 });
    symlinkSync(target, symlink);
    expect(() => consumeCodexAppControlBootstrap(symlink, 'x')).toThrow();
    expect(existsSync(symlink)).toBe(false);

    const linked = createCodexAppControlBootstrap(dir, 'linked');
    const secondLink = join(dir, 'second-link.bootstrap');
    linkSync(linked.path, secondLink);
    expect(() => consumeCodexAppControlBootstrap(linked.path, 'linked')).toThrow(/single-link/);
    rmSync(secondLink, { force: true });
  });

  it('pins POSIX locator bootstraps to the fixed per-UID control root', () => {
    const dir = tempDir();
    const sessionId = 'session-locator-root';
    const canonical = createCodexAppControlBootstrap(dir, sessionId, {
      kind: 'locator',
      locatorPath: codexAppControlLocatorPath(codexAppPosixControlRoot(), sessionId),
    });
    expect(consumeCodexAppControlBootstrap(canonical.path, sessionId).locatorPath)
      .toBe(codexAppControlLocatorPath(codexAppPosixControlRoot(), sessionId));

    const attackerRoot = tempDir();
    const forged = createCodexAppControlBootstrap(dir, sessionId, {
      kind: 'locator',
      locatorPath: codexAppControlLocatorPath(attackerRoot, sessionId),
    });
    expect(() => consumeCodexAppControlBootstrap(forged.path, sessionId)).toThrow(/invalid/);
  });

  it('cleans crash-orphaned bootstrap files for only the requested session', () => {
    const dir = tempDir();
    const first = createCodexAppControlBootstrap(dir, 'session-clean');
    const other = createCodexAppControlBootstrap(dir, 'session-other');
    cleanupStaleCodexAppControlBootstraps(dir, 'session-clean');
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(other.path)).toBe(true);
  });

  it('persists public candidates pending, then atomically collapses the proven generation active', () => {
    const dir = tempDir();
    const statePath = join(dir, 'state', 'session.json');
    const oldBootstrap = createCodexAppControlBootstrap(dir, 'session-state');
    const oldPending = mergeCodexAppControlCandidate(undefined, oldBootstrap.identity, 10);
    const oldActive = activateCodexAppControlIdentity(oldPending, oldBootstrap.identity.generation, 20);
    writeCodexAppControlState(statePath, oldActive);

    const fresh = createCodexAppControlBootstrap(dir, 'session-state');
    const pending = mergeCodexAppControlCandidate(oldActive, fresh.identity, 30);
    writeCodexAppControlState(statePath, pending);
    const persistedPending = readCodexAppControlState(statePath)!;
    expect(persistedPending.status).toBe('pending');
    expect(persistedPending.identities.map(identity => identity.generation)).toEqual([
      fresh.identity.generation,
      oldBootstrap.identity.generation,
    ]);
    expect(JSON.stringify(persistedPending)).not.toContain('privateKey');
    expect(statSync(statePath).mode & 0o777).toBe(0o600);

    const challenge = generateCodexAppControlChallenge();
    const oldKey = consumeCodexAppControlBootstrap(oldBootstrap.path, 'session-state');
    const oldAuth = parseCodexAppControlWireRecord(encodeCodexAppControlAuth(
      oldKey.privateKey,
      'session-state',
      oldKey.generation,
      challenge,
    ));
    if (!oldAuth || oldAuth.type !== 'auth') throw new Error('old auth parse failed');
    expect(authenticateCodexAppControlCandidate({
      state: persistedPending,
      auth: oldAuth,
      sessionId: 'session-state',
      challenge,
    })?.generation).toBe(oldBootstrap.identity.generation);
    expect(authenticateCodexAppControlCandidate({
      state: persistedPending,
      auth: { ...oldAuth, challenge: generateCodexAppControlChallenge() },
      sessionId: 'session-state',
      challenge,
    })).toBeUndefined();

    const reused = activateCodexAppControlIdentity(
      persistedPending,
      oldBootstrap.identity.generation,
      40,
    );
    writeCodexAppControlState(statePath, reused);
    expect(readCodexAppControlState(statePath)).toMatchObject({
      status: 'active',
      identities: [{ generation: oldBootstrap.identity.generation }],
      activatedAtMs: 40,
    });
  });

  it('cold-starts only persistent panes that have no valid public state', () => {
    const dir = tempDir();
    const bootstrap = createCodexAppControlBootstrap(dir, 'session-cold');
    const pending = mergeCodexAppControlCandidate(undefined, bootstrap.identity);
    for (const backendType of ['tmux', 'herdr', 'zellij'] as const) {
      expect(shouldColdStartCodexAppReattach({
        cliId: 'codex-app', backendType, isReattach: true,
      })).toBe(true);
      expect(shouldColdStartCodexAppReattach({
        cliId: 'codex-app', backendType, isReattach: true, persistedState: pending,
      })).toBe(false);
    }
    expect(shouldColdStartCodexAppReattach({
      cliId: 'codex-app', backendType: 'pty', isReattach: true,
    })).toBe(false);
    expect(shouldColdStartCodexAppReattach({
      cliId: 'codex', backendType: 'tmux', isReattach: true,
    })).toBe(false);
  });
});

describe('Codex App final transaction fencing', () => {
  it('allows an arbitrary first sequence after replacement but requires continuity thereafter', () => {
    const fence = new CodexAppControlSequenceFence();
    expect(fence.accept(41)).toBe(true);
    expect(fence.accept(42)).toBe(true);
    expect(fence.accept(44)).toBe(false);

    const duplicate = new CodexAppControlSequenceFence();
    expect(duplicate.accept(9)).toBe(true);
    expect(duplicate.accept(9)).toBe(false);
  });

  it('publishes a final only after a complete ordered transaction', () => {
    const assembler = new CodexAppControlFinalAssembler();
    expect(assembler.accept('final-start', {
      id: 'turn:1', total: 2, turnId: 'om_1', completedAtMs: 100,
    })).toEqual({ status: 'accepted' });
    expect(assembler.accept('final-chunk', {
      id: 'turn:1', index: 0, data: Buffer.from('hello ').toString('base64'),
    })).toEqual({ status: 'accepted' });
    expect(assembler.accept('final-chunk', {
      id: 'turn:1', index: 1, data: Buffer.from('world').toString('base64'),
    })).toEqual({ status: 'accepted' });
    expect(assembler.accept('final-end', { id: 'turn:1', total: 2 })).toEqual({
      status: 'complete',
      payload: { turnId: 'om_1', completedAtMs: 100, content: 'hello world' },
    });
  });

  it('rejects an incomplete final-end and accepts a full replay from a fresh connection', () => {
    const incomplete = new CodexAppControlFinalAssembler();
    expect(incomplete.accept('final-start', { id: 'turn:2', total: 2 })).toEqual({ status: 'accepted' });
    expect(incomplete.accept('final-chunk', {
      id: 'turn:2', index: 0, data: Buffer.from('first').toString('base64'),
    })).toEqual({ status: 'accepted' });
    expect(incomplete.accept('final-end', { id: 'turn:2', total: 2 })).toMatchObject({ status: 'reject' });

    const replay = new CodexAppControlFinalAssembler();
    expect(replay.accept('final-start', { id: 'turn:2', total: 2 })).toEqual({ status: 'accepted' });
    expect(replay.accept('final-chunk', {
      id: 'turn:2', index: 0, data: Buffer.from('first').toString('base64'),
    })).toEqual({ status: 'accepted' });
    expect(replay.accept('final-chunk', {
      id: 'turn:2', index: 1, data: Buffer.from('second').toString('base64'),
    })).toEqual({ status: 'accepted' });
    expect(replay.accept('final-end', { id: 'turn:2', total: 2 })).toMatchObject({
      status: 'complete',
      payload: { content: 'firstsecond' },
    });
  });

  it.each([
    ['out-of-order chunk', [
      ['final-start', { id: 'turn:3', total: 2 }],
      ['final-chunk', { id: 'turn:3', index: 1, data: Buffer.from('late').toString('base64') }],
    ]],
    ['duplicate chunk', [
      ['final-start', { id: 'turn:3', total: 2 }],
      ['final-chunk', { id: 'turn:3', index: 0, data: Buffer.from('one').toString('base64') }],
      ['final-chunk', { id: 'turn:3', index: 0, data: Buffer.from('again').toString('base64') }],
    ]],
    ['invalid base64', [
      ['final-start', { id: 'turn:3', total: 1 }],
      ['final-chunk', { id: 'turn:3', index: 0, data: '***not-base64***' }],
    ]],
    ['interleaved marker', [
      ['final-start', { id: 'turn:3', total: 1 }],
      ['state', { busy: false }],
    ]],
    ['mismatched final total', [
      ['final-start', { id: 'turn:3', total: 1 }],
      ['final-chunk', { id: 'turn:3', index: 0, data: Buffer.from('one').toString('base64') }],
      ['final-end', { id: 'turn:3', total: 2 }],
    ]],
  ] as const)('rejects %s instead of making it cumulatively ACK-eligible', (_name, records) => {
    const assembler = new CodexAppControlFinalAssembler();
    let result: ReturnType<CodexAppControlFinalAssembler['accept']> = { status: 'not-final' };
    for (const [kind, payload] of records) result = assembler.accept(kind, payload);
    expect(result.status).toBe('reject');
  });
});

describe('Windows Codex App control root, locator, and filesystem policy', () => {
  it('anchors state and locator paths under LOCALAPPDATA instead of SESSION_DATA_DIR', () => {
    const options = {
      platform: 'win32' as const,
      localAppData: 'C:\\Users\\alice\\AppData\\Local',
      homeDirectory: 'C:\\Users\\alice',
    };
    const root = codexAppWindowsControlRoot(options);
    expect(root).toBe('C:\\Users\\alice\\AppData\\Local\\Botmux\\codex-app-control');
    const state = codexAppControlStatePathForPlatform('Z:\\shared\\untrusted', 'session-win', options);
    expect(state.startsWith(root)).toBe(true);
    expect(state).not.toContain('shared');
    expect(codexAppControlLocatorPath(root, 'session-win', 'win32').startsWith(root)).toBe(true);
    expect(codexAppWindowsOwnerPipeEndpoint('session-win'))
      .toMatch(/^\\\\\?\\pipe\\botmux-codex-app-owner-[a-f0-9]{64}$/);
    expect(() => codexAppWindowsControlRoot({
      platform: 'win32',
      localAppData: '\\\\fileserver\\profiles\\alice',
      homeDirectory: 'C:\\Users\\alice',
    })).toThrow(/local drive-qualified/);
  });

  it('uses Windows file semantics without weakening POSIX owner-only policy', () => {
    expect(codexAppControlFilesystemPolicy('win32')).toEqual({
      useNoFollow: false,
      verifyUid: false,
      verifyExactMode: false,
      chmodAfterCreate: false,
      verifyPostUnlinkLinkCount: false,
      fsyncDirectory: false,
    });
    expect(codexAppControlFilesystemPolicy('linux')).toEqual({
      useNoFollow: true,
      verifyUid: true,
      verifyExactMode: true,
      chmodAfterCreate: true,
      verifyPostUnlinkLinkCount: true,
      fsyncDirectory: true,
    });
  });

  it('parses the current SID and accepts only a protected exact current-SID + SYSTEM DACL', () => {
    const sid = 'S-1-5-21-111-222-333-1001';
    expect(parseWindowsCurrentSid(`"DOMAIN\\alice","${sid}"`)).toBe(sid);
    // The username column is attacker-influenced and can itself be SID-shaped;
    // whoami's second CSV column is the only SID authority.
    expect(parseWindowsCurrentSid(`"S-1-5-18","${sid}"\r\n`)).toBe(sid);
    expect(parseWindowsCurrentSid(`"DOMAIN\\alice, admin","${sid}"\r\n`)).toBe(sid);
    expect(parseWindowsCurrentSid(`"${sid}","not-a-sid"`)).toBeUndefined();
    expect(parseWindowsCurrentSid(`"DOMAIN\\alice","${sid}","extra"`)).toBeUndefined();
    const exact = [
      'D:\\Botmux\\codex-app-control',
      `D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)`,
      '',
    ].join('\r\n');
    expect(verifyWindowsCodexAppControlDacl(exact, sid)).toBe(true);
    expect(verifyWindowsCodexAppControlDacl(
      `D:\\Botmux\\control D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)`,
      sid,
    )).toBe(true);
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(exact, 'utf16le'),
    ]);
    expect(verifyWindowsCodexAppControlDacl(decodeWindowsAclSnapshot(utf16), sid)).toBe(true);
    expect(verifyWindowsCodexAppControlDacl(
      `D:P(A;;FA;;;${sid})(A;;FA;;;SY)`,
      sid,
      'file',
    )).toBe(true);
    expect(verifyWindowsCodexAppControlDacl(exact, sid, 'file')).toBe(false);
    expect(verifyWindowsCodexAppControlDacl(
      `${exact.trim()}(A;OICI;FA;;;S-1-1-0)`,
      sid,
    )).toBe(false);
    expect(verifyWindowsCodexAppControlDacl(
      `D:AI(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)`,
      sid,
    )).toBe(false);
    expect(verifyWindowsCodexAppControlDacl(
      `D:P(A;OICIID;FA;;;${sid})(A;OICI;FA;;;SY)`,
      sid,
    )).toBe(false);
  });

  it('uses trusted absolute whoami/icacls argv without a shell and verifies saved SDDL', () => {
    const source = readFileSync(join(process.cwd(), 'src/utils/codex-app-control.ts'), 'utf8');
    const start = source.indexOf('function defaultWindowsControlCommandRunner(');
    const end = source.indexOf('/**\n * Remove inherited ACLs', start);
    const acl = source.slice(start, end);
    expect(acl).toContain('spawnSync(command, args, {');
    expect(acl).toContain('shell: false');
    expect(source).toContain("win32.join(systemRoot, 'System32', 'whoami.exe')");
    expect(source).toContain("win32.join(systemRoot, 'System32', 'icacls.exe')");
    expect(source).toContain("['/user', '/fo', 'csv', '/nh']");
    expect(source).toContain("[path, '/inheritance:r', '/q']");
    expect(source).toContain("[path, '/save', snapshotPath, '/q']");
    expect(source).toContain('verifyWindowsCodexAppControlDacl(snapshot, sid, kind)');
  });

  it('validates random 256-bit pipe endpoints and rejects wrong/corrupt locators', () => {
    const endpoint = generateCodexAppWindowsPipeEndpoint();
    const epoch = generateCodexAppControlEpoch();
    expect(endpoint).toMatch(/^\\\\\?\\pipe\\botmux-codex-app-[a-f0-9]{64}$/);
    const locator = validateCodexAppControlLocator({
      version: 1,
      sessionId: 'session-win',
      epoch,
      endpoint,
    }, 'session-win', { platform: 'win32' });
    expect(locator).toEqual({ version: 1, sessionId: 'session-win', epoch, endpoint });
    expect(validateCodexAppControlLocator(locator, 'wrong-session', { platform: 'win32' })).toBeUndefined();
    expect(validateCodexAppControlLocator(
      { ...locator, endpoint: '\\\\?\\pipe\\fixed' },
      'session-win',
      { platform: 'win32' },
    ))
      .toBeUndefined();
    expect(validateCodexAppControlLocator(
      { ...locator, epoch: 'short' },
      'session-win',
      { platform: 'win32' },
    )).toBeUndefined();
  });

  it('publishes only after listen succeeds and never publishes on bind failure', async () => {
    const order: string[] = [];
    const endpoint = generateCodexAppWindowsPipeEndpoint();
    const epoch = generateCodexAppControlEpoch();
    await bindThenPublishCodexAppControlLocator({
      sessionId: 'session-bind',
      epoch,
      endpoint,
      platform: 'win32',
      listen: async () => { order.push('listen'); },
      publish: () => { order.push('publish'); },
    });
    expect(order).toEqual(['listen', 'publish']);

    const publish = vi.fn();
    await expect(bindThenPublishCodexAppControlLocator({
      sessionId: 'session-bind',
      epoch: generateCodexAppControlEpoch(),
      endpoint: generateCodexAppWindowsPipeEndpoint(),
      platform: 'win32',
      listen: async () => { throw new Error('EADDRINUSE'); },
      publish,
    })).rejects.toThrow('EADDRINUSE');
    expect(publish).not.toHaveBeenCalled();
  });

  it('serializes owner publishers, bounds EADDRINUSE waiting, and fails other bind errors immediately', async () => {
    let nowMs = 0;
    let oldLeaseHeld = true;
    const bind = vi.fn(async () => {
      if (oldLeaseHeld) throw Object.assign(new Error('old worker owns lease'), { code: 'EADDRINUSE' });
      return 'new-lease';
    });
    await expect(acquireCodexAppControlOwnerLease({
      bind,
      timeoutMs: 1_000,
      retryDelayMs: 100,
      now: () => nowMs,
      wait: async delayMs => {
        nowMs += delayMs;
        if (nowMs >= 200) oldLeaseHeld = false;
      },
    })).resolves.toBe('new-lease');
    expect(bind).toHaveBeenCalledTimes(3);

    nowMs = 0;
    const alwaysBusy = vi.fn(async () => {
      throw Object.assign(new Error('still owned'), { code: 'EADDRINUSE' });
    });
    await expect(acquireCodexAppControlOwnerLease({
      bind: alwaysBusy,
      timeoutMs: 200,
      retryDelayMs: 100,
      now: () => nowMs,
      wait: async delayMs => { nowMs += delayMs; },
    })).rejects.toThrow('still owned');
    expect(nowMs).toBe(200);

    const denied = Object.assign(new Error('access denied'), { code: 'EACCES' });
    const failFast = vi.fn(async () => { throw denied; });
    await expect(acquireCodexAppControlOwnerLease({ bind: failFast })).rejects.toBe(denied);
    expect(failFast).toHaveBeenCalledTimes(1);
  });

  it('keeps B published when superseded A finishes binding late', async () => {
    let releaseListen!: () => void;
    const listen = new Promise<void>(resolve => { releaseListen = resolve; });
    let currentChannelId = 1;
    let stopping = false;
    const publishA = vi.fn();
    const retireA = vi.fn();
    const pendingA = bindThenPublishCodexAppControlLocator({
      sessionId: 'session-retired',
      epoch: generateCodexAppControlEpoch(),
      endpoint: generateCodexAppWindowsPipeEndpoint(),
      platform: 'win32',
      listen: () => listen,
      publish: publishA,
      isCurrent: () => !stopping && currentChannelId === 1,
      retire: retireA,
    });
    // Model stop(A), then bind+publish B, before A's delayed bind resolves.
    stopping = true;
    currentChannelId = 2;
    stopping = false;
    let published = '';
    await bindThenPublishCodexAppControlLocator({
      sessionId: 'session-retired',
      epoch: generateCodexAppControlEpoch(),
      endpoint: generateCodexAppWindowsPipeEndpoint(),
      platform: 'win32',
      listen: async () => {},
      publish: () => { published = 'B'; },
      isCurrent: () => !stopping && currentChannelId === 2,
    });
    releaseListen();
    await expect(pendingA).resolves.toBeUndefined();
    expect(published).toBe('B');
    expect(publishA).not.toHaveBeenCalled();
    expect(retireA).toHaveBeenCalledTimes(1);
    expect(shouldFailCodexAppControlChannel({
      channelId: 1,
      currentChannelId,
      stopping,
    })).toBe(false);

    const retireB = vi.fn();
    await expect(bindThenPublishCodexAppControlLocator({
      sessionId: 'session-retired',
      epoch: generateCodexAppControlEpoch(),
      endpoint: generateCodexAppWindowsPipeEndpoint(),
      platform: 'win32',
      listen: async () => {},
      publish: () => { throw new Error('B locator write failed'); },
      isCurrent: () => !stopping && currentChannelId === 2,
      retire: retireB,
    })).rejects.toThrow('B locator write failed');
    expect(retireB).toHaveBeenCalledTimes(1);
    expect(shouldFailCodexAppControlChannel({
      channelId: 2,
      currentChannelId,
      stopping,
    })).toBe(true);
  });

  it('retires a bound endpoint when locator publication fails', async () => {
    const retire = vi.fn();
    await expect(bindThenPublishCodexAppControlLocator({
      sessionId: 'session-publish-failure',
      epoch: generateCodexAppControlEpoch(),
      endpoint: generateCodexAppWindowsPipeEndpoint(),
      platform: 'win32',
      listen: async () => {},
      publish: () => { throw new Error('locator rename failed'); },
      retire,
    })).rejects.toThrow('locator rename failed');
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it('polls missing locators, retries unaccepted A, burns accepted A, then selects B', () => {
    const dir = shortPosixControlRoot();
    const sessionId = 'session-track';
    const locatorPath = codexAppControlLocatorPath(dir, sessionId);
    const socketDirectory = join(dir, 'sockets');
    mkdirSync(join(dir, 'locators'), { recursive: true, mode: 0o700 });
    mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
    const tracker = new CodexAppControlEndpointTracker();
    const first = {
      version: 1 as const,
      sessionId,
      epoch: generateCodexAppControlEpoch(),
      endpoint: generateCodexAppPosixSocketEndpoint(socketDirectory),
    };
    expect(takeCodexAppControlLocatorEndpoint({
      locatorPath,
      sessionId: first.sessionId,
      tracker,
      expectedControlRoot: dir,
    })).toBeUndefined();
    writeCodexAppControlLocator(locatorPath, first, process.platform, dir);
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(takeCodexAppControlLocatorEndpoint({
        locatorPath,
        sessionId: first.sessionId,
        tracker,
        expectedControlRoot: dir,
      })).toEqual({ endpoint: first.endpoint, epoch: first.epoch });
      expect(tracker.attemptCount(first.endpoint)).toBe(attempt);
    }
    tracker.noteAccepted(first.endpoint);
    expect(takeCodexAppControlLocatorEndpoint({
      locatorPath,
      sessionId: first.sessionId,
      tracker,
      expectedControlRoot: dir,
    })).toBeUndefined();
    expect(tracker.wasAttempted(first.endpoint)).toBe(true);
    expect(tracker.wasAccepted(first.endpoint)).toBe(true);
    const rotated = {
      ...first,
      epoch: generateCodexAppControlEpoch(),
      endpoint: generateCodexAppPosixSocketEndpoint(socketDirectory),
    };
    writeCodexAppControlLocator(locatorPath, rotated, process.platform, dir);
    expect(takeCodexAppControlLocatorEndpoint({
      locatorPath,
      sessionId: first.sessionId,
      tracker,
      expectedControlRoot: dir,
    })).toEqual({ endpoint: rotated.endpoint, epoch: rotated.epoch });
  });
});

describe('POSIX Codex App locator replacement', () => {
  it('pins non-Linux process-start probes to a stable locale and timezone', () => {
    expect(codexAppPosixProcessProbeEnv({
      PATH: '/trusted/bin',
      LC_ALL: 'zh_CN.UTF-8',
      LANG: 'zh_CN.UTF-8',
      TZ: 'Asia/Shanghai',
    })).toMatchObject({
      PATH: '/trusted/bin',
      LC_ALL: 'C',
      LANG: 'C',
      TZ: 'UTC',
    });
  });

  it('accepts only random endpoints inside the locator control root', () => {
    const root = shortPosixControlRoot();
    const sessionId = 'session-posix-locator';
    const locatorPath = codexAppControlLocatorPath(root, sessionId);
    const socketDirectory = join(root, 'sockets');
    mkdirSync(join(root, 'locators'), { recursive: true, mode: 0o700 });
    mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
    const locator = {
      version: 1 as const,
      sessionId,
      epoch: generateCodexAppControlEpoch(),
      endpoint: generateCodexAppPosixSocketEndpoint(socketDirectory),
    };

    expect(validateCodexAppControlLocator(locator, sessionId, {
      platform: 'linux',
      locatorPath,
      expectedControlRoot: root,
    })).toEqual(locator);
    expect(validateCodexAppControlLocator(
      { ...locator, endpoint: join(root, 'outside.sock') },
      sessionId,
      { platform: 'linux', locatorPath, expectedControlRoot: root },
    )).toBeUndefined();
    expect(validateCodexAppControlLocator(locator, sessionId, {
      platform: 'linux',
      locatorPath: join(root, 'locator.json'),
      expectedControlRoot: root,
    })).toBeUndefined();
    expect(validateCodexAppControlLocator(locator, sessionId, {
      platform: 'linux',
      locatorPath,
    })).toBeUndefined();
    expect(validateCodexAppControlLocator(locator, sessionId, {
      platform: 'linux',
      locatorPath,
      expectedControlRoot: join(root, 'attacker-selected'),
    })).toBeUndefined();
  });

  it('keeps B in the POSIX locator when superseded A finishes binding late', async () => {
    const root = shortPosixControlRoot();
    const sessionId = 'session-posix-delayed-publish';
    const locatorPath = codexAppControlLocatorPath(root, sessionId);
    const socketDirectory = join(root, 'sockets');
    mkdirSync(join(root, 'locators'), { recursive: true, mode: 0o700 });
    mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
    let channelId = 1;
    let releaseA!: () => void;
    const delayedListen = new Promise<void>(resolvePromise => { releaseA = resolvePromise; });
    const retireA = vi.fn();
    const endpointA = generateCodexAppPosixSocketEndpoint(socketDirectory);
    const pendingA = bindThenPublishCodexAppControlLocator({
      sessionId,
      epoch: generateCodexAppControlEpoch(),
      endpoint: endpointA,
      platform: process.platform,
      locatorPath,
      expectedControlRoot: root,
      listen: () => delayedListen,
      isCurrent: () => channelId === 1,
      publish: locator => writeCodexAppControlLocator(
        locatorPath,
        locator,
        process.platform,
        root,
      ),
      retire: retireA,
    });

    channelId = 2;
    const endpointB = generateCodexAppPosixSocketEndpoint(socketDirectory);
    await bindThenPublishCodexAppControlLocator({
      sessionId,
      epoch: generateCodexAppControlEpoch(),
      endpoint: endpointB,
      platform: process.platform,
      locatorPath,
      expectedControlRoot: root,
      listen: async () => undefined,
      isCurrent: () => channelId === 2,
      publish: locator => writeCodexAppControlLocator(
        locatorPath,
        locator,
        process.platform,
        root,
      ),
    });
    releaseA();
    await expect(pendingA).resolves.toBeUndefined();
    expect(retireA).toHaveBeenCalledTimes(1);
    expect(readCodexAppControlLocator(locatorPath, sessionId, process.platform, root)?.endpoint)
      .toBe(endpointB);
  });

  it('holds publisher ownership across overlap and fails closed on unknown owner liveness', async () => {
    const root = tempDir();
    const statuses = new Map<number, 'alive' | 'dead' | 'unknown'>([
      [101, 'alive'],
      [202, 'alive'],
    ]);
    const inspectOwner = (pid: number) => statuses.get(pid) ?? 'unknown';
    const first = await acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId: 'session-posix-owner',
      pid: 101,
      processStartToken: 'start-A',
      inspectOwner,
    });
    let nowMs = 0;
    let waits = 0;
    const second = await acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId: 'session-posix-owner',
      pid: 202,
      processStartToken: 'start-B',
      inspectOwner,
      timeoutMs: 1_000,
      retryDelayMs: 10,
      now: () => nowMs,
      wait: async delayMs => {
        nowMs += delayMs;
        waits++;
        if (waits === 2) first.release();
      },
    });
    expect(waits).toBeGreaterThanOrEqual(2);
    expect(first.isOwned()).toBe(false);
    expect(second.isOwned()).toBe(true);
    second.release();

    const unknown = await acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId: 'session-posix-unknown',
      pid: 101,
      processStartToken: 'start-A',
      inspectOwner,
    });
    await expect(acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId: 'session-posix-unknown',
      pid: 202,
      processStartToken: 'start-B',
      inspectOwner: () => 'unknown',
      timeoutMs: 20,
      retryDelayMs: 10,
      now: () => nowMs,
      wait: async delayMs => { nowMs += delayMs; },
    })).rejects.toThrow(/timed out/);
    expect(unknown.isOwned()).toBe(true);
    unknown.release();
  });

  it('does not reap a fresh empty initialization window before its grace expires', async () => {
    const root = tempDir();
    const sessionId = 'session-posix-initializing';
    const directory = codexAppPosixOwnerLeaseDirectory(root, sessionId);
    mkdirSync(join(root, 'leases'), { recursive: true, mode: 0o700 });
    mkdirSync(directory, { mode: 0o700 });
    let nowMs = statSync(directory).mtimeMs;
    let waits = 0;
    const lease = await acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId,
      pid: 304,
      processStartToken: 'start-after-empty',
      inspectOwner: () => 'alive',
      initializationGraceMs: 30,
      retryDelayMs: 10,
      timeoutMs: 100,
      now: () => nowMs,
      wait: async delayMs => { waits++; nowMs += delayMs; },
    });
    expect(waits).toBeGreaterThanOrEqual(3);
    expect(lease.isOwned()).toBe(true);
    lease.release();
  });

  it('does not let a v2 actor claim authority over a v3 generation directory', async () => {
    const root = tempDir();
    const sessionId = 'session-posix-v2-v3-boundary';
    const directory = codexAppPosixOwnerLeaseDirectory(root, sessionId);
    mkdirSync(join(root, 'leases'), { recursive: true, mode: 0o700 });
    mkdirSync(directory, { mode: 0o700 });
    const generation = '1'.repeat(64);
    writeFileSync(join(directory, `generation-${generation}.json`), generation, { mode: 0o600 });
    writePosixLeaseActorRecord({
      path: join(directory, `owner-${'2'.repeat(64)}.json`),
      sessionId,
      nonce: '2'.repeat(64),
      pid: 401,
      processStartToken: 'legacy-live',
      version: 2,
    });

    const lease = await acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId,
      pid: 402,
      processStartToken: 'v3-successor',
      inspectOwner: pid => pid === 401 ? 'alive' : 'unknown',
      initializationGraceMs: 0,
    });
    expect(lease.isOwned()).toBe(true);
    lease.release();
  });

  it('recovers multiple valid generation markers after the crash residue is actor-free', async () => {
    const root = tempDir();
    const sessionId = 'session-posix-multiple-generations';
    const directory = codexAppPosixOwnerLeaseDirectory(root, sessionId);
    mkdirSync(join(root, 'leases'), { recursive: true, mode: 0o700 });
    mkdirSync(directory, { mode: 0o700 });
    for (const generation of ['3'.repeat(64), '4'.repeat(64)]) {
      writeFileSync(join(directory, `generation-${generation}.json`), generation, { mode: 0o600 });
    }

    const lease = await acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId,
      pid: 403,
      processStartToken: 'multiple-generation-successor',
      inspectOwner: () => 'unknown',
      initializationGraceMs: 0,
    });
    expect(lease.isOwned()).toBe(true);
    lease.release();
  });

  it('keeps an ambiguous multi-generation directory fail-closed while an actor is live', async () => {
    const root = tempDir();
    const sessionId = 'session-posix-multiple-generations-live';
    const directory = codexAppPosixOwnerLeaseDirectory(root, sessionId);
    mkdirSync(join(root, 'leases'), { recursive: true, mode: 0o700 });
    mkdirSync(directory, { mode: 0o700 });
    for (const generation of ['5'.repeat(64), '6'.repeat(64)]) {
      writeFileSync(join(directory, `generation-${generation}.json`), generation, { mode: 0o600 });
    }
    writePosixLeaseActorRecord({
      path: join(directory, `owner-${'7'.repeat(64)}.json`),
      sessionId,
      nonce: '7'.repeat(64),
      pid: 404,
      processStartToken: 'ambiguous-live',
    });
    let nowMs = Date.now();
    await expect(acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId,
      pid: 405,
      processStartToken: 'blocked-successor',
      inspectOwner: pid => pid === 404 ? 'alive' : 'unknown',
      initializationGraceMs: 0,
      timeoutMs: 20,
      retryDelayMs: 10,
      now: () => nowMs,
      wait: async delayMs => { nowMs += delayMs; },
    })).rejects.toThrow(/timed out/);

    const lease = await acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId,
      pid: 405,
      processStartToken: 'recovered-successor',
      inspectOwner: pid => pid === 404 ? 'dead' : 'unknown',
      initializationGraceMs: 0,
    });
    expect(lease.isOwned()).toBe(true);
    lease.release();
  });

  it('recovers a dead reaper crash both before and after stale-owner retirement', async () => {
    const root = tempDir();
    const statuses = new Map<number, 'alive' | 'dead' | 'unknown'>([
      [311, 'alive'],
      [312, 'dead'],
      [313, 'alive'],
    ]);
    const inspectOwner = (pid: number) => statuses.get(pid) ?? 'unknown';

    const beforeSession = 'session-posix-reaper-before-retire';
    const stale = await acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId: beforeSession,
      pid: 311,
      processStartToken: 'owner-before',
      inspectOwner,
    });
    statuses.set(311, 'dead');
    const beforeReaperNonce = 'a'.repeat(64);
    writePosixLeaseActorRecord({
      path: join(stale.directory, `reap-${beforeReaperNonce}.json`),
      sessionId: beforeSession,
      nonce: beforeReaperNonce,
      pid: 312,
      processStartToken: 'reaper-before',
    });
    const recoveredBefore = await acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId: beforeSession,
      pid: 313,
      processStartToken: 'successor-before',
      inspectOwner,
    });
    expect(stale.isOwned()).toBe(false);
    expect(recoveredBefore.isOwned()).toBe(true);
    recoveredBefore.release();

    const afterSession = 'session-posix-reaper-after-retire';
    const afterDirectory = codexAppPosixOwnerLeaseDirectory(root, afterSession);
    mkdirSync(afterDirectory, { recursive: true, mode: 0o700 });
    chmodSync(afterDirectory, 0o700);
    const afterReaperNonce = 'b'.repeat(64);
    writePosixLeaseActorRecord({
      path: join(afterDirectory, `reap-${afterReaperNonce}.json`),
      sessionId: afterSession,
      nonce: afterReaperNonce,
      pid: 312,
      processStartToken: 'reaper-after',
    });
    const recoveredAfter = await acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId: afterSession,
      pid: 313,
      processStartToken: 'successor-after',
      inspectOwner,
      initializationGraceMs: 0,
    });
    expect(recoveredAfter.isOwned()).toBe(true);
    recoveredAfter.release();
  });

  it('keeps live and unknown reaper actors fail-closed', async () => {
    for (const [suffix, reaperStatus] of [
      ['live', 'alive'],
      ['unknown', 'unknown'],
    ] as const) {
      const root = tempDir();
      const sessionId = `session-posix-reaper-${suffix}`;
      const statuses = new Map<number, 'alive' | 'dead' | 'unknown'>([
        [321, 'dead'],
        [322, reaperStatus],
        [323, 'alive'],
      ]);
      const inspectOwner = (pid: number) => statuses.get(pid) ?? 'unknown';
      const stale = await acquireCodexAppPosixOwnerLease({
        controlRoot: root,
        sessionId,
        pid: 321,
        processStartToken: `owner-${suffix}`,
        inspectOwner,
      });
      const reaperNonce = suffix === 'live' ? 'c'.repeat(64) : 'd'.repeat(64);
      writePosixLeaseActorRecord({
        path: join(stale.directory, `reap-${reaperNonce}.json`),
        sessionId,
        nonce: reaperNonce,
        pid: 322,
        processStartToken: `reaper-${suffix}`,
      });
      let nowMs = Date.now();
      await expect(acquireCodexAppPosixOwnerLease({
        controlRoot: root,
        sessionId,
        pid: 323,
        processStartToken: `successor-${suffix}`,
        inspectOwner,
        timeoutMs: 30,
        retryDelayMs: 10,
        now: () => nowMs,
        wait: async delayMs => { nowMs += delayMs; },
      })).rejects.toThrow(/timed out/);
      expect(stale.isOwned()).toBe(false); // a reaper record suspends owner authority
      rmSync(stale.directory, { recursive: true, force: true });
    }
  });

  it('grace-recovers secure crash-partial owner and reaper records', async () => {
    for (const kind of ['owner', 'reap'] as const) {
      const root = tempDir();
      const sessionId = `session-posix-partial-${kind}`;
      const directory = codexAppPosixOwnerLeaseDirectory(root, sessionId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const nonce = (kind === 'owner' ? 'e' : 'f').repeat(64);
      const partialPath = join(directory, `${kind}-${nonce}.json`);
      writeFileSync(partialPath, '{"version":1', { mode: 0o600 });
      chmodSync(partialPath, 0o600);
      let nowMs = statSync(partialPath).mtimeMs;
      let waits = 0;
      const lease = await acquireCodexAppPosixOwnerLease({
        controlRoot: root,
        sessionId,
        pid: 333,
        processStartToken: `successor-partial-${kind}`,
        inspectOwner: () => 'alive',
        initializationGraceMs: 30,
        retryDelayMs: 10,
        timeoutMs: 200,
        now: () => nowMs,
        wait: async delayMs => { waits++; nowMs += delayMs; },
      });
      expect(waits).toBeGreaterThanOrEqual(3);
      expect(lease.isOwned()).toBe(true);
      lease.release();
    }
  });

  it('retries when graceful release wins exactly after mkdir reports EEXIST', async () => {
    const root = tempDir();
    const sessionId = 'session-posix-release-observation-gap';
    const first = await acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId,
      pid: 341,
      processStartToken: 'first-owner',
      inspectOwner: () => 'alive',
    });
    let contended = 0;
    const second = await acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId,
      pid: 342,
      processStartToken: 'second-owner',
      inspectOwner: () => 'alive',
      onContended: () => {
        contended++;
        first.release();
      },
    });
    expect(contended).toBeGreaterThanOrEqual(1);
    expect(first.isOwned()).toBe(false);
    expect(second.isOwned()).toBe(true);
    second.release();
  });

  it('never lets a delayed original creator publish into a successor directory inode', async () => {
    const root = tempDir();
    const sessionId = 'session-posix-delayed-original-writer';
    const successorNonce = '3'.repeat(64);
    let replaced = false;
    let nowMs = Date.now();
    await expect(acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId,
      pid: 346,
      processStartToken: 'delayed-original',
      inspectOwner: pid => pid === 347 ? 'alive' : 'dead',
      timeoutMs: 30,
      retryDelayMs: 10,
      now: () => nowMs,
      wait: async delayMs => { nowMs += delayMs; },
      onOwnerDirectoryCreated: directory => {
        if (replaced) return;
        replaced = true;
        rmSync(directory, { recursive: true, force: true });
        mkdirSync(directory, { mode: 0o700 });
        writePosixLeaseActorRecord({
          path: join(directory, `owner-${successorNonce}.json`),
          sessionId,
          nonce: successorNonce,
          pid: 347,
          processStartToken: 'successor-owner',
        });
      },
    })).rejects.toThrow(/timed out/);
    expect(replaced).toBe(true);
    const successorPath = join(
      codexAppPosixOwnerLeaseDirectory(root, sessionId),
      `owner-${successorNonce}.json`,
    );
    expect(existsSync(successorPath)).toBe(true);
  });

  it('retires a live foreign owner left in the publish-to-directory-CAS crash window', async () => {
    const root = tempDir();
    const sessionId = 'session-posix-foreign-owner-crash-window';
    const statuses = new Map<number, 'alive' | 'dead' | 'unknown'>([
      [361, 'alive'],
      [362, 'alive'],
      [363, 'alive'],
    ]);
    const inspectOwner = (pid: number) => statuses.get(pid) ?? 'unknown';
    let successor!: Awaited<ReturnType<typeof acquireCodexAppPosixOwnerLease>>;
    let replaced = false;
    let paused = false;
    let foreignOwnerPath = '';
    let signalPublished!: () => void;
    const published = new Promise<void>(resolvePromise => { signalPublished = resolvePromise; });
    let resumePublisher!: () => void;
    const publisherMayResume = new Promise<void>(resolvePromise => { resumePublisher = resolvePromise; });

    const delayed = acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId,
      pid: 361,
      processStartToken: 'delayed-owner',
      inspectOwner,
      timeoutMs: 1_000,
      retryDelayMs: 5,
      onOwnerDirectoryCreated: async directory => {
        if (replaced) return;
        replaced = true;
        rmSync(directory, { recursive: true, force: true });
        successor = await acquireCodexAppPosixOwnerLease({
          controlRoot: root,
          sessionId,
          pid: 362,
          processStartToken: 'successor-owner',
          inspectOwner,
        });
      },
      onOwnerRecordPublished: async (_directory, ownerRecordPath) => {
        if (paused) return;
        paused = true;
        foreignOwnerPath = ownerRecordPath;
        signalPublished();
        await publisherMayResume;
      },
    });

    await published;
    expect(existsSync(foreignOwnerPath)).toBe(true);
    expect(successor.isOwned()).toBe(true);
    await expect(acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId,
      pid: 363,
      processStartToken: 'observing-contender',
      inspectOwner,
      timeoutMs: 30,
      retryDelayMs: 5,
    })).rejects.toThrow(/timed out/);
    // The delayed actor is still live, but its D1-bound record has no authority
    // in D2 and cannot permanently create a multiple-owner poison pill.
    expect(existsSync(foreignOwnerPath)).toBe(false);
    expect(successor.isOwned()).toBe(true);

    successor.release();
    resumePublisher();
    const recovered = await delayed;
    expect(recovered.isOwned()).toBe(true);
    recovered.release();
  });

  it('reconciles a dead same-directory losing owner without disturbing the live winner', async () => {
    const root = tempDir();
    const sessionId = 'session-posix-same-directory-owner-crash';
    const statuses = new Map<number, 'alive' | 'dead' | 'unknown'>([
      [365, 'alive'],
      [366, 'dead'],
      [367, 'alive'],
    ]);
    const inspectOwner = (pid: number) => statuses.get(pid) ?? 'unknown';
    const winner = await acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId,
      pid: 365,
      processStartToken: 'same-dir-winner',
      inspectOwner,
    });
    const losingNonce = '4'.repeat(64);
    const losingPath = join(winner.directory, `owner-${losingNonce}.json`);
    writePosixLeaseActorRecord({
      path: losingPath,
      sessionId,
      nonce: losingNonce,
      pid: 366,
      processStartToken: 'same-dir-dead-loser',
    });
    expect(winner.isOwned()).toBe(true);

    await expect(acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId,
      pid: 367,
      processStartToken: 'same-dir-observer',
      inspectOwner,
      timeoutMs: 30,
      retryDelayMs: 5,
    })).rejects.toThrow(/timed out/);
    expect(existsSync(losingPath)).toBe(false);
    expect(winner.isOwned()).toBe(true);

    winner.release();
    const successor = await acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId,
      pid: 367,
      processStartToken: 'same-dir-observer',
      inspectOwner,
    });
    expect(successor.isOwned()).toBe(true);
    successor.release();
  });

  it('ignores and retires a live stale reaper published into a replacement directory', async () => {
    const root = tempDir();
    const sessionId = 'session-posix-foreign-reaper-crash-window';
    const statuses = new Map<number, 'alive' | 'dead' | 'unknown'>([
      [371, 'alive'],
      [372, 'alive'],
      [373, 'alive'],
      [374, 'alive'],
    ]);
    const inspectOwner = (pid: number) => statuses.get(pid) ?? 'unknown';
    const stale = await acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId,
      pid: 371,
      processStartToken: 'stale-owner',
      inspectOwner,
    });
    statuses.set(371, 'dead');

    let successor!: Awaited<ReturnType<typeof acquireCodexAppPosixOwnerLease>>;
    let replaced = false;
    let paused = false;
    let foreignReaperPath = '';
    let signalPublished!: () => void;
    const published = new Promise<void>(resolvePromise => { signalPublished = resolvePromise; });
    let resumePublisher!: () => void;
    const publisherMayResume = new Promise<void>(resolvePromise => { resumePublisher = resolvePromise; });
    const delayedCleaner = acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId,
      pid: 372,
      processStartToken: 'delayed-reaper',
      inspectOwner,
      timeoutMs: 1_000,
      retryDelayMs: 5,
      onBeforeReaperRecordPublished: async directory => {
        if (replaced) return;
        replaced = true;
        rmSync(directory, { recursive: true, force: true });
        successor = await acquireCodexAppPosixOwnerLease({
          controlRoot: root,
          sessionId,
          pid: 373,
          processStartToken: 'replacement-owner',
          inspectOwner,
        });
      },
      onReaperRecordPublished: async (_directory, reaperRecordPath) => {
        if (paused) return;
        paused = true;
        foreignReaperPath = reaperRecordPath;
        signalPublished();
        await publisherMayResume;
      },
    });

    await published;
    expect(existsSync(foreignReaperPath)).toBe(true);
    // A foreign live reaper must not revoke the real D2 owner while its delayed
    // publisher is paused at the exact post-publication crash boundary.
    expect(successor.isOwned()).toBe(true);
    await expect(acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId,
      pid: 374,
      processStartToken: 'replacement-observer',
      inspectOwner,
      timeoutMs: 30,
      retryDelayMs: 5,
    })).rejects.toThrow(/timed out/);
    expect(existsSync(foreignReaperPath)).toBe(false);
    expect(successor.isOwned()).toBe(true);

    successor.release();
    resumePublisher();
    const recovered = await delayedCleaner;
    expect(recovered.isOwned()).toBe(true);
    recovered.release();
    stale.release();
  });

  it('hard-fails wrong record mode instead of grace-reclassifying it as partial', async () => {
    const root = tempDir();
    const sessionId = 'session-posix-insecure-partial';
    const directory = codexAppPosixOwnerLeaseDirectory(root, sessionId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const nonce = '1'.repeat(64);
    writeFileSync(join(directory, `owner-${nonce}.json`), '{', { mode: 0o644 });
    chmodSync(join(directory, `owner-${nonce}.json`), 0o644);
    await expect(acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId,
      pid: 351,
      processStartToken: 'insecure-successor',
      inspectOwner: () => 'dead',
      initializationGraceMs: 0,
    })).rejects.toThrow(/0600/);
  });

  it('reclaims SIGKILL residue with multiple contenders but never grants two owners', async () => {
    const root = tempDir();
    const statuses = new Map<number, 'alive' | 'dead' | 'unknown'>([
      [301, 'alive'],
      [302, 'alive'],
      [303, 'alive'],
      [304, 'dead'],
    ]);
    const inspectOwner = (pid: number) => statuses.get(pid) ?? 'unknown';
    const stale = await acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId: 'session-posix-race',
      pid: 301,
      processStartToken: 'start-stale',
      inspectOwner,
    });
    statuses.set(301, 'dead'); // model SIGKILL: no graceful release
    const crashedReaperNonce = '2'.repeat(64);
    writePosixLeaseActorRecord({
      path: join(stale.directory, `reap-${crashedReaperNonce}.json`),
      sessionId: 'session-posix-race',
      nonce: crashedReaperNonce,
      pid: 304,
      processStartToken: 'start-dead-reaper',
    });

    let secondResolved = false;
    const contender = (pid: number, token: string) => acquireCodexAppPosixOwnerLease({
      controlRoot: root,
      sessionId: 'session-posix-race',
      pid,
      processStartToken: token,
      inspectOwner,
      timeoutMs: 2_000,
      retryDelayMs: 2,
    });
    const bPromise = contender(302, 'start-B');
    const cPromise = contender(303, 'start-C').then(lease => {
      secondResolved = true;
      return lease;
    });
    const firstWinner = await Promise.race([
      bPromise.then(lease => ({ name: 'B' as const, lease })),
      cPromise.then(lease => ({ name: 'C' as const, lease })),
    ]);
    expect(stale.isOwned()).toBe(false);
    expect(firstWinner.lease.isOwned()).toBe(true);
    if (firstWinner.name === 'B') expect(secondResolved).toBe(false);
    firstWinner.lease.release();
    const secondWinner = firstWinner.name === 'B' ? await cPromise : await bPromise;
    expect(secondWinner.isOwned()).toBe(true);
    expect(firstWinner.lease.isOwned()).toBe(false);
    secondWinner.release();
  });

  it('keeps random endpoint B reachable after old endpoint A closes late', async () => {
    const root = shortPosixControlRoot();
    const sessionId = 'session-posix-close';
    const socketDirectory = join(root, 'sockets');
    const locatorPath = codexAppControlLocatorPath(root, sessionId);
    mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, 'locators'), { recursive: true, mode: 0o700 });
    const endpointA = generateCodexAppPosixSocketEndpoint(socketDirectory);
    const endpointB = generateCodexAppPosixSocketEndpoint(socketDirectory);
    const serverA = createServer(socket => socket.end());
    const serverB = createServer(socket => socket.end('B'));
    const listen = (server: Server, endpoint: string) => new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(endpoint, () => {
        server.off('error', rejectPromise);
        resolvePromise();
      });
    });
    await listen(serverA, endpointA);
    await listen(serverB, endpointB);
    const locator = {
      version: 1 as const,
      sessionId,
      epoch: generateCodexAppControlEpoch(),
      endpoint: endpointB,
    };
    writeCodexAppControlLocator(locatorPath, locator, process.platform, root);

    await new Promise<void>(resolvePromise => serverA.close(() => resolvePromise()));
    expect(readCodexAppControlLocator(
      locatorPath,
      sessionId,
      process.platform,
      root,
    )?.endpoint).toBe(endpointB);
    expect(existsSync(endpointB)).toBe(true);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const socket = createConnection(endpointB);
      socket.once('data', data => {
        expect(data.toString('utf8')).toBe('B');
        socket.destroy();
        resolvePromise();
      });
      socket.once('error', rejectPromise);
    });
    await new Promise<void>(resolvePromise => serverB.close(() => resolvePromise()));
  });
});

describe('Codex App signed challenge protocol', () => {
  it('enforces challenge → matching locator epoch → ACK ordering and rejects repeats', () => {
    const generation = generateCodexAppControlEpoch();
    const epoch = generateCodexAppControlEpoch();
    const challenge = generateCodexAppControlChallenge();
    const parse = (line: string) => parseCodexAppControlWireRecord(line);
    const handshake = new CodexAppControlRunnerHandshake('session-handshake', generation, epoch);

    expect(handshake.handle(parse(encodeCodexAppControlChallenge(
      'session-handshake', challenge,
    )), 0)).toEqual({ type: 'authenticate', challenge });
    expect(handshake.handle(parse(encodeCodexAppControlChallenge(
      'session-handshake', generateCodexAppControlChallenge(),
    )), 0)).toEqual({ type: 'reject' });

    const wrongEpoch = new CodexAppControlRunnerHandshake('session-handshake', generation, epoch);
    expect(wrongEpoch.handle(parse(encodeCodexAppControlChallenge(
      'session-handshake', challenge,
    )), 0).type).toBe('authenticate');
    expect(wrongEpoch.handle(parse(encodeCodexAppControlAccepted(
      'session-handshake', generation, challenge, generateCodexAppControlEpoch(),
    )), 0)).toEqual({ type: 'reject' });

    expect(handshake.handle(parse(encodeCodexAppControlAccepted(
      'session-handshake', generation, challenge, epoch,
    )), 0)).toEqual({ type: 'accepted', challenge });
    expect(handshake.active).toBe(true);
    expect(handshake.handle(parse(encodeCodexAppControlAck(
      'session-handshake', generation, challenge, 2,
    )), 1)).toEqual({ type: 'reject' });
    expect(handshake.handle(parse(encodeCodexAppControlAck(
      'session-handshake', generation, challenge, 1,
    )), 1)).toEqual({ type: 'ack', seq: 1 });
  });

  it('uses an absolute handshake deadline that slow transport activity cannot extend', async () => {
    vi.useFakeTimers();
    const timedOut = vi.fn();
    const timer = armCodexAppControlHandshakeTimeout(timedOut, 100);
    try {
      await vi.advanceTimersByTimeAsync(40);
      // Model two partial/slow-drip transport reads. There is deliberately no
      // activity/reset API: only a matching accepted record clears the timer.
      await vi.advanceTimersByTimeAsync(40);
      expect(timedOut).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20);
      expect(timedOut).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeout(timer);
      vi.useRealTimers();
    }
  });

  it('re-arms the shared 90-second proof deadline after an authenticated disconnect', async () => {
    vi.useFakeTimers();
    const deadline = new CodexAppControlProofDeadline();
    const startupTimeout = vi.fn();
    const disconnectTimeout = vi.fn();
    try {
      deadline.arm(startupTimeout);
      expect(deadline.armed).toBe(true);
      // Successful startup authentication clears the first deadline.
      deadline.clear();
      await vi.advanceTimersByTimeAsync(CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS);
      expect(startupTimeout).not.toHaveBeenCalled();

      // Losing that authenticated socket starts a fresh proof deadline.
      deadline.arm(disconnectTimeout);
      await vi.advanceTimersByTimeAsync(CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS - 1);
      expect(disconnectTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(disconnectTimeout).toHaveBeenCalledTimes(1);
      expect(deadline.armed).toBe(false);
    } finally {
      deadline.clear();
      vi.useRealTimers();
    }
  });

  it('authenticates possession and signs every marker without putting a reusable secret on the wire', () => {
    const dir = tempDir();
    const bootstrap = createCodexAppControlBootstrap(dir, 'session-signed');
    const consumed = consumeCodexAppControlBootstrap(bootstrap.path, 'session-signed');
    const challenge = generateCodexAppControlChallenge();

    const authLine = encodeCodexAppControlAuth(
      consumed.privateKey,
      'session-signed',
      consumed.generation,
      challenge,
    );
    const auth = parseCodexAppControlWireRecord(authLine);
    expect(auth?.type).toBe('auth');
    expect(authLine).not.toContain('privateKey');
    expect(auth && auth.type === 'auth'
      ? verifyCodexAppControlAuth(auth, bootstrap.identity.publicKey)
      : false).toBe(true);

    const markerLine = encodeCodexAppSignedControlMarker(
      consumed.privateKey,
      'session-signed',
      consumed.generation,
      challenge,
      1,
      'activity',
      { phase: 'progress', atMs: 123 },
    );
    const marker = parseCodexAppControlWireRecord(markerLine);
    expect(marker?.type).toBe('marker');
    expect(marker && marker.type === 'marker'
      ? verifyCodexAppSignedControlMarker(marker, bootstrap.identity.publicKey)
      : false).toBe(true);
  });

  it('rejects replay across connection challenges and mutation of every signed domain field', () => {
    const dir = tempDir();
    const bootstrap = createCodexAppControlBootstrap(dir, 'session-replay');
    const consumed = consumeCodexAppControlBootstrap(bootstrap.path, 'session-replay');
    const challenge = generateCodexAppControlChallenge();
    const otherChallenge = generateCodexAppControlChallenge();
    const auth = parseCodexAppControlWireRecord(encodeCodexAppControlAuth(
      consumed.privateKey, 'session-replay', consumed.generation, challenge,
    ));
    expect(auth?.type).toBe('auth');
    if (!auth || auth.type !== 'auth') throw new Error('auth parse failed');
    expect(verifyCodexAppControlAuth({ ...auth, challenge: otherChallenge }, bootstrap.identity.publicKey)).toBe(false);
    expect(verifyCodexAppControlAuth({ ...auth, sessionId: 'other-session' }, bootstrap.identity.publicKey)).toBe(false);

    const marker = parseCodexAppControlWireRecord(encodeCodexAppSignedControlMarker(
      consumed.privateKey,
      'session-replay',
      consumed.generation,
      challenge,
      7,
      'final',
      { content: 'real' },
    ));
    expect(marker?.type).toBe('marker');
    if (!marker || marker.type !== 'marker') throw new Error('marker parse failed');
    for (const mutated of [
      { ...marker, sessionId: 'other' },
      { ...marker, generation: 'A'.repeat(43) },
      { ...marker, challenge: otherChallenge },
      { ...marker, seq: 8 },
      { ...marker, kind: 'activity' },
      { ...marker, payload: { content: 'forged' } },
    ]) {
      expect(verifyCodexAppSignedControlMarker(mutated, bootstrap.identity.publicKey)).toBe(false);
    }
  });

  it('deduplicates a re-signed sequence retry across socket reconnects', () => {
    const replay = new CodexAppControlReplayWindow();
    const firstGeneration = 'A'.repeat(43);
    const nextGeneration = 'B'.repeat(43);
    expect(replay.hasSeen(firstGeneration, 1)).toBe(false);
    replay.commit(firstGeneration, 1);
    expect(replay.hasSeen(firstGeneration, 1)).toBe(true);
    expect(replay.hasSeen(firstGeneration, 0)).toBe(true);
    expect(replay.hasSeen(firstGeneration, 2)).toBe(false);
    replay.commit(firstGeneration, 3);
    expect(replay.hasSeen(firstGeneration, 2)).toBe(true);

    replay.commit(nextGeneration, 7);
    replay.retainOnly(firstGeneration);
    expect(replay.highWater(firstGeneration)).toBe(3);
    expect(replay.highWater(nextGeneration)).toBe(0);
  });

  it('bounds socket line buffering and resynchronizes after oversized input', () => {
    const decoder = new CodexAppControlLineDecoder();
    expect(decoder.push(Buffer.from('one\npar')).lines).toEqual(['one']);
    expect(decoder.push(Buffer.from('tial\n')).lines).toEqual(['partial']);
    expect(decoder.push(Buffer.alloc(CODEX_APP_CONTROL_LINE_MAX_BYTES + 1, 0x78)).droppedMalformed).toBe(true);
    const recovered = decoder.push(Buffer.from('\nvalid\n'));
    expect(recovered).toEqual({ lines: ['valid'], droppedMalformed: true });
  });
});
