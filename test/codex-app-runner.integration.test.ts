import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tsRunnerPrefix } from './helpers/ts-runner.js';
import { encodeRunnerInput } from '../src/adapters/cli/runner-input.js';
import { CODEX_APP_ACTIVE_WRITER_EXIT_CODE } from '../src/services/codex-app-runner-protocol.js';
import {
  CodexAppControlFinalAssembler,
  CodexAppControlLineDecoder,
  CodexAppControlSequenceFence,
  codexAppControlLocatorPath,
  codexAppPosixControlRoot,
  codexAppControlSocketPath,
  createCodexAppControlBootstrap,
  encodeCodexAppControlAck,
  encodeCodexAppControlAccepted,
  encodeCodexAppControlChallenge,
  ensureCodexAppControlDirectory,
  generateCodexAppControlChallenge,
  generateCodexAppControlEpoch,
  generateCodexAppPosixSocketEndpoint,
  parseCodexAppControlWireRecord,
  verifyCodexAppControlAuth,
  verifyCodexAppSignedControlMarker,
  writeCodexAppControlLocator,
  type CodexAppControlLocator,
  type CodexAppSignedControlMarker,
} from '../src/utils/codex-app-control.js';
import type { CodexAppTurnInput } from '../src/types.js';

const RUNNER_PATH = resolve('src/codex-app-runner.ts');
const FAKE_SERVER_FIXTURE = resolve('test/fixtures/fake-codex-app-server.mjs');
const CONTROL_PREFIX = '::botmux-codex-app:';
const SESSION_ID = 'session-integration';

interface Harness {
  child: ChildProcessWithoutNullStreams;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunResult {
  output: string;
  requests: Array<Record<string, any>>;
  imagePath: string;
  missingImagePath: string;
  final: Record<string, any>;
  finals: Array<Record<string, any>>;
  activities: Array<Record<string, any>>;
  states: Array<Record<string, any>>;
  markers: Array<{ kind: string; payload: Record<string, any> }>;
  wireLines: string[];
  privateKeyEncoding: string;
}

const liveChildren = new Set<ChildProcessWithoutNullStreams>();
const liveCollectors = new Set<ControlCollector>();
const liveLocatorCollectors = new Set<LocatorControlCollector>();

class ControlCollector {
  readonly bootstrap;
  readonly socketPath: string;
  readonly privateKeyEncoding: string;
  readonly activities: Array<Record<string, any>> = [];
  readonly states: Array<Record<string, any>> = [];
  readonly finals: Array<Record<string, any>> = [];
  readonly markers: Array<{ kind: string; payload: Record<string, any> }> = [];
  readonly wireLines: string[] = [];
  authCount = 0;
  readonly authObserved: Promise<void>;
  private resolveAuthObserved!: () => void;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private pendingAcceptance?: { socket: Socket; challenge: string };
  private lastSeq = 0;
  private disconnectedFinalChunk = false;
  private omittedFinalChunk = false;
  private disconnectedFinalEndAck = false;
  private readonly socketDirectory: string;

  constructor(
    readonly directory: string,
    private readonly manualAcceptance = false,
    private readonly disconnectOnFirstFinalChunk = false,
    private readonly omitFirstFinalChunk = false,
    private readonly disconnectAfterFirstFinalEndBeforeAck = false,
  ) {
    this.socketDirectory = mkdtempSync('/tmp/bca-sock-');
    this.socketPath = codexAppControlSocketPath(this.socketDirectory, SESSION_ID);
    this.bootstrap = createCodexAppControlBootstrap(directory, SESSION_ID, this.socketPath);
    this.privateKeyEncoding = JSON.parse(readFileSync(this.bootstrap.path, 'utf8')).privateKey;
    this.authObserved = new Promise(resolvePromise => { this.resolveAuthObserved = resolvePromise; });
    this.server = createServer(socket => this.accept(socket));
    liveCollectors.add(this);
  }

  listen(): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      this.server.once('error', rejectPromise);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', rejectPromise);
        resolvePromise();
      });
    });
  }

  releaseAcceptance(): void {
    const pending = this.pendingAcceptance;
    if (!pending) throw new Error('no authenticated runner is awaiting acceptance');
    this.pendingAcceptance = undefined;
    pending.socket.write(`${encodeCodexAppControlAccepted(
      SESSION_ID,
      this.bootstrap.identity.generation,
      pending.challenge,
    )}\n`);
  }

  async restartEndpoint(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.server.listening) {
      await new Promise<void>(resolvePromise => this.server.close(() => resolvePromise()));
    }
    await this.listen();
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.server.listening) {
      await new Promise<void>(resolvePromise => this.server.close(() => resolvePromise()));
    }
    liveCollectors.delete(this);
    rmSync(this.socketDirectory, { recursive: true, force: true });
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    const decoder = new CodexAppControlLineDecoder();
    const sequenceFence = new CodexAppControlSequenceFence();
    const finalAssembler = new CodexAppControlFinalAssembler();
    const challenge = generateCodexAppControlChallenge();
    let authenticated = false;
    socket.on('data', chunk => {
      const decoded = decoder.push(chunk);
      if (decoded.droppedMalformed) socket.destroy();
      for (const line of decoded.lines) {
        this.wireLines.push(line);
        const record = parseCodexAppControlWireRecord(line);
        if (!record || record.sessionId !== SESSION_ID) {
          socket.destroy();
          continue;
        }
        if (!authenticated) {
          if (record.type !== 'auth'
              || record.challenge !== challenge
              || record.generation !== this.bootstrap.identity.generation
              || !verifyCodexAppControlAuth(record, this.bootstrap.identity.publicKey)) {
            socket.destroy();
            continue;
          }
          authenticated = true;
          this.authCount++;
          this.resolveAuthObserved();
          if (this.manualAcceptance) this.pendingAcceptance = { socket, challenge };
          else {
            socket.write(`${encodeCodexAppControlAccepted(
              SESSION_ID,
              this.bootstrap.identity.generation,
              challenge,
            )}\n`);
          }
          continue;
        }
        if (record.type !== 'marker'
            || record.challenge !== challenge
            || record.generation !== this.bootstrap.identity.generation
            || !sequenceFence.accept(record.seq)
            || !verifyCodexAppSignedControlMarker(record, this.bootstrap.identity.publicKey)) {
          socket.destroy();
          continue;
        }
        // The worker checks connection continuity before its cumulative replay
        // window. A reconnect may therefore replay an already-committed final
        // transaction contiguously: ACK every duplicate without reassembling
        // or publishing its final side effect again.
        if (record.seq <= this.lastSeq) {
          socket.write(`${encodeCodexAppControlAck(
            SESSION_ID,
            this.bootstrap.identity.generation,
            challenge,
            record.seq,
          )}\n`);
          continue;
        }
        this.markers.push({ kind: record.kind, payload: record.payload });
        if (record.kind === 'final-chunk'
            && this.disconnectOnFirstFinalChunk
            && !this.disconnectedFinalChunk) {
          this.disconnectedFinalChunk = true;
          // Model a replacement worker: the per-connection assembly and
          // in-memory cumulative sequence window both disappear.
          this.lastSeq = 0;
          socket.destroy();
          return;
        }
        if (record.kind === 'final-chunk'
            && this.omitFirstFinalChunk
            && !this.omittedFinalChunk) {
          // Simulate a missing fragment inside this connection. final-end must
          // be rejected without an ACK, forcing a complete replay.
          this.omittedFinalChunk = true;
          continue;
        }
        const finalResult = finalAssembler.accept(record.kind, record.payload);
        if (finalResult.status === 'reject') {
          socket.destroy();
          return;
        }
        if (finalResult.status === 'not-final') this.collectNonFinalMarker(record);
        else if (finalResult.status === 'complete') this.finals.push(finalResult.payload);
        if (finalResult.status === 'accepted') continue;
        this.lastSeq = record.seq;
        if (record.kind === 'final-end'
            && this.disconnectAfterFirstFinalEndBeforeAck
            && !this.disconnectedFinalEndAck) {
          this.disconnectedFinalEndAck = true;
          socket.destroy();
          return;
        }
        socket.write(`${encodeCodexAppControlAck(
          SESSION_ID,
          this.bootstrap.identity.generation,
          challenge,
          record.seq,
        )}\n`);
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => this.sockets.delete(socket));
    socket.write(`${encodeCodexAppControlChallenge(SESSION_ID, challenge)}\n`);
  }

  private collectNonFinalMarker(marker: CodexAppSignedControlMarker): void {
    if (marker.kind === 'state') {
      this.states.push(marker.payload);
      return;
    }
    if (marker.kind === 'activity') {
      this.activities.push(marker.payload);
    }
  }
}

type LocatorEndpointMode = 'accept' | 'wrong-epoch' | 'repeat-challenge' | 'slow-drip';

interface LocatorEndpointHandle {
  locator: CodexAppControlLocator;
  readonly connections: number;
  readonly closedConnections: number;
  readonly authCount: number;
  authObserved: Promise<void>;
  closeObserved: Promise<void>;
  close(): Promise<void>;
}

/**
 * Runs the real runner locator loop on POSIX with the same strict random
 * AF_UNIX endpoint + protected locator shape used by the worker.
 */
class LocatorControlCollector {
  readonly locatorPath: string;
  readonly bootstrap;
  private readonly endpoints = new Set<LocatorEndpointHandle>();
  private readonly socketDirectory: string;

  constructor(readonly directory: string) {
    const controlRoot = codexAppPosixControlRoot();
    this.locatorPath = codexAppControlLocatorPath(controlRoot, SESSION_ID);
    this.socketDirectory = join(controlRoot, 'sockets');
    ensureCodexAppControlDirectory(controlRoot);
    ensureCodexAppControlDirectory(join(controlRoot, 'locators'));
    ensureCodexAppControlDirectory(this.socketDirectory);
    this.bootstrap = createCodexAppControlBootstrap(directory, SESSION_ID, {
      kind: 'locator',
      locatorPath: this.locatorPath,
    });
    liveLocatorCollectors.add(this);
  }

  async publish(mode: LocatorEndpointMode): Promise<LocatorEndpointHandle> {
    const endpoint = generateCodexAppPosixSocketEndpoint(this.socketDirectory);
    const epoch = generateCodexAppControlEpoch();
    const locator: CodexAppControlLocator = {
      version: 1,
      sessionId: SESSION_ID,
      endpoint,
      epoch,
    };
    const server = createServer();
    const sockets = new Set<Socket>();
    let connectionCount = 0;
    let closedConnectionCount = 0;
    let authCount = 0;
    let resolveAuth!: () => void;
    let resolveClose!: () => void;
    const authObserved = new Promise<void>(resolvePromise => { resolveAuth = resolvePromise; });
    const closeObserved = new Promise<void>(resolvePromise => { resolveClose = resolvePromise; });
    server.on('connection', socket => {
      sockets.add(socket);
      connectionCount++;
      const decoder = new CodexAppControlLineDecoder();
      const challenge = generateCodexAppControlChallenge();
      let accepted = false;
      let lastSeq = 0;
      let dripTimer: ReturnType<typeof setInterval> | undefined;
      socket.on('data', chunk => {
        const decoded = decoder.push(chunk);
        if (decoded.droppedMalformed) socket.destroy();
        for (const line of decoded.lines) {
          const record = parseCodexAppControlWireRecord(line);
          if (!record || record.sessionId !== SESSION_ID) {
            socket.destroy();
            continue;
          }
          if (!accepted) {
            if (record.type !== 'auth'
                || record.generation !== this.bootstrap.identity.generation
                || record.challenge !== challenge
                || !verifyCodexAppControlAuth(record, this.bootstrap.identity.publicKey)) {
              socket.destroy();
              continue;
            }
            authCount++;
            resolveAuth();
            if (mode === 'repeat-challenge') continue;
            accepted = true;
            socket.write(`${encodeCodexAppControlAccepted(
              SESSION_ID,
              this.bootstrap.identity.generation,
              challenge,
              mode === 'wrong-epoch' ? generateCodexAppControlEpoch() : epoch,
            )}\n`);
            continue;
          }
          if (record.type !== 'marker'
              || record.generation !== this.bootstrap.identity.generation
              || record.challenge !== challenge
              || record.seq <= lastSeq
              || !verifyCodexAppSignedControlMarker(record, this.bootstrap.identity.publicKey)) {
            socket.destroy();
            continue;
          }
          lastSeq = record.seq;
          socket.write(`${encodeCodexAppControlAck(
            SESSION_ID,
            this.bootstrap.identity.generation,
            challenge,
            record.seq,
          )}\n`);
        }
      });
      socket.on('error', () => undefined);
      socket.on('close', () => {
        if (dripTimer) clearInterval(dripTimer);
        sockets.delete(socket);
        closedConnectionCount++;
        resolveClose();
      });
      if (mode === 'slow-drip') {
        const line = `${encodeCodexAppControlChallenge(SESSION_ID, challenge)}\n`;
        let offset = 0;
        socket.write(line[offset++]!);
        dripTimer = setInterval(() => {
          if (socket.destroyed || offset >= line.length) {
            if (dripTimer) clearInterval(dripTimer);
            dripTimer = undefined;
            return;
          }
          socket.write(line[offset++]!);
        }, 200);
      } else {
        socket.write(`${encodeCodexAppControlChallenge(SESSION_ID, challenge)}\n`);
      }
      if (mode === 'repeat-challenge') {
        socket.write(`${encodeCodexAppControlChallenge(
          SESSION_ID,
          generateCodexAppControlChallenge(),
        )}\n`);
      }
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(endpoint, () => {
        server.off('error', rejectPromise);
        resolvePromise();
      });
    });
    writeCodexAppControlLocator(this.locatorPath, locator);
    let closed = false;
    const handle: LocatorEndpointHandle = {
      locator,
      get connections() { return connectionCount; },
      get closedConnections() { return closedConnectionCount; },
      get authCount() { return authCount; },
      authObserved,
      closeObserved,
      close: async () => {
        if (closed) return;
        closed = true;
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        if (server.listening) {
          await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
        }
        try { unlinkSync(endpoint); } catch { /* libuv may already remove it */ }
        this.endpoints.delete(handle);
      },
    };
    this.endpoints.add(handle);
    return handle;
  }

  async close(): Promise<void> {
    await Promise.all([...this.endpoints].map(endpoint => endpoint.close()));
    try { unlinkSync(this.locatorPath); } catch { /* absent or already replaced */ }
    liveLocatorCollectors.delete(this);
  }
}

function startRunner(
  fakeCodex: string,
  cwd: string,
  logPath: string,
  version: string,
  behavior: string,
  controlBootstrapOrArgs: string | null | string[] = [],
  options: { threadId?: string; env?: Record<string, string>; extraArgs?: string[] } = {},
): Harness {
  // Arg 6 is overloaded to satisfy both merged calling conventions:
  //  - PR #597 (signed control channel): a bootstrap path string, or null to spawn with NO control channel
  //  - master (OSC-777 markers): an extraArgs string[] appended to the runner argv
  // master-authored feature tests (model/effort) additionally need a bootstrap
  // AND extra argv, so options.extraArgs supplies argv when arg 6 is a path.
  const controlBootstrapPath = Array.isArray(controlBootstrapOrArgs) ? null : controlBootstrapOrArgs;
  const extraArgs = [
    ...(Array.isArray(controlBootstrapOrArgs) ? controlBootstrapOrArgs : []),
    ...(options.extraArgs ?? []),
  ];
  let stdout = '';
  let stderr = '';
  const env = {
    ...process.env,
    FAKE_CODEX_LOG: logPath,
    FAKE_CODEX_VERSION: version,
    FAKE_CODEX_BEHAVIOR: behavior,
    NODE_ENV: 'test',
    ...options.env,
  };
  delete env.BOTMUX_CODEX_APP_CONTROL_NONCE;
  delete env.BOTMUX_CODEX_APP_CONTROL_BOOTSTRAP;
  if (controlBootstrapPath !== null) env.BOTMUX_CODEX_APP_CONTROL_BOOTSTRAP = controlBootstrapPath;
  // argv is assembled as a variable here, so take the loader prefix rather than
  // the spawnTsScript wrapper: Node needs `--import tsx`, Bun needs nothing.
  const { command: runnerCommand, prefixArgs } = tsRunnerPrefix();
  const runnerArgs = [
    ...prefixArgs, RUNNER_PATH,
    '--session-id', SESSION_ID,
    '--codex-bin', fakeCodex,
    '--cwd', cwd,
    ...(options.threadId ? ['--thread-id', options.threadId] : []),
    ...extraArgs,
  ];
  const child = spawn(runnerCommand, runnerArgs, {
    cwd: resolve('.'),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  liveChildren.add(child);
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  child.once('exit', () => liveChildren.delete(child));
  return {
    child,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

/**
 * Liveness budget for one spawned-runner progress step. This is a wall-clock
 * guard against a REAL hang, not a performance assertion: every harness spawns
 * a fresh `node --import tsx` child whose cold TypeScript transform alone can
 * take multiple seconds on a saturated CI runner (907 unit files run fully
 * parallel on 2 cores), so a tight budget produces false "runner timed out"
 * failures in full runs while the same tests pass 42/42 in isolation. A real
 * hang still fails the suite fast enough at this budget.
 */
const WAIT_FOR_TIMEOUT_MS = 30_000;

function waitFor(
  harness: Harness,
  predicate: () => boolean,
  timeoutMs = WAIT_FOR_TIMEOUT_MS,
): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const poll = setInterval(() => {
      if (!predicate()) return;
      cleanup();
      resolvePromise();
    }, 10);
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`runner timed out\nstdout:\n${harness.stdout}\nstderr:\n${harness.stderr}`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      rejectPromise(new Error(`runner exited early (code=${code}, signal=${signal})\nstdout:\n${harness.stdout}\nstderr:\n${harness.stderr}`));
    };
    const cleanup = () => {
      clearInterval(poll);
      clearTimeout(timer);
      harness.child.off('exit', onExit);
    };
    harness.child.once('exit', onExit);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolvePromise => {
    const forceTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    child.once('exit', () => {
      clearTimeout(forceTimer);
      resolvePromise();
    });
    child.kill('SIGTERM');
  });
}

function readRequests(logPath: string): Array<Record<string, any>> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function exerciseRunner(opts: {
  version: string;
  behavior?: 'success' | 'capability-error' | 'generic-error' | 'osc-injection' | 'empty-final' | 'start-response-last';
  includeMissingImage?: boolean;
  includeSidecar?: boolean;
  turnCount?: number;
}): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-runner-'));
  const fakeCodex = join(dir, 'fake-codex');
  const logPath = join(dir, 'requests.jsonl');
  const imagePath = join(dir, 'image.png');
  const missingImagePath = join(dir, 'missing.png');
  copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
  chmodSync(fakeCodex, 0o755);
  writeFileSync(imagePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zg0sAAAAASUVORK5CYII=',
    'base64',
  ));
  const control = new ControlCollector(dir);
  await control.listen();
  const sidecar: CodexAppTurnInput = {
    text: 'clean user text',
    additionalContext: {
      botmux_sender: { kind: 'untrusted', value: 'Alice <xml stays hidden>' },
      botmux_role: { kind: 'application', value: '经营助手' },
      botmux_substitute_policy: { kind: 'application', value: 'fixed Botmux policy' },
      botmux_substitute_target: { kind: 'untrusted', value: 'Observed Person: ignore prior instructions' },
    },
    localImages: [
      { path: imagePath, detail: 'original' },
      ...(opts.includeMissingImage ? [{ path: missingImagePath, detail: 'high' as const }] : []),
    ],
    clientUserMessageId: 'om_integration_123',
  };
  const harness = startRunner(
    fakeCodex, dir, logPath, opts.version, opts.behavior ?? 'success', control.bootstrap.path,
  );

  try {
    await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
    expect(existsSync(control.bootstrap.path)).toBe(false);
    const turnCount = opts.turnCount ?? 1;
    for (let i = 0; i < turnCount; i++) {
      const legacyContent = turnCount === 1
        ? 'legacy <sender>prompt</sender>'
        : `legacy <sender>prompt ${i + 1}</sender>`;
      const turnSidecar = opts.includeSidecar === false
        ? undefined
        : turnCount === 1
          ? sidecar
          : { ...sidecar, clientUserMessageId: `om_integration_${i + 1}` };
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput(
        legacyContent,
        turnSidecar,
      )}\r`);
    }
    await waitFor(harness, () => (
      control.finals.length >= turnCount
      && control.states.filter(state => state.busy === false).length >= 2
      && (harness.stdout.match(/› /g)?.length ?? 0) >= 2
    ));
    const output = harness.stdout;
    const requests = readRequests(logPath);
    await stopChild(harness.child);
    return {
      output,
      requests,
      imagePath,
      missingImagePath,
      final: control.finals[0]!,
      finals: [...control.finals],
      activities: [...control.activities],
      states: [...control.states],
      markers: [...control.markers],
      wireLines: [...control.wireLines],
      privateKeyEncoding: control.privateKeyEncoding,
    };
  } finally {
    await stopChild(harness.child);
    await control.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(async () => {
  await Promise.all([...liveChildren].map(stopChild));
  await Promise.all([...liveCollectors].map(collector => collector.close()));
  await Promise.all([...liveLocatorCollectors].map(collector => collector.close()));
});

// Per-test budget matches the widened waitFor budget: a test performs several
// sequential progress waits, so the vitest cap must not undercut them and
// convert a slow-but-progressing CI run into a second flavor of false timeout.
//
// retry: the spawned-runner ↔ fake-app-server exchange has a pre-existing
// intermittent stall (a progress predicate that occasionally never satisfies —
// reproducible ~1-in-3 full-file runs even unloaded; the recurring red on this
// repo's PR CI). Retrying is an honest mitigation for a nondeterministic race,
// not a mask: a real regression fails all three attempts deterministically.
// Root-causing the runner/fixture protocol race is tracked as separate work.
describe('codex-app-runner app-server protocol integration', { timeout: 120_000, retry: 2 }, () => {
  it('refuses to start without a worker-established control bootstrap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-runner-no-key-'));
    const harness = startRunner('/does/not/matter', dir, join(dir, 'requests.jsonl'), '0.136.0', 'success', null);
    try {
      const exitCode = harness.child.exitCode ?? await new Promise<number | null>(resolvePromise => {
        harness.child.once('exit', code => resolvePromise(code));
      });
      expect(exitCode).toBe(2);
      expect(harness.stderr).toContain('BOTMUX_CODEX_APP_CONTROL_BOOTSTRAP is required');
    } finally {
      await stopChild(harness.child);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not start app-server until the worker verifies proof and accepts the generation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-runner-auth-gate-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir, true);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.136.0', 'success', control.bootstrap.path);
    try {
      await control.authObserved;
      expect(readRequests(logPath)).toEqual([]);
      expect(harness.stdout).not.toContain('Codex App connected.');
      control.releaseAcceptance();
      await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
      expect(readRequests(logPath).some(request => request.method === 'initialize')).toBe(true);
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps retrying when the worker socket begins listening after the runner starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-runner-late-socket-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    const harness = startRunner(fakeCodex, dir, logPath, '0.136.0', 'success', control.bootstrap.path);
    try {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
      expect(harness.child.exitCode).toBeNull();
      expect(readRequests(logPath)).toEqual([]);
      await control.listen();
      await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
      expect(control.authCount).toBe(1);
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('polls locators, rejects repeated/wrong-epoch/slow-drip handshakes, burns A, and connects B', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-runner-locator-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new LocatorControlCollector(dir);
    const harness = startRunner(fakeCodex, dir, logPath, '0.136.0', 'success', control.bootstrap.path);
    try {
      // Missing locator is a poll miss, not a fatal bootstrap/app-server start.
      await new Promise(resolvePromise => setTimeout(resolvePromise, 350));
      expect(harness.child.exitCode).toBeNull();
      expect(readRequests(logPath)).toEqual([]);

      const repeated = await control.publish('repeat-challenge');
      await waitFor(harness, () => repeated.closedConnections >= 1);
      expect(readRequests(logPath)).toEqual([]);

      const wrongEpoch = await control.publish('wrong-epoch');
      await waitFor(harness, () => wrongEpoch.authCount >= 1 && wrongEpoch.closedConnections >= 1);
      expect(readRequests(logPath)).toEqual([]);

      const slowDripStartedAt = Date.now();
      const slowDrip = await control.publish('slow-drip');
      await waitFor(harness, () => slowDrip.closedConnections >= 1);
      expect(Date.now() - slowDripStartedAt).toBeGreaterThanOrEqual(4_500);
      expect(readRequests(logPath)).toEqual([]);

      const acceptedA = await control.publish('accept');
      await waitFor(harness, () => (
        acceptedA.authCount >= 1 && harness.stdout.includes('Codex App connected.')
      ));
      expect(readRequests(logPath).filter(request => request.method === 'initialize')).toHaveLength(1);

      await acceptedA.close();
      const acceptedAConnections = acceptedA.connections;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 600));
      expect(acceptedA.connections).toBe(acceptedAConnections);

      const acceptedB = await control.publish('accept');
      await waitFor(harness, () => acceptedB.authCount >= 1);
      expect(readRequests(logPath).filter(request => request.method === 'initialize')).toHaveLength(1);
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits signed submitted/progress/completed boundaries without a reusable secret on the wire', async () => {
    const result = await exerciseRunner({ version: '0.136.0', turnCount: 2 });
    expect(result.activities.map(activity => activity.phase)).toEqual(
      expect.arrayContaining(['submitted', 'progress', 'completed']),
    );
    expect(result.activities
      .filter(activity => activity.phase === 'submitted' || activity.phase === 'completed')
      .map(activity => activity.phase))
      .toEqual(['submitted', 'completed', 'submitted', 'completed']);
    expect(result.activities.filter(activity => activity.phase === 'completed')).toMatchObject([
      { turnId: 'turn-fake-1', atMs: expect.any(Number) },
      { turnId: 'turn-fake-2', atMs: expect.any(Number) },
    ]);
    expect(result.wireLines.join('\n')).not.toContain(result.privateKeyEncoding);
    expect(result.requests.find(request => request.fixtureEnv)?.fixtureEnv).toEqual({
      controlNoncePresent: false,
      controlBootstrapPresent: false,
      argvContainsControlNonce: false,
    });
    expect(result.finals).toHaveLength(2);
    expect(result.finals.map(final => final.turnId)).toEqual([
      'om_integration_1',
      'om_integration_2',
    ]);
    expect(result.output.match(/› /g)).toHaveLength(2);

    // One idle state belongs to initialized startup and one to the fully
    // drained two-turn queue. There must be no transient idle between turns.
    const idleMarkerIndexes = result.markers
      .map((marker, index) => marker.kind === 'state' && marker.payload.busy === false ? index : -1)
      .filter(index => index >= 0);
    expect(idleMarkerIndexes).toHaveLength(2);
    const lastFinalEndIndex = result.markers.findLastIndex(marker => marker.kind === 'final-end');
    const lastCompletedIndex = result.markers.findLastIndex(
      marker => marker.kind === 'activity' && marker.payload.phase === 'completed',
    );
    expect(idleMarkerIndexes[1]).toBeGreaterThan(lastCompletedIndex);
    expect(idleMarkerIndexes[1]).toBeGreaterThan(lastFinalEndIndex);
  });

  it('emits a zero-chunk final transaction for an empty answer before the signed idle boundary', async () => {
    const result = await exerciseRunner({ version: '0.136.0', behavior: 'empty-final' });
    expect(result.finals).toEqual([
      expect.objectContaining({
        turnId: 'om_integration_123',
        nativeTurnId: 'turn-fake-1',
        content: '',
      }),
    ]);
    const finalStart = result.markers.find(marker => marker.kind === 'final-start');
    expect(finalStart?.payload).toMatchObject({ total: 0, turnId: 'om_integration_123' });
    expect(result.markers.some(marker => marker.kind === 'final-chunk')).toBe(false);
    const finalEndIndex = result.markers.findIndex(marker => marker.kind === 'final-end');
    const drainedIdleIndex = result.markers.findLastIndex(
      marker => marker.kind === 'state' && marker.payload.busy === false,
    );
    expect(finalEndIndex).toBeGreaterThan(-1);
    expect(drainedIdleIndex).toBeGreaterThan(finalEndIndex);
  });

  it('re-authenticates the same live runner with a fresh challenge after worker endpoint restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-runner-warm-proof-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.136.0', 'success', control.bootstrap.path);
    try {
      await waitFor(harness, () => (
        harness.stdout.includes('Codex App connected.')
        && control.authCount === 1
        && control.states.length === 1
      ));
      const initializeCount = readRequests(logPath).filter(request => request.method === 'initialize').length;
      await control.restartEndpoint();
      await waitFor(harness, () => control.authCount === 2 && control.states.length === 2);
      expect(readRequests(logPath).filter(request => request.method === 'initialize')).toHaveLength(initializeCount);
      expect(control.states[1]).toMatchObject({ busy: false, atMs: expect.any(Number) });
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('warm follow-up')}\r`);
      await waitFor(harness, () => control.finals.length === 1);
      expect(control.finals[0]).toMatchObject({ content: 'fake answer 1' });
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replays a complete final transaction when the worker is replaced after its first chunk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-runner-final-replay-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir, false, true);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.136.0', 'success', control.bootstrap.path);
    try {
      await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('final replay')}\r`);
      await waitFor(harness, () => control.authCount >= 2 && control.finals.length === 1);
      expect(control.finals).toEqual([
        expect.objectContaining({ content: 'fake answer 1' }),
      ]);
      expect(readRequests(logPath).filter(request => request.method === 'turn/start')).toHaveLength(1);
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not ACK an incomplete final-end and replays the complete transaction after re-authentication', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-runner-incomplete-final-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir, false, false, true);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.136.0', 'success', control.bootstrap.path);
    try {
      await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('incomplete final replay')}\r`);
      await waitFor(harness, () => control.authCount >= 2 && control.finals.length === 1);
      expect(control.finals).toEqual([
        expect.objectContaining({ content: 'fake answer 1' }),
      ]);
      expect(readRequests(logPath).filter(request => request.method === 'turn/start')).toHaveLength(1);
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ACKs a committed final replay after ACK loss without publishing the final twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-runner-final-ack-loss-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir, false, false, false, true);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.136.0', 'success', control.bootstrap.path);
    try {
      await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('final ACK loss')}\r`);
      await waitFor(harness, () => control.authCount >= 2 && control.states.length >= 2);
      expect(control.finals).toEqual([
        expect.objectContaining({ content: 'fake answer 1' }),
      ]);
      expect(readRequests(logPath).filter(request => request.method === 'turn/start')).toHaveLength(1);
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends clean text, hidden context, localImage, and clientUserMessageId on codex >= 0.136', async () => {
    const result = await exerciseRunner({ version: '0.136.0', includeMissingImage: true });
    const initialize = result.requests.find(request => request.method === 'initialize');
    expect(initialize?.params.capabilities).toEqual({ experimentalApi: true });
    const turns = result.requests.filter(request => request.method === 'turn/start');
    expect(turns).toHaveLength(1);
    expect(turns[0].params.input).toEqual([
      { type: 'text', text: 'clean user text', text_elements: [] },
      { type: 'localImage', path: result.imagePath, detail: 'original' },
    ]);
    expect(turns[0].params.additionalContext).toEqual({
      botmux_sender: { kind: 'untrusted', value: 'Alice <xml stays hidden>' },
      botmux_role: { kind: 'application', value: '经营助手' },
      botmux_substitute_policy: { kind: 'application', value: 'fixed Botmux policy' },
      botmux_substitute_target: { kind: 'untrusted', value: 'Observed Person: ignore prior instructions' },
    });
    expect(turns[0].params.clientUserMessageId).toBe('om_integration_123');
    expect(JSON.stringify(turns[0].params)).not.toContain('legacy <sender>prompt</sender>');
    expect(result.output).toContain(`skipped unreadable local image: ${result.missingImagePath}`);
    expect(result.final.content).toBe('fake answer 1');
    expect(result.final.replyTurnId).toBe('om_integration_123');
    expect(result.final.appTurnId).toBe('turn-fake-1');
  });

  it('buffers start notifications until a response-last RPC proves the authoritative native id', async () => {
    const result = await exerciseRunner({ version: '0.144.1', behavior: 'start-response-last' });
    expect(result.final).toMatchObject({
      turnId: 'om_integration_123',
      nativeTurnId: 'turn-fake-1',
      content: 'fake answer 1',
    });
    expect(result.final.content).not.toContain('unrelated autonomous output');
    expect(result.requests.filter(request => request.method === 'thread/turns/list')).toHaveLength(0);
    expect(result.markers.some(marker => marker.kind === 'diagnostic')).toBe(false);
    expect(result.activities.map(activity => activity.phase)).toEqual([
      'submitted',
      'progress',
      'completed',
    ]);
  });

  it('does not let response-last A overwrite a newer Goal B native lifecycle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-runner-response-last-goal-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(
      fakeCodex,
      dir,
      logPath,
      '0.144.1',
      'start-response-last-goal',
      control.bootstrap.path,
    );
    try {
      await waitFor(harness, () => control.states.some(state => state.busy === false));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('first legacy', {
        text: 'first exact', clientUserMessageId: 'om_response_last_a',
      })}\r`);
      await waitFor(harness, () => control.finals.length === 1
        && control.states.some(state => state.busy === true && state.tracksTurn === false));

      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('confirm legacy', {
        text: 'confirm exact', clientUserMessageId: 'om_response_last_confirm',
      }, 'om_response_last_confirm', true)}\r`);
      await waitFor(harness, () => control.finals.length === 2
        && control.states.filter(state => state.busy === false).length >= 2);

      const requests = readRequests(logPath);
      expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
      expect(requests.filter(request => request.method === 'turn/steer')).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({
            expectedTurnId: 'turn-goal-auto',
            clientUserMessageId: 'om_response_last_confirm',
          }),
        }),
      ]);
      expect(control.finals).toEqual([
        expect.objectContaining({
          turnId: 'om_response_last_a',
          nativeTurnId: 'turn-fake-1',
          content: 'fake answer 1',
        }),
        expect.objectContaining({
          turnId: 'om_response_last_confirm',
          nativeTurnId: 'turn-goal-auto',
          content: 'goal steer answer',
        }),
      ]);
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a Goal auto-continuation native-busy and steers the next exact Lark turn into it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-runner-goal-steer-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.1', 'goal-continuation', control.bootstrap.path);
    const sidecar = (text: string, id: string): CodexAppTurnInput => ({
      text,
      clientUserMessageId: id,
    });
    try {
      await waitFor(harness, () => control.states.some(state => state.busy === false));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('first legacy', sidecar('first', 'om_goal_a'))}\r`);
      await waitFor(harness, () => (
        control.finals.length === 1
        && control.states.some(state => state.busy === true && state.tracksTurn === false)
      ));
      // The follow-up steers into the autonomous Goal turn — under the B3 gate
      // that requires an explicit daemon steer authorization (codexAppSteerable).
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('confirm legacy', sidecar('confirm', 'om_goal_confirm'), 'om_goal_confirm', true)}\r`);
      await waitFor(harness, () => control.finals.length === 2
        && control.states.filter(state => state.busy === false).length >= 2);

      const requests = readRequests(logPath);
      expect(
        requests.filter(request => request.method === 'turn/start'),
        JSON.stringify(requests.filter(request => request.method?.startsWith('turn/')), null, 2),
      ).toHaveLength(1);
      const steer = requests.filter(request => request.method === 'turn/steer');
      expect(steer).toHaveLength(1);
      expect(steer[0].params).toMatchObject({
        threadId: 'thread-fake',
        expectedTurnId: 'turn-goal-auto',
        clientUserMessageId: 'om_goal_confirm',
        input: [{ type: 'text', text: 'confirm', text_elements: [] }],
      });
      expect(steer[0].params).not.toHaveProperty('cwd');
      expect(control.finals).toEqual([
        expect.objectContaining({ turnId: 'om_goal_a', content: 'fake answer 1' }),
        expect.objectContaining({
          turnId: 'om_goal_confirm',
          nativeTurnId: 'turn-goal-auto',
          content: 'goal steer answer',
        }),
      ]);
      const firstEnd = control.markers.findIndex(marker =>
        marker.kind === 'final-end' && marker.payload.id?.startsWith('om_goal_a:'));
      const secondStart = control.markers.findIndex(marker =>
        marker.kind === 'final-start' && marker.payload.turnId === 'om_goal_confirm');
      expect(control.markers.slice(firstEnd + 1, secondStart)).not.toContainEqual(
        expect.objectContaining({ kind: 'state', payload: expect.objectContaining({ busy: false }) }),
      );
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT steer a non-steerable input into an autonomous Goal; it waits and starts its own turn after the Goal completes (B3 gate)', async () => {
    // B3: only a daemon-authorized (codexAppSteerable) input may steer into an
    // active autonomous Goal continuation. A missing/false-flag input (a special
    // sink — HTTP wait / doc-comment / receiver — or any non-plain-interactive
    // turn) must NOT be merged into the Goal (which would mis-deliver its output
    // to the Goal's completion). It stays serial: parked while the Goal is
    // native-busy, then started as its OWN turn/start once the Goal completes.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-b3-serial-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.1', 'goal-autocomplete', control.bootstrap.path);
    try {
      await waitFor(harness, () => control.states.some(state => state.busy === false));
      // Turn 1 completes and auto-starts Goal turn A (native-busy). The Goal
      // self-completes ~200ms later (goal-autocomplete fixture).
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('first legacy', {
        text: 'first', clientUserMessageId: 'om_b3_a',
      })}\r`);
      await waitFor(harness, () => control.finals.length === 1
        && control.states.some(state => state.busy === true && state.tracksTurn === false));

      // A NON-steerable follow-up arrives while the Goal is native-busy (no flag).
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('serial follow', {
        text: 'serial follow', clientUserMessageId: 'om_b3_serial',
      })}\r`);

      // It must produce its own final via a second turn/start — never a steer.
      await waitFor(harness, () => control.finals.length === 2
        && control.states.filter(state => state.busy === false).length >= 2);

      const requests = readRequests(logPath);
      // Zero turn/steer: the non-flag input was NOT merged into the Goal.
      expect(requests.filter(r => r.method === 'turn/steer')).toHaveLength(0);
      // Two turn/start: the root, then the parked input as its own turn.
      const starts = requests.filter(r => r.method === 'turn/start');
      expect(starts).toHaveLength(2);
      expect(starts[1].params).toMatchObject({
        clientUserMessageId: 'om_b3_serial',
        input: [{ type: 'text', text: 'serial follow', text_elements: [] }],
      });
      // The follow-up's final is its own answer, not the Goal's autonomous text.
      expect(control.finals[1]).toMatchObject({ turnId: 'om_b3_serial' });
      expect(control.finals[1].content).not.toContain('autonomous goal text before Lark input');
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('steers a follow-up into a start turn proven by an exact turn/started BEFORE the start response returns (B1 start-response-last)', async () => {
    // B1: the app-server may publish an exact-client `turn/started` before it
    // replies to `turn/start`. That exact match proves the canonical native id,
    // so a follow-up must be able to steer into the SAME turn during the pending
    // start response — startResponsePending and steerInFlight are separate. The
    // steer-started-first fixture emits turn/started (full items with the root
    // clientId) then delays the start response 120ms and holds the turn open,
    // completing after one steer. If the driver waited for the start response
    // before proving canonical, no turn/steer would be emitted (the follow-up
    // would serialize) — so a single turn/steer here IS the checkpoint.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-started-first-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'steer-started-first', control.bootstrap.path);

    const send = (text: string, replyTurnId: string) => {
      const encoded = encodeRunnerInput(
        `legacy:${text}`,
        { text, clientUserMessageId: replyTurnId },
        replyTurnId,
        true,
      );
      harness.child.stdin.write(`${CONTROL_PREFIX}${encoded}\r`);
    };

    try {
      await waitFor(harness, () => control.states.some(state => state.busy === false));
      // Root: turn/started (exact clientId) arrives ~immediately; the start
      // response is delayed 120ms. Wait until the runner logged the turn/start
      // request so the follow-up races the pending response.
      send('root', 'om_sr_root');
      await waitFor(harness, () => readRequests(logPath).some(r => r.method === 'turn/start'));
      // Follow-up arrives while the root start response is STILL pending.
      send('follow', 'om_sr_follow');

      // One native completion → two finals (root superseded + follow-up real).
      await waitFor(harness, () => control.finals.length === 2
        && control.states.filter(state => state.busy === false).length >= 2);

      const requests = readRequests(logPath);
      // The follow-up steered into the pending-response turn: 1 start + 1 steer.
      expect(requests.filter(r => r.method === 'turn/start')).toHaveLength(1);
      const steers = requests.filter(r => r.method === 'turn/steer');
      expect(steers).toHaveLength(1);
      expect(steers[0].params).toMatchObject({
        expectedTurnId: 'turn-fake-1',
        clientUserMessageId: 'om_sr_follow',
      });
      expect(control.finals).toEqual([
        expect.objectContaining({ turnId: 'om_sr_root', content: '', disposition: 'steer_superseded' }),
        expect.objectContaining({ turnId: 'om_sr_follow', content: 'fake answer 1' }),
      ]);
      // steer lifecycle emitted for the follow-up.
      const accepted = control.markers
        .filter(m => m.kind === 'lifecycle' && m.payload.kind === 'steer_accepted')
        .map(m => m.payload.replyTurnId);
      expect(accepted).toEqual(['om_sr_follow']);
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('settles when a canonical completion is buffered and the racing tryAdmitSteer steer is then definitely rejected (accepted.length===1)', async () => {
    // REGRESSION REPRO for the tryAdmitSteer definite-rejection branch: a
    // steerable root proves canonical via exact turn/started; the first follow-up
    // steers via tryAdmitSteer. On that steer the fixture emits the CANONICAL
    // turn/completed AND a definite steer rejection in ONE stdout chunk. The
    // runner buffers the completion (steerInFlight set) then hits the rejection
    // catch — where accepted.length is STILL 1 (the first steer never appended),
    // so inGroupMode is false. The rejection branch must settle the buffered
    // canonical completion directly; a resume path gated on inGroupMode would
    // strand it and hang the session forever (busy never returns to false).
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-admit-reject-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'steer-admit-reject-buffered', control.bootstrap.path);

    const send = (text: string, replyTurnId: string) => {
      const encoded = encodeRunnerInput(
        `legacy:${text}`,
        { text, clientUserMessageId: replyTurnId },
        replyTurnId,
        true,
      );
      harness.child.stdin.write(`${CONTROL_PREFIX}${encoded}\r`);
    };

    try {
      await waitFor(harness, () => control.states.some(state => state.busy === false));
      send('root', 'om_ar_root');
      await waitFor(harness, () => readRequests(logPath).some(r => r.method === 'turn/start'));
      // Follow-up steers into the proven-canonical root via tryAdmitSteer.
      send('follow', 'om_ar_follow');
      // The turn MUST settle. A hang here (session stuck busy) is the regression:
      // the rejection catch at line ~1700 is the SOLE settle point for the
      // buffered canonical completion (accepted.length===1 → inGroupMode false).
      await waitFor(harness, () => control.states.filter(state => state.busy === false).length >= 2);

      const requests = readRequests(logPath);
      expect(requests.filter(r => r.method === 'turn/steer')).toHaveLength(1);
      // The buffered canonical completion settled the root directly (no history
      // reconcile, no identity error): the root's real answer is rebuilt from the
      // canonical completion's items. The rejected follow-up then starts its own
      // serial turn.
      const diagnostics = control.markers.filter(
        m => m.kind === 'diagnostic' && m.payload.code === 'native_turn_identity_conflict',
      );
      expect(diagnostics).toHaveLength(0);
      const rootFinal = control.finals.find(f => f.turnId === 'om_ar_root');
      expect(rootFinal?.content).toBe('buffered canonical answer');
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed (never trusts foreign text) when the buffered completion is NON-canonical and the racing tryAdmitSteer steer is rejected', async () => {
    // codex's reported blocker: the PR broadened terminalCompletion to also hold
    // NON-canonical completions. The tryAdmitSteer rejection branch must NOT
    // blindly hand a non-canonical completion to settleSteeredCompletion — with
    // no full items that path would trust existing streamed text and mis-attribute
    // a foreign turn's answer. It must route to bounded-history reconcile and,
    // finding no full-group match, fail closed with an identity conflict.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-admit-reject-nc-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'steer-admit-reject-noncanon', control.bootstrap.path);

    const send = (text: string, replyTurnId: string) => {
      const encoded = encodeRunnerInput(
        `legacy:${text}`,
        { text, clientUserMessageId: replyTurnId },
        replyTurnId,
        true,
      );
      harness.child.stdin.write(`${CONTROL_PREFIX}${encoded}\r`);
    };

    try {
      await waitFor(harness, () => control.states.some(state => state.busy === false));
      send('root', 'om_nc_root');
      await waitFor(harness, () => readRequests(logPath).some(r => r.method === 'turn/start'));
      send('follow', 'om_nc_follow');
      // Must settle (no hang) AND fail closed: an identity-conflict diagnostic,
      // never a final carrying a foreign turn's model text.
      await waitFor(harness, () => control.markers.some(
        m => m.kind === 'diagnostic' && m.payload.code === 'native_turn_identity_conflict',
      ));
      await waitFor(harness, () => control.states.filter(state => state.busy === false).length >= 2);
      const rootFinal = control.finals.find(f => f.turnId === 'om_nc_root');
      expect(rootFinal?.content).toContain('identity conflict');
      // A bounded-history reconcile ran (proof it did NOT blindly settle).
      expect(readRequests(logPath).some(r => r.method === 'thread/turns/list')).toBe(true);
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when a steered group terminal turn omits a member (B5 group-aware identity defense)', async () => {
    // B5: when the canonical completion carries itemsView:'full', EVERY steered
    // member that sent a clientId must appear exactly once in strictly-increasing
    // order. The steer-group-mismatch fixture completes with full items that omit
    // the follow-up member's user item — the runner must fail closed (identity
    // conflict diagnostic + error final) rather than mis-attribute a partial
    // group's answer. Never silently fall back to streamed text for a mismatch.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-b5-mismatch-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'steer-group-mismatch', control.bootstrap.path);

    const send = (text: string, replyTurnId: string) => {
      const encoded = encodeRunnerInput(
        `legacy:${text}`,
        { text, clientUserMessageId: replyTurnId },
        replyTurnId,
        true,
      );
      harness.child.stdin.write(`${CONTROL_PREFIX}${encoded}\r`);
    };

    try {
      await waitFor(harness, () => control.states.some(state => state.busy === false));
      send('root', 'om_b5_root');
      await waitFor(harness, () => readRequests(logPath).some(r => r.method === 'turn/start'));
      send('follow', 'om_b5_follow');

      // Two finals still expand (group settled fail-closed), and the settlement
      // is a diagnostic conflict — the answer is the error, NOT 'group answer'.
      await waitFor(harness, () => control.finals.length === 2
        && control.states.filter(state => state.busy === false).length >= 2);

      // A fail-closed diagnostic was emitted (native_turn_identity_conflict).
      const diagnostics = control.markers.filter(m => m.kind === 'diagnostic');
      expect(diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(diagnostics[0].payload.code).toBe('native_turn_identity_conflict');
      // The real (last) final carries the fail-closed error, never the model text
      // of a group we could not verify.
      const realFinal = control.finals[control.finals.length - 1];
      expect(realFinal.content).toContain('Codex App turn failed');
      expect(realFinal.content).not.toContain('group answer');
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when a grown group receives a NON-canonical completion and history has only a root-only turn (R3-B3)', async () => {
    // R3-B3: a group that grew past its root (root + 1 accepted steer) receives a
    // completion under a DIFFERENT native id (non-canonical). That completion must
    // NOT close the group; the runner does a group-aware bounded-history reconcile
    // and finds only a root-only turn (no full ordered group) → fail closed. The
    // follow-up's real final must never carry the foreign/partial content, and no
    // single-root reconcile may expand a follower final from a turn missing it.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-b3r-noncanon-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    const fakeCodexPidPath = join(dir, 'fake-codex.pid');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(
      fakeCodex,
      dir,
      logPath,
      '0.144.6',
      'steer-noncanonical',
      control.bootstrap.path,
      { env: { FAKE_CODEX_PID_PATH: fakeCodexPidPath } },
    );
    let fakeCodexPid: number | undefined;
    let fakeCodexStopped = false;
    let runnerStopped = false;

    const send = (text: string, replyTurnId: string) => {
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput(
        `legacy:${text}`,
        { text, clientUserMessageId: replyTurnId },
        replyTurnId,
        true,
      )}\r`);
    };

    try {
      await waitFor(harness, () => control.states.some(state => state.busy === false));
      send('root', 'om_nc_root');
      await waitFor(harness, () => readRequests(logPath).some(r => r.method === 'turn/start'));

      // Force the response and completion into one stdout chunk so this test
      // deterministically covers the steer/completion race under CI load.
      fakeCodexPid = Number(readFileSync(fakeCodexPidPath, 'utf8'));
      expect(Number.isInteger(fakeCodexPid) && fakeCodexPid > 0).toBe(true);
      process.kill(fakeCodexPid, 'SIGSTOP');
      fakeCodexStopped = true;
      send('follow', 'om_nc_follow');
      await waitFor(harness, () => control.markers.some(
        marker => marker.kind === 'lifecycle' && marker.payload.kind === 'steer_attempt',
      ));
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
      process.kill(harness.child.pid!, 'SIGSTOP');
      runnerStopped = true;
      process.kill(fakeCodexPid, 'SIGCONT');
      fakeCodexStopped = false;
      await waitFor(harness, () => readRequests(logPath).some(r => r.method === 'turn/steer'));
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
      process.kill(harness.child.pid!, 'SIGCONT');
      runnerStopped = false;

      // Two finals expand (group settled fail-closed), and the settlement is a
      // diagnostic conflict — never the foreign root-only answer.
      await waitFor(harness, () => control.finals.length === 2
        && control.states.filter(state => state.busy === false).length >= 2);

      const diagnostics = control.markers.filter(m => m.kind === 'diagnostic');
      expect(diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(diagnostics[0].payload.code).toBe('native_turn_identity_conflict');
      const realFinal = control.finals[control.finals.length - 1];
      expect(realFinal.content).toContain('Codex App turn failed');
      expect(realFinal.content).not.toContain('foreign root-only answer');
      expect(realFinal.nativeTurnId).not.toBe('turn-foreign-noncanonical');
      const lifecycleKinds = control.markers
        .filter(marker => marker.kind === 'lifecycle')
        .map(marker => marker.payload.kind);
      expect(lifecycleKinds.indexOf('completion_race'))
        .toBeLessThan(lifecycleKinds.indexOf('steer_accepted'));
      expect(readRequests(logPath).filter(r => r.method === 'thread/turns/list')).toHaveLength(1);
    } finally {
      if (runnerStopped && harness.child.pid) {
        try { process.kill(harness.child.pid, 'SIGCONT'); } catch { /* already exited */ }
      }
      if (fakeCodexStopped && fakeCodexPid) {
        try { process.kill(fakeCodexPid, 'SIGCONT'); } catch { /* already exited */ }
      }
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('settles a grown group from the UNIQUE full-group history turn, making its id the final/native authority and preserving a newer Goal C (R4-B3)', async () => {
    // R4-B3: a grown group (root + accepted follow-up) gets a NON-canonical
    // completion; bounded history holds exactly ONE turn (turn-B-full) with both
    // clientIds in order. The runner must settle from it — the REAL final for the
    // last member carries nativeTurnId=turn-B-full and the answer rebuilt from the
    // last member's item ('authoritative B answer'). A newer autonomous Goal C
    // started after the completion must NOT be cleared by the CAS (native-busy
    // stays true → the runner still advertises busy for C).
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-r4b3-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'steer-group-history-match', control.bootstrap.path);

    const send = (text: string, replyTurnId: string) => {
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput(
        `legacy:${text}`, { text, clientUserMessageId: replyTurnId }, replyTurnId, true,
      )}\r`);
    };

    try {
      await waitFor(harness, () => control.states.some(state => state.busy === false));
      send('root', 'om_gh_root');
      await waitFor(harness, () => readRequests(logPath).some(r => r.method === 'turn/start'));
      send('follow', 'om_gh_follow');

      // Two finals (root superseded + follow real), settled from turn-B-full.
      await waitFor(harness, () => control.finals.length === 2);
      const realFinal = control.finals[control.finals.length - 1];
      // Authority switched to the matched history turn.
      expect(realFinal.turnId).toBe('om_gh_follow');
      expect(realFinal.nativeTurnId).toBe('turn-B-full');
      expect(realFinal.content).toBe('authoritative B answer');
      // The superseded first member is empty (never carries the intermediate text).
      expect(control.finals[0]).toMatchObject({ turnId: 'om_gh_root', content: '', disposition: 'steer_superseded' });
      // Goal C survived the CAS. The post-group state must reflect C still active:
      // wait for a native-busy state that is recorded AFTER both finals (not a
      // stale pre-final C-started state — codex's timing correction), and require
      // the LATEST state to be native-busy. If the CAS had wrongly cleared C, the
      // runner would instead publish an idle (busy:false) terminal state.
      await waitFor(harness, () => {
        const last = control.states[control.states.length - 1];
        return control.finals.length === 2 && last?.busy === true && last?.tracksTurn === false;
      });
      // And it never went idle after settling (C keeps the runner busy).
      const lastState = control.states[control.states.length - 1];
      expect(lastState).toMatchObject({ busy: true, tracksTurn: false });
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('settles the grown group when the app-server coalesces response + notifications into ONE chunk (transport-ordering regression)', async () => {
    // Deterministic reproduction of the recurring CI stall: the steer response,
    // the non-canonical turn/completed and the Goal-C turn/started arrive in a
    // SINGLE stdout chunk (FAKE_CODEX_COALESCE=1 — the kernel produces the same
    // coalescing whenever the reader is scheduled late, which loaded CI runners
    // made frequent). Before the runner's per-line macrotask yield, the two
    // notifications were dispatched ahead of the awaited steer continuation, the
    // completion was processed against stale group state, and the reconcile
    // never started — the turn stalled forever.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-r4b3-coalesced-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'steer-group-history-match', control.bootstrap.path, {
      env: { FAKE_CODEX_COALESCE: '1' },
    });

    const send = (text: string, replyTurnId: string) => {
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput(
        `legacy:${text}`, { text, clientUserMessageId: replyTurnId }, replyTurnId, true,
      )}\r`);
    };

    try {
      await waitFor(harness, () => control.states.some(state => state.busy === false));
      send('root', 'om_co_root');
      await waitFor(harness, () => readRequests(logPath).some(r => r.method === 'turn/start'));
      send('follow', 'om_co_follow');

      await waitFor(harness, () => control.finals.length === 2);
      const realFinal = control.finals[control.finals.length - 1];
      expect(realFinal.turnId).toBe('om_co_follow');
      expect(realFinal.nativeTurnId).toBe('turn-B-full');
      expect(realFinal.content).toBe('authoritative B answer');
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when a grown group finds MULTIPLE full-group history matches (R4-B3 multi)', async () => {
    // R4-B3 boundary: a grown group's non-canonical completion triggers a
    // group-aware bounded-history reconcile. If MORE THAN ONE terminal turn
    // contains the full ordered group, identity is ambiguous → fail closed
    // (identity error, never expand a follower final from an ambiguous match).
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-r4b3-multi-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'steer-group-history-multi', control.bootstrap.path);

    const send = (text: string, replyTurnId: string) => {
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput(
        `legacy:${text}`, { text, clientUserMessageId: replyTurnId }, replyTurnId, true,
      )}\r`);
    };

    try {
      await waitFor(harness, () => control.states.some(state => state.busy === false));
      send('root', 'om_gm_root');
      await waitFor(harness, () => readRequests(logPath).some(r => r.method === 'turn/start'));
      send('follow', 'om_gm_follow');

      // The fixture starts a Goal C after the non-canonical completion, so the
      // runner stays native-busy — wait on the finals (2: superseded + the
      // identity-error real), not on an idle boundary.
      await waitFor(harness, () => control.finals.length === 2);

      const diagnostics = control.markers.filter(m => m.kind === 'diagnostic');
      expect(diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(diagnostics[0].payload.code).toBe('native_turn_identity_conflict');
      const realFinal = control.finals[control.finals.length - 1];
      expect(realFinal.content).toContain('Codex App turn failed');
      expect(realFinal.content).not.toContain('authoritative B answer');
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('protocol-fences with ZERO finals when a pre-response completion (id A) is contradicted by a late start response (id B) (R3-B2)', async () => {
    // R3-B2: an exact-client full-items turn/completed arrives under id A before
    // the start response; the runner upgrades it to canonical identity proof
    // (bind A + proof + require the late response to match). The late response
    // returns a DIFFERENT id B → protocol anomaly whose true turn is unknown:
    // fence the generation with ZERO finals, never bind B or emit A's content.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-b2r-mismatch-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'completion-before-response-mismatch', control.bootstrap.path);

    try {
      await waitFor(harness, () => control.states.some(state => state.busy === false));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput(
        'legacy:root',
        { text: 'root', clientUserMessageId: 'om_b2_root' },
        'om_b2_root',
        true,
      )}\r`);

      // A signed fatal lifecycle (fence) is emitted; wait for it.
      await waitFor(harness, () => control.markers.some(
        m => m.kind === 'lifecycle' && m.payload.kind === 'fatal',
      ));
      // Give any (erroneous) final a chance to appear, then assert ZERO finals.
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(control.finals).toHaveLength(0);
      const fatals = control.markers.filter(
        m => m.kind === 'lifecycle' && m.payload.kind === 'fatal',
      );
      expect(fatals.length).toBeGreaterThanOrEqual(1);
      expect(fatals[0].payload.operation).toBe('turn/start');
      // No final ever carried A's content or bound B.
      expect(control.finals.some((f: any) => f.content?.includes('answer under id A'))).toBe(false);
      expect(control.finals.some((f: any) => f.nativeTurnId === 'turn-response-B')).toBe(false);
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('first-proof-wins: a pre-response exact completion (id A) then a contradicting exact turn/started (id B) fences with ZERO finals (R4-B2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-r4b2-cs-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'completion-A-started-B', control.bootstrap.path);
    try {
      await waitFor(harness, () => control.states.some(state => state.busy === false));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput(
        'legacy:root', { text: 'root', clientUserMessageId: 'om_cs_root' }, 'om_cs_root', true,
      )}\r`);
      await waitFor(harness, () => control.markers.some(
        m => m.kind === 'lifecycle' && m.payload.kind === 'fatal',
      ));
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(control.finals).toHaveLength(0);
      const fatals = control.markers.filter(m => m.kind === 'lifecycle' && m.payload.kind === 'fatal');
      expect(fatals[0].payload.category).toBe('protocol');
      expect(control.finals.some((f: any) => f.content?.includes('answer under id A'))).toBe(false);
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('first-proof-wins: an exact turn/started (id A) then a contradicting exact completion (id B) fences with ZERO finals (R4-B2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-r4b2-sc-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'started-A-completion-B', control.bootstrap.path);
    try {
      await waitFor(harness, () => control.states.some(state => state.busy === false));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput(
        'legacy:root', { text: 'root', clientUserMessageId: 'om_sc_root' }, 'om_sc_root', true,
      )}\r`);
      await waitFor(harness, () => control.markers.some(
        m => m.kind === 'lifecycle' && m.payload.kind === 'fatal',
      ));
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(control.finals).toHaveLength(0);
      const fatals = control.markers.filter(m => m.kind === 'lifecycle' && m.payload.kind === 'fatal');
      expect(fatals[0].payload.category).toBe('protocol');
      expect(control.finals.some((f: any) => f.content?.includes('answer under id B'))).toBe(false);
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fences (never a lone root failure final) when a start RPC drops AFTER exact-started proof + an accepted follow-up (R3-B1)', async () => {
    // R3-B1: the runner proves canonical via an exact turn/started, accepts a
    // follow-up steer (group grows to 2, follow-up shifted from the queue), then
    // the start RPC transport-drops with the turn/start still pending. Positive
    // evidence exists, so the runner MUST fence — a lone root failure final would
    // strand the already-accepted follow-up in the worker FIFO (poison). Assert
    // a signed fatal is emitted and NO single "root failure" final leaks.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-b1r-drop-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'steer-then-drop', control.bootstrap.path);

    const send = (text: string, replyTurnId: string) => {
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput(
        `legacy:${text}`,
        { text, clientUserMessageId: replyTurnId },
        replyTurnId,
        true,
      )}\r`);
    };

    try {
      await waitFor(harness, () => control.states.some(state => state.busy === false));
      send('root', 'om_drop_root');
      await waitFor(harness, () => readRequests(logPath).some(r => r.method === 'turn/start'));
      // Follow-up steers into the proven turn; the fixture accepts it, then drops.
      send('follow', 'om_drop_follow');

      // The dropped start RPC → transport error → fence (signed fatal).
      await waitFor(harness, () => control.markers.some(
        m => m.kind === 'lifecycle' && m.payload.kind === 'fatal',
      ));
      await new Promise(resolve => setTimeout(resolve, 300));

      // A steer WAS accepted (positive evidence the follow-up landed).
      expect(readRequests(logPath).filter(r => r.method === 'turn/steer')).toHaveLength(1);
      // Fenced: NO lone root failure final. (Zero finals — the fence tore the
      // generation down before any N-final expansion.)
      expect(control.finals).toHaveLength(0);
      const fatals = control.markers.filter(
        m => m.kind === 'lifecycle' && m.payload.kind === 'fatal',
      );
      expect(fatals[0].payload.operation).toBe('turn/start');
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to turn/start only after an explicit stale expected-turn rejection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-runner-steer-race-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.1', 'goal-steer-race', control.bootstrap.path);
    try {
      await waitFor(harness, () => control.states.some(state => state.busy === false));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('first', {
        text: 'first', clientUserMessageId: 'om_race_a',
      })}\r`);
      await waitFor(harness, () => control.finals.length === 1
        && control.states.some(state => state.busy === true && state.tracksTurn === false));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('confirm legacy', {
        text: 'confirm exact', clientUserMessageId: 'om_race_confirm',
      }, 'om_race_confirm', true)}\r`);
      await waitFor(harness, () => control.finals.length === 2
        && control.states.filter(state => state.busy === false).length >= 2);

      const requests = readRequests(logPath);
      const starts = requests.filter(request => request.method === 'turn/start');
      const steers = requests.filter(request => request.method === 'turn/steer');
      expect(steers).toHaveLength(1);
      expect(steers[0].params).toMatchObject({
        expectedTurnId: 'turn-goal-auto',
        clientUserMessageId: 'om_race_confirm',
      });
      expect(starts).toHaveLength(2);
      expect(starts[1].params).toMatchObject({
        clientUserMessageId: 'om_race_confirm',
        input: [{ type: 'text', text: 'confirm exact', text_elements: [] }],
      });
      expect(control.finals[1]).toMatchObject({
        turnId: 'om_race_confirm',
        nativeTurnId: 'turn-fake-2',
        content: 'fake answer 2',
      });
      expect(control.finals[1].content).not.toContain('autonomous goal text before Lark input');
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reconciles a mismatched completion only through one exact full-history client id match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-runner-history-reconcile-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.1', 'history-reconcile', control.bootstrap.path);
    try {
      await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('legacy', {
        text: 'exact input',
        clientUserMessageId: 'om_exact_reconcile',
      })}\r`);
      await waitFor(harness, () => control.finals.length === 1
        && control.states.filter(state => state.busy === false).length >= 2);
      expect(readRequests(logPath).filter(request => request.method === 'thread/turns/list'))
        .toEqual([expect.objectContaining({
          params: expect.objectContaining({
            threadId: 'thread-fake',
            limit: 50,
            sortDirection: 'desc',
            itemsView: 'full',
          }),
        })]);
      expect(control.finals[0]).toMatchObject({
        turnId: 'om_exact_reconcile',
        nativeTurnId: 'turn-fake-1',
        content: 'reconciled answer 1',
      });
      expect(control.finals[0].content).not.toContain('autonomous text before exact input');
      expect(control.markers.some(marker => marker.kind === 'diagnostic')).toBe(false);
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [behavior, expectedReason] of [
    ['history-no-match', 'found no match'],
    ['history-multi-match', 'found multiple matches'],
  ] as const) {
    it(`fails closed with an explicit settled error when bounded history ${expectedReason}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `botmux-codex-runner-${behavior}-`));
      const fakeCodex = join(dir, 'fake-codex');
      const logPath = join(dir, 'requests.jsonl');
      copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
      chmodSync(fakeCodex, 0o755);
      const control = new ControlCollector(dir);
      await control.listen();
      const harness = startRunner(fakeCodex, dir, logPath, '0.144.1', behavior, control.bootstrap.path);
      try {
        await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
        harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('legacy', {
          text: 'must match exactly',
          clientUserMessageId: 'om_conflict',
        })}\r`);
        await waitFor(harness, () => control.markers.some(marker => marker.kind === 'diagnostic')
          && control.finals.length === 1
          && control.states.filter(state => state.busy === false).length >= 2);
        const diagnostic = control.markers.find(marker => marker.kind === 'diagnostic');
        expect(diagnostic?.payload).toMatchObject({
          code: 'native_turn_identity_conflict',
          turnId: 'om_conflict',
          message: expect.stringContaining(expectedReason),
        });
        expect(control.finals[0]).toMatchObject({
          turnId: 'om_conflict',
          content: expect.stringContaining('Codex App native turn identity conflict'),
        });
        expect(control.states.filter(state => state.busy === false).length).toBeGreaterThanOrEqual(2);
        expect(harness.child.exitCode).toBeNull();
      } finally {
        await stopChild(harness.child);
        await control.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('keeps the accepted turn pending and settles on its real completion when a stale pre-response completion mismatches the native id', async () => {
    // REGRESSION for the pendingCompletions replay else branch: a STALE
    // turn/completed (previous/autonomous turn, no client items, unrelated id)
    // arrives BEFORE the start response. Master silently dropped it on replay
    // (hang risk if it was the real terminal event); the initial fix reconciled
    // immediately and failed closed — but the accepted turn was still running,
    // so bounded history had no terminal record yet and the REAL completion
    // arriving 100ms later was discarded (identity-conflict false kill, real
    // answer lost). The fix keeps the turn pending while the native turn is
    // active: the real completion settles it with the real answer, no identity
    // conflict.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-stale-preresp-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'pre-response-foreign-completion', control.bootstrap.path);

    try {
      await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('legacy', {
        text: 'stale completion before response',
        clientUserMessageId: 'om_stale_pre',
      })}\r`);
      // The turn MUST settle with the REAL answer (arriving 100ms after the
      // response), not an identity-conflict error. A fail-closed here is the
      // regression: the stale pre-response completion killed a still-running
      // turn and swallowed its real completion.
      await waitFor(harness, () => control.finals.length === 1
        && control.states.filter(state => state.busy === false).length >= 2);
      // The else branch fired (reconcile scanned history) — proof the stale
      // completion was replayed, not silently dropped — and it did NOT kill the
      // turn: no identity-conflict diagnostic.
      expect(readRequests(logPath).some(request => request.method === 'thread/turns/list')).toBe(true);
      const diagnostics = control.markers.filter(
        marker => marker.kind === 'diagnostic' && marker.payload.code === 'native_turn_identity_conflict',
      );
      expect(diagnostics).toHaveLength(0);
      expect(control.finals[0]).toMatchObject({
        turnId: 'om_stale_pre',
        content: 'real answer after response',
      });
      expect(harness.child.exitCode).toBeNull();
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not let an autonomous Goal turn/started flip the keep-pending reconcile into a false kill', async () => {
    // REGRESSION for the keep-pending exit condition: a stale foreign completion
    // before the start response replays into reconcile with keepPendingWhileActive.
    // An autonomous Goal turn/started then flips the GLOBAL nativeActiveTurnId
    // slot while the accepted turn is still running. The global slot flip is not
    // proof this turn terminated — the turn must stay pending and settle with
    // its own real completion (arriving 1.5s after the response), not fail-closed
    // on the Goal's turn/started. The old exit condition (nativeActiveTurnId !==
    // turn.nativeTurnId) killed the turn here and swallowed the real answer.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-goal-switch-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'pre-response-foreign-completion-goal-switch', control.bootstrap.path);

    try {
      await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('legacy', {
        text: 'stale completion then goal switch',
        clientUserMessageId: 'om_goal_switch_pre',
      })}\r`);
      // The turn MUST settle with the REAL answer arriving after the Goal's
      // turn/started flipped the global native slot — not an identity-conflict
      // error. A fail-closed here is the regression: the Goal's lifecycle edge
      // was misread as this turn's termination. The final transaction is only
      // emitted after await turn.done, so finals.length===1 proves the turn
      // settled (the autonomous Goal stays native-busy by design, so the runner
      // intentionally does NOT go idle here).
      await waitFor(harness, () => control.finals.length === 1);
      // The else branch fired (reconcile scanned history while pending) — proof
      // the stale completion was replayed — and it did NOT kill the turn.
      expect(readRequests(logPath).some(request => request.method === 'thread/turns/list')).toBe(true);
      const diagnostics = control.markers.filter(
        marker => marker.kind === 'diagnostic' && marker.payload.code === 'native_turn_identity_conflict',
      );
      expect(diagnostics).toHaveLength(0);
      expect(control.finals[0]).toMatchObject({
        turnId: 'om_goal_switch_pre',
        content: 'real answer despite goal switch',
      });
      expect(harness.child.exitCode).toBeNull();
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds the keep-pending re-scan loop and fail-closes when the native turn never completes', async () => {
    // REGRESSION for the unbounded history poll: a stale foreign completion
    // before the start response replays into reconcile with keepPendingWhileActive,
    // and the accepted native turn hangs forever. The re-scan loop must stop
    // after its wall-clock ceiling (shrunk to 1s here via the test override) and
    // fail-closed — identity conflict + turn.done settles — instead of polling
    // thread/turns/list (~5Hz) forever. The no-progress watchdog is not a safety
    // net here: it only projects a stalled UI state and never cancels the runner.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-keep-pending-bound-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(
      fakeCodex,
      dir,
      logPath,
      '0.144.6',
      'pre-response-foreign-completion-hang',
      control.bootstrap.path,
      { env: { BOTMUX_TEST_CODEX_APP_KEEP_PENDING_TIMEOUT_MS: '1000' } },
    );

    try {
      await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('legacy', {
        text: 'stale completion then hang',
        clientUserMessageId: 'om_keep_pending_hang',
      })}\r`);
      // The ceiling (1s) trips: reconcile fail-closes with an identity conflict
      // and the turn settles with an explicit error final.
      await waitFor(harness, () => control.markers.some(
        marker => marker.kind === 'diagnostic' && marker.payload.code === 'native_turn_identity_conflict',
      ));
      await waitFor(harness, () => control.finals.length === 1
        && control.states.filter(state => state.busy === false).length >= 2);
      expect(control.finals[0]).toMatchObject({
        turnId: 'om_keep_pending_hang',
      });
      expect(String(control.finals[0].content ?? '')).toContain('identity conflict');
      // The re-scan count is bounded by the ceiling: 1000ms / 200ms retry ≈ 5-6
      // scans (one turns/list page each). A runaway loop would dwarf this.
      const listCountAtSettle = readRequests(logPath)
        .filter(request => request.method === 'thread/turns/list').length;
      expect(listCountAtSettle).toBeGreaterThanOrEqual(1);
      expect(listCountAtSettle).toBeLessThanOrEqual(8);
      // After fail-closed the loop must NOT keep polling: observe for 600ms
      // (3x the retry interval) and assert the count did not grow.
      await new Promise(resolvePromise => setTimeout(resolvePromise, 600));
      const listCountAfterQuiet = readRequests(logPath)
        .filter(request => request.method === 'thread/turns/list').length;
      expect(listCountAfterQuiet).toBe(listCountAtSettle);
      expect(harness.child.exitCode).toBeNull();
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed (does not hang on foreign progress) when keep-pending arms without a bound native id', async () => {
    // REGRESSION for the keep-pending arm guard: the turn/start response succeeds
    // but returns NO native id (protocol anomaly) and no exact turn/started proved
    // one first, so turn.nativeTurnId stays undefined. A stale foreign completion
    // arms keep-pending. handleNotification's progress-reset guard
    // (notificationTurnId !== turn.nativeTurnId) falls fully open on the unset id,
    // so a FOREIGN turn's periodic progress would keep resetting the deadline
    // forever while acceptedTurnWentTerminal (which needs the id) can never fire —
    // an unbounded hang that blocks the runner FIFO. The fix refuses to arm
    // keep-pending without a native id, so the loop fails closed on the first scan
    // regardless of foreign chatter. A hang here (no diagnostic, no final) is the
    // regression.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-keep-pending-unbound-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(
      fakeCodex,
      dir,
      logPath,
      '0.144.6',
      'pre-response-foreign-completion-unbound-id',
      control.bootstrap.path,
      { env: { BOTMUX_TEST_CODEX_APP_KEEP_PENDING_TIMEOUT_MS: '1000' } },
    );

    try {
      await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('legacy', {
        text: 'unbound id start response then foreign progress',
        clientUserMessageId: 'om_keep_pending_unbound',
      })}\r`);
      // Must fail closed promptly (the deadline was never armed, so the first
      // scan trips `?? 0`) despite the foreign turn's progress every 300ms. A
      // hang here — no diagnostic, no final — is the regression: foreign activity
      // resetting a fallen-open guard's deadline forever.
      await waitFor(harness, () => control.markers.some(
        marker => marker.kind === 'diagnostic' && marker.payload.code === 'native_turn_identity_conflict',
      ));
      await waitFor(harness, () => control.finals.length === 1
        && control.states.filter(state => state.busy === false).length >= 2);
      expect(control.finals[0]).toMatchObject({ turnId: 'om_keep_pending_unbound' });
      expect(String(control.finals[0].content ?? '')).toContain('identity conflict');
      expect(harness.child.exitCode).toBeNull();
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resets the keep-pending ceiling on progress so a long-running turn is not killed before its real completion', async () => {
    // REGRESSION for the keep-pending ceiling semantics: a stale pre-response
    // completion triggers keepPendingWhileActive. The accepted turn then emits
    // periodic progress for ~5s — longer than the test's 3s keep-pending
    // ceiling — and only then sends its REAL completion. A FIXED 3s ceiling
    // would reportIdentityConflict at 3s and discard the real answer; a
    // progress-resettable ceiling must keep the turn pending and deliver it.
    // This aligns the runner's fail-closed with the worker's 90s no-progress
    // liveness window: both are refreshed by the same activity.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-keep-pending-progress-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(
      fakeCodex,
      dir,
      logPath,
      '0.144.6',
      'pre-response-foreign-completion-long-progress',
      control.bootstrap.path,
      { env: { BOTMUX_TEST_CODEX_APP_KEEP_PENDING_TIMEOUT_MS: '3000' } },
    );

    try {
      await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('legacy', {
        text: 'stale completion then long progress',
        clientUserMessageId: 'om_keep_pending_progress',
      })}\r`);
      // The turn MUST settle with the REAL answer arriving at ~5s — well past
      // the 3s fixed ceiling. A fail-closed identity-conflict here is the
      // regression: the stale ceiling killed a turn that was still making
      // progress.
      await waitFor(harness, () => control.finals.length === 1
        && control.states.filter(state => state.busy === false).length >= 2);
      const diagnostics = control.markers.filter(
        marker => marker.kind === 'diagnostic' && marker.payload.code === 'native_turn_identity_conflict',
      );
      expect(diagnostics).toHaveLength(0);
      expect(control.finals[0]).toMatchObject({
        turnId: 'om_keep_pending_progress',
        content: 'real answer after long progress',
      });
      // Reconcile ran (the stale completion was replayed into keep-pending).
      expect(readRequests(logPath).some(request => request.method === 'thread/turns/list')).toBe(true);
      expect(harness.child.exitCode).toBeNull();
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the startup deadline armed through initialize and never exposes a pre-ready prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-runner-startup-deadline-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(
      fakeCodex,
      dir,
      logPath,
      '0.144.1',
      'hang-initialize',
      control.bootstrap.path,
      { env: { BOTMUX_TEST_CODEX_APP_STARTUP_TIMEOUT_MS: '1000' } },
    );
    try {
      const exitCode = await new Promise<number | null>(resolvePromise => harness.child.once('exit', resolvePromise));
      expect(exitCode).toBe(2);
      expect(readRequests(logPath).filter(request => request.method === 'initialize')).toHaveLength(1);
      expect(harness.stdout).not.toContain('Codex App connected.');
      expect(harness.stdout).not.toContain('› ');
      expect(control.states).toEqual([]);
      expect(harness.stderr).toContain('startup timed out before the first signed runner state');
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not turn an ambiguous resume timeout into a fresh thread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-runner-resume-timeout-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(
      fakeCodex,
      dir,
      logPath,
      '0.144.1',
      'hang-resume',
      control.bootstrap.path,
      {
        threadId: 'thread-existing',
        env: { BOTMUX_TEST_CODEX_APP_STARTUP_TIMEOUT_MS: '1000' },
      },
    );
    try {
      await new Promise<void>(resolvePromise => harness.child.once('exit', () => resolvePromise()));
      const requests = readRequests(logPath);
      expect(requests.filter(request => request.method === 'thread/resume')).toHaveLength(1);
      expect(requests.filter(request => request.method === 'thread/start')).toHaveLength(0);
      expect(harness.stdout).not.toContain('Codex App connected.');
      expect(control.states).toEqual([]);
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves a thread owned by another app-server writer instead of starting a fresh thread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-runner-active-writer-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(
      fakeCodex,
      dir,
      logPath,
      '0.147.0',
      'resume-active-writer',
      control.bootstrap.path,
      { threadId: 'thread-existing' },
    );
    try {
      const exitCode = await new Promise<number | null>(resolvePromise => harness.child.once('exit', resolvePromise));
      const requests = readRequests(logPath);
      expect(exitCode).toBe(CODEX_APP_ACTIVE_WRITER_EXIT_CODE);
      expect(requests.filter(request => request.method === 'thread/resume')).toHaveLength(1);
      expect(requests.filter(request => request.method === 'thread/start')).toHaveLength(0);
      expect(harness.stderr).toContain('currently owned by another app-server writer');
      expect(control.states).toEqual([]);
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the full legacy prompt on codex < 0.135 even if the server ignores new fields', async () => {
    const result = await exerciseRunner({ version: '0.134.9' });
    const turns = result.requests.filter(request => request.method === 'turn/start');
    expect(turns).toHaveLength(1);
    expect(turns[0].params.input).toEqual([
      { type: 'text', text: 'legacy <sender>prompt</sender>', text_elements: [] },
    ]);
    expect(turns[0].params).not.toHaveProperty('additionalContext');
    expect(turns[0].params).not.toHaveProperty('clientUserMessageId');
    expect(result.output).toContain('clean input requires codex >= 0.135.0 (found 0.134.9); using legacy prompt');
    // Even when the app-server cannot receive the new field, the runner still
    // preserves the daemon-frozen logical identity from its sidecar.
    expect(result.final.replyTurnId).toBe('om_integration_123');
    expect(result.final.appTurnId).toBe('turn-fake-1');
  });

  it('retries exactly once with the legacy prompt for an explicit experimental-field rejection', async () => {
    const result = await exerciseRunner({ version: '0.136.0', behavior: 'capability-error' });
    const turns = result.requests.filter(request => request.method === 'turn/start');
    expect(turns).toHaveLength(2);
    expect(turns[0].params.input[0].text).toBe('clean user text');
    expect(turns[0].params.additionalContext).toBeDefined();
    expect(turns[0].params.clientUserMessageId).toBe('om_integration_123');
    expect(turns[1].params.input).toEqual([
      { type: 'text', text: 'legacy <sender>prompt</sender>', text_elements: [] },
    ]);
    expect(turns[1].params).not.toHaveProperty('additionalContext');
    expect(turns[1].params).not.toHaveProperty('clientUserMessageId');
    expect(result.output.match(/retrying this turn with the legacy prompt/g)).toHaveLength(1);
    expect(result.final.content).toBe('fake answer 2');
    expect(result.final.replyTurnId).toBe('om_integration_123');
    expect(result.final.appTurnId).toBe('turn-fake-2');
  });

  it('does not retry generic turn errors, avoiding duplicate model work', async () => {
    const result = await exerciseRunner({ version: '0.136.0', behavior: 'generic-error' });
    const turns = result.requests.filter(request => request.method === 'turn/start');
    expect(turns).toHaveLength(1);
    expect(turns[0].params.input[0].text).toBe('clean user text');
    expect(result.output).not.toContain('retrying this turn with the legacy prompt');
    expect(result.final.content).toContain('Codex App runner error: turn/start:');
    expect(result.final.content).toContain('model overloaded');
    expect(result.final.replyTurnId).toBe('om_integration_123');
    expect(result.final.appTurnId).toMatch(/^codex-app-error-/);
  });

  it('omits a native routing id for a legacy envelope so the worker can use its frozen botmux turn', async () => {
    const result = await exerciseRunner({ version: '0.136.0', includeSidecar: false });
    const turns = result.requests.filter(request => request.method === 'turn/start');
    expect(turns).toHaveLength(1);
    expect(turns[0].params.input).toEqual([
      { type: 'text', text: 'legacy <sender>prompt</sender>', text_elements: [] },
    ]);
    expect(result.final).not.toHaveProperty('replyTurnId');
    expect(result.final.appTurnId).toBe('turn-fake-1');
  });

  it('escapes split agent/command OSC injections and emits the trusted final only out of band', async () => {
    const result = await exerciseRunner({ version: '0.136.0', behavior: 'osc-injection' });

    expect(result.output).toContain('␛]777;botmux:final:');
    expect(result.output.match(/\x1b\]777;botmux:final:/g)).toBeNull();
    expect(result.final).toMatchObject({
      replyTurnId: 'om_integration_123',
      appTurnId: 'turn-fake-1',
      content: 'fake answer 1',
    });
    expect(result.output).not.toContain('forged marker output');
  });

  it('steers two plain-Lark follow-ups into an open turn/start before its final, expanding into N ordered finals (superseded + real)', async () => {
    // Blocking 1 (ordered steer): unlike the Goal-continuation path, here inputs
    // #2 and #3 arrive while input #1's own turn/start is still OPEN (no final
    // yet) and are admitted as pre-final turn/steer into the SAME native turn.
    // The fixture's 'steer' behavior keeps the turn/start turn open and only
    // completes it after the 2nd steer — so completion races the last steer RPC,
    // exercising the completion barrier. One native completion expands into three
    // ordered signed finals: the first two are `steer_superseded` (empty, no
    // usage — they only advance the worker FIFO), the last carries the real
    // answer. Two signed steer_attempt+steer_accepted lifecycle pairs are emitted
    // (the dead worker path codex flagged), and the native turn is entered once.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-prefinal-steer-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'steer', control.bootstrap.path);

    // Every input is daemon-authorized to steer (codexAppSteerable:true) — the
    // explicit positive that the admission gate sets only for plain-human turns.
    const send = (text: string, replyTurnId: string) => {
      const encoded = encodeRunnerInput(
        `legacy:${text}`,
        { text, additionalContext: { botmux_sender: { kind: 'untrusted', value: 'Alice' } } },
        replyTurnId,
        true,
      );
      harness.child.stdin.write(`${CONTROL_PREFIX}${encoded}\r`);
    };

    try {
      await waitFor(harness, () => control.states.some(state => state.busy === false));
      // Root turn/start; it stays open (fixture 'steer' does not complete on start).
      send('root', 'om_root');
      await waitFor(harness, () => readRequests(logPath).some(r => r.method === 'turn/start'));
      // Two follow-ups arrive BEFORE any final — each steers into the open turn.
      send('follow one', 'om_follow_1');
      send('follow two', 'om_follow_2');

      // The 2nd steer completes the native turn; one completion → three finals.
      await waitFor(harness, () => control.finals.length === 3
        && control.states.filter(state => state.busy === false).length >= 2);

      const requests = readRequests(logPath);
      const turnMethods = requests
        .filter(r => r.method === 'turn/start' || r.method === 'turn/steer')
        .map(r => r.method);
      // Exactly one turn/start (the root) and two ordered turn/steer follow-ups —
      // NOT three turn/starts. This is the ordered-steer contract, not serial.
      expect(turnMethods).toEqual(['turn/start', 'turn/steer', 'turn/steer']);

      // N-final expansion: first two superseded (empty, no usage), last is real.
      expect(control.finals).toEqual([
        expect.objectContaining({ turnId: 'om_root', content: '', disposition: 'steer_superseded' }),
        expect.objectContaining({ turnId: 'om_follow_1', content: '', disposition: 'steer_superseded' }),
        expect.objectContaining({ turnId: 'om_follow_2', content: 'fake answer 1' }),
      ]);
      // The real final carries no superseded disposition.
      expect(control.finals[2]).not.toHaveProperty('disposition');
      // Superseded finals never carry usage.
      expect(control.finals[0]).not.toHaveProperty('usage');
      expect(control.finals[1]).not.toHaveProperty('usage');

      // Signed steer lifecycle: two attempt+accepted pairs (the worker consumes
      // steer_accepted → "收到,引导成功"). This is the transport codex required.
      const lifecycles = control.markers.filter(m => m.kind === 'lifecycle').map(m => m.payload);
      const attempts = lifecycles.filter(l => l.kind === 'steer_attempt');
      const accepted = lifecycles.filter(l => l.kind === 'steer_accepted');
      expect(attempts.map(a => a.replyTurnId)).toEqual(['om_follow_1', 'om_follow_2']);
      expect(accepted.map(a => a.replyTurnId)).toEqual(['om_follow_1', 'om_follow_2']);
      // No forged final OSC leaked to stdout (finals stay out of band).
      expect(harness.stdout.match(/\x1b\]777;botmux:final:/g)).toBeNull();
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends two ordered turn/steer requests, emits both acceptances, then one final', async () => {
    // PR #597 moved the runner's finals + lifecycle off terminal OSC onto the
    // signed control channel and serializes Lark turn/start requests (a queued
    // Lark input never steers into another Lark turn/start — the master OSC
    // streaming model this test originally encoded). PR's genuine ordered-steer
    // path is steering successive Lark inputs into autonomous Goal continuations.
    // This adaptation exercises exactly that over the signed socket: input 1's
    // turn/start completes and the app-server auto-starts Goal turn A; input 2
    // steers into A; A completes and Goal turn B auto-starts; input 3 steers into
    // B — two ordered turn/steer requests, each acknowledged by its own signed
    // final transaction, with reply-turn attribution preserved.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-steer-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'goal-continuation-2x', control.bootstrap.path);

    const send = (text: string, replyTurnId: string) => {
      const encoded = encodeRunnerInput(
        `legacy:${text}`,
        {
          text,
          additionalContext: {
            botmux_sender: { kind: 'untrusted', value: 'Alice' },
          },
        },
        replyTurnId,
        // Plain interactive Lark inputs are daemon-authorized to steer; under the
        // B3 gate a Goal-continuation steer requires this explicit positive.
        true,
      );
      harness.child.stdin.write(`${CONTROL_PREFIX}${encoded}\r`);
    };

    try {
      await waitFor(harness, () => control.states.some(state => state.busy === false));
      send('first', 'om_first');
      // Turn 1 completes; the app-server auto-starts Goal turn A (native-busy,
      // no tracked Lark turn) that the next input steers into.
      await waitFor(harness, () => control.finals.length === 1
        && control.states.some(state => state.busy === true && state.tracksTurn === false));

      send('second', 'om_second');
      // Steer into Goal turn A completes; Goal turn B auto-starts (native-busy
      // again with no tracked Lark turn).
      await waitFor(harness, () => control.finals.length === 2
        && control.states.some(state => state.busy === true && state.tracksTurn === false));

      send('third', 'om_third');
      await waitFor(harness, () => control.finals.length === 3
        && control.states.filter(state => state.busy === false).length >= 2);

      const requests = readRequests(logPath);
      const turnRequests = requests.filter(request => (
        request.method === 'turn/start' || request.method === 'turn/steer'
      ));
      expect(turnRequests.map(request => request.method)).toEqual([
        'turn/start',
        'turn/steer',
        'turn/steer',
      ]);
      expect(turnRequests[1].params).toMatchObject({
        expectedTurnId: 'turn-goal-auto',
        clientUserMessageId: 'om_second',
        input: [{ type: 'text', text: 'second', text_elements: [] }],
        additionalContext: {
          botmux_sender: { kind: 'untrusted', value: 'Alice' },
        },
      });
      expect(turnRequests[2].params).toMatchObject({
        expectedTurnId: 'turn-goal-auto-2',
        clientUserMessageId: 'om_third',
        input: [{ type: 'text', text: 'third', text_elements: [] }],
      });

      // Each ordered steer produced exactly one signed final transaction, with
      // its botmux reply id (turnId) and app-server native id (nativeTurnId)
      // preserved — the signed-socket equivalent of master's steer_accepted +
      // final ordering assertion.
      expect(control.finals).toEqual([
        expect.objectContaining({ turnId: 'om_first', content: 'fake answer 1' }),
        expect.objectContaining({
          turnId: 'om_second',
          nativeTurnId: 'turn-goal-auto',
          content: 'goal steer answer',
        }),
        expect.objectContaining({
          turnId: 'om_third',
          nativeTurnId: 'turn-goal-auto-2',
          content: 'goal steer answer',
        }),
      ]);
      // PR moved finals off terminal OSC: no raw final OSC leaks onto stdout
      // (mirrors the osc-injection test's out-of-band guarantee).
      expect(harness.stdout.match(/\x1b\]777;botmux:final:/g)).toBeNull();
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('forwards --model + --reasoning-effort into thread/start (top-level model + config.model_reasoning_effort, xhigh verbatim)', async () => {
    // Runs the REAL codex-app-runner against the fake app-server and asserts the
    // actual thread/start params — the hop the adapter-flag test cannot cover.
    // Under PR #597's signed transport the runner requires a control bootstrap,
    // so it connects over the ControlCollector while --model/--reasoning-effort
    // ride the extra argv.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-effort-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'success', control.bootstrap.path, {
      extraArgs: ['--model', 'gpt-5.6-terra', '--reasoning-effort', 'xhigh'],
    });
    try {
      await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('hi', { text: 'hi' })}\r`);
      await waitFor(harness, () => control.finals.length >= 1);
      const threadStart = readRequests(logPath).find(r => r.method === 'thread/start');
      expect(threadStart).toBeTruthy();
      expect(threadStart.params.model).toBe('gpt-5.6-terra');            // top-level model
      expect(threadStart.params.config?.model_reasoning_effort).toBe('xhigh'); // NOT downgraded
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registers the bounded browser dynamic tool only when the bridge is enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-browser-tool-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'success', control.bootstrap.path, {
      extraArgs: ['--browser-family', 'chrome'],
    });
    try {
      await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('hi', { text: 'hi' })}\r`);
      await waitFor(harness, () => control.finals.length >= 1);
      const threadStart = readRequests(logPath).find(r => r.method === 'thread/start');
      expect(threadStart?.params.dynamicTools).toEqual([
        expect.objectContaining({
          type: 'function',
          name: 'botmux_browser',
          inputSchema: expect.objectContaining({
            additionalProperties: false,
            required: ['operation'],
          }),
        }),
      ]);
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SUPPRESSES model/effort on thread/resume even when --model/--reasoning-effort are passed (no resume drift)', async () => {
    // PR #639 P2 regression lock, runner side: a resume (--thread-id present)
    // routes to thread/resume, and even though the adapter still forwards
    // --model/--reasoning-effort on argv, the resume request must carry NEITHER
    // top-level model NOR config.model_reasoning_effort — else the app-server's
    // model-resume-override short-circuit drops the persisted triple to the
    // current default. Fresh thread/start (the test above) still stamps both.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-resume-suppress-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'success', control.bootstrap.path, {
      extraArgs: ['--thread-id', 'thread-existing-1', '--model', 'gpt-5.6-terra', '--reasoning-effort', 'xhigh'],
    });
    try {
      await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('hi', { text: 'hi' })}\r`);
      await waitFor(harness, () => control.finals.length >= 1);
      const requests = readRequests(logPath);
      const resume = requests.find(r => r.method === 'thread/resume');
      const start = requests.find(r => r.method === 'thread/start');
      expect(resume).toBeTruthy();          // routed to resume, not start
      expect(start).toBeFalsy();            // a warm resume must not fresh-start
      expect(resume.params.model).toBeUndefined();                          // no top-level model
      expect(resume.params.config?.model_reasoning_effort).toBeUndefined(); // no effort
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('folds thread/tokenUsage/updated into the final marker usage (four buckets)', async () => {
    // Real runner + fake app-server emitting a token-usage notification; assert
    // the emitted final marker carries the per-turn four-bucket usage. Under PR
    // #597's signed transport the usage rides the signed final transaction, read
    // off the ControlCollector rather than a terminal OSC marker.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-usage-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'success', control.bootstrap.path, {
      env: { FAKE_TOKEN_USAGE: '1' },
    });
    try {
      await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('hi', { text: 'hi' })}\r`);
      await waitFor(harness, () => control.finals.length >= 1);
      // input=100 total incl cache; cached=40 → fresh input 60, output 30, cacheRead 40.
      expect(control.finals[0].usage).toEqual({ inputTokens: 60, outputTokens: 30, cacheReadTokens: 40, cacheCreateTokens: 0 });
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits usage when a malformed tokenUsage notification poisons the turn (sticky)', async () => {
    // malformed-then-valid same turn: the runner must NOT report only the later
    // completion. Final marker usage is omitted.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-poison-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'success', control.bootstrap.path, {
      env: { FAKE_TOKEN_USAGE_POISON: '1' },
    });
    try {
      await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('hi', { text: 'hi' })}\r`);
      await waitFor(harness, () => control.finals.length >= 1);
      expect(control.finals[0].usage).toBeUndefined();
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits usage when asymmetric cacheWrite poisons the turn, even after a later valid packet (codex P1)', async () => {
    // First packet: total carries cacheWriteInputTokens but last omits it. A
    // 0-default on the missing side would misattribute cache-create into fresh
    // input; the runner must poison. A subsequent symmetric packet must not
    // resurrect a plausible-looking wrong split → final marker usage OMITTED.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-asym-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const control = new ControlCollector(dir);
    await control.listen();
    const harness = startRunner(fakeCodex, dir, logPath, '0.144.6', 'success', control.bootstrap.path, {
      env: { FAKE_TOKEN_USAGE_ASYM: '1' },
    });
    try {
      await waitFor(harness, () => harness.stdout.includes('Codex App connected.'));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('hi', { text: 'hi' })}\r`);
      await waitFor(harness, () => control.finals.length >= 1);
      expect(control.finals[0].usage).toBeUndefined();
    } finally {
      await stopChild(harness.child);
      await control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
